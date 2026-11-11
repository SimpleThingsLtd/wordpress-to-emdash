#!/usr/bin/env node
/**
 * Audits the WordPress → EmDash migration for lost content. Read-only: it
 * changes nothing on either site.
 *
 * Old side: what visitors saw on the live WordPress site (REST content.rendered,
 * the sitemaps, and the live pages in a headless browser for embeds).
 * New side: the pages the EmDash staging site renders (its sitemap and the
 * content element of each page, newSite.selectors.content).
 *
 *   node compare-sites.mjs [--refresh] [--refresh-old] [--refresh-ext] [--offline]
 *        [--only slug,slug] [--no-browser-checks] [--no-shots] [--shots 10] [--no-html]
 *
 *   --refresh            refetch new-site pages and probes (WordPress stays cached)
 *   --refresh-old        refetch WordPress responses too (rarely: be kind to the server)
 *   --refresh-ext        recheck third-party image URLs
 *   --offline            use only cached responses; anything uncached counts as unreachable
 *   --only a,b           compare just these slugs (skips the URL-pattern tests)
 *   --no-browser-checks  skip the live-page embed checks
 *   --shots N            side-by-side screenshots of the N worst pages (default audit.shots)
 *   --no-shots           skip screenshots
 *   --no-html            skip writing report.html
 *   --render-only        rebuild report.html from the last report.json, no fetching
 *
 * Writes <paths.compare>/report.json (every finding), summary.md (ranked),
 * shots/ and report.html. Responses are cached under <paths.compareCache>.
 * WordPress never gets more than http.concurrency.wordpress (4) requests in
 * flight, including the browser's.
 *
 * Hosts, selectors, routes, old permalink bases, replaced and listing pages,
 * extra URL tests and known-noise rules all come from migration.config.json.
 * The audit assumes the new site serves each post and page at the same path
 * as WordPress did.
 *
 * Playwright is optional. Without it the inventory, page-status, sitemap and
 * URL-pattern checks still run; the page-by-page comparison, live embed
 * checks and screenshots are skipped with a message. It's loaded from the
 * project's node_modules or paths.tools:
 *   npm install --prefix .migration/tools playwright-core
 * sharp, when installed, joins each screenshot pair into one image.
 */
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { parseArgs } from "./lib/cli.mjs";
import { CONFIG, isWordPressHost, requireConfig, wordpressHostPattern } from "./lib/config.mjs";
import { analyse, codeNorm, compareCode, diffParagraphs, gluedParagraphs, hostType, LINK_TRAILER, liveEmbeds, missingTexts, selectorsFromConfig, shingles, sq, tokens, wc } from "./lib/compare-core.mjs";
import { launchBrowser, loadPlaywright, loadSharp, PLAYWRIGHT_HINT } from "./lib/optional.mjs";
import { decodeEntities } from "./lib/wxr.mjs";

const args = parseArgs(["only", "shots"]);
const flag = args.flag;
const opt = args.opt;
const RENDER_ONLY = flag("render-only");
if (!RENDER_ONLY) requireConfig("sites.wordpress", "sites.staging");

const OLD = CONFIG.sites.wordpress;
const NEW = CONFIG.sites.staging;
const NEW_HOST = CONFIG.hosts.staging;
const OLD_HOST = [...CONFIG.hosts.wordpress][0];
const CACHE = CONFIG.paths.compareCache;
const OUT = CONFIG.paths.compare;
const SHOTS = join(OUT, "shots");
const WXR = CONFIG.paths.wxr;
const UA = `${CONFIG.http.userAgent} migration-audit`;
const SEL = selectorsFromConfig();
const LP = CONFIG.linkPosts;
// The owner's choices for fix-content (decisions.json): an embed or script handled as decided isn't a loss
let DECISIONS = {};
const decisionFor = (slug, fix, type) => DECISIONS[`${slug}:${fix}:${type}`] ?? (fix === "embeds" ? DECISIONS[`provider:${type}`] : undefined) ?? null;
// import-comments.mjs's plan, once it has run: how many comments each page should show
let COMMENT_PLAN = null;
const slugKey = (s) => {
	try {
		return decodeURIComponent(s).toLowerCase();
	} catch {
		return String(s).toLowerCase();
	}
};

async function loadCommentPlan() {
	const plan = JSON.parse(await readFile(join(CONFIG.paths.work, "comments", "plan.json"), "utf8").catch(() => "null"));
	if (!Array.isArray(plan?.import)) return null;
	const perPost = new Map();
	for (const c of plan.import) {
		const key = slugKey(String(c.post).split(":").slice(1).join(":"));
		perPost.set(key, (perPost.get(key) ?? 0) + 1);
	}
	return { generated: plan.generated ?? null, counts: plan.counts ?? {}, total: plan.import.length, perPost };
}

const REFRESH = flag("refresh");
const REFRESH_OLD = flag("refresh-old");
const REFRESH_EXT = flag("refresh-ext");
const OFFLINE = flag("offline");
const ONLY = args.list("only") ? new Set(args.list("only")) : null;
const BROWSER_CHECKS = !flag("no-browser-checks");
const SHOT_COUNT = flag("no-shots") ? 0 : Number(opt("shots", String(CONFIG.audit.shots)));
const WRITE_HTML = !flag("no-html");
if (OFFLINE && (REFRESH || REFRESH_OLD || REFRESH_EXT)) throw new Error("--offline can't be combined with --refresh flags");

const log = (...a) => console.log(...a);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const sha = (s) => createHash("sha1").update(s).digest("hex");

// ---------------------------------------------------------------- fetching

function limiter(max) {
	let active = 0;
	const queue = [];
	const next = () => {
		if (active >= max || !queue.length) return;
		active++;
		const { fn, res, rej } = queue.shift();
		Promise.resolve()
			.then(fn)
			.then(res, rej)
			.finally(() => {
				active--;
				next();
			});
	};
	return (fn) =>
		new Promise((res, rej) => {
			queue.push({ fn, res, rej });
			next();
		});
}
const C = CONFIG.http.concurrency;
const LIMIT = { old: limiter(C.wordpress), new: limiter(C.new), ext: limiter(C.external) };
const stats = { old: 0, new: 0, ext: 0, cached: 0, offlineMisses: 0 };
const KEEP_HEADERS = ["content-type", "location", "x-wp-total", "x-wp-totalpages", "content-length"];

const hostOf = (u) => {
	try {
		return new URL(u).hostname.toLowerCase();
	} catch {
		return "";
	}
};
const kindFor = (u) => (hostOf(u) === NEW_HOST ? "new" : isWordPressHost(hostOf(u)) ? "old" : "ext");

async function rawFetch(url, method, wantBody) {
	try {
		const res = await fetch(url, {
			method,
			redirect: "manual",
			headers: { "user-agent": UA, accept: "text/html,application/json,application/xml,image/*,*/*;q=0.8" },
			signal: AbortSignal.timeout(45000),
		});
		const headers = {};
		for (const h of KEEP_HEADERS) {
			const v = res.headers.get(h);
			if (v) headers[h] = v;
		}
		let body = null;
		if (wantBody && method !== "HEAD") body = await res.text();
		else await res.body?.cancel().catch(() => {});
		return { url, method, status: res.status, headers, body };
	} catch (err) {
		return { url, method, status: 0, headers: {}, body: null, error: String(err?.cause?.code ?? err?.name ?? err) };
	}
}

/** One request, no redirect following, cached on disk. */
async function request(url, { method = "GET", body = true } = {}) {
	const kind = kindFor(url);
	const key = sha(`${method} ${body ? "body" : "head"} ${url}`);
	const file = join(CACHE, kind, key.slice(0, 2), `${key}.json`);
	const fresh = (kind === "new" && REFRESH) || (kind === "old" && REFRESH_OLD) || (kind === "ext" && REFRESH_EXT);
	if (!fresh) {
		try {
			const hit = JSON.parse(await readFile(file, "utf8"));
			stats.cached++;
			return hit;
		} catch {}
	}
	if (OFFLINE) {
		stats.offlineMisses++;
		return { url, method, status: 0, headers: {}, body: null, error: "offline (not cached)" };
	}
	const tries = kind === "new" ? 5 : kind === "old" ? 3 : 2;
	let result;
	for (let attempt = 0; attempt < tries; attempt++) {
		result = await LIMIT[kind](() => rawFetch(url, method, body));
		stats[kind]++;
		const transient = result.status === 0 || result.status >= 500 || result.status === 429;
		if (!transient) break;
		if (attempt < tries - 1) await sleep([2000, 5000, 10000, 20000][attempt]);
	}
	const transient = result.status === 0 || result.status >= 500 || result.status === 429;
	if (!transient || kind === "ext") {
		await mkdir(dirname(file), { recursive: true });
		await writeFile(file, JSON.stringify(result));
	}
	return result;
}

/** Follows redirects hop by hop (each hop cached) and reports the chain. */
async function chain(url, { method = "GET", body = true, maxHops = 6 } = {}) {
	const hops = [];
	let current = url;
	for (let i = 0; i <= maxHops; i++) {
		const r = await request(current, { method, body });
		hops.push({ url: current, status: r.status, ...(r.error ? { error: r.error } : {}) });
		const loc = r.headers?.location;
		if (r.status >= 300 && r.status < 400 && loc) {
			current = new URL(loc, current).href;
			continue;
		}
		return { start: url, final: current, status: r.status, hops, res: r };
	}
	return { start: url, final: current, status: -1, hops, res: null };
}

/** Status of a resource: HEAD, then GET if HEAD isn't allowed. */
async function probe(url) {
	let c = await chain(url, { method: "HEAD", body: false });
	if ([0, 400, 403, 404, 405, 501].includes(c.status)) {
		const g = await chain(url, { method: "GET", body: false });
		if (g.status !== 0 || c.status === 0) c = g;
	}
	return { status: c.status, final: c.final, type: c.res?.headers?.["content-type"] ?? null, hops: c.hops.length - 1 };
}

const swapHost = (u, host) => {
	const x = new URL(u);
	x.protocol = "https:";
	x.hostname = host;
	x.port = "";
	return x.href;
};
const toNew = (u) => {
	// A local staging URL (http://localhost:4321) keeps its scheme and port
	const n = new URL(NEW);
	if (n.protocol === "https:" && !n.port) return swapHost(u, NEW_HOST);
	const x = new URL(u);
	x.protocol = n.protocol;
	x.hostname = n.hostname;
	x.port = n.port;
	return x.href;
};
const toOld = (u) => swapHost(u, OLD_HOST);
function pathKey(u) {
	try {
		const p = new URL(u, OLD).pathname;
		let d;
		try {
			d = decodeURIComponent(p);
		} catch {
			d = p;
		}
		return d.toLowerCase().replace(/\/+$/, "") || "/";
	} catch {
		return u;
	}
}
const slugOf = (k) => (k.includes(":") ? k.split(":").slice(1).join(":") : k);

