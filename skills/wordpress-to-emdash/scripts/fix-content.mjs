#!/usr/bin/env node
/**
 * Repairs content the WordPress → EmDash import lost, from the export and
 * what WordPress displayed. Dry run by default: it changes nothing and writes
 *   <paths.fixes>/proposals.json           every proposed change, per post
 *   <paths.fixes>/preview.html             the same, readable, for approval
 *   <paths.fixes>/decisions.template.json  every open owner decision
 *
 *   node fix-content.mjs [--only gallery,captions,...] [--slugs a,b]
 *        [--include-low] [--skip slug[:fix],...] [--decisions file]
 *        [--audit report.json] [--no-verify] [--no-preview] [--out dir]
 *
 *   node fix-content.mjs --apply --target local|staging [same filters] [--limit N]
 *        [--proposals <file>]   (default <paths.fixes>/proposals.approved.json)
 *
 * Fixes (in run order): titles, brackets, captions, gallery, code, classic,
 * embeds, wpImages, textLoss, unpublish. See lib/fix/fixes/.
 *
 * Confidence: high and medium changes are applied by default; low ones only
 * with --include-low. Items that need the owner's decision are applied only
 * when decisions.json (paths.decisions) picks an option for them, e.g.
 *   { "some-post:code:script-text": "remove",
 *     "another-post:embeds:codepen": "card",
 *     "provider:spotify": "card" }
 *
 * Approval: once the owner has read preview.html, copy proposals.json to
 * proposals.approved.json. Apply reads only the approved copy, so a later dry
 * run can't change what gets applied (gotcha E6b).
 *
 * Apply re-runs the same fixes against the target's current content and its
 * own media library (local and staging use different storage keys, gotcha
 * B1b), checks each result matches the approved proposal (keys and media URLs
 * aside), then PUTs the content with _rev and publishes. Run it again and it
 * finds nothing to do. Take restore points first (gotcha E6c).
 */
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { announce, clientFor, parseArgs, resolveTarget } from "./lib/cli.mjs";
import { CONFIG, entryPath, requireConfig } from "./lib/config.mjs";
import { AUDIT_PATH, NEW, OLD, OUT, fetchStats, loadAudit, loadLocalEntries, loadLocalMedia, loadLocalRedirects, loadWpRendered, loadWxr, probe, wayback } from "./lib/fix/data.mjs";
import { MediaIndex } from "./lib/fix/media.mjs";
import { clone, diffBlocks, normaliseFilename, stable } from "./lib/fix/pt.mjs";
import { FIXES } from "./lib/fix/registry.mjs";

requireConfig("sites.wordpress", "d1.database");
const args = parseArgs(["only", "slugs", "skip", "decisions", "out", "target", "limit", "proposals", "audit"]);
const flag = args.flag;
const opt = args.opt;
const list = args.list;

const APPLY = flag("apply");
const ONLY = list("only");
const SLUGS = list("slugs") ? new Set(list("slugs")) : null;
const SKIP = new Set(list("skip") ?? []);
const INCLUDE_LOW = flag("include-low");
const LIMIT = Number(opt("limit", "0")) || Infinity;
const OUT_DIR = opt("out", OUT);
const DECISIONS_FILE = opt("decisions", CONFIG.paths.decisions);
const AUDIT_FILE = opt("audit", AUDIT_PATH);
const ALLOWED = new Set(["high", "medium", ...(INCLUDE_LOW ? ["low"] : [])]);

if (ONLY) {
	const known = new Set(FIXES.map((f) => f.id));
	for (const id of ONLY) if (!known.has(id)) throw new Error(`Unknown fix "${id}". Fixes: ${[...known].join(", ")}`);
}
const TARGET = APPLY ? resolveTarget(args) : null;
if (!APPLY && opt("target") && opt("target") !== "local") console.log(`Note: the dry run always reads the local D1 copy; --target ${opt("target")} only matters with --apply.`);

const RANK = { high: 3, medium: 2, low: 1 };
const lowest = (cs) => cs.reduce((m, c) => (RANK[c] < RANK[m] ? c : m), "high");
const log = (...a) => console.log(...a);
const urlsFor = (collection, slug) => ({ wordpress: `${OLD}${entryPath(slug, collection)}`, new: `${NEW || CONFIG.sites.local}${entryPath(slug, collection)}` });

