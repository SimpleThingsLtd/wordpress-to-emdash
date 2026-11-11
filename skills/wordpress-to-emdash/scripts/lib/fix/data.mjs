/**
 * Inputs for the content-repair scripts (scripts/fix-content.mjs). Read-only.
 *
 * - EmDash content, media and redirects from the local D1 copy (wrangler, no dev server)
 * - The WordPress export (posts, pages and attachments with their IDs)
 * - WordPress REST responses (what WordPress actually displayed), cached
 * - The migration audit (<paths.compare>/report.json)
 *
 * Network requests to WordPress go through a limiter (http.concurrency.wordpress,
 * 4 by default) and are cached under <paths.fixes>/cache/.
 */
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { CONFIG, isWordPressHost } from "../config.mjs";

export const ROOT = CONFIG.paths.root;
export const OUT = CONFIG.paths.fixes;
export const CACHE = join(OUT, "cache");
export const WXR_PATH = CONFIG.paths.wxr;
export const AUDIT_PATH = join(CONFIG.paths.compare, "report.json");
const AUDIT_CACHE = CONFIG.paths.compareCache;
export const OLD = CONFIG.sites.wordpress;
export const NEW = CONFIG.sites.staging;
const UA = `${CONFIG.http.userAgent} migration-fixes`;

const sha = (s) => createHash("sha1").update(s).digest("hex");

// ------------------------------------------------------------------ D1

/** One query against the local D1 copy (d1.database). Never writes. */
export function d1(sql) {
	if (!/^\s*select\b/i.test(sql)) throw new Error("d1() only runs SELECT statements");
	if (!CONFIG.d1.database) throw new Error("Set d1.database in migration.config.json (the database_name in wrangler.jsonc)");
	let out;
	try {
		out = execFileSync("npx", ["wrangler", "d1", "execute", CONFIG.d1.database, "--local", "--json", "--command", sql], {
			cwd: ROOT,
			maxBuffer: 512 * 1024 * 1024,
			stdio: ["ignore", "pipe", "pipe"],
			encoding: "utf8",
		});
	} catch (err) {
		throw new Error(`wrangler d1 execute ${CONFIG.d1.database} --local failed (run from ${ROOT}): ${String(err.stderr ?? err.message).slice(0, 400)}`);
	}
	const parsed = JSON.parse(out);
	return parsed[0]?.results ?? [];
}

/** Published entries of every imported collection (content.postTypes), with content parsed. */
export function loadLocalEntries({ includeDrafts = false } = {}) {
	const where = includeDrafts ? "deleted_at IS NULL" : "status = 'published' AND deleted_at IS NULL";
	const entries = [];
	const lp = CONFIG.linkPosts;
	for (const collection of CONFIG.collections) {
		if (!/^[a-z0-9_]+$/i.test(collection)) throw new Error(`Unexpected collection name "${collection}"`);
		const rows = d1(`SELECT * FROM ec_${collection} WHERE ${where}`);
		for (const r of rows) {
			let content = [];
			try {
				content = JSON.parse(r.content || "[]");
			} catch {}
			const linkUrl = lp.enabled && lp.collection === collection ? (r[lp.field] ?? null) : null;
			entries.push({ collection, id: r.id, slug: r.slug, status: r.status, title: r.title, excerpt: r.excerpt ?? null, linkUrl, featuredImage: r.featured_image ?? null, content });
		}
	}
	return entries;
}

export function loadLocalMedia() {
	return d1("SELECT id, filename, mime_type, size, width, height, alt, caption, storage_key, content_hash FROM media WHERE status = 'ready'");
}

export function loadLocalRedirects() {
	return d1("SELECT source, destination, group_name, enabled FROM _emdash_redirects");
}

// ------------------------------------------------------------------ WXR

const field = (item, tag) => {
	const m = item.match(new RegExp(`<${tag}>(?:<!\\[CDATA\\[)?([\\s\\S]*?)(?:\\]\\]>)?</${tag}>`));
	return m ? m[1] : "";
};
const metas = (item) => {
	const out = {};
	for (const [, body] of item.matchAll(/<wp:postmeta>([\s\S]*?)<\/wp:postmeta>/g)) {
		const k = field(body, "wp:meta_key");
		if (k) out[k] = field(body, "wp:meta_value");
	}
	return out;
};