async function mapLimit(items, n, fn) {
	const out = new Array(items.length);
	let i = 0;
	await Promise.all(
		Array.from({ length: Math.min(n, items.length) }, async () => {
			while (i < items.length) {
				const k = i++;
				out[k] = await fn(items[k], k);
			}
		}),
	);
	return out;
}

// ------------------------------------------------------------ inventories

async function wpCollection(path, fields) {
	const all = [];
	let page = 1;
	let pages = 1;
	do {
		const url = `${OLD}/wp-json/wp/v2/${path}?per_page=100&page=${page}${fields ? `&_fields=${fields}` : ""}`;
		const r = await request(url);
		if (r.status !== 200) {
			if (page === 1) return { items: [], status: r.status };
			break;
		}
		all.push(...JSON.parse(r.body));
		pages = Number(r.headers["x-wp-totalpages"] ?? 1);
		page++;
	} while (page <= pages);
	return { items: all, status: 200 };
}

async function sitemapUrls(url, swap) {
	const r = await request(url);
	if (r.status !== 200 || !r.body) return [{ url, error: r.status }];
	const locs = [...r.body.matchAll(/<loc>\s*([^<\s]+)\s*<\/loc>/g)].map((m) => decodeEntities(m[1]));
	if (/<sitemapindex/i.test(r.body)) {
		const out = [];
		for (const child of locs) out.push(...(await sitemapUrls(swap ? toNew(child) : child, swap)));
		return out;
	}
	return locs.map((loc) => ({ url: loc, sitemap: url.split("/").pop() }));
}

// ------------------------------------------------------------------- main

const GROUPS = [
	{ key: "pages", title: "Missing pages and URLs" },
	{ key: "content", title: "Missing blocks and paragraphs" },
	{ key: "media", title: "Broken media, embeds and links" },
	{ key: "code", title: "Code differences" },
	{ key: "metadata", title: "Metadata" },
];
const SEVERITY = ["critical", "high", "medium", "low", "info"];
const findings = [];
let fid = 0;

/** audit.knownNoise: findings that match a rule are recorded as known (info), not counted. */
const NOISE = (CONFIG.audit.knownNoise ?? []).map((r) => ({
	kinds: r.kind === "*" ? null : new Set([].concat(r.kind ?? [])),
	slug: r.slug ? new RegExp(r.slug, "i") : null,
	path: r.path ? new RegExp(r.path, "i") : null,
	summary: r.summary ? new RegExp(r.summary, "i") : null,
	status: r.status ?? null,
	reason: r.reason ?? "Known noise (audit.knownNoise)",
}));
function noiseFor(f) {
	for (const r of NOISE) {
		if (r.kinds && !r.kinds.has(f.kind)) continue;
		if (r.slug && !r.slug.test(f.slug ?? "")) continue;
		if (r.path && !r.path.test(pathKey(f.newUrl ?? f.oldUrl ?? ""))) continue;
		if (r.summary && !r.summary.test(f.summary ?? "")) continue;
		if (r.status !== null && f.details?.status !== r.status) continue;
		return r.reason;
	}
	return null;
}
function add(f) {
	const finding = { id: `F${String(++fid).padStart(4, "0")}`, known: null, score: 1, ...f };
	const noise = !finding.known && noiseFor(finding);
	if (noise) Object.assign(finding, { known: noise, severity: "info", score: 1 });
	findings.push(finding);
}

