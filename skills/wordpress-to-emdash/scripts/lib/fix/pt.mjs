/**
 * Portable Text helpers for the content repairs. Everything here is pure:
 * blocks in, new blocks out; inputs are never mutated.
 */

export const clone = (v) => structuredClone(v);
export const isTextBlock = (b) => b?._type === "block";
export const textOf = (b) => (b?.children ?? []).map((c) => c.text ?? "").join("");

/** Text of any block type, for diffs and previews. */
export function plainOf(b) {
	if (!b) return "";
	switch (b._type) {
		case "block":
			return textOf(b);
		case "code":
			return b.code ?? "";
		case "image":
			return b.caption ?? b.alt ?? "";
		case "gallery":
			return (b.images ?? []).map((i) => i.caption ?? "").filter(Boolean).join(" ");
		case "embed":
			return b.caption ?? "";
		default:
			return "";
	}
}

let seq = 0;
/** Keys unique within a run; the prefix makes repaired blocks easy to spot. */
export const newKey = (prefix = "fx") => `${prefix}${Date.now().toString(36).slice(-4)}${(seq++).toString(36)}`;

/** Whitespace that never shows: \s plus zero-width characters. */
export const WS = /[\s​‌‍﻿]/;
export const skeleton = (s) => s.replace(/[\s​‌‍﻿]+/g, "");

/**
 * Character map of a text block: skeleton characters and where each one
 * sits in the block's concatenated text.
 */
export function charMap(block) {
	const text = textOf(block);
	const skel = [];
	const pos = [];
	for (let i = 0; i < text.length; i++) {
		if (!WS.test(text[i])) {
			skel.push(text[i]);
			pos.push(i);
		}
	}
	return { text, skel: skel.join(""), pos };
}

/** Span runs of a block as plain {text, marks, _key} records. */
const runsOf = (block) => (block.children ?? []).map((c) => ({ ...c, text: c.text ?? "" }));

/** Replace the raw text range [a, b) of a block's spans with `insert`. */
export function spliceRuns(runs, a, b, insert = "") {
	const out = [];
	let at = 0;
	let inserted = !insert;
	for (const r of runs) {
		const start = at;
		const end = at + r.text.length;
		at = end;
		if (end <= a || start >= b) {
			if (!inserted && start >= b) {
				// Insertion point fell exactly on a boundary before this run
				const prev = out.at(-1);
				if (prev) prev.text += insert;
				else out.push({ _type: "span", _key: `${r._key}-i`, text: insert, marks: [] });
				inserted = true;
			}
			out.push(r);
			continue;
		}
		const keepLeft = r.text.slice(0, Math.max(0, a - start));
		const keepRight = r.text.slice(Math.max(0, b - start));
		let text = keepLeft;
		if (!inserted && a >= start && a <= end) {
			text += insert;
			inserted = true;
		}
		text += keepRight;
		out.push({ ...r, text });
	}
	if (!inserted) {
		const prev = out.at(-1);
		if (prev) prev.text += insert;
		else out.push({ _type: "span", _key: "i0", text: insert, marks: [] });
	}
	return out;
}

/** Split span runs at raw offsets (ascending). Returns one run list per piece. */
export function splitRuns(runs, cuts) {
	const pieces = [[]];
	let at = 0;
	let ci = 0;
	let part = 0;
	for (const r of runs) {
		let start = 0;
		while (ci < cuts.length && cuts[ci] < at + r.text.length && cuts[ci] >= at) {
			const off = cuts[ci] - at;
			if (off > start) pieces.at(-1).push({ ...r, text: r.text.slice(start, off), _key: start ? `${r._key}-${part++}` : r._key });
			pieces.push([]);
			start = off;
			ci++;
		}
		if (start < r.text.length || (!r.text.length && !start)) {
			pieces.at(-1).push({ ...r, text: r.text.slice(start), _key: start ? `${r._key}-${part++}` : r._key });
		}
		at += r.text.length;
	}
	while (ci++ < cuts.length) pieces.push([]);
	return pieces;
}

/** Trim leading/trailing whitespace across a run list; drop empty runs. */
export function trimRuns(runs) {
	const out = runs.map((r) => ({ ...r }));
	while (out.length && !out[0].text.replace(/^[\s​﻿]+/, "")) out.shift();
	if (out.length) out[0].text = out[0].text.replace(/^[\s​﻿]+/, "");
	while (out.length && !out.at(-1).text.replace(/[\s​﻿]+$/, "")) out.pop();
	if (out.length) out.at(-1).text = out.at(-1).text.replace(/[\s​﻿]+$/, "");
	return out.filter((r) => r.text.length);
}