/**
 * Every item in the export that matters here: posts, pages and attachments.
 * Attachments carry caption (excerpt), description, alt and parent.
 */
export async function loadWxr(path = WXR_PATH) {
	const xml = await readFile(path, "utf8");
	const posts = [];
	const attachments = [];
	for (const [, item] of xml.matchAll(/<item>([\s\S]*?)<\/item>/g)) {
		const type = field(item, "wp:post_type");
		const base = {
			id: Number(field(item, "wp:post_id")),
			type,
			title: field(item, "title"),
			slug: safeDecode(field(item, "wp:post_name")),
			status: field(item, "wp:status"),
			parent: Number(field(item, "wp:post_parent") || 0),
			menuOrder: Number(field(item, "wp:menu_order") || 0),
			link: field(item, "link"),
		};
		if (type in CONFIG.content.postTypes) {
			posts.push({ ...base, html: field(item, "content:encoded"), meta: metas(item) });
		} else if (type === "attachment") {
			const meta = metas(item);
			attachments.push({
				...base,
				url: field(item, "wp:attachment_url"),
				caption: field(item, "excerpt:encoded"),
				description: field(item, "content:encoded"),
				alt: meta._wp_attachment_image_alt ?? "",
				file: meta._wp_attached_file ?? "",
				thumb: thumbFrom(field(item, "wp:attachment_url"), meta._wp_attachment_metadata),
			});
		}
	}
	return { posts, attachments, byId: new Map(attachments.map((a) => [a.id, a])) };
}

/** WordPress's own small copy of an attachment (thumbnail or medium), from its PHP-serialised metadata. */
function thumbFrom(url, serialized) {
	if (!url || !serialized) return null;
	for (const size of ["medium", "thumbnail"]) {
		const m = serialized.match(new RegExp(`s:\\d+:"${size}";a:\\d+:\\{s:4:"file";s:\\d+:"([^"]+)"`));
		if (m) return url.slice(0, url.lastIndexOf("/") + 1) + m[1];
	}
	return null;
}

function safeDecode(s) {
	try {
		return decodeURIComponent(s);
	} catch {
		return s;
	}
}

// ------------------------------------------------------------- fetching

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
	return (fn) => new Promise((res, rej) => (queue.push({ fn, res, rej }), next()));
}
const LIMIT = { wp: limiter(CONFIG.http.concurrency.wordpress), other: limiter(CONFIG.http.concurrency.external) };
export const fetchStats = { wp: 0, other: 0, cached: 0 };
const isWp = (u) => {
	try {
		return isWordPressHost(new URL(u).hostname);
	} catch {
		return false;
	}
};

/**
 * Cached GET/HEAD. Returns { status, headers, body, final }. Follows
 * redirects. WordPress gets at most 4 requests in flight.
 */
export async function cachedFetch(url, { method = "GET", body = method === "GET", refresh = false } = {}) {
	const key = sha(`${method} ${body ? "body" : "nobody"} ${url}`);
	const file = join(CACHE, "http", key.slice(0, 2), `${key}.json`);
	if (!refresh) {
		try {
			const hit = JSON.parse(await readFile(file, "utf8"));
			fetchStats.cached++;
			return hit;
		} catch {}
	}
	const kind = isWp(url) ? "wp" : "other";
	const result = await LIMIT[kind](async () => {
		fetchStats[kind]++;
		try {
			const res = await fetch(url, { method, redirect: "follow", headers: { "user-agent": UA }, signal: AbortSignal.timeout(30000) });
			const headers = {};
			for (const h of ["content-type", "content-length", "x-wp-total", "x-wp-totalpages", "last-modified"]) {
				const v = res.headers.get(h);
				if (v) headers[h] = v;
			}
			const text = body ? await res.text() : (await res.body?.cancel().catch(() => {}), null);
			return { url, status: res.status, final: res.url, headers, body: text };
		} catch (err) {
			return { url, status: 0, final: url, headers: {}, body: null, error: String(err?.cause?.code ?? err?.name ?? err) };
		}
	});
	if (result.status !== 0 && result.status < 500 && result.status !== 429) {
		await mkdir(dirname(file), { recursive: true });
		await writeFile(file, JSON.stringify(result));
	}
	return result;
}

