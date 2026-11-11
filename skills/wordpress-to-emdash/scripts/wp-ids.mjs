#!/usr/bin/env node
/**
 * Writes paths.wpIds (by default src/lib/wp-ids.json): WordPress post and
 * page IDs mapped to their addresses on the new site, so old ?p=123 and
 * ?page_id=45 links still land on the right page (gotcha C2). The home-page
 * snippet in templates/snippets/ reads it.
 *
 *   node wp-ids.mjs [export.xml] [--out file]
 *
 * Addresses follow content.entryPath ("/{slug}/" by default), using the slug
 * as WordPress stored it (a few are still percent-encoded, which is what
 * WordPress served). Only published items of the types in content.postTypes.
 */
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { parseArgs } from "./lib/cli.mjs";
import { CONFIG, entryPath } from "./lib/config.mjs";
import { field, items } from "./lib/wxr.mjs";

const args = parseArgs(["out"]);
const wxr = args.positional[0] ?? CONFIG.paths.wxr;
const out = args.opt("out", CONFIG.paths.wpIds);
const xml = await readFile(wxr, "utf8");

const ids = {};
for (const item of items(xml)) {
	const type = field(item, "wp:post_type");
	if (!(type in CONFIG.content.postTypes) || field(item, "wp:status") !== "publish") continue;
	const id = field(item, "wp:post_id");
	const slug = field(item, "wp:post_name");
	if (id && slug) ids[id] = entryPath(slug, CONFIG.content.postTypes[type]);
}
await mkdir(dirname(out), { recursive: true });
await writeFile(out, `${JSON.stringify(ids, null, "\t")}\n`);
console.log(`${Object.keys(ids).length} IDs → ${out}`);
