#!/usr/bin/env node
/**
 * Restores WordPress quotes that the importer emptied.
 *
 * Since WordPress 5.8 a quote block keeps its paragraphs as inner blocks.
 * The Gutenberg converter reads only the quote's own HTML, so each of those
 * quotes arrived as one empty blockquote, and every quote lost its <cite>.
 * This rebuilds each top-level quote from the export (paragraphs, links and
 * emphasis kept) and appends the citation as a final "— Name" line, which
 * the template's src/components/pt/Quote.astro renders as the quote's
 * footer (gotcha A1).
 *
 *   node fix-quotes.mjs [export.xml]                         dry run (default)
 *   node fix-quotes.mjs [export.xml] --apply --target local|staging
 *
 * The export defaults to paths.wxr. Re-runs recognise quotes already rebuilt.
 */
import { announce, clientFor, parseArgs, resolveTarget } from "./lib/cli.mjs";
import { CONFIG, requireConfig } from "./lib/config.mjs";
import { loadConverter } from "./lib/optional.mjs";
import { decodeEntities, norm, readWxr } from "./lib/wxr.mjs";

requireConfig("sites.wordpress");
const args = parseArgs(["target"]);
const wxrPath = args.positional[0] ?? CONFIG.paths.wxr;
const target = resolveTarget(args);
const dryRun = !target.apply;
const { api, listAll } = clientFor(target);
const { parseGutenbergBlocks, parseInlineContent } = await loadConverter();
announce(target, "fix-quotes");

let n = 0;
const key = () => `q${Date.now().toString(36)}${(n++).toString(36)}`;

const P = /<p\b[^>]*>([\s\S]*?)<\/p>/gi;
const LI = /<li\b[^>]*>([\s\S]*?)<\/li>/gi;
const CITE = /<cite\b[^>]*>([\s\S]*?)<\/cite>/i;

function block(html, prefix = "") {
	const { children, markDefs } = parseInlineContent(prefix + html.trim(), key);
	return { _type: "block", _key: key(), style: "blockquote", children, markDefs };
}

/** The paragraphs of one core/quote, as blockquote-styled blocks. */
function quoteBlocks(q) {
	const out = [];
	const inner = q.innerBlocks ?? [];
	if (inner.length) {
		for (const b of inner) {
			const html = b.innerHTML ?? "";
			if (b.blockName === "core/list") {
				for (const [, li] of html.matchAll(LI)) out.push(block(li, "• "));
				for (const item of b.innerBlocks ?? []) {
					const m = (item.innerHTML ?? "").match(/<li\b[^>]*>([\s\S]*?)<\/li>/i);
					if (m) out.push(block(m[1], "• "));
				}
			} else {
				const ps = [...html.matchAll(P)].map((m) => m[1]);
				if (ps.length) for (const p of ps) out.push(block(p));
				else if (html.replace(/<[^>]+>/g, "").trim()) out.push(block(html.replace(/<\/?h\d[^>]*>/g, "")));
			}
		}
	} else {
		const html = (q.innerHTML ?? "").replace(CITE, "");
		const ps = [...html.matchAll(P)].map((m) => m[1]);
		if (ps.length) for (const p of ps) out.push(block(p));
		else {
			const bare = html.replace(/<\/?blockquote[^>]*>/gi, "");
			if (bare.replace(/<[^>]+>/g, "").trim()) out.push(block(bare));
		}
	}
	const cite = (q.innerHTML ?? "").match(CITE)?.[1] ?? q.attrs?.citation;
	if (cite && cite.replace(/<[^>]+>/g, "").trim()) out.push(block(cite.replace(/^\s*[—–-]\s*/, ""), "— "));
	return out.filter((b) => b.children.some((c) => c.text?.trim()));
}

const textOf = (b) => (b.children ?? []).map((c) => c.text ?? "").join("");
const isQuote = (b) => b?._type === "block" && b.style === "blockquote" && !b.listItem;

/**
 * Where each WordPress quote landed: the converter wrote one empty block for
 * a quote with inner blocks, or one block per <p> for an older quote.
 * Adjacent quotes share a run, so they're located one at a time.
 */
function locate(content, quotes) {
	const plan = [];
	let cursor = 0;
	for (const q of quotes) {
		let i = cursor;
		while (i < content.length && !isQuote(content[i])) i++;
		if (i >= content.length) return null;
		// Already restored (a re-run): the quote's blocks match the rebuilt ones
		const fresh = quoteBlocks(q).map(textOf).map(norm);
		const here = content.slice(i, i + fresh.length);
		const done = fresh.length > 0 && here.length === fresh.length && here.every((b, k) => isQuote(b) && norm(textOf(b)) === fresh[k]);
		const len = done ? fresh.length : q.innerBlocks?.length ? 1 : Math.max(1, [...(q.innerHTML ?? "").matchAll(P)].length);
		for (let j = i; j < i + len; j++) if (!isQuote(content[j])) return null;
		plan.push([i, i + len]);
		cursor = i + len;
	}
	return plan;
}