// ---------------------------------------------------------------- context

async function loadDecisions() {
	if (!existsSync(DECISIONS_FILE)) return {};
	return JSON.parse(await readFile(DECISIONS_FILE, "utf8"));
}

async function baseContext() {
	const [wxr, rendered, audit, decisions] = await Promise.all([loadWxr(), loadWpRendered(), loadAudit(AUDIT_FILE), loadDecisions()]);
	const wxrMap = new Map(wxr.posts.filter((p) => p.status === "publish").map((p) => [`${CONFIG.content.postTypes[p.type]}:${p.slug}`, p]));
	return {
		wxr,
		audit,
		decisions,
		wxrFor: (e) => wxrMap.get(`${e.collection}:${e.slug}`) ?? null,
		wpRendered: (e) => rendered.get(e.slug) ?? null,
		probe,
		wayback,
		decision: (slug, fix, kind) => decisions[`${slug}:${fix}:${kind}`] ?? null,
		allows: (confidence) => ALLOWED.has(confidence),
		notes: [],
		note(msg) {
			this.notes.push(msg);
		},
	};
}

// ---------------------------------------------------------------- pipeline

/**
 * Run the fixes over one entry. Returns per-fix results and the final
 * content/title/status. Pure apart from cached WordPress probes.
 */
async function runPipeline(entry, ctx) {
	let content = clone(entry.content ?? []);
	let title = entry.title;
	let unpublish = false;
	const results = [];
	for (const fix of FIXES) {
		if (ONLY && !ONLY.includes(fix.id)) continue;
		if (SKIP.has(entry.slug) || SKIP.has(`${entry.slug}:${fix.id}`)) continue;
		let r;
		try {
			r = await fix.run({ ...entry, title, content }, content, ctx);
		} catch (err) {
			results.push({ fix: fix.id, label: fix.label, error: String(err.stack ?? err).slice(0, 600), items: [], applied: false });
			continue;
		}
		if (!r || (!r.items?.length && !r.needsOwner?.length)) continue;
		const items = r.items ?? [];
		const applicable = items.filter((it) => it.status !== "needs-owner" && it.applied !== false);
		const confidence = applicable.length ? lowest(applicable.map((it) => it.confidence)) : null;
		const applied = Boolean(confidence) && ALLOWED.has(confidence);
		const res = {
			fix: fix.id,
			label: fix.label,
			confidence,
			applied,
			items,
			needsOwner: r.needsOwner ?? [],
			notes: r.notes ?? [],
		};
		if (applied) {
			if (r.content) {
				res.hunks = diffBlocks(content, r.content);
				content = r.content;
			}
			if (r.title && r.title !== title) {
				res.title = { before: title, after: r.title };
				title = r.title;
			}
			if (r.unpublish) {
				res.unpublish = true;
				unpublish = true;
			}
		} else if (r.content) {
			// Shown in the preview, not applied
			res.hunks = diffBlocks(content, r.content);
			if (r.title) res.title = { before: title, after: r.title };
			if (r.unpublish) res.unpublish = true;
		}
		res.signature = signature(res);
		results.push(res);
	}
	return { results, content, title, unpublish };
}

/** Change fingerprint without keys or site-specific media URLs/ids. */
function signature(res) {
	const scrub = (v) => {
		if (Array.isArray(v)) return v.map(scrub);
		if (v && typeof v === "object" && Array.isArray(v.markDefs) && !v._canon) {
			// Link keys are generated: refer to each markDef by its position instead
			const ids = new Map(v.markDefs.map((d, i) => [d._key, `#${i}`]));
			const children = (v.children ?? []).map((c) => ({ ...c, marks: (c.marks ?? []).map((m) => ids.get(m) ?? m) }));
			return scrub({ ...v, markDefs: v.markDefs.map(({ _key, ...d }) => d), children, _canon: true });
		}
		if (v && typeof v === "object") {
			const o = {};
			for (const [k, x] of Object.entries(v)) {
				if (k === "_key" || k === "_ref" || k === "width" || k === "height") continue;
				o[k] = scrub(x);
			}
			return o;
		}
		if (typeof v === "string") return v.replace(/\/_emdash\/api\/media\/file\/[A-Z0-9]+(\.[a-z0-9]+)?/gi, "/media/*$1");
		return v;
	};
	const body = stable({ hunks: scrub((res.hunks ?? []).map((h) => ({ before: h.before, after: h.after }))), title: res.title ?? null, unpublish: res.unpublish ?? false });
	return createHash("sha1").update(body).digest("hex").slice(0, 16);
}

