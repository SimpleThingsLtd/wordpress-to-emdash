#!/usr/bin/env node
/**
 * Drive EmDash's WordPress (WXR) importer from the command line.
 *
 * Runs the same API sequence as the admin's Import page:
 * analyze -> prepare (missing fields) -> execute (chunked) -> media (batched)
 * -> rewrite URLs. Safe to re-run: existing entries are skipped by slug and
 * media is de-duplicated by content hash.
 *
 *   node import-wordpress.mjs [export.xml] [--analyze-only]           analysis only (default)
 *   node import-wordpress.mjs [export.xml] --apply --target local|staging [--skip-media]
 *
 * The export defaults to paths.wxr. Which WordPress post types go to which
 * collection comes from content.postTypes; everything else in the export
 * (reusable blocks, nav items …) is left out. Importer options come from
 * the "import" section of the config.
 *
 * Import locally first and move the result to staging as a site package
 * (`npx emdash site export` / `site import`); see references/import-pipeline.md.
 */
import { readFile } from "node:fs/promises";
import { basename } from "node:path";
import { announce, clientFor, parseArgs, resolveTarget } from "./lib/cli.mjs";
import { CONFIG } from "./lib/config.mjs";

const args = parseArgs(["target"]);
const file = args.positional[0] ?? CONFIG.paths.wxr;
const analyzeOnly = args.flag("analyze-only") || !args.flag("apply");
const skipMedia = args.flag("skip-media");
if (args.flag("analyze-only") && args.flag("apply")) throw new Error("--analyze-only and --apply together: pick one");
const target = resolveTarget(args);
const { api } = clientFor(target);
announce(target, analyzeOnly ? "import-wordpress (analysis only)" : "import-wordpress");

const xml = await readFile(file);
const wxr = () => new File([xml], basename(file), { type: "application/xml" });

// 1. Analyze (reads the file; changes nothing on the site)
const form = new FormData();
form.append("file", wxr());
const analysis = await api("/import/wordpress/analyze", { method: "POST", body: form, readOnlySafe: true });
const WANTED = CONFIG.content.postTypes;
console.log(`Site: ${analysis.site?.title} (${analysis.site?.url})`);
for (const pt of analysis.postTypes) {
	const missing = Object.entries(pt.schemaStatus.fieldStatus)
		.filter(([, f]) => f.status !== "compatible")
		.map(([k, f]) => `${k}:${f.status}`);
	console.log(
		`  ${pt.name.padEnd(12)} ${String(pt.count).padStart(4)} -> ${pt.suggestedCollection}` +
			(missing.length ? `  [${missing.join(", ")}]` : "") +
			(pt.schemaStatus.canImport ? "" : `  BLOCKED: ${pt.schemaStatus.reason}`) +
			(!(pt.name in WANTED) ? "  (not imported)" : WANTED[pt.name] !== pt.suggestedCollection ? `  (imported into ${WANTED[pt.name]})` : ""),
	);
}
console.log(`  attachments ${analysis.attachments.count}, categories ${analysis.categories}, tags ${analysis.tags}`);
console.log(`  authors: ${analysis.authors.map((a) => `${a.login} (${a.displayName}, ${a.postCount})`).join(", ")}`);
const unmapped = analysis.postTypes.filter((pt) => !(pt.name in WANTED) && pt.count > 0).map((pt) => pt.name);
if (unmapped.length) console.log(`  not imported (add to content.postTypes to include): ${unmapped.join(", ")}`);
if (analyzeOnly) process.exit(0);

const selections = {};
for (const pt of analysis.postTypes) {
	selections[pt.name] = {
		collection: WANTED[pt.name] ?? pt.suggestedCollection,
		enabled: pt.name in WANTED,
	};
}

// 2. Prepare: create any missing fields on the target collections
const needsPrep = analysis.postTypes.filter(
	(pt) => selections[pt.name].enabled && (!pt.schemaStatus.exists || Object.values(pt.schemaStatus.fieldStatus).some((f) => f.status === "missing")),
);
if (needsPrep.length) {
	const prep = await api("/import/wordpress/prepare", {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({
			postTypes: needsPrep.map((pt) => ({
				name: pt.name,
				collection: selections[pt.name].collection,
				fields: pt.requiredFields,
			})),
		}),
	});
	console.log("Prepared:", JSON.stringify(prep.fieldsCreated ?? prep));
}

// 3. Execute in chunks: taxonomy -> content (loop) -> finalize
const opts = CONFIG.import;
const config = {
	postTypeMappings: selections,
	skipExisting: opts.skipExisting,
	authorMappings: Object.fromEntries(analysis.authors.map((a) => [a.login, null])),
	importMenus: opts.importMenus,
	importSiteTitle: opts.importSiteTitle,
	importLogo: opts.importLogo,
	importSeo: opts.importSeo,
};
async function chunk(phase, cursor, state) {
	const f = new FormData();
	f.append("file", wxr());
	f.append("config", JSON.stringify(config));
	f.append("phase", phase);
	if (cursor) f.append("cursor", JSON.stringify(cursor));
	if (state) f.append("chunk", JSON.stringify(state));
	return api("/import/wordpress/execute", { method: "POST", body: f });
}
const totals = { imported: 0, skipped: 0, errors: [] };
const add = (r) => {
	totals.imported += r?.imported ?? 0;
	totals.skipped += r?.skipped ?? 0;
	totals.errors.push(...(r?.errors ?? []));
};
let step = await chunk("taxonomy");
add(step.result);
let { cursor, chunk: state } = step;
let done = false;
while (!done) {
	step = await chunk("content", cursor, state);
	add(step.result);
	({ cursor, chunk: state, done } = step);
	process.stdout.write(`\r  content: ${totals.imported} imported, ${totals.skipped} skipped`);
}
step = await chunk("finalize", cursor, state);
add(step.result);
console.log(`\nImport done: ${totals.imported} imported, ${totals.skipped} skipped, ${totals.errors.length} errors`);
for (const e of totals.errors.slice(0, 20)) console.log(`  ! ${e.title}: ${e.error}`);

if (skipMedia) process.exit(0);

// 4. Media: small batches keep each request under Worker CPU limits
const items = analysis.attachments.items;
const batch = Math.max(1, Number(opts.mediaBatchSize) || 5);
const urlMap = {};
const failed = [];
for (let i = 0; i < items.length; i += batch) {
	const res = await api("/import/wordpress/media", {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ attachments: items.slice(i, i + batch), stream: false }),
	});
	Object.assign(urlMap, res.urlMap);
	failed.push(...(res.failed ?? []));
	process.stdout.write(`\r  media: ${Math.min(i + batch, items.length)}/${items.length}, ${failed.length} failed`);
}
console.log();
for (const f of failed.slice(0, 20)) console.log(`  ! ${f.originalUrl}: ${f.error}`);

// 5. Point content at the new media URLs
if (Object.keys(urlMap).length) {
	const rw = await api("/import/wordpress/rewrite-urls", {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ urlMap }),
	});
	console.log(`Rewrote ${rw.urlsRewritten} URLs across ${rw.updated} entries`);
}
