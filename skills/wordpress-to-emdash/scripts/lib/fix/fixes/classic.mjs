/**
 * Classic-editor posts: paragraphs, lists, headings and quotes.
 *
 * WordPress ran wpautop on these posts at display time (blank line =
 * paragraph, newline = <br>). The importer converted the raw HTML instead,
 * so a stretch of text between two block tags became one Portable Text
 * block with "\n\n" inside it, and in <div>-wrapped posts (often content
 * pasted from an older platform) every <p>, <li> and <h2> inside the div ran
 * together with no break at all ("listings.As").
 *
 * The repair never re-imports. It keeps every existing span (text, marks,
 * links, the URLs fix-media-urls rewrote, the trailers postprocess-links
 * removed) and only decides where blocks start and what style they have, by
 * lining the block's visible characters up against what WordPress showed.
 * Whitespace is the only thing it adds or removes: a "\n" where WordPress
 * had a <br> but the text ran together, and the "\n\n" at each new block
 * edge. Each rebuilt block is checked: its characters, whitespace aside,
 * must equal the original's.
 */
import { linkTrailerSkeleton } from "../../config.mjs";
import { WS, blockFromRuns, charMap, isTextBlock, runsOf, skeleton, splitRuns, spliceRuns, textOf, trimRuns } from "../pt.mjs";
import { wordpressBlocks } from "../wp-structure.mjs";

const HEADING = /^h[1-6]$/;

/** The target stream: WordPress's text blocks as one skeleton string. */
function targetStream(blocks) {
	let T = "";
	const starts = new Set();
	const brAt = new Set();
	const blockOf = [];
	const textBlocks = [];
	for (const b of blocks) {
		if (b.kind !== "text") continue;
		const k = textBlocks.length;
		textBlocks.push(b);
		const start = T.length;
		let pendingBr = false;
		for (const ch of b.text) {
			if (ch === "\n") pendingBr = true;
			else if (WS.test(ch)) continue;
			else {
				if (pendingBr && T.length > start) brAt.add(T.length);
				pendingBr = false;
				T += ch;
				blockOf.push(k);
			}
		}
		if (T.length > start) starts.add(start);
	}
	return { T, starts, brAt, blockOf, textBlocks };
}

// The link-post trailer postprocess-links.mjs moved into the link field (linkPosts.trailerWords)
const TRAILER = linkTrailerSkeleton();

function locate(stream, s, cursor) {
	const { T, starts } = stream;
	const L = s.length;
	const endOk = (i) => starts.has(i + L) || i + L === T.length;
	let firstStart = -1;
	let first = -1;
	for (let i = T.indexOf(s, cursor); i >= 0; i = T.indexOf(s, i + 1)) {
		if (first < 0) first = i;
		if (starts.has(i)) {
			if (endOk(i)) return { at: i, aligned: "both" };
			if (firstStart < 0) firstStart = i;
		}
	}
	if (firstStart >= 0) {
		// A link post whose "— Read on …" trailer was moved into link_url
		const k = stream.blockOf[firstStart + L - 1];
		let end = firstStart + L;
		while (end < T.length && stream.blockOf[end] === k) end++;
		const tail = T.slice(firstStart + L, end);
		return { at: firstStart, aligned: TRAILER?.test(tail) ? "trailer" : "start" };
	}
	if (first >= 0 && L >= 24) return { at: first, aligned: "none" };
	return null;
}

/** Portable Text style fields for a WordPress block. */
function styleFor(target, current) {
	if (target.listItem) return { style: "normal", listItem: target.listItem, level: target.level ?? 1 };
	if (HEADING.test(target.style)) return { style: target.style, listItem: undefined, level: undefined };
	if (target.style === "blockquote") return { style: "blockquote", listItem: undefined, level: undefined };
	if (current.style === "blockquote") return { style: "blockquote", listItem: undefined, level: undefined };
	return { style: "normal", listItem: undefined, level: undefined };
}
const styleLabel = (b) => (b.listItem ? `${b.listItem} list item` : b.style === "normal" ? "paragraph" : b.style === "blockquote" ? "quote" : `heading ${b.style.slice(1)}`);

/**
 * Re-segment one block. Returns null when nothing changes.
 */
