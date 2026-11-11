#!/usr/bin/env node
/**
 * The chunked WordPress import creates one guest byline per chunk for the
 * same author ("jsmith", "jsmith-2", "jsmith-3", …; gotcha A12). For each
 * entry in bylines.merge, fold the matching bylines into one target byline,
 * point every entry at it, and delete the duplicates.
 *
 *   node merge-bylines.mjs                                  dry run (default)
 *   node merge-bylines.mjs --apply --target local|staging
 *
 * Config:
 *   "bylines": { "merge": [ {
 *     "target": { "slug": "jane-smith", "displayName": "Jane Smith", "websiteUrl": "https://example.com", "isGuest": true },
 *     "duplicates": "^jsmith(-\\d+)?$"
 *   } ] }
 * Entries in content.bylineCollections are checked (default: every imported collection).
 */
import { announce, clientFor, parseArgs, resolveTarget } from "./lib/cli.mjs";
import { CONFIG, requireConfig } from "./lib/config.mjs";

requireConfig("sites.wordpress");
const merges = CONFIG.bylines.merge ?? [];
if (!merges.length) {
	console.log("bylines.merge is empty in migration.config.json: nothing to merge. List each author's target byline and a pattern for the per-chunk duplicates.");
	process.exit(0);
}
const args = parseArgs(["target"]);
const target = resolveTarget(args);
const { api, listAll, collect } = clientFor(target);
announce(target, "merge-bylines");

const bylines = await collect("/admin/bylines");
for (const m of merges) {
	if (!m.target?.slug || !m.duplicates) throw new Error("Each bylines.merge entry needs target.slug and a duplicates pattern");
	const pattern = new RegExp(m.duplicates);
	const isDuplicate = (b) => b.slug !== m.target.slug && pattern.test(b.slug);

	let tgt = bylines.find((b) => b.slug === m.target.slug);
	if (!tgt) {
		if (target.apply) {
			const created = await api("/admin/bylines", { method: "POST", body: JSON.stringify(m.target) });
			tgt = created.item ?? created;
			console.log(`created byline ${tgt.slug}`);
		} else {
			console.log(`would create byline ${m.target.slug} (${m.target.displayName ?? ""})`);
			tgt = { id: "(new)", slug: m.target.slug };
		}
	}
	const dupes = new Set(bylines.filter(isDuplicate).map((b) => b.id));
	console.log(`${m.target.slug}: ${dupes.size} duplicate bylines to fold in (${bylines.filter(isDuplicate).map((b) => b.slug).slice(0, 8).join(", ")}${dupes.size > 8 ? ", …" : ""})`);

	let moved = 0;
	for (const collection of CONFIG.content.bylineCollections) {
		for await (const row of listAll(collection)) {
			const { item, _rev } = await api(`/content/${collection}/${row.id}`);
			const ids = (item.bylines ?? []).map((c) => c.byline?.id ?? c.bylineId);
			const already = ids.length === 1 && ids[0] === tgt.id;
			if (already || (ids.length && !ids.some((id) => dupes.has(id)))) continue;
			moved++;
			if (!target.apply) continue;
			await api(`/content/${collection}/${row.id}`, {
				method: "PUT",
				body: JSON.stringify({ bylines: [{ bylineId: tgt.id }], _rev }),
			});
			if (moved % 25 === 0) process.stdout.write(`\r  ${moved} entries updated`);
		}
	}
	console.log(`\n${target.apply ? "" : "would credit "}${moved} entries ${target.apply ? "now credited " : ""}to ${m.target.displayName ?? m.target.slug}`);

	if (target.apply) {
		for (const id of dupes) await api(`/admin/bylines/${id}`, { method: "DELETE" });
		console.log(`deleted ${dupes.size} duplicate bylines`);
	} else console.log(`would delete ${dupes.size} duplicate bylines`);
}
