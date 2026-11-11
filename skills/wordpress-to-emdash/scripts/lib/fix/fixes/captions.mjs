/**
 * [caption] leftovers → captioned image blocks; [button] → a link; layout
 * shortcodes WordPress turned into boxes and columns ([one_half], [box] …)
 * lose their visible tag text.
 *
 * The importer pulled the <img> out of each [caption] as its own image
 * block and left the shortcode's text on either side of it:
 *   "[caption id="attachment_284" align="alignleft" …]"  [image]  " 1200px was …"
 * This removes the tag text, moves the caption onto the image block (from
 * the shortcode's caption="" attribute or the text before [/caption]), and
 * keeps the link the image had. If the image block is missing, it adds one
 * from the media library.
 */
import { CONFIG, escapeRe } from "../../config.mjs";
import { imageBlockFor, externalImageBlock, WP_ALIGN } from "../media.mjs";
import { isTextBlock, newKey, textOf, imageUrl, normaliseFilename, clone } from "../pt.mjs";
import { decodeEntities, norm } from "../../wxr.mjs";
import { editBlock, expandMarkers, MARK, tidy } from "../text-edit.mjs";
import { findShortcodes, parseAtts } from "../wp-structure.mjs";

// Layout and link shortcodes from the old theme: fixes.shortcodes.layout and .button
const LAYOUT = CONFIG.fixes.shortcodes.layout.map(escapeRe);
const BUTTONS = CONFIG.fixes.shortcodes.button.map(escapeRe);
const TOKEN = new RegExp(`\\[(\\/?)(${["caption", "wp_caption", ...LAYOUT].join("|")})\\b([^\\]]*)\\]`, "g");
const BUTTON = BUTTONS.length ? new RegExp(`\\[(${BUTTONS.join("|")})\\b([^\\]]*)\\]([\\s\\S]*?)\\[\\/\\1\\]`, "g") : null;
const HAS_TOKEN = new RegExp(`\\[\\/?(${["caption", "wp_caption", ...LAYOUT].join("|")})`);
const HAS_BUTTON = BUTTONS.length ? new RegExp(`\\[(${BUTTONS.join("|")})\\b`) : null;

const stripTags = (h) => decodeEntities(String(h ?? "").replace(/<[^>]+>/g, " ")).replace(/\s+/g, " ").trim();

/** The captions in the export, in order, with their image and text. */
function wxrCaptions(html) {
	return findShortcodes(html, ["caption", "wp_caption"]).map((sc) => {
		const inner = sc.inner ?? "";
		const img = inner.match(/<img\b[^>]*>/i)?.[0] ?? "";
		const a = (re) => img.match(re)?.[1];
		const href = inner.match(/<a\b[^>]*href=["']([^"']+)["'][^>]*>\s*<img/i)?.[1];
		const text = sc.atts.caption ?? stripTags(inner.replace(/<a\b[^>]*>\s*<img[^>]*>\s*<\/a>/gi, "").replace(/<img[^>]*>/gi, ""));
		return {
			id: sc.atts.id ?? null,
			attachmentId: Number((sc.atts.id ?? "").replace(/\D/g, "")) || Number(a(/wp-image-(\d+)/)) || null,
			align: sc.atts.align ?? null,
			src: a(/src=["']([^"']+)["']/i) ?? null,
			alt: decodeEntities(a(/alt=["']([^"']*)["']/i) ?? ""),
			href: href ? decodeEntities(href) : null,
			caption: decodeEntities(text).trim(),
			raw: sc.raw,
		};
	});
}

