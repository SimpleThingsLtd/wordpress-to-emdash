/**
 * Code that became paragraphs, and script/CSS source printed as text.
 *
 * 1. Every <pre> WordPress displayed (REST content.rendered, so exactly
 *    what visitors saw) that isn't a code block on the new page: find its
 *    characters in the page's text blocks (whitespace aside) and replace
 *    that stretch with a { _type: "code", code, language? } block. Code
 *    that's gone entirely goes back after the paragraph it followed.
 * 2. Pages where <script>/<style> source WordPress ran (and didn't show)
 *    is printed as text (gotcha A8): one proposal per page. The owner picks
 *    "code" (show it as code blocks) or "remove" in decisions.json, as
 *    "<slug>:code:script-text"; nothing changes until they do. A page that
 *    only prints <style> rules is recommended for "remove".
 */
import { charMap, isTextBlock, newKey, skeleton, textOf } from "../pt.mjs";
import { decodeEntities, norm } from "../../wxr.mjs";
import { blockFromRuns, runsOf, splitRuns, trimRuns } from "../pt.mjs";
import { attr, isEl, parseHtml } from "../wp-structure.mjs";

const codeNorm = (s) =>
	(s ?? "")
		.replace(/\r\n?/g, "\n")
		.split("\n")
		.map((l) => l.replace(/[ \t]+$/, ""))
		.join("\n")
		.replace(/^\n+|\n+$/g, "");

const LANG = { javascript: "javascript", js: "javascript", css: "css", markup: "html", html: "html", php: "php", bash: "bash", shell: "bash", json: "json", sql: "sql", apacheconf: "apache" };

/** The <pre> blocks WordPress displayed, with the text before each. */
function wordpressPres(renderedHtml) {
	const root = parseHtml(renderedHtml);
	const out = [];
	let lastText = "";
	const visit = (n) => {
		if (isEl(n) && n.tagName === "pre") {
			const cls = `${attr(n, "class") ?? ""} ${(n.childNodes ?? []).filter(isEl).map((c) => attr(c, "class") ?? "").join(" ")}`;
			if (/\bcodepen\b/.test(cls)) return;
			// Browsers run <script> inside <pre> instead of showing it
			const shown = (x) => (isEl(x) && ["script", "style", "noscript"].includes(x.tagName) ? "" : x.nodeName === "#text" ? x.value : isEl(x) && x.tagName === "br" ? "\n" : (x.childNodes ?? []).map(shown).join(""));
			const code = codeNorm(shown(n));
			if (code.trim()) {
				const lang = cls.match(/language-([\w-]+)/)?.[1];
				out.push({ code, language: lang ? LANG[lang] ?? lang : undefined, anchor: norm(lastText).slice(-60) });
			}
			return;
		}
		if (isEl(n) && ["script", "style", "noscript"].includes(n.tagName)) return;
		if (n.nodeName === "#text" && n.value.trim()) lastText = `${lastText} ${n.value}`.slice(-400);
		for (const c of n.childNodes ?? []) visit(c);
	};
	visit(root);
	return out;
}

/** Text blocks as one skeleton stream, to find code that spans blocks. */
function stream(blocks) {
	let S = "";
	const at = []; // skeleton index → [block index, raw offset]
	blocks.forEach((b, bi) => {
		if (!isTextBlock(b)) {
			S += "\u0002"; // a non-text block breaks any match
			at.push([bi, -1]);
			return;
		}
		const cm = charMap(b);
		for (let i = 0; i < cm.skel.length; i++) {
			S += cm.skel[i];
			at.push([bi, cm.pos[i]]);
		}
	});
	return { S, at };
}

function codeBlock(code, language) {
	const b = { _type: "code", _key: newKey("code"), code };
	if (language) b.language = language;
	return b;
}

/** Replace raw range [b1:o1 .. b2:o2] (o2 exclusive) with `insert`. */
function replaceRange(blocks, b1, o1, b2, o2, insert) {
	const first = blocks[b1];
	const last = blocks[b2];
	const before = trimRuns(splitRuns(runsOf(first), [o1])[0]);
	const after = trimRuns(splitRuns(runsOf(last), [o2])[1] ?? []);
	const out = blocks.slice(0, b1);
	if (before.length) out.push(blockFromRuns(first, before));
	out.push(...insert);
	if (after.length) out.push(blockFromRuns(last, after, { _key: b1 === b2 ? `${last._key}-c` : last._key }));
	out.push(...blocks.slice(b2 + 1));
	return out;
}

const PLANS = {
	remove: "Only <style> rules that WordPress applied and never showed. The text can go; the page loses nothing visible.",
	"needs-owner": "Script source that ran on WordPress (a widget, a demo or embed code) and never showed. Options: show it as a code block (if the post is about the code), remove it, or rebuild the widget by hand as an isolated HTML block.",
};