// ---------------------------------------------------------------- dry run

async function dryRun() {
	log(`Dry run: reading the local D1 copy (${CONFIG.d1.database}); nothing is written anywhere except ${OUT_DIR}`);
	const entries = loadLocalEntries().filter((e) => !SLUGS || SLUGS.has(e.slug));
	const media = MediaIndex.fromLocal(loadLocalMedia(), loadLocalRedirects());
	log(`  ${entries.length} published entries, ${media.items.length} media items`);
	log(`Loading the WordPress export, WordPress REST (cached) and the audit (${AUDIT_FILE})…`);
	const ctx = { ...(await baseContext()), media };

	const proposals = [];
	let n = 0;
	for (const entry of entries) {
		const run = await runPipeline(entry, ctx);
		if (++n % 100 === 0) log(`  ${n}/${entries.length}`);
		if (!run.results.length) continue;
		proposals.push({
			slug: entry.slug,
			collection: entry.collection,
			id: entry.id,
			title: entry.title,
			urls: urlsFor(entry.collection, entry.slug),
			fixes: run.results,
			before: entry.content,
			after: run.content,
			titleAfter: run.title,
			unpublish: run.unpublish,
		});
	}

	const report = {
		generatedAt: new Date().toISOString(),
		target: "local (dry run)",
		config: CONFIG.file,
		options: { only: ONLY, slugs: SLUGS ? [...SLUGS] : null, includeLow: INCLUDE_LOW, skip: [...SKIP], decisions: Object.keys(ctx.decisions).length },
		counts: countProposals(proposals),
		requests: fetchStats,
		proposals,
	};

	if (!flag("no-verify")) {
		log("Verifying: rendering before/after and scoring against WordPress with the audit's normalisation…");
		const { verify } = await import("./lib/fix/verify.mjs");
		const verification = await verify(proposals, ctx);
		if (verification) report.verification = verification;
		log("Checking the fixes are idempotent and deterministic…");
		report.idempotency = await idempotency(proposals, ctx);
		log(`  re-run over the fixed content: ${report.idempotency.rerunChanges.length} posts would change again; signatures that differ on a second run: ${report.idempotency.nondeterministic.length}`);
	}

	await mkdir(OUT_DIR, { recursive: true });
	// proposals.json without the full before/after content (kept in a side file)
	const slim = { ...report, proposals: proposals.map(({ before, after, ...p }) => ({ ...p, fixes: p.fixes.map(slimFix) })) };
	await writeFile(join(OUT_DIR, "proposals.json"), JSON.stringify(slim, null, 2));
	await writeFile(join(OUT_DIR, "content-before-after.json"), JSON.stringify(proposals.map(({ slug, collection, before, after }) => ({ slug, collection, before, after }))));
	log(`Wrote ${join(OUT_DIR, "proposals.json")}`);

	// Every open decision with its recommended option, for the owner to copy to decisions.json and edit
	const template = {};
	for (const p of proposals) for (const f of p.fixes) for (const nj of f.needsOwner ?? []) if (nj.decisionKey && nj.options) template[nj.decisionKey] = nj.recommend && nj.options[nj.recommend] ? nj.recommend : null;
	await writeFile(join(OUT_DIR, "decisions.template.json"), `${JSON.stringify(template, null, 2)}\n`);

	if (!flag("no-preview")) {
		const { renderPreview } = await import("./lib/fix/preview.mjs");
		await writeFile(join(OUT_DIR, "preview.html"), renderPreview({ ...report, proposals: proposals.map((p) => ({ ...p, fixes: p.fixes.map(slimFix) })) }, thumbnails(media, ctx.wxr)));
		log(`Wrote ${join(OUT_DIR, "preview.html")}`);
	}
	printSummary(report);
	log(`\nOnce the owner approves: cp ${join(OUT_DIR, "proposals.json")} ${join(OUT_DIR, "proposals.approved.json")}`);
	log("Then take restore points and run --apply --target staging and --apply --target local from that file.");
}

