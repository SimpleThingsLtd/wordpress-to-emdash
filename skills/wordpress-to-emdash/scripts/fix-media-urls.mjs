#!/usr/bin/env node
/**
 * Repoint content at EmDash media instead of the old WordPress uploads
 * (gotcha B1).
 *
 * The importer maps each attachment's own URL, but posts also reference
 * WordPress's resized copies (photo-1024x576.jpg), http:// variants and the
 * odd image that was never registered as an attachment. This maps every
 * remaining <sites.wordpress>/wp-content/uploads/ URL to the matching
 * imported original by filename, uploads any genuine strays, then rewrites
 * the content through the importer's rewrite-urls endpoint.
 *
 *   node fix-media-urls.mjs                                  dry run (default)
 *   node fix-media-urls.mjs --apply --target local|staging
 */
import { announce, clientFor, parseArgs, resolveTarget } from "./lib/cli.mjs";
import { CONFIG, requireConfig, wordpressHostPattern } from "./lib/config.mjs";
import { normaliseFilename as normalise } from "./lib/fix/pt.mjs";

requireConfig("sites.wordpress");
const args = parseArgs(["target"]);
const target = resolveTarget(args);
const dryRun = !target.apply;
const { api, listAll, listPages, request } = clientFor(target);
announce(target, "fix-media-urls");

const OLD = new RegExp(`https?:\\/\\/${wordpressHostPattern()}\\/wp-content\\/uploads\\/[^"'\\\\\\s)<>]+`, "g");

// 1. Index the media library by normalised filename
const library = new Map();
for await (const m of listPages("/media")) {
	const key = normalise(m.filename);
	if (!library.has(key)) library.set(key, m.url);
}
console.log(`media library: ${library.size} files`);

// 2. Find every old URL still in content
const found = new Set();
for (const collection of CONFIG.collections) {
	for await (const row of listAll(collection)) {
		const { item } = await api(`/content/${collection}/${row.id}`);
		for (const u of JSON.stringify(item.data).match(OLD) ?? []) found.add(u);
	}
}
console.log(`old URLs in content: ${found.size}`);

// 3. Map them, uploading strays that only exist on the old server
const urlMap = {};
const missing = [];
for (const url of found) {
	const file = url.split("/").pop().split("?")[0];
	const key = normalise(file);
	let tgt = library.get(key);
	if (!tgt) {
		// Try the full-size original first, then the exact URL
		const original = url.replace(/-\d+x\d+(\.[a-z0-9]+)$/i, "$1").replace(/^http:/, "https:");
		for (const candidate of [...new Set([original, url.replace(/^http:/, "https:")])]) {
			const res = await fetch(candidate, { signal: AbortSignal.timeout(20000), headers: { "user-agent": CONFIG.http.userAgent } }).catch(() => null);
			if (!res?.ok) continue;
			if (dryRun) {
				await res.body?.cancel().catch(() => {});
				tgt = `(upload ${candidate})`;
				break;
			}
			const form = new FormData();
			form.append("file", new File([await res.arrayBuffer()], candidate.split("/").pop(), { type: res.headers.get("content-type") ?? "application/octet-stream" }));
			const uploaded = await (await request("/media", { method: "POST", body: form })).json();
			tgt = (uploaded.data ?? uploaded).item?.url ?? (uploaded.data ?? uploaded).url;
			library.set(key, tgt);
			break;
		}
	}
	if (tgt) urlMap[url] = tgt;
	else missing.push(url);
}
console.log(`mapped ${Object.keys(urlMap).length}, unrecoverable ${missing.length}`);
for (const m of missing) console.log(`  ! ${m}`);
if (dryRun) {
	for (const [k, v] of Object.entries(urlMap).slice(0, 12)) console.log(`  ${k}\n    -> ${v}`);
	process.exit(0);
}

// 4. Rewrite
if (Object.keys(urlMap).length) {
	const rw = await api("/import/wordpress/rewrite-urls", { method: "POST", body: JSON.stringify({ urlMap }) });
	console.log(`rewrote ${rw.urlsRewritten} URLs across ${rw.updated} entries`);
}
