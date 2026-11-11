#!/usr/bin/env node
/**
 * Bring a WordPress site's approved, non-spam comments into EmDash, keeping
 * each one's author name, date, threading and approval (gotcha A13).
 *
 *   node import-comments.mjs                                  dry run: preview.html + plan.json
 *   node import-comments.mjs --offline                        dry run without asking the site which posts exist
 *   node import-comments.mjs --apply --target local|staging   import, verify, write the author-links file
 *     --feed-url https://… --feed-port 8787                   use your own tunnel instead of cloudflared
 *     --verbose                                               one line per comment
 *
 * How it writes: EmDash 1.4 has no API to create a comment with its original
 * date (the public endpoint stamps "now" and moderates; the admin API only
 * moderates; `emdash site import` needs an empty site). The exporter import
 * does keep dates, so this script plays the EmDash Exporter plugin: it serves
 * the filtered comments from a short-lived local feed behind a random token,
 * reachable through a Cloudflare quick tunnel, and asks the site to import them
 * (POST /_emdash/api/import/wordpress-plugin/execute, phase "comments"). See
 * lib/comments/feed.mjs.
 *
 * What EmDash keeps: author name, email (admin only, for moderation; never
 * rendered), body as plain text, date, status, and one level of replies
 * (deeper replies hang under their top-level comment). What it doesn't: the
 * author URL (EmDash 1.4 has no column for it) and the WordPress comment ID.
 * Both go to a JSON file the site's comment template reads (comments.extrasFile,
 * keyed by date and name): the URL links the author's name, the ID keeps old
 * #comment-<id> anchors working. Re-runs recognise imported comments by
 * post + date (+ name), on every status, trash included.
 *
 * Config: comments.* in migration.config.json (references/configuration.md).
 * Output: <paths.work>/comments/ preview.html, plan.json, ledger.<target>.json;
 * with --apply, the extras file in the site.
 */
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";
import { announce, clientFor, parseArgs, resolveTarget } from "./lib/cli.mjs";
import { startFeed } from "./lib/comments/feed.mjs";
import { hostOf, makeFilter } from "./lib/comments/filter.mjs";
import { renderPreview } from "./lib/comments/preview.mjs";
import { readWxrComments, slugKeys } from "./lib/comments/read.mjs";
import { CONFIG, entryPath, requireConfig } from "./lib/config.mjs";

requireConfig("sites.wordpress");
const args = parseArgs(["target", "feed-url", "feed-port"]);
const offline = args.flag("offline");
const verbose = args.flag("verbose");
const target = resolveTarget(args, { needsApi: !offline });
if (offline && target.apply) throw new Error("--offline is for dry runs: --apply has to check the site's posts");
const opts = CONFIG.comments;
const outDir = join(CONFIG.paths.work, "comments");
const extrasFile = resolve(CONFIG.paths.root, opts.extrasFile);

const client = offline ? null : clientFor(target);
if (offline) console.log(`import-comments: --offline dry run (the site isn't asked which posts exist)`);
else announce(target, "import-comments");

// ------------------------------------------------------------ read
const { posts, comments } = await readWxrComments(CONFIG.paths.wxr, { timeZone: CONFIG.site.timeZone });
console.log(`${comments.length} comments in ${relative(process.cwd(), CONFIG.paths.wxr)} (${comments.filter((c) => c.approved === "1").length} approved)`);

const collectionsInUse = [...new Set(comments.map((c) => CONFIG.content.postTypes[posts.get(c.postWpId)?.type]).filter(Boolean))];
const entries = new Map();
if (!offline) {
	for (const collection of collectionsInUse) {
		const bySlug = new Map();
		for await (const row of client.listAll(collection)) for (const k of slugKeys(row.slug)) bySlug.set(k, { id: row.id, slug: row.slug, status: row.status });
		entries.set(collection, bySlug);
	}
}
const entryFor = (post) => {
	const collection = post ? CONFIG.content.postTypes[post.type] ?? null : null;
	if (!collection) return { collection: null, entry: null };
	if (offline) return { collection, entry: undefined };
	const map = entries.get(collection);
	return { collection, entry: slugKeys(post.slug).map((k) => map?.get(k)).find(Boolean) ?? null };
};

// ------------------------------------------------------------ decide
const ownHosts = new Set([...CONFIG.hosts.wordpress, hostOf(CONFIG.sites.final), hostOf(CONFIG.sites.staging)].filter(Boolean).map((h) => h.replace(/^www\./, "")));
const filter = makeFilter({ ...opts, ownHosts });
const decisions = filter.classify(comments, posts, entryFor);
const byId = new Map(decisions.map((d) => [d.c.wpId, d]));
const kept = decisions.filter((d) => d.status === "import");
for (const d of kept) d.link = filter.authorLink(d);

