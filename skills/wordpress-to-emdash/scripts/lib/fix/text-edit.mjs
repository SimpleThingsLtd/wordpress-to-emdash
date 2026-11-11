/**
 * Text surgery on Portable Text blocks: remove or replace character ranges
 * of a block's concatenated span text, and split a block where an inserted
 * block belongs. Marks and markDefs stay with their characters.
 */
import { blockFromRuns, newKey, runsOf, spliceRuns, splitRuns, textOf, trimRuns } from "./pt.mjs";

/** Marker for "a new block goes here", embedded in text while editing. */
export const MARK = (n) => `\u0000${n}\u0000`;
const MARKER_RE = /\u0000(\d+)\u0000/;

/**
 * Apply edits to one block. Each edit: { start, end, text?, link? }.
 * `link` replaces the range with a linked span ({ href, label }).
 */
export function editBlock(block, edits) {
	let runs = runsOf(block);
	let markDefs = [...(block.markDefs ?? [])];
	for (const e of [...edits].sort((a, b) => b.start - a.start)) {
		if (e.link) {
			const lk = newKey("lk");
			markDefs.push({ _type: "link", _key: lk, href: e.link.href });
			runs = spliceRuns(runs, e.start, e.end, "\u0001");
			// Swap the placeholder character for its own linked span
			const out = [];
			for (const r of runs) {
				const i = r.text.indexOf("\u0001");
				if (i < 0) {
					out.push(r);
					continue;
				}
				if (i > 0) out.push({ ...r, text: r.text.slice(0, i) });
				out.push({ _type: "span", _key: newKey("sp"), text: e.link.label, marks: [lk] });
				if (i + 1 < r.text.length) out.push({ ...r, _key: `${r._key}-r`, text: r.text.slice(i + 1) });
			}
			runs = out;
		} else {
			runs = spliceRuns(runs, e.start, e.end, e.text ?? "");
		}
	}
	return blockFromRuns({ ...block, markDefs }, runs);
}

/**
 * Split blocks at embedded markers and put the matching inserts there.
 * Text pieces are trimmed; pieces left empty are dropped.
 */
export function expandMarkers(blocks, inserts) {
	const out = [];
	for (const b of blocks) {
		if (b._type !== "block" || !MARKER_RE.test(textOf(b))) {
			out.push(b);
			continue;
		}
		const text = textOf(b);
		const cuts = [];
		const order = [];
		const re = /\u0000(\d+)\u0000/g;
		let m;
		while ((m = re.exec(text))) {
			cuts.push(m.index, m.index + m[0].length);
			order.push(Number(m[1]));
		}
		const pieces = splitRuns(runsOf(b), cuts);
		pieces.forEach((runs, i) => {
			if (i % 2 === 1) {
				out.push(...(inserts.get(order[(i - 1) / 2]) ?? []));
				return;
			}
			const trimmed = trimRuns(runs);
			if (trimmed.length) out.push(blockFromRuns(b, trimmed, { _key: i === 0 ? b._key : `${b._key}-m${i}` }));
		});
	}
	return out;
}

/** Trim a block's edges; null when nothing visible is left. */
export function tidy(block) {
	if (block._type !== "block") return block;
	const runs = trimRuns(runsOf(block));
	if (!runs.length) return null;
	return blockFromRuns(block, runs);
}