const FIGURE_QUOTE = /<figure>\s*<blockquote[^>]*>([\s\S]*?)<\/blockquote>\s*(?:<figcaption>([\s\S]*?)<\/figcaption>)?\s*<\/figure>/g;
const plain = (html) => norm(decodeEntities(html.replace(/<[^>]+>/g, " ")));

/** Gutenberg quotes: rebuild each one where the converter left it. */
function fixGutenberg(slug, html, content) {
	const quotes = parseGutenbergBlocks(html).filter((b) => b.blockName === "core/quote");
	const found = locate(content, quotes);
	if (!found) return skipped.push(`${slug}: couldn't line up its ${quotes.length} quotes`), false;
	let changed = false;
	// Walk backwards so earlier indexes stay valid as runs change length
	for (let k = found.length - 1; k >= 0; k--) {
		const [start, end] = found[k];
		const fresh = quoteBlocks(quotes[k]);
		if (!fresh.length) continue;
		const current = content.slice(start, end).map(textOf).map(norm).join("\n");
		const wanted = fresh.map(textOf).map(norm).join("\n");
		if (current === wanted) continue;
		const body = fresh.filter((b) => !textOf(b).startsWith("— ")).map(textOf).map(norm).join("\n");
		if (current.trim() && current !== body) {
			skipped.push(`${slug}: quote ${k + 1} differs from WordPress, left alone`);
			continue;
		}
		// The converter put an attribute citation in a plain paragraph after the quote
		let drop = end - start;
		const after = content[end];
		const cite = fresh.at(-1);
		if (after && !isQuote(after) && cite && norm(`— ${textOf(after)}`) === norm(textOf(cite))) drop++;
		content.splice(start, drop, ...fresh);
		changed = true;
	}
	return changed;
}

/**
 * Classic posts quoted with <figure><blockquote>…<figcaption>. The HTML
 * converter dropped those, or ran the quote into the paragraph before it.
 */
function fixClassic(slug, html, content) {
	let changed = false;
	for (const m of html.matchAll(FIGURE_QUOTE)) {
		const paras = [...m[1].matchAll(P)].map((p) => p[1]);
		const fresh = (paras.length ? paras : [m[1]]).map((p) => block(p));
		if (m[2]) fresh.push(block(m[2].replace(/^\s*(&mdash;|—)\s*/, ""), "— "));
		const quoteText = norm(textOf(fresh[0]));
		if (content.some((b) => isQuote(b) && norm(textOf(b)) === quoteText)) continue;

		// Run into the previous paragraph: split those spans back out
		const host = content.findIndex((b) => b._type === "block" && (b.children ?? []).some((c) => norm(c.text ?? "") === quoteText));
		if (host >= 0) {
			const b = content[host];
			const at = b.children.findIndex((c) => norm(c.text ?? "") === quoteText);
			content.splice(host, 1, { ...b, children: b.children.slice(0, at) }, ...fresh);
			changed = true;
			continue;
		}
		// Dropped: put it back after the paragraph that preceded it
		const before = [...html.slice(0, m.index).matchAll(P)].pop();
		const anchor = before ? plain(before[1]).slice(0, 60) : null;
		const at = anchor ? content.findIndex((b) => norm(textOf(b)).startsWith(anchor)) : -1;
		if (at < 0) {
			skipped.push(`${slug}: no anchor for "${quoteText.slice(0, 40)}"`);
			continue;
		}
		content.splice(at + 1, 0, ...fresh);
		changed = true;
	}
	return changed;
}

const skipped = [];
const wxr = new Map(
	(await readWxr(wxrPath))
		.filter((i) => i.status === "publish" && (i.html.includes("<!-- wp:quote") || /<figure>\s*<blockquote/.test(i.html)))
		.map((i) => [`${i.collection}:${i.slug}`, i]),
);
console.log(`${wxr.size} published items have quotes to check.`);

let fixed = 0;
for (const collection of CONFIG.collections) {
	for await (const row of listAll(collection, { status: "published" })) {
		const item = wxr.get(`${collection}:${row.slug}`);
		if (!item) continue;
		const { item: entry, _rev } = await api(`/content/${collection}/${row.id}`);
		const content = [...(entry.data.content ?? [])];
		const changed = item.html.includes("<!-- wp:quote")
			? fixGutenberg(row.slug, item.html, content)
			: fixClassic(row.slug, item.html, content);
		if (!changed) continue;
		fixed++;
		if (dryRun) {
			console.log(`would fix ${collection}/${row.slug}`);
			continue;
		}
		await api(`/content/${collection}/${row.id}`, {
			method: "PUT",
			body: JSON.stringify({ data: { content }, _rev }),
		});
		await api(`/content/${collection}/${row.id}/publish`, { method: "POST", body: "{}" });
		console.log(`fixed ${collection}/${row.slug}`);
	}
}
console.log(`${dryRun ? "Would fix" : "Fixed"} ${fixed} entries.`);
for (const s of skipped) console.log(`  skipped ${s}`);