/** Rebuild a text block from runs, keeping only the markDefs still used. */
export function blockFromRuns(template, runs, overrides = {}) {
	const used = new Set(runs.flatMap((r) => r.marks ?? []));
	const markDefs = (template.markDefs ?? []).filter((d) => used.has(d._key));
	const children = runs.map((r) => {
		const c = { _type: "span", _key: r._key, text: r.text };
		if (r.marks?.length) c.marks = [...r.marks];
		return c;
	});
	const b = { ...template, ...overrides, children };
	if (markDefs.length) b.markDefs = markDefs;
	else delete b.markDefs;
	for (const k of Object.keys(overrides)) if (overrides[k] === undefined) delete b[k];
	return dedupeSpanKeys(b);
}

function dedupeSpanKeys(b) {
	const seen = new Set();
	for (const c of b.children) {
		let k = c._key || "s";
		let n = 0;
		while (seen.has(k)) k = `${c._key}-${++n}`;
		c._key = k;
		seen.add(k);
	}
	return b;
}

export { runsOf };

/** A plain paragraph (or other style) from text. */
export function textBlock(text, { style = "normal", listItem, level, key = newKey(), marks } = {}) {
	const b = { _type: "block", _key: key, style, children: [{ _type: "span", _key: `${key}s`, text, ...(marks?.length ? { marks } : {}) }] };
	if (listItem) Object.assign(b, { listItem, level: level ?? 1 });
	return b;
}

/** A paragraph with one link: prefix text, linked text, suffix. */
export function linkBlock({ before = "", label, href, after = "", style = "normal", key = newKey(), listItem, level }) {
	const lk = `${key}l`;
	const children = [];
	if (before) children.push({ _type: "span", _key: `${key}a`, text: before });
	children.push({ _type: "span", _key: `${key}b`, text: label, marks: [lk] });
	if (after) children.push({ _type: "span", _key: `${key}c`, text: after });
	const b = { _type: "block", _key: key, style, children, markDefs: [{ _type: "link", _key: lk, href }] };
	if (listItem) Object.assign(b, { listItem, level: level ?? 1 });
	return b;
}

/** Stable JSON for comparing blocks (key order independent). */
export function stable(v) {
	if (Array.isArray(v)) return `[${v.map(stable).join(",")}]`;
	if (v && typeof v === "object") return `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${stable(v[k])}`).join(",")}}`;
	return JSON.stringify(v);
}

/**
 * Block-level diff: which runs of `before` were replaced by which runs of
 * `after`. Blocks are matched by stable JSON (LCS), so untouched blocks
 * never show up as changes.
 */
export function diffBlocks(before, after) {
	const a = before.map(stable);
	const b = after.map(stable);
	const n = a.length;
	const m = b.length;
	// LCS on block identity (content is at most a few hundred blocks)
	const dp = Array.from({ length: n + 1 }, () => new Uint16Array(m + 1));
	for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
	const hunks = [];
	let i = 0;
	let j = 0;
	let cur = null;
	const flush = () => {
		if (cur) hunks.push(cur);
		cur = null;
	};
	while (i < n || j < m) {
		if (i < n && j < m && a[i] === b[j]) {
			flush();
			i++;
			j++;
		} else if (j < m && (i >= n || dp[i][j + 1] >= dp[i + 1][j])) {
			cur ??= { beforeIndex: i, afterIndex: j, before: [], after: [] };
			cur.after.push(after[j++]);
		} else {
			cur ??= { beforeIndex: i, afterIndex: j, before: [], after: [] };
			cur.before.push(before[i++]);
		}
	}
	flush();
	return hunks;
}

/** Media URL of an image-like block, wherever the importer put it. */
export const imageUrl = (b) => b?.asset?.url ?? b?.asset?._ref ?? b?.asset?.src ?? "";

/**
 * "Photo-1024x576.JPG", "photo-scaled.jpg" and "photo-e1700000000.jpg" all
 * become "photo.jpg" (fix-media-urls.mjs rules). add-redirects.mjs keeps
 * edited copies ("-e<timestamp>") apart with { stripEdited: false }.
 */
export function normaliseFilename(name, { stripEdited = true } = {}) {
	let clean = String(name ?? "").split(/[?#]/)[0].split("/").pop();
	try {
		clean = decodeURIComponent(clean);
	} catch {}
	clean = clean.toLowerCase();
	const dot = clean.lastIndexOf(".");
	const stem = dot > 0 ? clean.slice(0, dot) : clean;
	const ext = dot > 0 ? clean.slice(dot) : "";
	const base = stem.replace(/-\d+x\d+$/, "").replace(/-scaled$/, "");
	return (stripEdited ? base.replace(/-e\d{10,}$/, "") : base) + ext;
}
