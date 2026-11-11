/**
 * Smaller text losses the audit found, each restored from the export or
 * from what WordPress rendered:
 *   - captions on videos, embeds, images and code figures
 *   - Gutenberg footnotes (the block rendered nothing)
 *   - social-links blocks (a list of profile links)
 *   - list items and paragraphs the converter dropped (an <li> without its
 *     </li>, text sitting directly inside a <ul>, text after a nested list)
 *   - image blocks that point at a WordPress attachment ID instead of a file
 * Text that belongs to a tweet or a link preview waits for the embed decision.
 */
import { loadConverter } from "../../optional.mjs";
import { imageBlockFor } from "../media.mjs";
import { clone, imageUrl, isTextBlock, newKey, normaliseFilename, textBlock, textOf } from "../pt.mjs";
import { decodeEntities, norm } from "../../wxr.mjs";
import { findAnchor, isEl, parseHtml, serialize, textBefore, walk, wordpressBlocks } from "../wp-structure.mjs";

const { parseInlineContent } = await loadConverter();

const sq = (s) => norm(decodeEntities(s ?? "")).replace(/[^a-z0-9]/g, "");
const strip = (h) => decodeEntities(String(h ?? "").replace(/<[^>]+>/g, " ")).replace(/\s+/g, " ").trim();

function inlineBlock(html, opts = {}) {
	let n = 0;
	const base = newKey("tl");
	const { children, markDefs } = parseInlineContent(html.trim(), () => `${base}${n++}`);
	const b = { _type: "block", _key: base, style: opts.style ?? "normal", children };
	if (markDefs.length) b.markDefs = markDefs;
	if (opts.listItem) Object.assign(b, { listItem: opts.listItem, level: opts.level ?? 1 });
	return b;
}

