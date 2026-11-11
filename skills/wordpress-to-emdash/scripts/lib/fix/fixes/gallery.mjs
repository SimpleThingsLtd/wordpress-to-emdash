/**
 * Galleries and missing images.
 *
 * [gallery] shortcodes reached EmDash as raw text, or not at all. Each one
 * is rebuilt as a gallery block from the export: the ids="" list when it
 * has one, otherwise the images attached to the post, in WordPress's order
 * (menu_order, then ID). Captions and alt text come from the attachments.
 * Each image is mapped to the media item already imported for it.
 *
 * Images the audit found missing outside galleries are put back after the
 * paragraph they followed on WordPress.
 */
import { externalImageBlock, imageBlockFor, mediaUrl } from "../media.mjs";
import { isTextBlock, newKey, normaliseFilename, textOf } from "../pt.mjs";
import { decodeEntities, norm } from "../../wxr.mjs";
import { expandMarkers, editBlock, MARK, tidy } from "../text-edit.mjs";
import { findShortcodes, parseHtml, domToBlocks } from "../wp-structure.mjs";
import { wpautop } from "../wpautop.mjs";

const IMAGE_EXT = /\.(jpe?g|png|gif|webp|bmp|svg)$/i;
const GALLERY_TEXT = /\[gallery\b[^\]]*\]/g;

/** WordPress gallery_shortcode() image selection. */
function galleryAttachments(sc, post, wxr) {
	const ids = (sc.atts.ids ?? sc.atts.include ?? "").split(",").map((s) => Number(s.trim())).filter(Boolean);
	if (ids.length) return ids.map((id) => wxr.byId.get(id) ?? { id, missing: true });
	const exclude = new Set((sc.atts.exclude ?? "").split(",").map((s) => Number(s.trim())).filter(Boolean));
	return wxr.attachments
		.filter((a) => a.parent === post.id && IMAGE_EXT.test(a.url) && !exclude.has(a.id))
		.sort((a, b) => a.menuOrder - b.menuOrder || a.id - b.id);
}

/** The text WordPress showed just before an offset of the raw HTML. */
function textBefore(html, offset) {
	const blocks = domToBlocks(parseHtml(wpautop(html.slice(0, offset).replace(/\[[^\]]+\]/g, ""))));
	const last = blocks.filter((b) => b.kind === "text").at(-1);
	return last ? norm(decodeEntities(last.text)).slice(-60) : null;
}

async function resolveAttachment(a, ctx) {
	const hit = ctx.media.resolve(a.url);
	if (hit) return { ...hit, how: hit.via };
	// Not imported under its own name: the importer skips files whose bytes
	// it already has (IMG_29381.jpg is IMG_2938.jpg uploaded twice)
	const head = await ctx.probe(a.url);
	if (head.status === 200 && head.length) {
		const stem = normaliseFilename(a.url).replace(/\.[^.]+$/, "").replace(/[-_]?\d$/, "");
		const twin = ctx.media.items.find((m) => m.size === head.length && normaliseFilename(m.filename).startsWith(stem));
		if (twin) return { item: twin, via: "duplicate-bytes", how: `same size as ${twin.filename}` };
	}
	return { item: null, status: head.status };
}