/** HEAD, falling back to a ranged GET for servers that refuse HEAD. */
export async function probe(url) {
	let r = await cachedFetch(url, { method: "HEAD", body: false });
	if ([0, 403, 405, 501].includes(r.status)) r = await cachedFetch(url, { method: "GET", body: false });
	return { status: r.status, final: r.final, type: r.headers?.["content-type"] ?? null, length: Number(r.headers?.["content-length"] ?? 0) || null };
}

// -------------------------------------------------------- WordPress REST

const REST_FIELDS = "id,slug,link,date,date_gmt,modified_gmt,title,content,excerpt,categories,tags,featured_media,format,type,status,jetpack_featured_media_url";

/**
 * WordPress REST posts and pages (content.rendered = what visitors saw).
 * Reuses the audit's cache when it has the same request, then keeps its
 * own copy under <paths.fixes>/cache/wp-rest/.
 */
export async function loadWpRendered() {
	const out = new Map();
	for (const [path, fields] of [
		["posts", REST_FIELDS],
		["pages", REST_FIELDS.replace("categories,tags,", "")],
	]) {
		let page = 1;
		let pages = 1;
		do {
			const url = `${OLD}/wp-json/wp/v2/${path}?per_page=100&page=${page}&_fields=${fields}`;
			const mine = join(CACHE, "wp-rest", `${path}-${page}.json`);
			let res = null;
			try {
				res = JSON.parse(await readFile(mine, "utf8"));
			} catch {}
			if (!res) {
				const k = sha(`GET body ${url}`);
				const auditFile = join(AUDIT_CACHE, "old", k.slice(0, 2), `${k}.json`);
				if (existsSync(auditFile)) res = JSON.parse(await readFile(auditFile, "utf8"));
				else {
					const r = await cachedFetch(url);
					res = { status: r.status, headers: r.headers, body: r.body };
				}
				await mkdir(dirname(mine), { recursive: true });
				await writeFile(mine, JSON.stringify(res));
			}
			if (res.status !== 200) break;
			for (const p of JSON.parse(res.body)) {
				out.set(safeDecode(p.slug), { id: p.id, kind: path === "posts" ? "post" : "page", slug: safeDecode(p.slug), link: p.link, title: p.title?.rendered ?? "", html: p.content?.rendered ?? "" });
			}
			pages = Number(res.headers?.["x-wp-totalpages"] ?? 1);
			page++;
		} while (page <= pages);
	}
	return out;
}

// ------------------------------------------------------------- the audit

export async function loadAudit(path = AUDIT_PATH) {
	let report;
	try {
		report = JSON.parse(await readFile(path, "utf8"));
	} catch (err) {
		throw new Error(`Couldn't read the audit report ${path} (run compare-sites.mjs first, or pass --audit <file>): ${err.message}`);
	}
	const bySlug = new Map();
	for (const f of report.findings) {
		// Known findings are settled, except ones the owner decided in decisions.json: those still
		// need the decision carried out (each fix recognises its own finished work)
		if (!f.slug || (f.known && !f.decided)) continue;
		if (!bySlug.has(f.slug)) bySlug.set(f.slug, []);
		bySlug.get(f.slug).push(f);
	}
	const kinds = (slug, ...ks) => (bySlug.get(slug) ?? []).filter((f) => ks.includes(f.kind));
	const slugsWith = (...ks) => new Set(report.findings.filter((f) => (!f.known || f.decided) && f.slug && ks.includes(f.kind)).map((f) => f.slug));
	return { report, bySlug, kinds, slugsWith };
}

/** The Wayback Machine's closest copy of a URL, as a raw-file URL (or null). */
export async function wayback(url, timestamp = CONFIG.fixes.waybackTimestamp) {
	const r = await cachedFetch(`https://archive.org/wayback/available?url=${encodeURIComponent(url.replace(/^https?:\/\//, ""))}&timestamp=${timestamp}`);
	try {
		const snap = JSON.parse(r.body ?? "{}").archived_snapshots?.closest;
		if (!snap?.available) return null;
		return snap.url.replace(/^http:/, "https:").replace(/\/web\/(\d+)\//, "/web/$1im_/");
	} catch {
		return null;
	}
}
