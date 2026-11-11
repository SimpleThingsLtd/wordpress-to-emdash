#!/usr/bin/env node
/**
 * Redirects for addresses the old WordPress site answered that the new site
 * doesn't route itself (gotchas C1, C6):
 *   - every original upload (/wp-content/uploads/…) → its EmDash media URL
 *     (served by the template's src/pages/wp-content/uploads/[...path].ts,
 *     since EmDash's redirect middleware skips paths with file extensions);
 *   - each page in urls.replacedPages → its replacement;
 *   - redirects.rules from the config (author archives, old feeds …).
 * Existing sources are skipped, so it's safe to re-run.
 *
 *   node add-redirects.mjs [export.xml]                          dry run (default)
 *   node add-redirects.mjs [export.xml] --apply --target local|staging
 */
import { readFile } from "node:fs/promises";
import { announce, clientFor, parseArgs, resolveTarget } from "./lib/cli.mjs";
import { CONFIG, requireConfig } from "./lib/config.mjs";
import { normaliseFilename } from "./lib/fix/pt.mjs";

requireConfig("sites.wordpress");
const args = parseArgs(["target"]);
const wxrPath = args.positional[0] ?? CONFIG.paths.wxr;
const target = resolveTarget(args);
const { api, listPages } = clientFor(target);
announce(target, "add-redirects");
const xml = await readFile(wxrPath, "utf8");

const normalise = (name) => normaliseFilename(name, { stripEdited: false });

const library = new Map();
for await (const m of listPages("/media")) if (!library.has(normalise(m.filename))) library.set(normalise(m.filename), m.url);

const existing = new Set();
for await (const r of listPages("/redirects")) existing.add(r.source);

const group = CONFIG.redirects.group;
const slugOf = (k) => (k.includes(":") ? k.split(":").slice(1).join(":") : k);
const rules = [
	...CONFIG.redirects.rules.map((r) => ({ groupName: group, ...r })),
	...Object.entries(CONFIG.urls.replacedPages).map(([k, to]) => ({ source: `/${slugOf(k)}`, destination: to, groupName: group })),
];
const attachments = [...xml.matchAll(/<wp:attachment_url>(?:<!\[CDATA\[)?(.*?)(?:\]\]>)?<\/wp:attachment_url>/g)].map((m) => m[1]);
let unmatched = 0;
for (const url of attachments) {
	let path;
	try {
		path = new URL(url).pathname;
	} catch {
		continue;
	}
	const tgt = library.get(normalise(path.split("/").pop()));
	if (tgt) rules.push({ source: path, destination: tgt, groupName: CONFIG.redirects.uploadsGroup });
	else unmatched++;
}

let created = 0;
let wouldCreate = 0;
for (const rule of rules) {
	if (existing.has(rule.source)) continue;
	if (!target.apply) {
		wouldCreate++;
		if (wouldCreate <= 15) console.log(`  would add ${rule.source} -> ${rule.destination} (${rule.groupName})`);
		continue;
	}
	await api("/redirects", { method: "POST", body: JSON.stringify({ type: 301, ...rule }) }).then(
		() => created++,
		(err) => console.log(`  ! ${rule.source}: ${String(err.message).slice(0, 120)}`),
	);
}
if (target.apply) console.log(`${created} redirects created (${rules.length - created} already present or failed)`);
else console.log(`Would create ${wouldCreate} redirects (${rules.length - wouldCreate} already present)`);
if (unmatched) console.log(`${unmatched} uploads in the export have no matching media item (run fix-media-urls.mjs, or import them)`);