function resegment(block, at, stream, aligned) {
	const cm = charMap(block);
	const s = cm.skel;
	const L = s.length;
	const cuts = [];
	const brs = [];
	const kinds = new Set();
	for (let q = at + 1; q < at + L; q++) {
		const gapStart = cm.pos[q - at - 1] + 1;
		const gapEnd = cm.pos[q - at];
		const gap = cm.text.slice(gapStart, gapEnd);
		if (stream.starts.has(q)) {
			cuts.push({ q, raw: gapEnd, hadBreak: gap.includes("\n") });
			kinds.add(gap.includes("\n") ? "split" : "glued");
		} else if (stream.brAt.has(q) && gap !== "\n") {
			if (!gap.includes("\n")) kinds.add("glued-br");
			brs.push({ a: gapStart, b: gapEnd });
		}
	}

	// Styles of the pieces
	const pieceStarts = [at, ...cuts.map((c) => c.q)];
	const targets = pieceStarts.map((q) => stream.textBlocks[stream.blockOf[q]]);
	const unsplitStyleChange = !cuts.length && (block.style ?? "normal") === "normal" && !block.listItem && (targets[0].listItem || HEADING.test(targets[0].style) || targets[0].style === "blockquote");
	if (!cuts.length && !brs.length && !unsplitStyleChange) return null;

	// Apply whitespace edits (back to front), then split
	let runs = runsOf(block);
	const rawCuts = cuts.map((c) => c.raw);
	const edits = [...brs].sort((x, y) => y.a - x.a);
	for (const e of edits) {
		runs = spliceRuns(runs, e.a, e.b, "\n");
		const delta = 1 - (e.b - e.a);
		for (let i = 0; i < rawCuts.length; i++) if (rawCuts[i] >= e.b) rawCuts[i] += delta;
	}
	const pieces = splitRuns(runs, rawCuts).map(trimRuns);

	const out = [];
	pieces.forEach((pr, i) => {
		if (!pr.length) return;
		const st = cuts.length || unsplitStyleChange ? styleFor(targets[i], block) : {};
		if (st.style && st.style !== (block.style ?? "normal")) kinds.add(HEADING.test(st.style) ? "heading" : st.style === "blockquote" ? "quote" : "restyle");
		if (st.listItem && !block.listItem) kinds.add("list");
		const key = i === 0 ? block._key : `${block._key}-p${i}`;
		out.push(blockFromRuns(block, pr, { ...st, _key: key }));
	});

	// Never change text: the visible characters must survive exactly
	const after = skeleton(out.map(textOf).join(""));
	if (after !== s) throw new Error(`classic repair changed text in block ${block._key}`);
	return { blocks: out, kinds, cuts: cuts.length, brs: brs.length, aligned };
}

function confidenceFor(kinds, aligned) {
	if (aligned === "none" || aligned === "start") return "low";
	if (kinds.has("glued") || kinds.has("glued-br") || kinds.has("heading") || kinds.has("quote") || kinds.has("list") || kinds.has("restyle")) return "medium";
	return "high";
}

const KIND_TEXT = {
	split: "paragraph breaks restored",
	glued: "run-together paragraphs separated",
	"glued-br": "missing line breaks restored",
	list: "list items restored",
	heading: "headings restored",
	quote: "quote restored",
	restyle: "style restored",
};

export default {
	id: "classic",
	label: "Classic-editor posts: paragraphs, line breaks, lists, headings, quotes",
	order: 50,
	run(entry, content, ctx) {
		const wp = ctx.wxrFor(entry);
		if (!wp || wp.html.includes("<!-- wp:")) return null;
		const { blocks: targetBlocks } = wordpressBlocks(wp.html);
		const stream = targetStream(targetBlocks);
		if (!stream.T) return null;

		const next = [];
		const items = [];
		const unmatched = [];
		let cursor = 0;
		for (let i = 0; i < content.length; i++) {
			const block = content[i];
			if (!isTextBlock(block)) {
				next.push(block);
				continue;
			}
			const s = charMap(block).skel;
			if (!s) {
				next.push(block);
				continue;
			}
			const hit = locate(stream, s, cursor);
			if (!hit) {
				if (s.length >= 12) unmatched.push(textOf(block).slice(0, 80));
				next.push(block);
				continue;
			}
			cursor = hit.at + s.length;
			const res = resegment(block, hit.at, stream, hit.aligned);
			if (!res) {
				next.push(block);
				continue;
			}
			const kinds = [...res.kinds];
			const confidence = confidenceFor(res.kinds, res.aligned);
			const applied = !ctx.allows || ctx.allows(confidence);
			if (applied) next.push(...res.blocks);
			else next.push(block);
			items.push({
				applied,
				kind: kinds.includes("glued") || kinds.includes("glued-br") ? "glued" : kinds.includes("list") ? "list" : kinds.includes("heading") ? "heading" : kinds.includes("quote") ? "quote" : "split",
				kinds,
				summary: `${kinds.map((k) => KIND_TEXT[k]).join(", ")}: 1 block → ${res.blocks.length} (${[...new Set(res.blocks.map(styleLabel))].join(", ")})`,
				confidence,
				before: [block],
				after: res.blocks,
			});
		}
		if (!items.length) return { content, items: [], notes: unmatched.length ? [`${unmatched.length} text blocks didn't line up with WordPress (left alone)`] : [] };
		return { content: next, items, notes: unmatched.length ? [`${unmatched.length} text blocks didn't line up with WordPress and were left alone: ${unmatched.slice(0, 3).map((t) => `“${t}…”`).join("; ")}`] : [] };
	},
};