/** Where a figcaption's media is in the export: image file, video file, embed URL or <pre>. */
function figureFor(html, caption, nth = 0) {
	const want = sq(caption);
	let seen = 0;
	for (const m of html.matchAll(/<figure\b[\s\S]*?<\/figure>/gi)) {
		const cap = m[0].match(/<figcaption[^>]*>([\s\S]*?)<\/figcaption>/i);
		if (!cap || sq(strip(cap[1])) !== want) continue;
		if (seen++ < nth) continue;
		const fig = m[0];
		const img = fig.match(/<img\b[^>]*src=["']([^"']+)["']/i)?.[1];
		const video = fig.match(/<video\b[^>]*src=["']([^"']+)["']/i)?.[1] ?? fig.match(/<source\b[^>]*src=["']([^"']+)["']/i)?.[1];
		const embed = fig.match(/wp-block-embed__wrapper">\s*(\S+?)\s*<\/div>/i)?.[1];
		const pre = /<pre\b/i.test(fig);
		return { img, video, embed, pre, captionHtml: cap[1], offset: m.index };
	}
	return null;
}

export default {
	id: "textLoss",
	label: "Smaller text losses: captions, footnotes, list items, paragraphs",
	order: 80,
	run(entry, content, ctx) {
		const wp = ctx.wxrFor(entry);
		const rendered = ctx.wpRendered(entry);
		if (!wp) return null;
		const items = [];
		const needsOwner = [];
		let next = content.map((b) => b);
		const handled = new Set();

		// 1. Captions
		for (const f of ctx.audit.kinds(entry.slug, "captions-missing")) {
			const nth = new Map();
			for (const caption of f.details?.captions ?? []) {
				const n = nth.get(sq(caption)) ?? 0;
				nth.set(sq(caption), n + 1);
				const fig = figureFor(wp.html, caption, n);
				if (!fig) continue;
				const capText = strip(fig.captionHtml);
				let done = false;
				const setCaption = (b) => {
					if (b.caption) return b;
					done = true;
					return { ...clone(b), caption: capText };
				};
				const file = fig.img ?? fig.video;
				// Media URLs carry the storage key, so compare the media item's filename
				const fileOf = (u) => normaliseFilename(ctx.media.fromSiteUrl(u)?.filename ?? u);
				const want = file ? normaliseFilename(file) : null;
				const visitBlock = (b) => {
					if (done) return b;
					if (b._type === "columns") return { ...b, columns: b.columns.map((c) => ({ ...c, content: (c.content ?? []).map(visitBlock) })) };
					if (want && (b._type === "image" || b._type === "embed") && fileOf(b._type === "image" ? imageUrl(b) : b.url) === want) return setCaption(b);
					if (fig.embed && b._type === "embed" && (b.url ?? "").replace(/^https?:\/\/(www\.)?/, "").split(/[?#]/)[0] === fig.embed.replace(/^https?:\/\/(www\.)?/, "").split(/[?#]/)[0]) return setCaption(b);
					if (file && b._type === "gallery") {
						const images = b.images.map((im) => (!done && fileOf(imageUrl(im)) === want ? setCaption(im) : im));
						return done ? { ...b, images } : b;
					}
					return b;
				};
				next = next.map(visitBlock);
				const pageText = sq(next.map((b) => (isTextBlock(b) ? textOf(b) : "")).join(" "));
				if (!done && fig.pre && pageText.includes(sq(capText).slice(0, 60))) {
					handled.add(sq(caption));
					continue; // already under its code block (a re-run)
				}
				if (!done && fig.pre) {
					// A code figure's caption: a paragraph after the code block, links kept
					const anchor = textBefore(wp.html, fig.offset);
					let at = findAnchor(next, anchor, textOf);
					while (at >= 0 && next[at + 1] && next[at + 1]._type === "code") at++;
					if (at >= 0 && next[at]?._type === "code") {
						next = [...next.slice(0, at + 1), inlineBlock(fig.captionHtml), ...next.slice(at + 1)];
						done = true;
					}
				}
				if (done) {
					handled.add(sq(caption));
					items.push({ kind: "caption", summary: `Caption restored: “${capText.slice(0, 80)}”${fig.pre ? " (under its code block, links kept)" : ""}`, confidence: fig.pre ? "medium" : "high" });
				} else if (fig.embed || file) {
					handled.add(sq(caption));
					needsOwner.push({ kind: "caption", summary: `Caption “${capText.slice(0, 80)}” belongs to ${fig.embed ?? file}, which isn't on the page yet (see the embed decisions)`, status: "needs-owner" });
				}
			}
		}

		// 2. Gutenberg footnotes
		const fnAt = next.findIndex((b) => b._type === "htmlBlock" && /wp:footnotes/.test(b.html ?? ""));
		const fnList = rendered?.html.match(/<ol class="wp-block-footnotes">([\s\S]*?)<\/ol>/)?.[1];
		if (fnAt >= 0 && fnList) {
			const lis = [...fnList.matchAll(/<li\b[^>]*>([\s\S]*?)<\/li>/g)].map((m) => m[1].replace(/<a\b[^>]*aria-label="Jump to footnote[^"]*"[^>]*>[\s\S]*?<\/a>/g, "").trim());
			const blocks = lis.map((li) => inlineBlock(li, { listItem: "number" }));
			next = [...next.slice(0, fnAt), ...blocks, ...next.slice(fnAt + 1)];
			for (const li of lis) handled.add(sq(strip(li)));
			items.push({ kind: "footnotes", summary: `${lis.length} footnote${lis.length > 1 ? "s" : ""} restored as a numbered list (the footnotes block rendered nothing)`, confidence: "medium", notes: ["The superscript numbers in the text no longer jump to them; EmDash has no footnote block"] });
		}

		// 3. Social links block
		const social = [...wp.html.matchAll(/<!-- wp:social-link (\{[^]*?\}) \/-->/g)].map((m) => {
			try {
				return JSON.parse(m[1]);
			} catch {
				return null;
			}
		}).filter((a) => a?.url);
		if (social.length && !next.some((b) => isTextBlock(b) && b.markDefs?.some((d) => d.href === social[0].url))) {
			const NAMES = { linkedin: "LinkedIn", codepen: "CodePen", github: "GitHub", youtube: "YouTube" };
			const blocks = social.map((s) => {
				const label = s.label || NAMES[s.service] || s.service.charAt(0).toUpperCase() + s.service.slice(1);
				const k = newKey("so");
				return { _type: "block", _key: k, style: "normal", listItem: "bullet", level: 1, children: [{ _type: "span", _key: `${k}s`, text: label, marks: [`${k}l`] }], markDefs: [{ _type: "link", _key: `${k}l`, href: s.url }] };
			});
			const start = wp.html.indexOf("<!-- wp:social-links");
			const at = findAnchor(next, textBefore(wp.html, start), textOf);
			const emptyHtml = next.findIndex((b) => b._type === "htmlBlock" && /social-link/.test(b.html ?? ""));
			if (emptyHtml >= 0) next = [...next.slice(0, emptyHtml), ...blocks, ...next.slice(emptyHtml + 1)];
			else if (at >= 0) next = [...next.slice(0, at + 1), ...blocks, ...next.slice(at + 1)];
			if (emptyHtml >= 0 || at >= 0) {
				for (const s of social) handled.add(sq(s.label || NAMES[s.service] || s.service));
				items.push({ kind: "social", summary: `Social links block restored as a list of ${social.length} links (${social.map((s) => s.service).join(", ")})`, confidence: "medium" });
			}
		}

		// 4. Dropped list items and paragraphs
		const missing = ctx.audit.kinds(entry.slug, "list-items-missing", "paragraphs-missing", "quotes-missing").flatMap((f) => [...(f.details?.lost ?? []), ...(f.details?.paragraphs ?? []).map((p) => p.text), ...(f.details?.quotes ?? [])]);
		if (missing.length) {
			const tweets = [...(rendered?.html ?? "").matchAll(/<blockquote\b[^>]*(twitter-tweet|wp-embedded-content)[^>]*>([\s\S]*?)<\/blockquote>/gi)].map((m) => ({ kind: m[1], text: sq(strip(m[2])) }));
			const target = wordpressBlocks(wp.html).blocks.filter((b) => b.kind === "text");
			const inserted = new Set();
			const pageSq = sq(next.map((b) => (isTextBlock(b) ? textOf(b) : b.caption ?? "")).join(" "));
			for (const text of [...new Set(missing)]) {
				const s = sq(text);
				if (!s || handled.has(s) || pageSq.includes(s.slice(0, 60))) continue;
				const inEmbed = tweets.find((t) => t.text.includes(s.slice(0, 40)));
				if (inEmbed) {
					handled.add(s);
					needsOwner.push({ kind: "embed-text", summary: `“${text.slice(0, 80)}” is part of ${inEmbed.kind === "twitter-tweet" ? "an embedded tweet" : "a WordPress link preview"}: it comes back with that embed's decision`, status: "needs-owner" });
					continue;
				}
				const ti = target.findIndex((b) => sq(b.text).includes(s.slice(0, 60)) || (s.length > 20 && s.includes(sq(b.text)) && sq(b.text).length > 12));
				if (ti < 0) continue;
				const tb = target[ti];
				if (inserted.has(ti)) {
					handled.add(s);
					continue;
				}
				// Nested text that's already on the page as part of a longer item
				if (pageSq.includes(sq(tb.text).slice(0, 60))) continue;
				let style = { style: tb.style, listItem: tb.listItem, level: tb.level };
				let confidence = "medium";
				const notes = [];
				// Text after a nested list inside an <li>: keep it with the sub-items
				const prev = target[ti - 1];
				if (tb.listItem && prev?.listItem && (prev.level ?? 1) > (tb.level ?? 1)) {
					style = { style: "normal", listItem: prev.listItem, level: prev.level };
					confidence = "low";
					notes.push("WordPress showed this as a paragraph inside the list item, after its sub-list; Portable Text can't nest a paragraph there, so it becomes one more sub-item");
				}
				let block;
				if (tb.el && /^(li|p|h[1-6])$/.test(tb.el.tagName)) {
					const inner = serialize(tb.el)
						.replace(/<(ul|ol)\b[\s\S]*<\/\1>/gi, "")
						.replace(/[\t\n\r ]+/g, " ")
						.replace(/\s*<br\s*\/?>\s*/gi, "\n");
					block = inlineBlock(inner, style);
					if (sq(textOf(block)) !== sq(tb.text)) block = textBlock(tb.text.trim(), style);
				} else block = textBlock(tb.text.trim().replace(/ ?\n ?/g, "\n"), style);
				const anchorText = prev ? norm(decodeEntities(prev.text)).slice(-60) : null;
				const at = findAnchor(next, anchorText, textOf);
				if (at < 0) {
					needsOwner.push({ kind: "missing", summary: `“${text.slice(0, 80)}” is missing; couldn't find where it goes`, status: "needs-owner" });
					continue;
				}
				// Insert after the anchor and any blocks that continue it (nested items)
				let end = at;
				while (tb.listItem && next[end + 1]?.listItem && (next[end + 1].level ?? 1) > (style.level ?? 1)) end++;
				next = [...next.slice(0, end + 1), block, ...next.slice(end + 1)];
				handled.add(s);
				inserted.add(ti);
				const what = style.listItem ? "List item" : style.style === "blockquote" ? "Quote" : tb.text.includes("\n") ? "Lines" : "Paragraph";
				items.push({ kind: "missing", summary: `${what} restored: “${tb.text.trim().replace(/\s+/g, " ").slice(0, 90)}${tb.text.length > 90 ? "…" : ""}”`, confidence, notes });
			}
		}

		// 5. Image blocks pointing at a WordPress attachment ID
		const fixId = (b) => {
			if (b._type !== "image" || !/^\d+$/.test(imageUrl(b))) return b;
			const att = ctx.wxr.byId.get(Number(imageUrl(b)));
			const hit = att && ctx.media.resolve(att.url);
			if (!hit) return b;
			items.push({ kind: "attachment-id", summary: `Image that pointed at WordPress attachment #${imageUrl(b)} → media “${hit.item.filename}”`, confidence: "high", images: [att.url] });
			const nb = imageBlockFor(hit.item, { key: b._key, alt: b.alt ?? (decodeEntities(att.alt) || undefined), caption: b.caption });
			return nb;
		};
		next = next.map((b) => (b._type === "columns" ? { ...b, columns: b.columns.map((c) => ({ ...c, content: (c.content ?? []).map(fixId) })) } : fixId(b)));

		if (!items.length && !needsOwner.length) return null;
		return { content: next, items, needsOwner };
	},
};