// What's already on the target, on every status (a trashed import stays trashed)
const existingIndex = new Map();
if (!offline) await loadExisting();
async function loadExisting() {
	existingIndex.clear();
	for (const collection of collectionsInUse) {
		for (const status of ["approved", "pending", "spam", "trash"]) {
			for (const row of await client.collect("/admin/comments", { status, collection })) {
				const key = `${row.contentId}|${row.createdAt}`;
				if (!existingIndex.has(key)) existingIndex.set(key, []);
				existingIndex.get(key).push(row);
			}
		}
	}
}
const findExisting = (d) => {
	if (!d.entry) return null;
	const list = existingIndex.get(`${d.entry.id}|${d.c.date}`) ?? [];
	return list.length === 1 ? list[0] : (list.find((r) => r.authorName === d.name) ?? list.find((r) => r.authorName === d.c.author) ?? null);
};
for (const d of kept) d.existing = findExisting(d);

// Feed IDs: parents before children (the importer threads in ID order)
const children = new Map();
const roots = [];
for (const d of kept) {
	if (d.parentWpId && byId.get(d.parentWpId)?.status === "import") {
		if (!children.has(d.parentWpId)) children.set(d.parentWpId, []);
		children.get(d.parentWpId).push(d);
	} else roots.push(d);
}
let nextFeedId = 1;
const visit = (d) => {
	d.feedId = nextFeedId++;
	for (const k of children.get(d.c.wpId) ?? []) visit(k);
};
roots.sort((a, b) => (a.c.date ?? "").localeCompare(b.c.date ?? "") || a.c.wpId - b.c.wpId).forEach(visit);
const rootOf = (d) => (d.parentWpId && byId.get(d.parentWpId)?.status === "import" ? rootOf(byId.get(d.parentWpId)) : d);

// ------------------------------------------------------------ report
const excluded = decisions.filter((d) => d.status === "exclude");
const byCategory = {};
for (const d of excluded) byCategory[d.category] = (byCategory[d.category] ?? 0) + 1;
const counts = {
	importComments: kept.filter((d) => !d.ping).length,
	importPings: kept.filter((d) => d.ping).length,
	excluded: excluded.length,
	existing: kept.filter((d) => d.existing).length,
	byCategory,
};
// What EmDash can't store, for the site's comment template: keyed by date and name
const extras = Object.fromEntries(
	[...kept]
		.sort((a, b) => a.c.date.localeCompare(b.c.date) || a.c.wpId - b.c.wpId)
		.map((d) => [`${d.c.date}|${d.name}`, { wp: d.c.wpId, ...(d.link ? { url: d.link } : {}), ...(d.ping ? { type: d.c.type } : {}) }]),
);
const linkCount = kept.filter((d) => d.link).length;

await mkdir(outDir, { recursive: true });
const siteUrl = target.url || CONFIG.sites.local;
await writeFile(
	join(outDir, "preview.html"),
	renderPreview({
		title: CONFIG.site.name || hostOf(CONFIG.sites.wordpress),
		generated: new Date().toISOString().replace("T", " ").slice(0, 16) + " UTC",
		target: target.target,
		checkedTarget: !offline,
		decisions,
		counts,
		siteUrl,
		entryPath,
		locale: CONFIG.site.locale,
		timeZone: CONFIG.site.timeZone,
		extrasFile: relative(CONFIG.paths.root, extrasFile),
		owners: opts.trustedAuthors,
	}),
);
const planRow = (d) => ({
	wpId: d.c.wpId,
	post: d.post ? `${d.collection ?? d.post.type}:${d.post.slug}` : null,
	type: d.c.type,
	author: d.name,
	date: d.c.date,
	parentWpId: d.c.parentWpId,
	...(d.status === "import" ? { threadUnder: d.parentWpId, link: d.link, already: Boolean(d.existing) } : { category: d.category, reason: d.reason }),
	score: d.score,
	signals: d.signals.map((s) => `+${s.points} ${s.text}`),
	notes: d.notes,
});
await writeFile(join(outDir, "plan.json"), `${JSON.stringify({ generated: new Date().toISOString(), target: offline ? null : target.target, counts, import: kept.map(planRow), excluded: excluded.map(planRow) }, null, "\t")}\n`);

if (verbose) {
	for (const d of decisions) console.log(`  #${d.c.wpId} ${d.status === "import" ? (d.existing ? "have" : "ADD ") : "skip"} ${d.name.slice(0, 28).padEnd(28)} ${d.status === "import" ? d.notes.join("; ") : `${d.category}: ${d.reason}`}${d.signals.length ? ` [${d.signals.map((s) => `${s.code}+${s.points}`).join(" ")}]` : ""}`);
}
console.log(`import: ${counts.importComments} comments, ${counts.importPings} pingbacks/trackbacks (threads: ${kept.filter((d) => d.parentWpId).length} replies)`);
console.log(`left out: ${counts.excluded} — ${Object.entries(byCategory).map(([k, v]) => `${k} ${v}`).join(", ")}`);
if (!offline) console.log(`already on ${target.target}: ${counts.existing} of ${kept.length}`);
console.log(`preview: ${relative(process.cwd(), join(outDir, "preview.html"))}  (plan.json beside it)`);

const toImport = kept.filter((d) => !d.existing);
if (!target.apply) {
	if (!offline) console.log(`would import ${toImport.length} to ${target.target}, and write ${Object.keys(extras).length} entries (${linkCount} author links) to ${relative(process.cwd(), extrasFile)}`);
	process.exit(0);
}

