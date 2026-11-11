#!/usr/bin/env node
/**
 * Quick text check: compares every published WordPress post and page in the
 * export with the page the new site renders, and lists text that didn't make
 * it across. Read-only. (The full audit is compare-sites.mjs.)
 *
 *   node audit-content.mjs [export.xml] [--site http://localhost:4321] [--json out.json]
 *
 * --site defaults to sites.local; pages are fetched at content.entryPath.
 */
import { writeFile } from "node:fs/promises";
import { parseArgs } from "./lib/cli.mjs";
import { CONFIG, entryPath } from "./lib/config.mjs";
import { decodeEntities, htmlToLines, norm, readWxr } from "./lib/wxr.mjs";

const args = parseArgs(["site", "json"]);
const wxrPath = args.positional[0] ?? CONFIG.paths.wxr;
const site = args.opt("site", CONFIG.sites.local).replace(/\/$/, "");
const jsonOut = args.opt("json");

const items = (await readWxr(wxrPath)).filter((i) => i.status === "publish" && i.slug);

async function rendered(item) {
	const path = entryPath(encodeURIComponent(item.slug), item.collection);
	const res = await fetch(`${site}${path}`);
	if (!res.ok) return { status: res.status, text: "" };
	const html = await res.text();
	const main = html.match(/<main[\s\S]*<\/main>/i)?.[0] ?? html;
	return { status: res.status, text: norm(decodeEntities(main.replace(/<[^>]+>/g, " "))) };
}

const report = [];
let next = 0;
async function worker() {
	while (next < items.length) {
		const item = items[next++];
		const page = await rendered(item);
		if (page.status !== 200) {
			report.push({ slug: item.slug, status: page.status, missing: [] });
			continue;
		}
		const missing = htmlToLines(item.html)
			.filter((l) => l.length >= 12)
			.filter((l) => !page.text.includes(norm(l).slice(0, 80)));
		if (missing.length) report.push({ slug: item.slug, status: 200, missing });
	}
}
await Promise.all(Array.from({ length: 6 }, worker));

report.sort((a, b) => b.missing.length - a.missing.length || a.slug.localeCompare(b.slug));
const broken = report.filter((r) => r.status !== 200);
console.log(`${items.length} published items checked against ${site}`);
console.log(`${broken.length} not 200: ${broken.map((r) => `${r.slug} (${r.status})`).join(", ") || "none"}`);
console.log(`${report.length - broken.length} with missing text:`);
for (const r of report.filter((r) => r.status === 200)) {
	console.log(`\n/${r.slug}/  (${r.missing.length})`);
	for (const l of r.missing.slice(0, 4)) console.log(`   - ${l.slice(0, 110)}`);
}
if (jsonOut) await writeFile(jsonOut, JSON.stringify(report, null, 2));