/**
 * Thumbnail URL for the preview: media URLs only work on the site, so map
 * each one back to its WordPress upload and use WordPress's small copy.
 */
function thumbnails(media, wxr) {
	const keyToPath = new Map();
	for (const [path, item] of media.byPath) if (!keyToPath.has(item.storageKey)) keyToPath.set(item.storageKey, path);
	const byName = new Map(wxr.attachments.map((a) => [normaliseFilename(a.url), a]));
	return (url) => {
		if (!url) return "";
		if (/^\d+$/.test(url)) return wxr.byId.get(Number(url))?.thumb ?? "";
		const item = media.fromSiteUrl(url);
		const wpUrl = item ? (keyToPath.has(item.storageKey) ? `${OLD}${keyToPath.get(item.storageKey)}` : item.filename) : url;
		const att = byName.get(normaliseFilename(wpUrl));
		return att?.thumb ?? att?.url ?? (wpUrl.startsWith("http") ? wpUrl : "");
	};
}

/**
 * Apply relies on two properties, checked here in memory:
 *  - idempotent: the fixes find nothing to do in their own output
 *  - deterministic: the same input gives the same change signatures
 */
async function idempotency(proposals, ctx) {
	const rerunChanges = [];
	const nondeterministic = [];
	for (const p of proposals) {
		const base = { collection: p.collection, id: p.id, slug: p.slug };
		const again = await runPipeline({ ...base, status: p.unpublish ? "draft" : "published", title: p.titleAfter, content: p.after }, ctx);
		const still = again.results.filter((r) => r.applied && (r.hunks?.length || r.title || r.unpublish));
		if (still.length) rerunChanges.push({ slug: p.slug, fixes: still.map((r) => r.fix) });
		const twice = await runPipeline({ ...base, status: "published", title: p.title, content: p.before }, ctx);
		const sig = new Map(p.fixes.map((f) => [f.fix, f.signature]));
		const differs = twice.results.filter((r) => sig.get(r.fix) !== r.signature).map((r) => r.fix);
		if (differs.length) nondeterministic.push({ slug: p.slug, fixes: differs });
	}
	return { rerunChanges, nondeterministic };
}

// Item-level before/after is kept only for changes held back (they have no hunk)
const slimFix = (f) => ({ ...f, items: f.items.map(({ before, after, beforeIdx, ...it }) => (it.applied === false && before ? { ...it, before, after } : it)) });

function countProposals(proposals) {
	const byFix = {};
	for (const p of proposals) {
		for (const f of p.fixes) {
			const c = (byFix[f.fix] ??= { label: f.label, posts: 0, applied: 0, items: 0, needsOwner: 0, confidence: { high: 0, medium: 0, low: 0 }, errors: 0 });
			c.posts++;
			if (f.applied) c.applied++;
			if (f.error) c.errors++;
			for (const it of f.items) {
				if (it.status === "needs-owner") c.needsOwner++;
				else {
					c.items++;
					c.confidence[it.confidence] = (c.confidence[it.confidence] ?? 0) + 1;
				}
			}
			c.needsOwner += f.needsOwner.length;
		}
	}
	return { posts: proposals.length, byFix };
}

function printSummary(report) {
	log("\nProposals by fix (posts · items · high/medium/low · needs the owner):");
	for (const fix of FIXES) {
		const c = report.counts.byFix[fix.id];
		if (!c) continue;
		log(`  ${fix.id.padEnd(10)} ${String(c.posts).padStart(4)} posts  ${String(c.items).padStart(4)} items  ${c.confidence.high}/${c.confidence.medium}/${c.confidence.low}  ${c.needsOwner} for the owner${c.errors ? `  ${c.errors} ERRORS` : ""}`);
	}
	if (report.verification) {
		log("\nText match against WordPress (audit normalisation), before → after:");
		for (const [fix, v] of Object.entries(report.verification.byFix)) log(`  ${fix.padEnd(10)} ${v.summary}`);
	}
	log(`\nWordPress/other requests: ${JSON.stringify(report.requests)}`);
}