// ------------------------------------------------------------ apply
let result = { imported: 0, skipped: 0, errors: [] };
if (toImport.length) {
	const items = toImport
		.sort((a, b) => a.feedId - b.feedId)
		.map((d) => {
			const parent = d.parentWpId && byId.get(d.parentWpId)?.status === "import" ? byId.get(d.parentWpId) : null;
			return {
				id: d.feedId,
				post_id: d.c.postWpId,
				parent_id: parent ? parent.feedId : null,
				author_name: d.name,
				author_email: opts.keepEmails ? d.c.email : "",
				body: d.c.text,
				date_gmt: d.c.date,
				status: "approved",
			};
		});
	const idMap = {};
	for (const d of kept) idMap[String(d.c.postWpId)] = { id: d.entry.id, collection: d.collection };
	let commentRoots = {};
	for (const d of kept) if (d.existing) commentRoots[String(d.feedId)] = d.existing.parentId ?? d.existing.id;
	const postTypeMappings = Object.fromEntries(Object.entries(CONFIG.content.postTypes).map(([type, collection]) => [type, { collection, enabled: true }]));

	const feed = await startFeed(items, { pageSize: opts.pageSize, publicUrl: args.opt("feed-url"), port: args.opt("feed-port"), log: console.log });
	try {
		let page = 1;
		for (;;) {
			const body = JSON.stringify({ url: feed.url, token: feed.token, config: { postTypeMappings }, phase: "comments", cursor: { postTypeIndex: 0, page }, idMap, commentRoots });
			const chunk = await withRetry(() => client.api("/import/wordpress-plugin/execute", { method: "POST", body }), `comments page ${page}`);
			const r = chunk.result ?? {};
			result.imported += r.comments?.imported ?? 0;
			result.skipped += r.comments?.skipped ?? 0;
			result.errors.push(...(r.errors ?? []));
			commentRoots = { ...commentRoots, ...(chunk.chunk?.commentRoots ?? {}) };
			console.log(`  page ${page}: imported ${r.comments?.imported ?? 0}, skipped ${r.comments?.skipped ?? 0}${r.errors?.length ? `, ${r.errors.length} errors` : ""}`);
			if (chunk.done || !chunk.cursor) break;
			page = chunk.cursor.page;
		}
		if (!feed.requests.some((q) => q.ok)) throw new Error("The site never fetched the feed: nothing was imported");
	} finally {
		await feed.close();
	}
	for (const e of result.errors) console.log(`  error: ${e.title}: ${e.error}`);
}

// Verify: every kept comment is there, under the right parent
await loadExisting();
const ledger = [];
let missing = 0;
let wrongParent = 0;
for (const d of kept.sort((a, b) => a.feedId - b.feedId)) {
	const row = findExisting(d);
	if (!row) {
		missing++;
		console.log(`  missing after import: #${d.c.wpId} ${d.name} on ${d.post.slug}`);
		continue;
	}
	d.existing = row;
	const root = rootOf(d);
	const expectedParent = root === d ? null : (root.existing?.id ?? "?");
	if ((row.parentId ?? null) !== expectedParent) {
		wrongParent++;
		console.log(`  thread differs: #${d.c.wpId} has parent ${row.parentId ?? "none"}, expected ${expectedParent ?? "none"}`);
	}
	ledger.push({ wpId: d.c.wpId, emdashId: row.id, collection: d.collection, slug: d.entry.slug, parentWpId: d.c.parentWpId, threadUnderWpId: root === d ? null : root.c.wpId, emdashParentId: row.parentId ?? null, status: row.status });
}
await writeFile(join(outDir, `ledger.${target.target}.json`), `${JSON.stringify(ledger, null, "\t")}\n`);
await mkdir(dirname(extrasFile), { recursive: true });
await writeFile(extrasFile, `${JSON.stringify(extras, null, "\t")}\n`);

console.log(`imported ${result.imported} now (${result.skipped} skipped by EmDash as already there), ${result.errors.length} errors`);
console.log(`on ${target.target}: ${ledger.length} of ${kept.length} kept comments present, ${missing} missing, ${wrongParent} threaded differently`);
console.log(`extras: ${Object.keys(extras).length} entries, ${linkCount} with author links → ${relative(process.cwd(), extrasFile)} (commit it with the site)`);
console.log(`ledger: ${relative(process.cwd(), join(outDir, `ledger.${target.target}.json`))}`);
if (target.target === "staging") console.log("Cached post pages don't change until the page cache is purged: deploy (the template Worker purges on a new version) or purge the zone.");
if (missing || wrongParent || result.errors.length) process.exitCode = 1;

async function withRetry(fn, label, tries = 5) {
	for (let i = 1; ; i++) {
		try {
			return await fn();
		} catch (err) {
			// 4xx (bad request, auth) won't get better; 5xx and network errors can (a tunnel still warming up)
			if (i >= tries || / -> 4\d\d:/.test(err.message)) throw err;
			console.log(`  ${label}: ${err.message.slice(0, 160)} (retrying in ${5 * i}s)`);
			await new Promise((r) => setTimeout(r, 5000 * i));
		}
	}
}