export default {
	id: "captions",
	label: "[caption] leftovers → captioned images; [button] → links; layout shortcodes removed",
	order: 10,
	run(entry, content, ctx) {
		const hasTokens = content.some((b) => isTextBlock(b) && (HAS_TOKEN.test(textOf(b)) || HAS_BUTTON?.test(textOf(b))));
		if (!hasTokens) return null;
		const wp = ctx.wxrFor(entry);
		const wanted = wp ? wxrCaptions(wp.html) : [];
		// The theme that drew [button] and the column/box shortcodes is gone, so WordPress shows them raw too
		const renderedHtml = ctx.wpRendered(entry)?.html ?? "";
		const rawOnWp = (name) => new RegExp(`\\[\\/?${name}\\b`).test(renderedHtml);
		const PAST_PARITY = "WordPress shows this shortcode as raw text today (the theme that drew it is gone), so this goes past parity";

		// 1. Tokens across the content, in order
		const tokens = [];
		content.forEach((b, bi) => {
			if (!isTextBlock(b)) return;
			const t = textOf(b);
			for (const m of t.matchAll(TOKEN)) tokens.push({ bi, start: m.index, end: m.index + m[0].length, close: m[1] === "/", tag: m[2], atts: parseAtts(m[3] ?? ""), raw: m[0] });
			if (BUTTON) for (const m of t.matchAll(BUTTON)) tokens.push({ bi, start: m.index, end: m.index + m[0].length, tag: m[1], button: true, atts: parseAtts(m[2] ?? ""), label: m[3].trim(), raw: m[0] });
		});
		tokens.sort((a, b) => a.bi - b.bi || a.start - b.start);

		const edits = new Map(); // block index → edits
		const addEdit = (bi, e) => (edits.has(bi) ? edits.get(bi).push(e) : edits.set(bi, [e]));
		const imagePatches = new Map(); // block index → patch
		const inserts = new Map();
		const items = [];
		let capN = 0;
		let insertN = 0;

		for (let i = 0; i < tokens.length; i++) {
			const t = tokens[i];
			if (t.button) {
				const href = t.atts.link ?? t.atts.url;
				if (!href) continue;
				addEdit(t.bi, { start: t.start, end: t.end, link: { href, label: t.label || href } });
				items.push({ kind: "button", summary: `[${t.tag}] → link “${t.label}” (${href})`, confidence: "high", bi: [t.bi], notes: rawOnWp(t.tag) ? [PAST_PARITY] : [] });
				continue;
			}
			if (t.tag !== "caption" && t.tag !== "wp_caption") {
				addEdit(t.bi, { start: t.start, end: t.end, text: "" });
				items.push({ kind: "layout", summary: `Layout shortcode tag removed: ${t.raw.slice(0, 60)}`, confidence: "high", bi: [t.bi], quiet: true, pastParity: rawOnWp(t.tag) });
				continue;
			}
			if (t.close) continue; // handled with its opening tag
			const close = tokens.slice(i + 1).find((x) => x.close && (x.tag === "caption" || x.tag === "wp_caption"));
			const w = wanted[capN++] ?? null;
			const idMatches = !w || !t.atts.id || !w.id || t.atts.id === w.id;

			// Image blocks between the tags
			const between = [];
			const endBi = close ? close.bi : t.bi;
			for (let k = t.bi + 1; k < endBi; k++) between.push(k);
			const images = between.filter((k) => content[k]?._type === "image");
			const strays = between.filter((k) => content[k]?._type === "block" && textOf(content[k]).trim());

			// Caption text the importer left as visible text, before [/caption]
			let leftText = "";
			if (close) {
				if (close.bi === t.bi) leftText = textOf(content[t.bi]).slice(t.end, close.start);
				else leftText = textOf(content[close.bi]).slice(0, close.start);
			}
			const caption = (t.atts.caption ? decodeEntities(t.atts.caption) : w?.caption ?? leftText).trim();
			const captionMatches = !leftText.trim() || norm(leftText) === norm(caption) || norm(caption).includes(norm(leftText));

			// Remove the tag text (and the caption text it wrapped)
			addEdit(t.bi, { start: t.start, end: t.end, text: images.length ? "" : MARK(insertN) });
			if (close) {
				if (close.bi === t.bi) addEdit(t.bi, { start: t.end, end: close.end, text: "" });
				else addEdit(close.bi, { start: 0, end: close.end, text: "" });
			}

			const align = WP_ALIGN[t.atts.align ?? w?.align ?? ""] ?? undefined;
			const linkHref = (content[t.bi].markDefs ?? []).find((d) => d._type === "link" && !(content[t.bi].children ?? []).some((c) => c.marks?.includes(d._key)))?.href;
			let confidence = idMatches && captionMatches && !strays.length ? "high" : "medium";
			const notes = [];
			if (/class=["'][^"']*\bimg-(blur|grayscale|greyscale|sepia|brightness|saturate|hue|contrast|invert)/i.test(w?.raw ?? "")) notes.push("WordPress applied a CSS filter class to this image; EmDash shows it unfiltered");
			if (!idMatches) notes.push(`shortcode id ${t.atts.id} doesn't match the export's ${w?.id}`);
			if (!captionMatches) notes.push(`caption text on the page (“${leftText.trim().slice(0, 60)}”) differs from the export`);
			if (strays.length) notes.push("other text sits inside the shortcode");

			if (images.length) {
				const k = images[0];
				imagePatches.set(k, { caption: caption || undefined, alignment: align, link: linkHref && !content[k].link ? { href: linkHref } : undefined });
				items.push({ kind: "caption", summary: `Captioned image${caption ? ` “${caption.slice(0, 70)}”` : ""}${align ? ` (${align})` : ""}`, confidence, bi: [t.bi, k, close?.bi].filter((x) => x !== undefined), notes });
			} else {
				// The image itself was lost: add it back from the media library
				const src = w?.src;
				const hit = src ? ctx.media.resolve(src) : null;
				const key = newKey("cap");
				const block = hit
					? imageBlockFor(hit.item, { key, alt: w?.alt, caption, alignment: align, link: linkHref ? { href: linkHref } : undefined })
					: src
						? externalImageBlock(src, { key, alt: w?.alt, caption, alignment: align })
						: null;
				if (block) {
					inserts.set(insertN, [block]);
					if (!hit) {
						confidence = "low";
						notes.push(`image not in the media library: ${src} (needs upload)`);
					}
				}
				insertN++;
				items.push({ kind: "caption", summary: `Image restored with caption${caption ? ` “${caption.slice(0, 70)}”` : ""}`, confidence: block ? confidence : "low", bi: [t.bi, close?.bi].filter((x) => x !== undefined), notes, images: src ? [src] : [] });
			}
		}

		// 2. Apply
		let next = content.map((b, bi) => {
			let nb = b;
			if (edits.has(bi)) nb = editBlock(nb, edits.get(bi));
			if (imagePatches.has(bi)) {
				nb = clone(nb);
				for (const [k, v] of Object.entries(imagePatches.get(bi))) if (v !== undefined) nb[k] = v;
			}
			return nb;
		});
		next = expandMarkers(next, inserts)
			.map((b) => (b._type === "block" ? tidy(b) : b))
			.filter(Boolean);

		// One proposal item per caption/button; layout removals are folded in
		const visible = items.filter((it) => !it.quiet);
		const layout = items.length - visible.length;
		const out = visible.map(({ bi, quiet, ...it }) => ({ ...it, beforeIdx: bi }));
		if (layout) out.push({ kind: "layout", summary: `${layout} layout shortcode tag${layout > 1 ? "s" : ""} ([one_half], [box] …) removed; WordPress once drew them as columns or boxes`, confidence: "high", notes: items.some((it) => it.pastParity) ? [PAST_PARITY] : [] });
		return { content: next, items: out, notes: wanted.length && capN !== wanted.length ? [`${capN} captions on the page, ${wanted.length} in the export`] : [] };
	},
};