async function main() {
	await mkdir(SHOTS, { recursive: true });
	if (RENDER_ONLY) {
		const report = JSON.parse(await readFile(join(OUT, "report.json"), "utf8"));
		report.site ??= { name: CONFIG.site.name, locale: CONFIG.site.locale ?? null, timeZone: CONFIG.site.timeZone ?? null };
		const { renderReportHtml, proposeFixes } = await import("./lib/compare-report.mjs");
		report.fixes = proposeFixes(report);
		report.history = JSON.parse(await readFile(join(OUT, "history.json"), "utf8").catch(() => "[]")).slice(-30);
		await writeFile(join(OUT, "report.html"), renderReportHtml(report));
		log(`Rendered ${join(OUT, "report.html")} from report.json`);
		return;
	}
	const started = Date.now();
	if (OFFLINE) log("Offline: using cached responses only.");

	// 1. Inventories
	log("Inventory: WordPress REST + sitemaps, EmDash sitemaps…");
	const FIELDS = "id,slug,link,date,date_gmt,modified_gmt,title,content,excerpt,categories,tags,featured_media,format,type,status,jetpack_featured_media_url";
	const EXTRA = (CONFIG.wordpress.extraPostTypes ?? []).map((t) => (typeof t === "string" ? { rest: t, kind: t } : { rest: t.rest, kind: t.kind ?? t.rest }));
	const [posts, pages, cats, tags, ...extras] = await Promise.all([
		wpCollection("posts", FIELDS),
		wpCollection("pages", FIELDS.replace("categories,tags,", "")),
		wpCollection("categories", "id,slug,name,count,link"),
		wpCollection("tags", "id,slug,name,count,link"),
		...EXTRA.map((t) => wpCollection(t.rest, FIELDS.replace("categories,tags,", ""))),
	]);
	const comments = await request(`${OLD}/wp-json/wp/v2/comments?per_page=1&_fields=id`);
	const commentTotal = Number(comments.headers?.["x-wp-total"] ?? 0) || null;
	const catById = new Map(cats.items.map((c) => [c.id, c]));
	const tagById = new Map(tags.items.map((t) => [t.id, t]));
	const dec = (s) => {
		try {
			return decodeURIComponent(s);
		} catch {
			return s;
		}
	};

	const oldSitemap = await sitemapUrls(`${OLD}${CONFIG.wordpress.sitemap}`, false);
	const newSitemap = await sitemapUrls(`${NEW}${CONFIG.newSite.sitemap}`, true);
	const extraCounts = Object.fromEntries(EXTRA.map((t, i) => [t.kind, extras[i].items.length]));
	log(`  WordPress: ${posts.items.length} posts, ${pages.items.length} pages, ${EXTRA.map((t) => `${extraCounts[t.kind]} ${t.kind}`).join(", ")}${EXTRA.length ? ", " : ""}${cats.items.length} categories, ${tags.items.length} tags, ${oldSitemap.length} sitemap URLs`);
	log(`  EmDash: ${newSitemap.length} sitemap URLs`);
	if (posts.status && posts.status !== 200) log(`  ! WordPress REST posts returned ${posts.status}`);

	const items = [
		...posts.items.map((p) => ({ ...p, kind: "post" })),
		...pages.items.map((p) => ({ ...p, kind: "page" })),
		...EXTRA.flatMap((t, i) => extras[i].items.map((p) => ({ ...p, kind: t.kind }))),
	].map((p) => {
		const slug = dec(p.slug);
		const oldUrl = p.link === `${OLD}/` ? `${OLD}/${p.slug}/` : p.link;
		return {
			id: p.id,
			kind: p.kind,
			slug,
			title: decodeEntities(p.title?.rendered ?? ""),
			oldUrl,
			frontPage: p.link === `${OLD}/`,
			newUrl: toNew(oldUrl),
			path: pathKey(oldUrl),
			date: p.date,
			dateGmt: p.date_gmt,
			categories: (p.categories ?? []).map((id) => dec(catById.get(id)?.slug ?? `#${id}`)),
			tags: (p.tags ?? []).map((id) => dec(tagById.get(id)?.slug ?? `#${id}`)),
			featured: p.featured_media > 0,
			featuredUrl: p.jetpack_featured_media_url || null,
			format: p.format,
			html: p.content?.rendered ?? "",
		};
	});

	// Deliberate replacements and listing pages (urls.replacedPages, urls.listingPages)
	const REPLACED = new Map(Object.entries(CONFIG.urls.replacedPages).map(([k, to]) => [slugOf(k), to]));
	const LISTING = new Set(Object.keys(CONFIG.urls.listingPages).map(slugOf));
	const SECTIONS = new Set((CONFIG.newSite.sections ?? []).map((s) => pathKey(s)));

	// WordPress addresses that a new section route now owns (gotcha C7)
	const collisions = items.filter((it) => SECTIONS.has(it.path) && !LISTING.has(it.slug));
	if (collisions.length) log(`  WordPress ${collisions.length === 1 ? "address" : "addresses"} owned by a new section route: ${collisions.map((c) => `${c.path}/ (${c.kind})`).join(", ")}`);

	// 2. New-site status for every old content URL
	log(`Fetching ${items.length} pages from the new site…`);
	await mapLimit(items, C.new, async (it) => {
		it.newChain = await chain(it.newUrl);
	});

	// URL inventories: only on one side
	const oldPaths = new Map();
	for (const it of items) oldPaths.set(it.path, { url: it.oldUrl, source: `rest:${it.kind}` });
	for (const s of oldSitemap) if (s.url && !oldPaths.has(pathKey(s.url))) oldPaths.set(pathKey(s.url), { url: s.url, source: s.sitemap });
	const newPaths = new Map();
	for (const s of newSitemap) if (s.url) newPaths.set(pathKey(s.url), { url: toNew(s.url), source: s.sitemap });

	const newSitemapStatus = await mapLimit([...newPaths.values()], 8, async (n) => ({ ...n, ...(await chain(n.url, { body: false })) }));
	for (const n of newSitemapStatus) {
		const finalPath = pathKey(n.final);
		if (n.status !== 200) {
			add({ group: "pages", severity: "low", kind: "sitemap-lists-non-200", oldUrl: null, newUrl: n.url, summary: `New sitemap lists ${pathKey(n.url)}, which returns ${n.status}`, details: { hops: n.hops, status: n.status } });
		} else if (finalPath !== pathKey(n.url)) {
			add({ group: "pages", severity: "low", kind: "sitemap-lists-redirect", oldUrl: null, newUrl: n.url, summary: `New sitemap lists ${pathKey(n.url)}, which redirects to ${finalPath}`, details: { hops: n.hops, status: n.status } });
		}
	}

	// 3. Page status findings
	for (const it of items) {
		const c = it.newChain;
		const finalPath = pathKey(c.final);
		it.newStatus = c.status;
		it.newFinal = c.final;
		it.redirected = c.hops.length > 1;
		const okSame = c.status === 200 && finalPath === it.path;
		it.ok = okSame;
		if (okSame) continue;
		const base = { group: "pages", slug: it.slug, title: it.title, oldUrl: it.oldUrl, newUrl: it.newUrl, details: { hops: c.hops, kind: it.kind, status: c.status } };
		if (REPLACED.has(it.slug)) {
			add({ ...base, severity: "info", kind: "page-replaced", summary: `/${it.slug}/ → ${finalPath} (${c.status})`, known: `Deliberately replaced by ${REPLACED.get(it.slug)}` });
		} else if (c.status === 200 && it.kind === "page" && LISTING.has(it.slug)) {
			add({ ...base, severity: "low", kind: "listing-page-redirect", summary: `Listing page /${it.slug}/ redirects to ${finalPath}/ (looks intended; check)`, score: 2 });
		} else if (c.status === 200) {
			add({ ...base, severity: "high", kind: "page-wrong-redirect", summary: `${it.kind} /${it.slug}/ redirects to ${finalPath}`, score: 50 });
		} else {
			add({ ...base, severity: it.kind === "post" || it.kind === "page" ? "critical" : "high", kind: "page-missing", summary: `${it.kind} “${it.title}” returns ${c.status} on the new site`, score: 100 });
		}
	}

	// Old sitemap URLs that aren't content items (taxonomies, author, archives)
	const extraOld = [...oldPaths.entries()].filter(([p, v]) => !v.source.startsWith("rest:"));
	const extraOldStatus = await mapLimit(extraOld, 8, async ([p, v]) => ({ path: p, ...v, chain: await chain(toNew(v.url), { body: false }) }));
	const onlyOld = [];
	for (const e of extraOldStatus) {
		const ok = e.chain.status === 200;
		if (!ok) onlyOld.push({ path: e.path, url: e.url, source: e.source, status: e.chain.status, final: pathKey(e.chain.final) });
	}
	const onlyNew = [...newPaths.entries()].filter(([p]) => !oldPaths.has(p)).map(([p, v]) => ({ path: p, url: v.url, source: v.source }));
	const contentNotInNewSitemap = items.filter((it) => it.ok && !newPaths.has(it.path)).map((it) => it.path);
	if (contentNotInNewSitemap.length) add({ group: "pages", severity: "low", kind: "missing-from-new-sitemap", summary: `${contentNotInNewSitemap.length} pages resolve but aren't in the new sitemap`, details: { paths: contentNotInNewSitemap } });

	// Comments planned by import-comments.mjs, if it has run (gotcha A13)
	COMMENT_PLAN = await loadCommentPlan();
	DECISIONS = JSON.parse(await readFile(CONFIG.paths.decisions, "utf8").catch(() => "{}"));
	if (COMMENT_PLAN) log(`  Comments: ${COMMENT_PLAN.total} planned by import-comments.mjs, on ${COMMENT_PLAN.perPost.size} pages`);

	// 4. Page-by-page content comparison (needs a browser)
	const pw = await loadPlaywright();
	if (!pw) log(`Playwright isn't installed: skipping the page-by-page comparison, image and link probes, live embed checks and screenshots. ${PLAYWRIGHT_HINT}`);
	const browser = pw ? await launchBrowser(pw) : null;
	const pageReports = [];
	const urlTests = [];
	let liveChecks = { old: {}, new: {} };
	const shots = [];
	const skipped = [];
	try {
		if (browser) {
			const ap = await browser.newPage();
			await ap.goto("about:blank");
			const toCompare = items.filter((it) => it.ok && (!ONLY || ONLY.has(it.slug)));
			log(`Comparing ${toCompare.length} pages…`);
			for (const it of toCompare) {
				const oldA = await ap.evaluate(analyse, { html: `<!doctype html><html><body><div id="__root">${it.html}</div></body></html>`, mode: "old", base: it.oldUrl, sel: SEL });
				const newA = await ap.evaluate(analyse, { html: it.newChain.res.body ?? "", mode: "new", base: it.newFinal, sel: SEL });
				pageReports.push(comparePage(it, oldA, newA, { LISTING, SECTIONS }));
			}

			// 5. Probes: images, internal links
			log("Checking images and internal links on the new site…");
			const imageRefs = new Map();
			const linkRefs = new Map();
			for (const pr of pageReports) {
				const srcs = [...pr.newA.images.map((i) => i.src), ...(pr.newA.meta?.featured ? [pr.newA.meta.featured] : [])];
				for (const src of srcs) {
					if (!src || src.startsWith("data:")) continue;
					if (!imageRefs.has(src)) imageRefs.set(src, []);
					imageRefs.get(src).push(pr.slug);
				}
				for (const l of pr.newA.links) {
					const href = l.href ?? "";
					if (!href || href.startsWith("#") || /^(mailto|tel|javascript|data):/i.test(href)) continue;
					const u = l.abs;
					if (!u || !/^https?:/i.test(u)) continue;
					const h = hostOf(u);
					if (!(h === NEW_HOST || isWordPressHost(h))) continue;
					const target = toNew(u.split("#")[0]);
					if (!linkRefs.has(target)) linkRefs.set(target, { slugs: new Set(), original: new Set() });
					linkRefs.get(target).slugs.add(pr.slug);
					linkRefs.get(target).original.add(href);
				}
			}
			const imgResults = new Map();
			await mapLimit([...imageRefs.keys()], C.new, async (src) => {
				const onOld = isWordPressHost(hostOf(src));
				const testUrl = onOld ? toNew(src) : src;
				imgResults.set(src, { onOld, testUrl, ...(await probe(testUrl)) });
			});
			const linkResults = new Map();
			await mapLimit([...linkRefs.keys()], 8, async (u) => {
				linkResults.set(u, await probe(u));
			});
			// Was a broken link already broken on WordPress?
			const brokenLinks = [...linkResults.entries()].filter(([, r]) => r.status === 404 || r.status === 410 || r.status === 0);
			await mapLimit(brokenLinks, C.wordpress, async ([u, r]) => {
				r.oldStatus = (await probe(toOld(u))).status;
			});

			for (const pr of pageReports) finishPage(pr, imgResults, linkResults, linkRefs);

			// Old images the new page doesn't have: did they display on WordPress?
			const oldImgChecks = pageReports.flatMap((pr) => (pr.unmatchedOldImages ?? []).map((src) => ({ pr, src })));
			await mapLimit(oldImgChecks, C.wordpress, async (x) => {
				x.result = await probe(x.src);
			});
			for (const pr of pageReports) imageFindings(pr, oldImgChecks.filter((x) => x.pr === pr));
		} else skipped.push("page comparison", "image and link probes");

		// 6. Old URL patterns
		if (!ONLY) urlTests.push(...(await runUrlTests(items, cats.items, tags.items, oldSitemap)));

		// 7. Live embed checks (what actually displayed)
		if (browser && BROWSER_CHECKS) liveChecks = await runLiveChecks(browser, pageReports);
		else if (BROWSER_CHECKS) skipped.push("live embed checks");
		for (const pr of pageReports) embedFindings(pr, liveChecks);

		// Page scores and findings bookkeeping
		for (const pr of pageReports) {
			pr.score = findings.filter((f) => f.slug === pr.slug && !f.known).reduce((s, f) => s + (f.score ?? 1), 0);
		}

		// 8. Screenshots of the worst pages
		if (SHOT_COUNT > 0 && browser) {
			const worst = [...pageReports].sort((a, b) => b.score - a.score).filter((p) => p.score > 0).slice(0, SHOT_COUNT);
			shots.push(...(await takeShots(browser, worst)));
		} else if (SHOT_COUNT > 0) skipped.push("screenshots");
	} finally {
		await browser?.close();
	}

	// URL test findings
	for (const t of urlTests) {
		if (t.pass) continue;
		add({
			group: "pages",
			severity: t.severity,
			kind: `pattern-${t.group}`,
			oldUrl: t.oldUrl,
			newUrl: t.url,
			summary: `${t.label}: ${t.result}`,
			details: { hops: t.hops, expect: t.expect, status: t.status },
			score: t.severity === "high" ? 20 : t.severity === "medium" ? 8 : 2,
			...(t.oldStatus ? { known: `Already ${t.oldStatus} on WordPress`, severity: "info", score: 1 } : {}),
		});
	}

	// Comments: in the WXR, but EmDash's WXR import doesn't bring them (gotcha A13)
	const wxrText = await readFile(WXR, "utf8").catch(() => "");
	const approved = [...wxrText.matchAll(/<wp:comment>([\s\S]*?)<\/wp:comment>/g)].map((m) => m[1]).filter((c) => /<wp:comment_approved>(?:<!\[CDATA\[)?1/.test(c));
	const pings = approved.filter((c) => /<wp:comment_type>(?:<!\[CDATA\[)?(pingback|trackback)/.test(c)).length;
	const commentsAccepted = CONFIG.audit.commentsAccepted;
	if (COMMENT_PLAN) {
		const counted = pageReports.filter((p) => p.comments);
		const shown = counted.reduce((n, p) => n + p.comments.shown, 0);
		const expected = counted.reduce((n, p) => n + p.comments.expected, 0);
		const left = Object.entries(COMMENT_PLAN.counts.byCategory ?? {}).map(([k, v]) => `${k} ${v}`).join(", ");
		add({
			group: "content",
			severity: "info",
			kind: "comments-imported",
			summary: `${COMMENT_PLAN.total} of ${approved.length} approved comments and pingbacks planned for import by import-comments.mjs; ${counted.length ? `${shown} of the ${expected} expected on the compared pages are shown` : "not counted on the pages (needs Playwright and newSite.selectors.comment)"}${left ? `. Left out: ${left}` : ""}`,
			known: "Reviewed in comments/preview.html and imported with import-comments.mjs; a page short of its comments is a comments-missing finding",
			details: { planned: COMMENT_PLAN.total, planGenerated: COMMENT_PLAN.generated, leftOut: COMMENT_PLAN.counts.byCategory ?? {}, pagesCounted: counted.length, expected, shown, wxrApproved: approved.length, wxrPings: pings, restTotal: commentTotal },
		});
	} else if (approved.length || commentTotal) {
		add({
			group: "content",
			severity: commentsAccepted ? "info" : "medium",
			kind: "comments-not-imported",
			summary: `${approved.length - pings} approved comments and ${pings} pingbacks or trackbacks (${approved.length} approved in all) were not imported; the REST API counts ${commentTotal ?? "?"} comments`,
			known: commentsAccepted || null,
			details: { restTotal: commentTotal, wxrApproved: approved.length, wxrPings: pings, note: commentsAccepted ? undefined : "Record the owner's decision in audit.commentsAccepted, or bring the comments across another way" },
			score: commentsAccepted ? 1 : 5,
		});
	}
	const wxrNote = shortcodeNote(wxrText);
	add({ group: "content", severity: "info", kind: "shortcodes-in-export", summary: wxrNote.summary, known: "Inventory note: shortcodes in the export", details: wxrNote });

	// Findings the owner already decided in decisions.json: an embed shown as a card, an image or
	// quoted text, or left out (not "html", which should still play); a script shown as code or removed
	for (const f of findings) {
		if (f.known || !f.slug) continue;
		const embed = ["embed-lost", "embed-degraded"].includes(f.kind) && f.details?.type ? decisionFor(f.slug, "embeds", f.details.type) : null;
		const script = ["code-shown-as-text", "tables-missing", "markup-visible"].includes(f.kind) ? decisionFor(f.slug, "code", "script-text") : null;
		const decided = embed && embed !== "html" ? `embed: ${embed}` : script ? `script: ${script}` : null;
		// `decided` keeps it in fix-content's view, so a decision not yet applied still gets applied
		if (decided) Object.assign(f, { known: `Owner decision in decisions.json (${decided})`, decided, severity: "info", score: 1 });
	}

	// 9. Report
	const rank = (f) => [GROUPS.findIndex((g) => g.key === f.group), SEVERITY.indexOf(f.severity), -(f.score ?? 0)];
	findings.sort((a, b) => {
		const ra = rank(a);
		const rb = rank(b);
		for (let i = 0; i < ra.length; i++) if (ra[i] !== rb[i]) return ra[i] - rb[i];
		return 0;
	});
	const open = findings.filter((f) => !f.known);
	const extraTotal = Object.values(extraCounts).reduce((n, x) => n + x, 0);
	const counts = {
		bySeverity: Object.fromEntries(SEVERITY.map((s) => [s, open.filter((f) => f.severity === s).length])),
		byGroup: Object.fromEntries(GROUPS.map((g) => [g.key, open.filter((f) => f.group === g.key).length])),
		known: findings.filter((f) => f.known).length,
		inventory: {
			oldPosts: posts.items.length,
			oldPages: pages.items.length,
			oldExtra: extraCounts,
			oldExtraTotal: extraTotal,
			oldCategories: cats.items.length,
			oldTags: tags.items.length,
			oldComments: commentTotal,
			commentsShown: pageReports.reduce((n, p) => n + (p.comments?.shown ?? 0), 0),
			oldSitemapUrls: oldSitemap.length,
			newSitemapUrls: newSitemap.length,
			pagesOk: items.filter((i) => i.ok).length,
			pagesCompared: pageReports.length,
			pagesWithFindings: new Set(open.filter((f) => f.slug).map((f) => f.slug)).size,
			urlTests: urlTests.length,
			urlTestsFailed: urlTests.filter((t) => !t.pass).length,
			imagesChecked: pageReports.reduce((s, p) => s + p.newA.images.length, 0),
			internalLinksChecked: pageReports.reduce((s, p) => s + (p.internalLinks ?? 0), 0),
		},
		requests: stats,
	};
	const report = {
		generatedAt: new Date().toISOString(),
		durationSeconds: Math.round((Date.now() - started) / 1000),
		site: { name: CONFIG.site.name, locale: CONFIG.site.locale ?? null, timeZone: CONFIG.site.timeZone ?? null },
		sites: { old: OLD, new: NEW },
		config: CONFIG.file,
		options: { refresh: REFRESH, refreshOld: REFRESH_OLD, offline: OFFLINE, only: ONLY ? [...ONLY] : null, browserChecks: BROWSER_CHECKS, shots: SHOT_COUNT },
		skipped,
		groups: GROUPS,
		counts,
		findings,
		onlyOld,
		onlyNew,
		urlTests,
		liveChecks,
		shots,
		pages: pageReports.map((pr) => ({
			slug: pr.slug,
			kind: pr.kind,
			title: pr.title,
			oldUrl: pr.oldUrl,
			newUrl: pr.newUrl,
			score: pr.score,
			counts: pr.counts,
			paragraphs: pr.paragraphs,
		})),
	};
	const groupsNow = {};
	for (const t of urlTests) {
		groupsNow[t.group] ??= [0, 0];
		groupsNow[t.group][1]++;
		if (t.pass) groupsNow[t.group][0]++;
	}
	const historyFile = join(OUT, "history.json");
	const history = JSON.parse(await readFile(historyFile, "utf8").catch(() => "[]"));
	// Only runs that actually asked staging something say anything new about it
	if (urlTests.length && (REFRESH || stats.new > 0)) {
		history.push({ at: report.generatedAt, refresh: REFRESH, urlGroups: groupsNow, bySeverity: counts.bySeverity });
		await writeFile(historyFile, JSON.stringify(history.slice(-30), null, 2));
	}
	report.history = history.slice(-30);
	const { proposeFixes, renderReportHtml } = await import("./lib/compare-report.mjs");
	report.fixes = proposeFixes(report);
	await writeFile(join(OUT, "report.json"), JSON.stringify(report, null, 2));
	const summary = renderSummary(report);
	await writeFile(join(OUT, "summary.md"), summary);
	if (WRITE_HTML) {
		try {
			await writeFile(join(OUT, "report.html"), renderReportHtml(report));
		} catch (err) {
			log(`  (report.html not written: ${err.message})`);
		}
	}
	log(`\n${summary.split("\n").slice(0, 40).join("\n")}`);
	log(`\nWrote ${join(OUT, "report.json")} and summary.md (${findings.length} findings, ${report.durationSeconds}s; requests ${JSON.stringify(stats)})`);
}

// --------------------------------------------------------- per-page logic

function comparePage(it, oldA, newA, { LISTING, SECTIONS }) {
	const pr = { slug: it.slug, kind: it.kind, title: it.title, oldUrl: it.oldUrl, newUrl: it.newUrl, item: it, oldA, newA, findings: [] };
	const base = { slug: it.slug, title: it.title, oldUrl: it.oldUrl, newUrl: it.newUrl };
	const isLinkPost = Boolean(LP.enabled && newA.meta?.linkUrl);
	pr.isLinkPost = isLinkPost;

	const listingPage = it.kind === "page" && LISTING.has(it.slug);
	// A post whose address a new-site page now serves: the "is this a post" selector says no,
	// or (without that selector) the address is one of newSite.sections
	const shadowed = it.kind === "post" && newA.meta && (newA.meta.isPost === false || (newA.meta.isPost === null && SECTIONS.has(it.path)));
	if (shadowed) {
		pr.counts = {};
		pr.paragraphs = { skipped: "address now serves a new-site page" };
		add({ ...base, group: "pages", severity: oldA.words > 0 ? "high" : "low", kind: "post-shadowed", summary: `Post “${it.title}” (${oldA.words} words) can't be reached: /${it.slug}/ now serves the new site's ${newA.meta.title || "page"} page`, details: { oldWords: oldA.words, newTitle: newA.meta.title }, score: oldA.words > 0 ? 60 : 3 });
		return pr;
	}
	if (it.frontPage || listingPage) {
		pr.counts = {};
		pr.paragraphs = { skipped: it.frontPage ? "front page, deliberately replaced" : "listing page, rendered by a new-site template" };
		if (listingPage && oldA.lines.length > 2) {
			add({ ...base, group: "content", severity: "info", kind: "listing-page", summary: `/${it.slug}/ is a WordPress listing page; the new site renders it from a template`, known: "Listing page replaced by a new-site route", details: { oldLines: oldA.lines.length } });
		}
		return pr;
	}

	// Paragraphs
	const para = diffParagraphs(oldA.lines, newA, isLinkPost);
	pr.paragraphs = { checked: para.checked, matched: para.matched, missing: para.missing.length, changed: para.changed.length };
	const missingWords = para.missing.reduce((s, m) => s + m.words, 0);
	const changedWords = para.changed.reduce((s, m) => s + m.words, 0);
	if (para.missing.length) {
		add({ ...base, group: "content", severity: missingWords >= 20 ? "high" : "medium", kind: "paragraphs-missing", summary: `${para.missing.length} paragraph${para.missing.length > 1 ? "s" : ""} missing (${missingWords} words)`, details: { paragraphs: para.missing }, score: 10 + missingWords });
	}
	if (para.changed.length) {
		add({ ...base, group: "content", severity: changedWords >= 40 ? "medium" : "low", kind: "paragraphs-changed", summary: `${para.changed.length} paragraph${para.changed.length > 1 ? "s" : ""} only partly match (${changedWords} words)`, details: { paragraphs: para.changed }, score: 3 + changedWords * 0.3 });
	}
	if (!newA.meta?.hasProse && para.checked > 0) {
		add({ ...base, group: "content", severity: "high", kind: "no-prose", summary: `New page has no content element (${SEL.content.join(" or ")})`, score: 30 });
	}

	// Text the new page shows that WordPress didn't (leaked script or CSS source, raw markup)
	const oldSqAll = sq(oldA.lines.join(" "));
	const oldSh = new Set(oldA.lines.flatMap((l) => shingles(tokens(l))));
	const added = newA.lines.filter((l) => {
		const s = sq(l);
		if (s.length < 16 || oldSqAll.includes(s)) return false;
		const sh = shingles(tokens(l));
		return sh.length && sh.filter((x) => oldSh.has(x)).length / sh.length < 0.5;
	});
	const addedWords = added.reduce((n, l) => n + wc(l), 0);
	if (addedWords >= 25) {
		const CODEY = /function\s*\(|\$\(|\bvar\s+\w+\s*=|=>|;\s*\}|<\/?script|document\.|\.css\(|@media|[\w.#-]+\s*\{[^}]*:[^}]*;/;
		const codey = added.some((l) => CODEY.test(l));
		add({ ...base, group: "content", severity: codey ? "medium" : "low", kind: codey ? "code-shown-as-text" : "text-added", summary: `${addedWords} words on the new page that WordPress didn't show${codey ? " (script or CSS source printed as text)" : ""}`, details: { lines: added.slice(0, 12).map((l) => l.slice(0, 300)) }, score: codey ? 12 : 2 });
	}

	// Glued or merged paragraphs
	const glued = gluedParagraphs(oldA.lines, newA);
	if (glued.length) {
		add({ ...base, group: "content", severity: "medium", kind: "paragraphs-glued", summary: `${glued.length} paragraph break${glued.length > 1 ? "s" : ""} lost with words run together`, details: { examples: glued.slice(0, 8) }, score: 4 + glued.length * 2 });
	}
	const newBreaks = newA.pCount + Math.floor(newA.brCount / 2);
	if (oldA.pCount >= 4 && newA.pCount <= oldA.pCount / 2) {
		add({ ...base, group: "content", severity: "low", kind: "paragraphs-merged", summary: `${oldA.pCount} paragraphs became ${newA.pCount} (${newA.brCount} line breaks inside them)`, details: { oldP: oldA.pCount, newP: newA.pCount, newBr: newA.brCount, newBreaks }, score: 2 });
	}

	// Block counts
	const newLinesSq = sq(newA.lines.join(" "));
	const counts = {
		headings: [oldA.headings.length, newA.headings.length],
		listItems: [oldA.listItems.length, newA.listItems.length],
		blockquotes: [oldA.blockquotes.length, newA.blockquotes.length],
		citations: [oldA.blockquotes.filter((b) => b.cite).length, newA.blockquotes.filter((b) => b.cite).length],
		captions: [oldA.figcaptions.length, newA.figcaptions.length],
		images: [oldA.images.length, newA.images.length],
		embeds: [oldA.embeds.length, newA.embeds.length],
		tables: [oldA.tables.length, newA.tables.length],
		code: [oldA.pres.filter((p) => !p.codepen && codeNorm(p.text)).length, newA.pres.length],
		paragraphs: [oldA.pCount, newA.pCount],
		words: [oldA.words, newA.words],
	};
	pr.counts = counts;

	const h = missingTexts(oldA.headings.map((x) => x.text), newA.headings.map((x) => x.text), newLinesSq);
	if (h.lost.length || h.demoted.length) {
		add({ ...base, group: "content", severity: h.lost.length ? "high" : "low", kind: h.lost.length ? "headings-missing" : "headings-demoted", summary: h.lost.length ? `${h.lost.length} heading${h.lost.length > 1 ? "s" : ""} missing` : `${h.demoted.length} heading${h.demoted.length > 1 ? "s" : ""} now plain text`, details: { lost: h.lost, demoted: h.demoted, counts: counts.headings }, score: h.lost.length * 8 + h.demoted.length * 2 });
	}
	const li = missingTexts(oldA.listItems, newA.listItems, newLinesSq);
	if (li.lost.length || li.demoted.length) {
		add({ ...base, group: "content", severity: li.lost.length ? "high" : "low", kind: li.lost.length ? "list-items-missing" : "list-items-flattened", summary: li.lost.length ? `${li.lost.length} list item${li.lost.length > 1 ? "s" : ""} missing (${counts.listItems[0]} → ${counts.listItems[1]})` : `${li.demoted.length} list item${li.demoted.length > 1 ? "s" : ""} no longer in a list`, details: { lost: li.lost.slice(0, 40), demoted: li.demoted.slice(0, 40), counts: counts.listItems }, score: li.lost.length * 4 + li.demoted.length });
	}
	const oldQuotes = oldA.blockquotes
		.filter((b) => !b.tweet)
		.map((b) => (isLinkPost && LINK_TRAILER ? { ...b, text: b.text.replace(LINK_TRAILER, "").trim() } : b))
		.filter((b) => !(isLinkPost && (sq(b.text) === sq(it.title) || sq(it.title).includes(sq(b.text)))));
	const newQuoteSq = newA.blockquotes.map((b) => sq(b.text));
	const lostQuotes = oldQuotes.filter((q) => {
		const s = sq(q.text).slice(0, 60);
		return s.length > 8 && !newQuoteSq.some((n) => n.includes(s));
	});
	if (lostQuotes.length) {
		const stillText = lostQuotes.filter((q) => newLinesSq.includes(sq(q.text).slice(0, 60)));
		add({ ...base, group: "content", severity: stillText.length === lostQuotes.length ? "low" : "high", kind: stillText.length === lostQuotes.length ? "quotes-flattened" : "quotes-missing", summary: stillText.length === lostQuotes.length ? `${lostQuotes.length} blockquote${lostQuotes.length > 1 ? "s" : ""} now plain paragraphs` : `${lostQuotes.length - stillText.length} blockquote${lostQuotes.length - stillText.length > 1 ? "s" : ""} missing`, details: { quotes: lostQuotes.map((q) => q.text.slice(0, 200)), counts: counts.blockquotes }, score: (lostQuotes.length - stillText.length) * 10 + stillText.length * 2 });
	}
	if (counts.citations[1] < counts.citations[0]) {
		const lostCites = oldA.blockquotes.filter((b) => b.cite && !newLinesSq.includes(sq(b.cite).slice(0, 40)));
		add({ ...base, group: "content", severity: lostCites.length ? "medium" : "low", kind: lostCites.length ? "citations-missing" : "citations-unstyled", summary: lostCites.length ? `${lostCites.length} quote citation${lostCites.length > 1 ? "s" : ""} missing` : `${counts.citations[0] - counts.citations[1]} quote citation${counts.citations[0] - counts.citations[1] > 1 ? "s" : ""} no longer set as a citation`, details: { citations: oldA.blockquotes.filter((b) => b.cite).map((b) => b.cite), counts: counts.citations }, score: lostCites.length * 5 + 1 });
	}
	if (counts.captions[1] < counts.captions[0]) {
		const lostCaps = oldA.figcaptions.filter((c) => sq(c).length > 2 && !newLinesSq.includes(sq(c)));
		if (lostCaps.length) add({ ...base, group: "content", severity: "medium", kind: "captions-missing", summary: `${lostCaps.length} image caption${lostCaps.length > 1 ? "s" : ""} missing`, details: { captions: lostCaps, counts: counts.captions }, score: lostCaps.length * 4 });
	}
	if (counts.tables[1] < counts.tables[0]) {
		add({ ...base, group: "content", severity: "high", kind: "tables-missing", summary: `${counts.tables[0] - counts.tables[1]} table${counts.tables[0] - counts.tables[1] > 1 ? "s" : ""} missing`, details: { tables: oldA.tables, counts: counts.tables }, score: 30 });
	}

	// Raw shortcodes, markup or entities visible only on the new side
	const newOnly = (a, b) => a.filter((x) => !b.includes(x));
	const sc = newOnly(newA.shortcodes, oldA.shortcodes);
	if (sc.length) add({ ...base, group: "content", severity: "high", kind: "shortcode-visible", summary: `Raw shortcode shown as text: ${[...new Set(sc)].join(" ").slice(0, 120)}`, details: { shortcodes: sc }, score: 40 });
	const mk = newOnly(newA.markup, oldA.markup);
	if (mk.length) add({ ...base, group: "content", severity: "medium", kind: "markup-visible", summary: `HTML shown as text: ${[...new Set(mk)].slice(0, 4).join(" ")}`, details: { markup: mk.slice(0, 20) }, score: 10 });
	const ent = newOnly(newA.entities, oldA.entities);
	if (ent.length) add({ ...base, group: "content", severity: "low", kind: "entities-visible", summary: `HTML entities shown as text: ${[...new Set(ent)].slice(0, 6).join(" ")}`, details: { entities: ent.slice(0, 20) }, score: 3 });

	// Code
	const code = compareCode(oldA.pres, newA.pres.map((p) => ({ ...p })));
	pr.code = code;
	const codepenOld = oldA.pres.filter((p) => p.codepen).length;
	const emptyOld = oldA.pres.filter((p) => !p.codepen && !codeNorm(p.text)).length;
	if (emptyOld) add({ ...base, group: "code", severity: "info", kind: "code-empty-on-old", summary: `${emptyOld} code box${emptyOld > 1 ? "es were" : " was"} already empty on WordPress`, known: "Empty on WordPress too: the code inside ran as a script instead of showing", details: { emptyOld } });
	let extra = code.extra;
	if (codepenOld) extra = extra.filter((t, i) => !(sq(t) === sq("<code></code>") || !sq(t)) || i >= codepenOld);
	const codeMissing = code.pairs.filter((p) => p.status === "missing");
	const codeDiff = code.pairs.filter((p) => ["different", "double-escaped"].includes(p.status));
	const codeWs = code.pairs.filter((p) => p.status === "whitespace");
	const flattened = codeMissing.filter((p) => sq(p.old).length >= 6 && newLinesSq.includes(sq(p.old).slice(0, 80)));
	const goneCode = codeMissing.filter((p) => !flattened.includes(p));
	if (goneCode.length) add({ ...base, group: "code", severity: "high", kind: "code-missing", summary: `${goneCode.length} code block${goneCode.length > 1 ? "s" : ""} missing`, details: { blocks: goneCode.map((p) => p.old.slice(0, 600)) }, score: goneCode.length * 20 });
	if (flattened.length) add({ ...base, group: "code", severity: "medium", kind: "code-flattened", summary: `${flattened.length} code block${flattened.length > 1 ? "s are" : " is"} now ordinary paragraphs (indentation and monospace lost)`, details: { blocks: flattened.map((p) => p.old.slice(0, 600)) }, score: flattened.length * 8 });
	for (const d of codeDiff) add({ ...base, group: "code", severity: "medium", kind: d.status === "double-escaped" ? "code-double-escaped" : "code-different", summary: `Code differs from line ${d.line}: “${d.oldLine.slice(0, 60)}” → “${d.newLine.slice(0, 60)}”`, details: d, score: 15 });
	if (codeWs.length) add({ ...base, group: "code", severity: "low", kind: "code-whitespace", summary: `${codeWs.length} code block${codeWs.length > 1 ? "s" : ""} differ only in whitespace`, details: { blocks: codeWs }, score: 2 });
	if (extra.length) add({ ...base, group: "code", severity: "low", kind: "code-extra", summary: `${extra.length} code block${extra.length > 1 ? "s" : ""} on the new page that WordPress didn't show as code`, details: { blocks: extra }, score: 3 });

	// Metadata
	metaFindings(pr, base);
	return pr;
}

function metaFindings(pr, base) {
	const it = pr.item;
	const m = pr.newA.meta ?? {};
	if (m.title !== it.title && decodeEntities(m.title) === it.title) {
		add({ ...base, group: "metadata", severity: "medium", kind: "title-double-escaped", summary: `Title shows “${m.title}” (entity escaped twice)`, details: { old: it.title, new: m.title }, score: 5 });
	} else if (sq(m.title) !== sq(it.title)) {
		const sev = sq(m.title).includes(sq(it.title)) || sq(it.title).includes(sq(m.title)) ? "low" : "medium";
		add({ ...base, group: "metadata", severity: sev, kind: "title-different", summary: `Title “${it.title}” → “${m.title}”`, details: { old: it.title, new: m.title }, score: sev === "medium" ? 5 : 1 });
	}
	if (it.kind !== "post") return;
	if (SEL.date.length) {
		if (!m.datetime) {
			add({ ...base, group: "metadata", severity: "medium", kind: "date-missing", summary: "No publish date on the new page", score: 4 });
		} else {
			const oldT = Date.parse(`${it.dateGmt}Z`);
			const newT = Date.parse(m.datetime);
			const diffMin = Math.round((newT - oldT) / 60000);
			if (Math.abs(diffMin) > 1) {
				const localT = Date.parse(`${it.date}Z`);
				const sameDay = it.date.slice(0, 10) === m.datetime.slice(0, 10);
				add({ ...base, group: "metadata", severity: sameDay ? "low" : "medium", kind: "date-different", summary: `Published ${it.date.slice(0, 16).replace("T", " ")} → ${m.datetime.slice(0, 16).replace("T", " ")}${Math.abs(newT - localT) < 60000 ? " (local time stored as UTC)" : ""}`, details: { oldGmt: it.dateGmt, oldLocal: it.date, new: m.datetime, minutes: diffMin }, score: sameDay ? 1 : 4 });
			}
		}
	}
	const slugFrom = (href, seg) => {
		try {
			const p = new URL(href).pathname.split("/").filter(Boolean);
			return p[0] === seg ? decodeURIComponent(p[1] ?? "").toLowerCase() : null;
		} catch {
			return null;
		}
	};
	if (SEL.categories.length) {
		const newCats = (m.categories ?? []).map((c) => slugFrom(c.href, CONFIG.newSite.categoryBase)).filter(Boolean);
		const oldCats = it.categories.map((s) => s.toLowerCase());
		const lostCats = oldCats.filter((c) => !newCats.includes(c) && c !== "uncategorized");
		const addedCats = newCats.filter((c) => !oldCats.includes(c));
		if (lostCats.length || addedCats.length) add({ ...base, group: "metadata", severity: lostCats.length ? "medium" : "low", kind: "categories-different", summary: `Categories ${oldCats.join(", ") || "none"} → ${newCats.join(", ") || "none"}`, details: { old: oldCats, new: newCats, lost: lostCats, added: addedCats }, score: lostCats.length * 2 + addedCats.length });
	}
	if (SEL.tags.length) {
		const newTags = (m.tags ?? []).map((t) => slugFrom(t.href, CONFIG.newSite.tagBase)).filter(Boolean);
		const oldTags = it.tags.map((s) => s.toLowerCase());
		const lostTags = oldTags.filter((t) => !newTags.includes(t));
		const addedTags = newTags.filter((t) => !oldTags.includes(t));
		if (lostTags.length || addedTags.length) add({ ...base, group: "metadata", severity: "low", kind: "tags-different", summary: `${lostTags.length} tag${lostTags.length === 1 ? "" : "s"} missing${addedTags.length ? `, ${addedTags.length} added` : ""}${lostTags.length ? `: ${lostTags.slice(0, 6).join(", ")}` : ""}`, details: { old: oldTags, new: newTags, lost: lostTags, added: addedTags }, score: lostTags.length * 0.5 + addedTags.length * 0.5 });
	}
	if (SEL.featured.length && it.featured && !m.featured) {
		if (pr.isLinkPost) add({ ...base, group: "metadata", severity: "info", kind: "featured-hidden-link-post", summary: "Featured image not shown (link post)", known: "Link posts don't show featured images by design", details: { old: it.featuredUrl } });
		else add({ ...base, group: "metadata", severity: "medium", kind: "featured-missing", summary: "Featured image missing", details: { old: it.featuredUrl }, score: 6 });
	}
	// Comments the import planned for this page
	if (COMMENT_PLAN && SEL.comment.length && m.comments != null) {
		const expected = COMMENT_PLAN.perPost.get(slugKey(it.slug)) ?? 0;
		pr.comments = { expected, shown: m.comments };
		if (m.comments < expected) add({ ...base, group: "content", severity: "medium", kind: "comments-missing", summary: `${m.comments} of ${expected} imported comments shown`, details: { expected, shown: m.comments, note: "Apply import-comments.mjs to this site, render the Comments component on the entry page, or check newSite.selectors.comment" }, score: Math.min(8, 2 + expected - m.comments) });
	}
	if (pr.isLinkPost) {
		const oldLinks = pr.oldA.links.map((l) => l.abs).filter(Boolean);
		const trailer = pr.oldA.links.at(-1)?.abs;
		const nu = m.linkUrl;
		const normU = (u) => (u ?? "").replace(/^https?:\/\/(www\.)?/, "").replace(/\/$/, "").toLowerCase();
		if (trailer && normU(trailer) !== normU(nu) && !oldLinks.some((l) => normU(l) === normU(nu))) {
			// By hostname: a substring test would count "t.co" inside "microsoft.com"
			const viaShortener = (LP.shorteners ?? []).includes(hostOf(trailer).replace(/^www\./, ""));
			add({ ...base, group: "metadata", severity: viaShortener ? "info" : "low", kind: "link-url-different", summary: `Link-post destination is ${nu} (WordPress linked ${trailer})`, details: { old: trailer, new: nu }, ...(viaShortener ? { known: "Shortener expanded by postprocess-links.mjs" } : {}), score: 1 });
		}
	}
}

function finishPage(pr, imgResults, linkResults, linkRefs) {
	const base = { slug: pr.slug, title: pr.title, oldUrl: pr.oldUrl, newUrl: pr.newUrl };
	if (!pr.newA) return;
	const oldSrcs = new Set(pr.oldA.images.map((i) => i.src));
	const broken = [];
	const viaOld = [];
	for (const img of [...pr.newA.images, ...(pr.newA.meta?.featured ? [{ src: pr.newA.meta.featured, featured: true }] : [])]) {
		const r = imgResults.get(img.src);
		if (!r) continue;
		if (r.onOld) viaOld.push(img.src);
		if (r.status !== 200) broken.push({ src: img.src, tested: r.testUrl, status: r.status, featured: !!img.featured, preexisting: oldSrcs.has(img.src) && !r.onOld && kindFor(img.src) === "ext" });
	}
	const cutover = broken.filter((b) => !b.preexisting && isWordPressHost(hostOf(b.src)));
	const realBroken = broken.filter((b) => !b.preexisting && !isWordPressHost(hostOf(b.src)));
	const oldBroken = broken.filter((b) => b.preexisting);
	const viaOldOk = viaOld.filter((src) => !cutover.some((b) => b.src === src));
	if (cutover.length) add({ ...base, group: "media", severity: "high", kind: "image-breaks-at-cutover", summary: `${cutover.length} image${cutover.length > 1 ? "s" : ""} still load from WordPress and have no redirect on the new site, so they break at cutover`, details: { images: cutover, note: "Tested on the new host to simulate cutover" }, score: 20 * cutover.length });
	if (realBroken.length) add({ ...base, group: "media", severity: "high", kind: "image-broken", summary: `${realBroken.length} image${realBroken.length > 1 ? "s" : ""} on the new page don't load (${[...new Set(realBroken.map((b) => b.status))].join(", ")})`, details: { images: realBroken }, score: 25 * realBroken.length });
	if (oldBroken.length) add({ ...base, group: "media", severity: "low", kind: "image-broken-external", summary: `${oldBroken.length} hotlinked image${oldBroken.length > 1 ? "s" : ""} from other sites no longer load (same on WordPress)`, details: { images: oldBroken }, score: 1 });
	if (viaOldOk.length) add({ ...base, group: "media", severity: "low", kind: "image-src-old-host", summary: `${viaOldOk.length} image${viaOldOk.length > 1 ? "s" : ""} still point at WordPress (they will redirect after cutover)`, details: { images: viaOldOk, note: "Tested on the new host to simulate cutover" }, score: 2 });

	// Internal links
	const brokenLinks = [];
	let internal = 0;
	for (const [u, ref] of linkRefs) {
		if (!ref.slugs.has(pr.slug)) continue;
		internal++;
		const r = linkResults.get(u);
		if (r && (r.status === 404 || r.status === 410 || r.status === 0)) brokenLinks.push({ url: u, href: [...ref.original][0], status: r.status, oldStatus: r.oldStatus ?? null });
	}
	pr.internalLinks = internal;
	const regress = brokenLinks.filter((b) => b.oldStatus === 200);
	const both = brokenLinks.filter((b) => b.oldStatus !== 200);
	if (regress.length) add({ ...base, group: "media", severity: "medium", kind: "internal-link-broken", summary: `${regress.length} internal link${regress.length > 1 ? "s" : ""} 404 on the new site but worked on WordPress`, details: { links: regress }, score: 6 * regress.length });
	if (both.length) add({ ...base, group: "media", severity: "low", kind: "internal-link-broken-before", summary: `${both.length} internal link${both.length > 1 ? "s" : ""} 404 (already broken on WordPress)`, details: { links: both }, score: 1 });

	// Old images with no counterpart, for a later display check
	const newAlts = new Set(pr.newA.images.map((i) => sq(i.alt)).filter((a) => a.length > 3));
	const fileKey = (u) => {
		try {
			return decodeURIComponent(new URL(u).pathname.split("/").pop()).toLowerCase().replace(/-\d+x\d+(?=\.)/, "").replace(/-scaled(?=\.)/, "");
		} catch {
			return u;
		}
	};
	const newFiles = new Set(pr.newA.images.map((i) => fileKey(i.src)));
	const deficit = pr.oldA.images.length - pr.newA.images.length;
	const unmatched = pr.oldA.images.filter((i) => !(sq(i.alt).length > 3 && newAlts.has(sq(i.alt))) && !newFiles.has(fileKey(i.src)));
	pr.unmatchedOldImages = deficit > 0 ? unmatched.map((i) => i.src) : [];
	pr.imageDeficit = Math.max(0, deficit);
}

function imageFindings(pr, checks) {
	if (!pr.imageDeficit) return;
	const base = { slug: pr.slug, title: pr.title, oldUrl: pr.oldUrl, newUrl: pr.newUrl };
	const loads = (r) => r?.status === 200 && !/^text\/html/i.test(r?.type ?? "");
	const shownOnOld = checks.filter((c) => loads(c.result)).map((c) => c.src);
	const deadOnOld = checks.filter((c) => !loads(c.result)).map((c) => ({ src: c.src, status: c.result?.status, type: c.result?.type ?? null }));
	const lost = Math.min(pr.imageDeficit, shownOnOld.length || pr.imageDeficit);
	const gallery = pr.oldA.galleries > 0 && pr.newA.galleries === 0;
	if (shownOnOld.length || !checks.length) {
		add({
			...base,
			group: "media",
			severity: "high",
			kind: gallery ? "gallery-missing" : "images-missing",
			summary: gallery ? `Gallery missing: ${pr.oldA.images.length} images → ${pr.newA.images.length}` : `${lost} image${lost > 1 ? "s" : ""} missing (${pr.oldA.images.length} → ${pr.newA.images.length})`,
			details: { unmatchedOld: shownOnOld.slice(0, 60), deadOnOld, counts: [pr.oldA.images.length, pr.newA.images.length] },
			score: 20 + lost * 8,
		});
	} else {
		add({ ...base, group: "media", severity: "low", kind: "images-missing-dead-on-old", summary: `${pr.imageDeficit} image${pr.imageDeficit > 1 ? "s" : ""} not migrated, but they were already broken on WordPress`, details: { deadOnOld }, score: 1 });
	}
}

const retype = (list) => list?.map((e) => (e.kind === "iframe" && e.type !== "html" ? { ...e, type: hostType(e.src) } : e)) ?? null;

function embedFindings(pr, live) {
	const base = { slug: pr.slug, title: pr.title, oldUrl: pr.oldUrl, newUrl: pr.newUrl };
	const oldE = pr.oldA?.embeds ?? [];
	const newE = pr.newA?.embeds ?? [];
	if (!oldE.length && !newE.length) return;
	const lo = retype(live.old[pr.slug]);
	const ln = retype(live.new[pr.slug]);
	const tally = (list, shownOnly) => {
		const t = {};
		for (const e of list) if (!shownOnly || e.shown) t[e.type] = (t[e.type] ?? 0) + 1;
		return t;
	};
	const markupOld = tally(oldE.filter((e) => e.kind !== "embed-link"));
	const shownOld = lo ? tally(lo, true) : null;
	const shownNew = ln ? tally(ln, true) : tally(newE.filter((e) => ["iframe", "video", "audio", "html-block"].includes(e.kind)));
	const newLinks = tally(newE.filter((e) => e.kind === "embed-link"));
	const newSqAll = sq((pr.newA?.lines ?? []).join(" "));
	const tweetsAsText = (pr.oldA?.blockquotes ?? []).filter((b) => b.tweet && sq(b.text).length > 10 && newSqAll.includes(sq(b.text).slice(0, 50))).length;
	const asText = {};
	if (tweetsAsText) asText.tweet = tweetsAsText;
	const codepenPlaceholders = newE.filter((e) => e.kind === "codepen").length;
	if (codepenPlaceholders) newLinks.codepen = (newLinks.codepen ?? 0) + codepenPlaceholders;
	const degradedWording = (type, links, texts) => (type === "codepen" ? "now a CodePen link with no embed" : texts && !links ? "now plain quoted text" : texts ? "now a link or quoted text" : "now a plain link");
	pr.embeds = { markupOld, shownOld, shownNew, newLinks };
	const types = new Set([...Object.keys(markupOld), ...Object.keys(shownOld ?? {})]);
	for (const type of types) {
		const had = (shownOld ?? markupOld)[type] ?? 0;
		const markup = markupOld[type] ?? 0;
		const now = shownNew[type] ?? 0;
		const asLink = (newLinks[type] ?? 0) + (asText[type] ?? 0);
		if (had > now) {
			const lost = had - now;
			const degraded = Math.min(lost, asLink);
			add({
				...base,
				group: "media",
				severity: degraded === lost ? "medium" : "high",
				kind: degraded === lost ? "embed-degraded" : "embed-lost",
				summary: `${type} embed${lost > 1 ? "s" : ""} ${degraded === lost ? degradedWording(type, newLinks[type] ?? 0, asText[type] ?? 0) : degraded ? `missing (${degraded} of ${lost} kept as text or a link)` : "missing"}: displayed on WordPress ${had}, new site ${now}${shownOld ? "" : " (markup count; live check skipped)"}`,
				details: { type, displayedOld: had, displayedNew: now, asLink, oldEmbeds: oldE.filter((e) => e.type === type), liveOld: lo?.filter((e) => e.type === type) ?? null },
				score: degraded === lost ? 15 : 60 * lost,
			});
		}
		if (shownOld && markup > (shownOld[type] ?? 0)) {
			const dead = markup - (shownOld[type] ?? 0);
			const why = [...new Set((lo ?? []).filter((e) => e.type === type && !e.shown).map((e) => e.note || `${e.kind} ${e.w}×${e.h}`))];
			add({
				...base,
				group: "media",
				severity: "info",
				kind: "embed-not-shown-on-old",
				summary: `${dead} ${type} embed${dead > 1 ? "s" : ""} in the WordPress markup didn't display there either${now ? "" : "; the new page has none"}`,
				known: "Not a migration loss: it didn't display on WordPress",
				details: { type, inMarkup: markup, displayedOld: shownOld[type] ?? 0, displayedNew: now, why, oldEmbeds: oldE.filter((e) => e.type === type) },
			});
		}
	}
}

// ------------------------------------------------------ old URL patterns

const EXPECT = { feed: { feed: true }, xml: { xml: true }, any200: { any200: true }, any200NotHome: { any200NotHome: true }, image: { image: true } };
const asExpect = (e) => (typeof e === "string" ? (EXPECT[e] ?? { any200: true }) : e?.path ? { path: pathKey(e.path) } : e?.paths ? { paths: e.paths.map((p) => pathKey(p)) } : (e ?? { any200: true }));

async function runUrlTests(items, cats, tags, oldSitemap) {
	log("Testing old URL patterns on the new site…");
	const A = CONFIG.audit;
	const tests = [];
	const posts = items.filter((i) => i.kind === "post" && i.ok).sort((a, b) => a.date.localeCompare(b.date));
	const sample = (arr, n) => (arr.length <= n ? arr : n <= 1 ? arr.slice(0, n) : Array.from({ length: n }, (_, i) => arr[Math.floor((i * (arr.length - 1)) / (n - 1))]));
	for (const p of sample(posts, A.idSamples)) tests.push({ group: "p", label: `?p=${p.id}`, oldUrl: `${OLD}/?p=${p.id}`, url: `${NEW}/?p=${p.id}`, expect: { path: p.path }, severity: "medium" });
	for (const p of items.filter((i) => i.kind === "page" && i.ok).slice(0, 2)) tests.push({ group: "p", label: `?page_id=${p.id}`, oldUrl: `${OLD}/?page_id=${p.id}`, url: `${NEW}/?page_id=${p.id}`, expect: { path: p.path }, severity: "medium" });

	// Older permalink bases (urls.oldPermalinkBases): /<base>/<slug>/ → /<slug>/
	for (const b of CONFIG.urls.oldPermalinkBases) {
		const baseName = String(b).replace(/^\/+|\/+$/g, "");
		for (const p of sample(posts, A.permalinkSamples)) tests.push({ group: `${baseName}-base`, label: `/${baseName}/${p.slug}/`, oldUrl: `${OLD}/${baseName}/${encodeURIComponent(p.slug)}/`, url: `${NEW}/${baseName}/${encodeURIComponent(p.slug)}/`, expect: { path: p.path }, severity: "medium" });
	}

	const xml = await readFile(WXR, "utf8").catch(() => "");
	const attachments = [...xml.matchAll(/<wp:attachment_url>(?:<!\[CDATA\[)?(.*?)(?:\]\]>)?<\/wp:attachment_url>/g)].map((m) => m[1]).filter((a) => /^https?:/.test(a));
	for (const a of sample(attachments, A.uploadSamples)) tests.push({ group: "uploads", label: `Upload ${new URL(a).pathname}`, oldUrl: a, url: toNew(a), expect: { image: true }, severity: "high" });
	const resizedRe = new RegExp(`src="(https?:\\/\\/${wordpressHostPattern()}\\/wp-content\\/uploads\\/[^"]+-\\d+x\\d+\\.(?:jpe?g|png|gif|webp))"`, "gi");
	const resized = [...new Set(items.flatMap((i) => [...i.html.matchAll(resizedRe)].map((m) => m[1])))];
	for (const a of sample(resized, A.resizedSamples)) tests.push({ group: "uploads", label: `Resized upload ${new URL(a).pathname}`, oldUrl: a, url: toNew(a), expect: { image: true }, severity: "high" });
	const attachmentPages = [...xml.matchAll(/<item>([\s\S]*?)<\/item>/g)]
		.map((m) => m[1])
		.filter((item) => /<wp:post_type>(?:<!\[CDATA\[)?attachment(?:\]\]>)?<\/wp:post_type>/.test(item))
		.map((item) => item.match(/<link>([^<]+)<\/link>/)?.[1])
		.filter((u) => u && !/[?&]attachment_id=/.test(u));
	for (const a of sample(attachmentPages, A.attachmentPageSamples)) tests.push({ group: "attachment-page", label: `Attachment page ${pathKey(a)}/`, oldUrl: a, url: toNew(a), expect: { any200: true }, severity: "low" });

	for (const c of cats.filter((c) => c.count > 0)) {
		const path = pathKey(c.link);
		// A nested category may also redirect to /<base>/<child>/ (templates/src/pages/category/[parent]/[slug].ts)
		const segs = path.split("/").filter(Boolean);
		const paths = segs.length > 2 ? [path, `/${CONFIG.newSite.categoryBase}/${segs.at(-1)}`] : [path];
		tests.push({ group: "category", label: `Category ${path}/`, oldUrl: c.link, url: toNew(c.link), expect: { paths }, severity: "medium" });
	}
	for (const t of tags.filter((t) => t.count > 0)) {
		const path = pathKey(t.link);
		tests.push({ group: "tag", label: `Tag ${path}/`, oldUrl: t.link, url: toNew(t.link), expect: { paths: [path] }, severity: "low" });
	}
	const misc = [
		["/feed/", "high", "feed"],
		["/feed/atom/", "low", "feed"],
		["/comments/feed/", "low", "feed"],
		["/?feed=rss2", "low", "feed"],
		["/page/2/", "low", "any200NotHome"],
		["/sitemap_index.xml", "low", "xml"],
		["/post-sitemap.xml", "low", "xml"],
		[`/?s=${encodeURIComponent(A.searchTerm)}`, "low", "any200"],
		...(A.extraUrlTests ?? []).map((t) => [t.path, t.severity ?? "low", t.expect ?? "any200", t.group]),
	];
	for (const [path, sev, exp, group] of misc) tests.push({ group: group ?? (path.includes("feed") ? "feed" : "misc"), label: path, oldUrl: `${OLD}${path}`, url: `${NEW}${path}`, expect: asExpect(exp), severity: sev });
	const author = CONFIG.urls.authorArchiveTarget;
	for (const a of oldSitemap.filter((s) => /author-sitemap/.test(s.sitemap ?? ""))) tests.push({ group: "author", label: `Author ${pathKey(a.url)}/`, oldUrl: a.url, url: toNew(a.url), expect: author ? { paths: [pathKey(author)] } : { any200NotHome: true }, severity: "low" });

	const months = new Set();
	const years = new Set();
	for (const p of items.filter((i) => i.kind === "post")) {
		years.add(p.date.slice(0, 4));
		months.add(`${p.date.slice(0, 4)}/${p.date.slice(5, 7)}`);
	}
	for (const y of [...years].sort()) tests.push({ group: "date-archive", label: `Year archive /${y}/`, oldUrl: `${OLD}/${y}/`, url: `${NEW}/${y}/`, expect: { any200NotHome: true }, severity: "low" });
	for (const m of [...months].sort()) tests.push({ group: "date-archive", label: `Month archive /${m}/`, oldUrl: `${OLD}/${m}/`, url: `${NEW}/${m}/`, expect: { any200NotHome: true }, severity: "low" });

	// urls.acceptedRedirects: other destinations that count as a pass for an old path
	const accepted = new Map(Object.entries(CONFIG.urls.acceptedRedirects ?? {}).map(([from, to]) => [pathKey(from), [].concat(to).map((p) => pathKey(p))]));
	for (const t of tests) {
		const also = accepted.get(pathKey(t.oldUrl));
		if (!also || !(t.expect.path || t.expect.paths)) continue;
		t.expect = { paths: [...new Set([...(t.expect.paths ?? [t.expect.path]), ...also])] };
	}

	await mapLimit(tests, 8, async (t) => {
		const imageLike = t.expect.image;
		const r = imageLike ? await probe(t.url) : await chain(t.url, { body: false });
		const type = imageLike ? r.type : (r.res?.headers?.["content-type"] ?? "");
		const final = r.final;
		const fp = pathKey(final);
		const hops = imageLike ? r.hops : r.hops.length - 1;
		t.status = r.status;
		t.final = final;
		t.hops = r.hops;
		t.type = type;
		const e = t.expect;
		let pass = r.status === 200;
		if (pass && e.path) pass = fp === e.path;
		if (pass && e.paths) pass = e.paths.includes(fp);
		if (pass && e.image) pass = /\.(jpe?g|png|gif|webp|svg|bmp|ico)$/i.test(t.url) ? /^image\//.test(type ?? "") : !/text\/html/.test(type ?? "");
		if (pass && e.feed) pass = /xml|rss|atom/.test(type ?? "");
		if (pass && e.xml) pass = /xml/.test(type ?? "");
		if (pass && e.any200NotHome) pass = fp !== "/";
		t.pass = pass;
		// A sampled upload that fails: does WordPress still serve it?
		if (!pass && t.group === "uploads" && !OFFLINE) {
			const o = await probe(t.oldUrl);
			if (o.status !== 200) t.oldStatus = o.status || "unreachable";
		}
		t.result = pass
			? `ok (${hops ? `${hops} redirect${hops > 1 ? "s" : ""} → ` : ""}${fp})`
			: r.status === 200
				? `lands on ${fp}${e.path ? `, expected ${e.path}` : e.image ? ` (${type || "no type"}, not an image)` : e.feed || e.xml ? ` (${type || "no type"}, not a feed)` : ""}`
				: `${r.status}${fp !== pathKey(t.url) ? ` at ${fp}` : ""}`;
	});
	return tests;
}

// --------------------------------------------------- live browser checks

async function gatedContext(browser, { blockHeavy }) {
	const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, serviceWorkers: "block", userAgent: UA });
	await context.route("**/*", async (route) => {
		const req = route.request();
		const host = hostOf(req.url());
		if (!isWordPressHost(host)) return route.continue();
		if (OFFLINE || (blockHeavy && ["image", "media", "font"].includes(req.resourceType()))) return route.abort();
		try {
			const response = await LIMIT.old(() => route.fetch({ timeout: 45000 }));
			await route.fulfill({ response });
		} catch {
			await route.abort().catch(() => {});
		}
	});
	return context;
}

async function runLiveChecks(browser, pageReports) {
	const targets = pageReports.filter((pr) => pr.oldA && (pr.oldA.embeds.length || pr.newA.embeds.length || pr.oldA.scripts.length));
	log(`Live embed checks on ${targets.length} pages (WordPress sequential, images blocked)…`);
	const out = { old: {}, new: {} };
	const ctxOld = await gatedContext(browser, { blockHeavy: true });
	const ctxNew = await browser.newContext({ viewport: { width: 1440, height: 900 }, serviceWorkers: "block" });
	try {
		for (const pr of targets) {
			for (const [side, ctx, url, selectors, refresh] of [
				["old", ctxOld, pr.oldUrl, [CONFIG.wordpress.selectors.content], REFRESH_OLD],
				["new", ctxNew, pr.newUrl, SEL.content, REFRESH],
			]) {
				const file = join(CACHE, `live-${side}`, `${sha(url)}.json`);
				if (!refresh) {
					try {
						out[side][pr.slug] = JSON.parse(await readFile(file, "utf8"));
						continue;
					} catch {}
				}
				if (OFFLINE) continue;
				const page = await ctx.newPage();
				try {
					await page.goto(url, { waitUntil: "load", timeout: 40000 }).catch(async (err) => {
						if (!/ERR_|Timeout/.test(String(err))) throw err;
						await sleep(3000);
						await page.goto(url, { waitUntil: "load", timeout: 40000 });
					});
					await page.waitForLoadState("networkidle", { timeout: 6000 }).catch(() => {});
					await page.waitForTimeout(1000);
					const res = await page.evaluate(liveEmbeds, selectors);
					out[side][pr.slug] = res;
					await mkdir(dirname(file), { recursive: true });
					await writeFile(file, JSON.stringify(res));
				} catch (err) {
					log(`  ! live ${side} ${pr.slug}: ${String(err.message).slice(0, 100)}`);
				} finally {
					await page.close();
				}
			}
		}
	} finally {
		await ctxOld.close();
		await ctxNew.close();
	}
	return out;
}

async function takeShots(browser, worst) {
	if (OFFLINE) {
		log("Screenshots skipped: offline.");
		return [];
	}
	log(`Screenshots of the ${worst.length} worst pages…`);
	const sharp = await loadSharp();
	if (!sharp) log("  (sharp isn't installed: each pair is saved as two PNGs instead of one side-by-side image)");
	const ctxOld = await gatedContext(browser, { blockHeavy: false });
	const ctxNew = await browser.newContext({ viewport: { width: 1440, height: 900 }, serviceWorkers: "block" });
	const MAX_H = 7000;
	const out = [];
	const grab = async (ctx, url) => {
		const page = await ctx.newPage();
		try {
			await page.goto(url, { waitUntil: "load", timeout: 60000 });
			await page.waitForLoadState("networkidle", { timeout: 12000 }).catch(() => {});
			const height = await page.evaluate(async (max) => {
				const step = 700;
				for (let y = 0; y < Math.min(document.body.scrollHeight, max); y += step) {
					window.scrollTo(0, y);
					await new Promise((r) => setTimeout(r, 120));
				}
				window.scrollTo(0, 0);
				return document.documentElement.scrollHeight;
			}, MAX_H);
			await page.waitForTimeout(800);
			const h = Math.min(height, MAX_H);
			const buf = await page.screenshot({ type: "png", fullPage: h > 900, clip: { x: 0, y: 0, width: 1440, height: h } });
			return { buf, height };
		} finally {
			await page.close();
		}
	};
	try {
		for (const pr of worst) {
			try {
				const [o, n] = [await grab(ctxOld, pr.oldUrl), await grab(ctxNew, pr.newUrl)];
				const stem = pr.slug.replace(/[^a-z0-9-]+/gi, "_").slice(0, 80);
				const record = { slug: pr.slug, title: pr.title, oldUrl: pr.oldUrl, newUrl: pr.newUrl, score: Math.round(pr.score), oldHeight: o.height, newHeight: n.height };
				if (!sharp) {
					await writeFile(join(SHOTS, `${stem}-old.png`), o.buf);
					await writeFile(join(SHOTS, `${stem}-new.png`), n.buf);
					out.push({ ...record, file: `shots/${stem}-old.png`, fileNew: `shots/${stem}-new.png` });
					log(`  ${stem}-old.png, ${stem}-new.png`);
					continue;
				}
				const W = 720;
				const left = await sharp(o.buf).resize({ width: W }).toBuffer({ resolveWithObject: true });
				const right = await sharp(n.buf).resize({ width: W }).toBuffer({ resolveWithObject: true });
				const HEAD = 44;
				const GAP = 16;
				const H = HEAD + Math.max(left.info.height, right.info.height);
				const esc = (s) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;");
				const label = Buffer.from(
					`<svg xmlns="http://www.w3.org/2000/svg" width="${W * 2 + GAP}" height="${HEAD}"><rect width="100%" height="100%" fill="#111"/><text x="12" y="28" font-family="Helvetica, Arial" font-size="16" fill="#fff">WordPress (old) · ${esc(pathKey(pr.oldUrl))}/${o.height > MAX_H ? ` · first ${MAX_H}px of ${o.height}` : ""}</text><text x="${W + GAP + 12}" y="28" font-family="Helvetica, Arial" font-size="16" fill="#fff">EmDash staging (new)${n.height > MAX_H ? ` · first ${MAX_H}px of ${n.height}` : ""}</text></svg>`,
				);
				const file = `${stem}.jpg`;
				await sharp({ create: { width: W * 2 + GAP, height: H, channels: 3, background: "#d4d4d4" } })
					.composite([
						{ input: label, top: 0, left: 0 },
						{ input: left.data, top: HEAD, left: 0 },
						{ input: right.data, top: HEAD, left: W + GAP },
					])
					.jpeg({ quality: 70, mozjpeg: true })
					.toFile(join(SHOTS, file));
				out.push({ ...record, file: `shots/${file}` });
				log(`  ${file}`);
			} catch (err) {
				log(`  ! screenshot ${pr.slug}: ${String(err.message).slice(0, 120)}`);
			}
		}
	} finally {
		await ctxOld.close();
		await ctxNew.close();
	}
	return out;
}

// ------------------------------------------------------------- reporting

/** Shortcodes in post bodies, for the inventory (gotcha A4). */
function shortcodeNote(xml) {
	const content = [...xml.matchAll(/<content:encoded><!\[CDATA\[([\s\S]*?)\]\]><\/content:encoded>/g)].map((m) => m[1]).join("\n");
	const KNOWN = new Set(["caption", "wp_caption", "gallery", "embed", "video", "audio", "playlist", "code", "sourcecode", "youtube", "vimeo", "soundcloud", "gist", "tweet", "wpvideo", "slideshare", "contact-form", "button", "box", "column", "row", "toggle", "tabs", "tab", "one_half", "one_third", "two_third", "one_fourth", "three_fourth", ...CONFIG.fixes.shortcodes.layout, ...CONFIG.fixes.shortcodes.button]);
	const counts = {};
	for (const m of content.matchAll(/\[([a-z][a-z0-9_-]{1,30})(?=[\s\]/])([^\]]*)\]/gi)) {
		const tag = m[1].toLowerCase();
		const closes = content.includes(`[/${m[1]}]`);
		if (!KNOWN.has(tag) && !closes && !/=/.test(m[2])) continue;
		counts[tag] = (counts[tag] ?? 0) + 1;
	}
	const codepenMarkup = (content.match(/class="codepen"/g) || []).length;
	const top = Object.entries(counts).sort((a, b) => b[1] - a[1]);
	const list = top.slice(0, 12).map(([t, n]) => `[${t}] ×${n}`);
	return {
		summary: `In post bodies: ${list.length ? list.join(", ") : "no shortcodes"}${top.length > 12 ? `, and ${top.length - 12} more` : ""}${codepenMarkup ? `; CodePen embed markup ×${codepenMarkup}` : ""}`,
		inContent: Object.fromEntries(top),
		codepenMarkup,
	};
}

function renderSummary(report) {
	const lines = [];
	const c = report.counts;
	const inv = c.inventory;
	lines.push(`# Migration audit: ${report.sites.old} → ${report.sites.new}`);
	lines.push(`Generated ${report.generatedAt}`);
	lines.push("");
	lines.push(`Open findings by severity: ${SEVERITY.filter((s) => s !== "info").map((s) => `${s} ${c.bySeverity[s]}`).join(", ")}; info ${c.bySeverity.info}; known ${c.known}`);
	lines.push(`Pages: ${inv.pagesOk}/${inv.oldPosts + inv.oldPages + inv.oldExtraTotal} old content URLs resolve; ${inv.pagesCompared} compared; ${inv.pagesWithFindings} with findings`);
	lines.push(`URL tests: ${inv.urlTests - inv.urlTestsFailed}/${inv.urlTests} pass`);
	if (report.skipped?.length) lines.push(`Skipped: ${report.skipped.join(", ")}`);
	for (const g of GROUPS) {
		const fs = report.findings.filter((f) => f.group === g.key && !f.known);
		lines.push("");
		lines.push(`## ${g.title} (${fs.length})`);
		const byKind = new Map();
		for (const f of fs) {
			if (!byKind.has(f.kind)) byKind.set(f.kind, []);
			byKind.get(f.kind).push(f);
		}
		for (const [kind, list] of byKind) {
			lines.push(`- **${kind}** ×${list.length} (${list[0].severity})`);
			for (const f of list.slice(0, 8)) lines.push(`  - ${f.slug ? `/${f.slug}/ ` : ""}${f.summary}`);
			if (list.length > 8) lines.push(`  - … ${list.length - 8} more`);
		}
	}
	lines.push("");
	lines.push(`## Known (not failures) (${c.known})`);
	const known = report.findings.filter((f) => f.known);
	const byKnown = new Map();
	for (const f of known) byKnown.set(f.known, [...(byKnown.get(f.known) ?? []), f]);
	for (const [why, list] of byKnown) lines.push(`- ${why}: ${list.length}${list.length <= 3 ? ` (${list.map((f) => f.slug ?? f.summary).join("; ")})` : ""}`);
	return `${lines.join("\n")}\n`;
}

await main();
