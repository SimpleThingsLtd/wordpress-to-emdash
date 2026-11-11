#!/usr/bin/env node
/**
 * Link posts (gotcha A11): an opt-in convention, configured under linkPosts.
 *
 * Some sites saved "link log" posts as a paragraph ending in a trailer such as
 * "— Read on <a href>…</a>". This moves that URL into a field
 * (linkPosts.field, for example `link_url`), removes the trailer from the body
 * (the title can link out instead), expands URL shorteners, and republishes.
 *
 * When linkPosts.category is set, posts in that category without the trailer
 * fall back to a final paragraph that is only a URL, then to the post's last
 * outbound link.
 *
 *   node postprocess-links.mjs                                  dry run (default)
 *   node postprocess-links.mjs --apply --target local|staging
 *
 * Example config (a "— Read on <a>…</a>" trailer convention):
 *   "linkPosts": { "enabled": true, "field": "link_url", "category": "links",
 *                  "trailerBeforeLink": "—\\s*Read on\\s*$" }
 * The field must exist on the collection first (add it to the seed or admin).
 */
import { announce, clientFor, parseArgs, resolveTarget } from "./lib/cli.mjs";
import { CONFIG, isWordPressHost, requireConfig } from "./lib/config.mjs";

requireConfig("sites.wordpress");
const LP = CONFIG.linkPosts;
if (!LP.enabled) {
	console.log("linkPosts.enabled is false in migration.config.json: this site has no link-post convention to convert. Nothing to do.");
	process.exit(0);
}
const args = parseArgs(["target"]);
const target = resolveTarget(args);
const dryRun = !target.apply;
const { api, listAll } = clientFor(target);
announce(target, "postprocess-links");

const TRAILER = new RegExp(LP.trailerBeforeLink);

function extract(blocks) {
	if (!Array.isArray(blocks)) return null;
	for (let b = blocks.length - 1; b >= 0; b--) {
		const block = blocks[b];
		if (block?._type !== "block") continue;
		const kids = block.children ?? [];
		const i = kids.findIndex((k) => TRAILER.test(k.text ?? ""));
		if (i === -1) continue;
		const linkSpan = kids[i + 1];
		const markKey = linkSpan?.marks?.find((m) => block.markDefs?.some((d) => d._key === m));
		const href = block.markDefs?.find((d) => d._key === markKey)?.href;
		if (!href) return null;

		const before = kids.slice(0, i).map((k) => ({ ...k }));
		const leftover = (kids[i].text ?? "").replace(TRAILER, "");
		if (leftover.trim()) before.push({ ...kids[i], text: leftover });
		if (before.length) before[before.length - 1].text = before[before.length - 1].text.replace(/\s+$/, "");
		const keptMarks = new Set(before.flatMap((k) => k.marks ?? []));
		const nextBlock = before.some((k) => (k.text ?? "").trim())
			? { ...block, children: before, markDefs: (block.markDefs ?? []).filter((d) => keptMarks.has(d._key)) }
			: null;
		const content = [...blocks.slice(0, b), ...(nextBlock ? [nextBlock] : []), ...blocks.slice(b + 1)];
		return { href, content };
	}
	return null;
}

const BARE_URL = /^https?:\/\/\S+$/;
const textOf = (block) => (block?.children ?? []).map((k) => k.text ?? "").join("").trim();

/** Older link posts end with a paragraph that is nothing but the URL. */
function extractBareUrl(blocks) {
	if (!Array.isArray(blocks)) return null;
	let b = blocks.length - 1;
	while (b >= 0 && blocks[b]?._type === "block" && !textOf(blocks[b])) b--;
	const block = blocks[b];
	if (block?._type !== "block") return null;
	const text = textOf(block);
	if (!BARE_URL.test(text)) return null;
	const mark = block.children?.flatMap((k) => k.marks ?? [])[0];
	const href = block.markDefs?.find((d) => d._key === mark)?.href ?? text;
	return { href, content: blocks.slice(0, b) };
}

const isOwnSite = (href) => {
	try {
		const h = new URL(href).hostname;
		return isWordPressHost(h) || h === CONFIG.hosts.staging || h === CONFIG.hosts.final;
	} catch {
		return false;
	}
};

/** Last resort for posts filed under the link category: the final outbound link. */
function lastLink(blocks) {
	if (!Array.isArray(blocks)) return null;
	const hrefs = blocks
		.flatMap((b) => b?.markDefs ?? [])
		.filter((d) => d._type === "link" && /^https?:/.test(d.href ?? "") && !isOwnSite(d.href))
		.map((d) => d.href);
	return hrefs.length ? { href: hrefs[hrefs.length - 1], content: blocks } : null;
}

/** Expand IFTTT/bit.ly style short links to where they actually go. */
const SHORTENERS = new Set(LP.shorteners);
async function expand(href) {
	if (!LP.expandShorteners) return href;
	let url = href;
	for (let hop = 0; hop < 5; hop++) {
		let host;
		try {
			host = new URL(url).hostname.replace(/^www\./, "");
		} catch {
			return href;
		}
		if (!SHORTENERS.has(host)) return url;
		try {
			const res = await fetch(url, { method: "HEAD", redirect: "manual", signal: AbortSignal.timeout(8000) });
			const next = res.headers.get("location");
			if (!next) return url;
			url = new URL(next, url).toString();
		} catch {
			return url;
		}
	}
	return url;
}

let updated = 0;
const unmatched = [];
for await (const row of listAll(LP.collection, { status: "published" })) {
	const { item, _rev } = await api(`/content/${LP.collection}/${row.id}`);
	if (item.data[LP.field]) continue;
	let found = extract(item.data.content);
	if (!found && LP.category) {
		const cats = await api(`/content/${LP.collection}/${row.id}/terms/category`);
		const inLinks = cats.terms?.some((t) => t.slug === LP.category);
		if (inLinks) found = extractBareUrl(item.data.content) ?? lastLink(item.data.content);
		if (!found && inLinks) unmatched.push(item.slug);
	}
	if (!found) continue;
	updated++;
	found.href = await expand(found.href);
	if (dryRun) {
		console.log(`${item.slug} -> ${found.href}`);
		continue;
	}
	await api(`/content/${LP.collection}/${row.id}`, {
		method: "PUT",
		body: JSON.stringify({ data: { [LP.field]: found.href, content: found.content }, _rev }),
	});
	await api(`/content/${LP.collection}/${row.id}/publish`, { method: "POST", body: "{}" });
	process.stdout.write(`\r  ${updated} link posts updated`);
}
console.log(`\n${dryRun ? "Would update" : "Updated"} ${updated} link posts.`);
if (unmatched.length) {
	console.log(`${unmatched.length} posts in "${LP.category}" without the trailer:`);
	for (const s of unmatched) console.log(`  ${s}`);
}