export default {
	id: "gallery",
	label: "Galleries and missing images",
	order: 20,
	async run(entry, content, ctx) {
		const wp = ctx.wxrFor(entry);
		if (!wp) return null;
		const items = [];
		const inserts = new Map();
		let insertN = 0;
		let next = content;

		// 1. [gallery] shortcodes
		const galleries = findShortcodes(wp.html, ["gallery"]);
		const existingGalleries = content.filter((b) => b._type === "gallery");
		for (const [gi, sc] of galleries.entries()) {
			const atts = galleryAttachments(sc, wp, ctx.wxr);
			if (!atts.length) continue;
			const images = [];
			const unresolved = [];
			const how = [];
			let lowest = "high";
			for (const a of atts) {
				if (a.missing) {
					unresolved.push({ id: a.id, url: null, why: "attachment not in the export" });
					continue;
				}
				const r = await resolveAttachment(a, ctx);
				const caption = decodeEntities(a.caption ?? "").trim() || undefined;
				const alt = decodeEntities(a.alt ?? "").trim() || undefined;
				const key = newKey("gi");
				if (r.item) {
					const img = imageBlockFor(r.item, { key, alt, caption });
					images.push(img);
					if (r.via === "duplicate-bytes" || r.via === "filename-ambiguous") {
						lowest = "medium";
						how.push(`${a.url.split("/").pop()} wasn't imported under its own name; using ${r.item.filename} (${r.how})`);
					}
				} else {
					unresolved.push({ id: a.id, url: a.url, why: r.status === 200 ? "not in the media library (needs upload)" : `not in the media library and WordPress returns ${r.status}` });
					images.push(externalImageBlock(a.url, { key, alt, caption }));
					lowest = "low";
				}
			}
			// Already rebuilt (re-run): a gallery with these images is there
			const already = existingGalleries.some((g) => (g.images ?? []).length >= images.length && images.every((im) => (g.images ?? []).some((x) => normaliseFilename(x.asset?.url ?? "") === normaliseFilename(im.asset.url) || x.asset?._ref === im.asset._ref)));
			if (already) continue;

			const block = { _type: "gallery", _key: newKey("gal"), images, columns: Number(sc.atts.columns ?? 3) || 3 };
			// Where: the raw [gallery] text if it's on the page, else after the paragraph before it
			const textAt = next.findIndex((b) => isTextBlock(b) && GALLERY_TEXT.test(textOf(b)));
			GALLERY_TEXT.lastIndex = 0;
			let placed = false;
			if (textAt >= 0) {
				const t = textOf(next[textAt]);
				const m = [...t.matchAll(GALLERY_TEXT)][0];
				inserts.set(insertN, [block]);
				next = next.map((b, i) => (i === textAt ? editBlock(b, [{ start: m.index, end: m.index + m[0].length, text: MARK(insertN) }]) : b));
				insertN++;
				placed = "replaces the raw [gallery] text";
			} else {
				const anchor = textBefore(wp.html, sc.start);
				const at = anchor ? findAnchor(next, anchor) : -1;
				if (at >= 0) {
					next = [...next.slice(0, at + 1), block, ...next.slice(at + 1)];
					placed = "after the paragraph it followed on WordPress";
				}
			}
			if (!placed) {
				items.push({ kind: "gallery", summary: `Gallery of ${images.length} images: couldn't find where it goes`, confidence: "low", status: "needs-owner", images: atts.map((a) => a.url).filter(Boolean) });
				continue;
			}
			if (unresolved.length && lowest !== "low") lowest = "medium";
			items.push({
				kind: "gallery",
				summary: `Gallery of ${images.length} images rebuilt from the export (${sc.atts.ids ? "ids list" : "images attached to the post"}, ${block.columns} columns), ${placed}${sc.atts.orderby === "rand" ? "; WordPress shuffled it on every load, this keeps the ids order" : ""}`,
				confidence: lowest,
				images: atts.map((a) => a.url).filter(Boolean),
				unresolved,
				notes: [...how, ...unresolved.map((u) => `${u.url ?? `#${u.id}`}: ${u.why}`)],
			});
		}

		// 2. Single images the audit found missing
		for (const f of ctx.audit.kinds(entry.slug, "images-missing")) {
			for (const src of f.details?.unmatchedOld ?? []) {
				if (next.some((b) => b._type === "image" && normaliseFilename(b.asset?.url ?? "") === normaliseFilename(src))) continue;
				const at = wp.html.indexOf(src.replace(/^https?:/, "")) >= 0 ? wp.html.indexOf(src.replace(/^https?:/, "")) : wp.html.indexOf(src);
				if (at < 0) continue;
				const imgTag = wp.html.slice(wp.html.lastIndexOf("<img", at), wp.html.indexOf(">", at) + 1);
				const alt = decodeEntities(imgTag.match(/alt=["']([^"']*)["']/i)?.[1] ?? "");
				const anchor = textBefore(wp.html, wp.html.lastIndexOf("<img", at));
				const pos = anchor ? findAnchor(next, anchor) : -1;
				const hit = ctx.media.resolve(src);
				const head = hit ? null : await ctx.probe(src);
				const loads = head?.status === 200 && /^image\//.test(head.type ?? "");
				const archived = hit || loads ? null : await ctx.wayback(src);
				const key = newKey("img");
				const url = hit ? null : loads ? head.final : archived ?? src;
				const block = hit ? imageBlockFor(hit.item, { key, alt }) : externalImageBlock(url, { key, alt });
				if (pos < 0) {
					items.push({ kind: "image", summary: `Missing image ${src}: couldn't find where it goes`, confidence: "low", status: "needs-owner", images: [src] });
					continue;
				}
				// After the paragraph (or the end of the quote) it followed
				let end = pos;
				while (next[end + 1]?._type === "block" && next[end + 1].style === "blockquote" && next[pos].style === "blockquote") end++;
				const where = `after “${textOf(next[end]).slice(0, 50)}…”`;
				if (!hit && !loads) {
					// Gone from where WordPress hotlinked it: only an archived copy is left
					items.push({
						kind: "image",
						summary: `Missing image ${where}: the original (${src}) is gone${archived ? "; the Wayback Machine has a copy" : ""}`,
						confidence: "low",
						status: "needs-owner",
						images: [archived ?? src],
						notes: [archived ? `Upload ${archived} to the media library and insert it, or leave the image out` : "No archived copy found: leave it out"],
					});
					continue;
				}
				next = [...next.slice(0, end + 1), block, ...next.slice(end + 1)];
				items.push({
					kind: "image",
					summary: `Missing image restored ${where}${hit ? "" : ` from ${url} (hotlinked from another site; upload it before cutover)`}`,
					confidence: hit ? "high" : "medium",
					images: [src],
				});
			}
		}

		if (!items.length) return null;
		next = expandMarkers(next, inserts).map((b) => (b._type === "block" ? tidy(b) : b)).filter(Boolean);
		return { content: next, items };
	},
};

function findAnchor(blocks, anchor) {
	const a = anchor.slice(-40);
	for (let i = blocks.length - 1; i >= 0; i--) if (isTextBlock(blocks[i]) && norm(textOf(blocks[i])).includes(a)) return i;
	return -1;
}

export { mediaUrl };