export default {
	id: "code",
	label: "Code blocks that became paragraphs; script source shown as text",
	order: 30,
	run(entry, content, ctx) {
		const rendered = ctx.wpRendered(entry);
		if (!rendered) return null;
		const items = [];
		const needsOwner = [];
		let next = content;

		// 1. <pre> blocks
		const pres = wordpressPres(rendered.html);
		const haveCode = () => next.filter((b) => b._type === "code").map((b) => skeleton(b.code ?? ""));
		for (const pre of pres) {
			const k = skeleton(pre.code);
			if (k.length < 6) continue;
			const existing = haveCode();
			if (existing.some((c) => c === k || c === skeleton(decodeEntities(pre.code)) || skeleton(decodeEntities(c)) === k)) continue;
			const { S, at } = stream(next);
			const i = S.indexOf(k);
			if (i >= 0) {
				const [b1, o1] = at[i];
				const [b2, oLast] = at[i + k.length - 1];
				const before = next.slice(b1, b2 + 1);
				next = replaceRange(next, b1, o1, b2, oLast + 1, [codeBlock(pre.code, pre.language)]);
				items.push({
					kind: "flattened",
					summary: `Code block restored (${pre.code.split("\n").length} lines${pre.language ? `, ${pre.language}` : ""}) from ${before.length} paragraph${before.length > 1 ? "s" : ""}`,
					confidence: "high",
				});
				continue;
			}
			// Not on the page at all: put it back after the text it followed
			const flatHit = S.indexOf(k.slice(0, 40));
			if (flatHit >= 0) {
				items.push({ kind: "partial", summary: `Code “${pre.code.split("\n")[0].slice(0, 60)}…” is on the page as text but doesn't match WordPress exactly; left as is`, confidence: "low", status: "needs-owner" });
				continue;
			}
			const anchor = pre.anchor.slice(-40);
			let pos = -1;
			for (let j = 0; j < next.length; j++) if (isTextBlock(next[j]) && norm(textOf(next[j])).includes(anchor)) pos = j;
			if (anchor && pos >= 0) {
				next = [...next.slice(0, pos + 1), codeBlock(pre.code, pre.language), ...next.slice(pos + 1)];
				items.push({ kind: "missing", summary: `Missing code block restored (${pre.code.split("\n").length} lines${pre.language ? `, ${pre.language}` : ""}) after “…${textOf(next[pos]).slice(-50)}”`, confidence: "medium" });
			} else {
				items.push({ kind: "missing", summary: `Missing code block “${pre.code.split("\n")[0].slice(0, 60)}…”: couldn't find where it goes`, confidence: "low", status: "needs-owner" });
			}
		}

		// 2. Script/CSS source printed as text: the exact characters of each
		//    <script>/<style> in the export, wherever they sit in the text
		const finding = ctx.audit.kinds(entry.slug, "code-shown-as-text")[0];
		const wp = ctx.wxrFor(entry);
		if (finding && wp) {
			const sources = [...wp.html.matchAll(/<(script|style)\b[^>]*>([\s\S]*?)<\/\1>/gi)].map((m) => ({ tag: m[1].toLowerCase(), text: decodeEntities(m[2]) })).filter((x) => skeleton(x.text).length > 20);
			const ranges = [];
			for (const src of sources) {
				const { S, at } = stream(next);
				const k = skeleton(src.text);
				// The converter sometimes dropped tag-like bits of the source; fall back to its first and last 40 characters
				let i = S.indexOf(k);
				let j = i >= 0 ? i + k.length - 1 : -1;
				if (i < 0) {
					i = S.indexOf(k.slice(0, 40));
					const tail = k.slice(-40);
					const t = i >= 0 ? S.indexOf(tail, i) : -1;
					j = t >= 0 ? t + tail.length - 1 : -1;
				}
				if (i < 0 || j < 0 || S.slice(i, j + 1).includes("\u0002")) continue;
				ranges.push({ src, b1: at[i][0], o1: at[i][1], b2: at[j][0], o2: at[j][1] + 1, exact: S.indexOf(k) >= 0, text: S.slice(i, j + 1) });
			}
			if (ranges.length) {
				const tags = new Set(ranges.map((r) => r.src.tag));
				const recommend = tags.size === 1 && tags.has("style") ? "remove" : "needs-owner";
				const build = (mode) => {
					let out = next;
					for (const r of [...ranges].reverse()) {
						const raw = (bi, from, to) => textOf(out[bi]).slice(from, to);
						const code = r.b1 === r.b2 ? raw(r.b1, r.o1, r.o2) : [raw(r.b1, r.o1), ...out.slice(r.b1 + 1, r.b2).map(textOf), raw(r.b2, 0, r.o2)].join("\n");
						out = replaceRange(out, r.b1, r.o1, r.b2, r.o2, mode === "code" ? [codeBlock(codeNorm(code), r.src.tag === "style" ? "css" : "javascript")] : []);
					}
					return out;
				};
				const option = { code: { label: "Show as code blocks", content: () => build("code") }, remove: { label: "Remove the text", content: () => build("remove") } };
				const chosen = ctx.decision(entry.slug, "code", "script-text");
				const entryItem = {
					kind: "script-text",
					summary: `${ranges.length} <${[...new Set(ranges.map((r) => r.src.tag))].join("/")}> source${ranges.length > 1 ? "s" : ""} that WordPress ran but never showed, printed as text. Recommendation: ${recommend === "needs-owner" ? "your call" : option[recommend].label.toLowerCase()}`,
					confidence: "low",
					notes: [PLANS[recommend], ...(ranges.some((r) => !r.exact) ? ["Matched by its first and last characters: the importer dropped tag-like parts of the source"] : [])],
					preview: ranges.map((r) => r.src.text.trim().slice(0, 500)),
					options: Object.fromEntries(Object.entries(option).map(([k, v]) => [k, v.label])),
					recommend,
				};
				if (chosen && option[chosen]) {
					next = option[chosen].content();
					// The owner's decision stands in for confidence
					items.push({ ...entryItem, confidence: "medium", decision: chosen });
				} else {
					needsOwner.push({ ...entryItem, status: "needs-owner", decisionKey: `${entry.slug}:code:script-text` });
				}
			}
		}
		if (!items.length && !needsOwner.length) return null;
		return { content: next, items, needsOwner };
	},
};