// ---------------------------------------------------------------- apply

async function applyMode() {
	const proposalsFile = opt("proposals", join(OUT_DIR, "proposals.approved.json"));
	if (!existsSync(proposalsFile)) {
		throw new Error(`No approved proposals at ${proposalsFile}. Run the dry run, have the owner review preview.html, then copy proposals.json to proposals.approved.json (or pass --proposals <file>).`);
	}
	const approved = JSON.parse(await readFile(proposalsFile, "utf8"));
	const bySlug = new Map(approved.proposals.map((p) => [`${p.collection}:${p.slug}`, p]));

	const { api, listAll, collect } = clientFor(TARGET);
	announce(TARGET, "fix-content");
	log(`  approved proposals: ${proposalsFile} (${approved.proposals.length} posts, generated ${approved.generatedAt})`);

	// The target's own media library and upload redirects
	const mediaItems = (await collect("/media")).map((m) => ({ id: m.id, filename: m.filename, storageKey: m.storageKey ?? m.storage_key ?? String(m.url ?? "").split("/").pop(), width: m.width, height: m.height, alt: m.alt, size: m.size, mime: m.mimeType ?? m.mime_type }));
	const redirects = await collect("/redirects");
	const media = new MediaIndex(mediaItems, redirects, TARGET.target);
	const ctx = { ...(await baseContext()), media };
	log(`  ${media.items.length} media items, ${redirects.length} redirects on the target`);

	const applyLog = [];
	let done = 0;
	for (const collection of CONFIG.collections) {
		for await (const row of listAll(collection, { status: "published" })) {
			if (done >= LIMIT) break;
			const proposal = bySlug.get(`${collection}:${row.slug}`);
			if (!proposal || (SLUGS && !SLUGS.has(row.slug))) continue;
			const { item, _rev } = await api(`/content/${collection}/${row.id}`);
			const entry = { collection, id: row.id, slug: row.slug, status: item.status ?? "published", title: item.data?.title ?? row.title, content: item.data?.content ?? [] };
			const run = await runPipeline(entry, ctx);
			const appliedFixes = run.results.filter((r) => r.applied);
			if (!appliedFixes.length) {
				applyLog.push({ slug: row.slug, result: "nothing to do (already applied)" });
				continue;
			}
			// Each change must be the one the owner approved
			const approvedSig = new Map(proposal.fixes.filter((f) => f.applied).map((f) => [f.fix, f.signature]));
			const drift = appliedFixes.filter((r) => approvedSig.get(r.fix) !== r.signature);
			if (drift.length) {
				log(`  ! ${row.slug}: ${drift.map((d) => d.fix).join(", ")} differ from the approved proposal; skipped`);
				applyLog.push({ slug: row.slug, result: "skipped: differs from proposal", fixes: drift.map((d) => d.fix) });
				continue;
			}
			if (!TARGET.apply) throw new Error("internal: write attempted without --apply");
			const data = {};
			if (appliedFixes.some((r) => r.hunks?.length)) data.content = run.content;
			if (run.title !== entry.title) data.title = run.title;
			if (Object.keys(data).length) {
				await api(`/content/${collection}/${row.id}`, { method: "PUT", body: JSON.stringify({ data, _rev }) });
				if (!run.unpublish) await api(`/content/${collection}/${row.id}/publish`, { method: "POST", body: "{}" });
			}
			if (run.unpublish) await api(`/content/${collection}/${row.id}/unpublish`, { method: "POST", body: "{}" });
			done++;
			log(`  fixed ${row.slug} (${appliedFixes.map((r) => r.fix).join(", ")})`);
			applyLog.push({ slug: row.slug, result: "applied", fixes: appliedFixes.map((r) => r.fix) });
		}
	}
	await mkdir(OUT_DIR, { recursive: true });
	const file = join(OUT_DIR, `apply-${TARGET.target}-${new Date().toISOString().replace(/[:.]/g, "-")}.json`);
	await writeFile(file, JSON.stringify(applyLog, null, 2));
	log(`Applied to ${done} entries. Log: ${file}`);
}

if (APPLY) await applyMode();
else await dryRun();
