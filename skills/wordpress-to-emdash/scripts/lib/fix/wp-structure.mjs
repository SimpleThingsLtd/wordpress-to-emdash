/**
 * What WordPress displayed, as a flat list of blocks, from a post's raw
 * export HTML: shortcodes swapped for placeholders, wpautop applied (classic
 * posts), then the DOM walked into paragraphs, headings, list items and
 * quote paragraphs. Images, code, figures, tables and embeds become "atom"
 * blocks: they separate text but carry none.
 */
import { CONFIG } from "../config.mjs";
import { loadFromConverter } from "../optional.mjs";
import { wpautop } from "./wpautop.mjs";

// parse5 is a dependency of the Gutenberg converter, so resolve it from there
const { parseFragment, serialize } = await loadFromConverter("parse5");
export { parseFragment, serialize };

// ------------------------------------------------------------ shortcodes

/** shortcode_parse_atts() */
export function parseAtts(s) {
	const atts = {};
	const re = /([\w-]+)\s*=\s*"([^"]*)"(?:\s|$)|([\w-]+)\s*=\s*'([^']*)'(?:\s|$)|([\w-]+)\s*=\s*([^\s'"]+)(?:\s|$)|"([^"]*)"(?:\s|$)|'([^']*)'(?:\s|$)|(\S+)(?:\s|$)/g;
	const text = s.replace(/[ ​]/g, " ");
	let m;
	let i = 0;
	while ((m = re.exec(text))) {
		if (m[1]) atts[m[1].toLowerCase()] = m[2];
		else if (m[3]) atts[m[3].toLowerCase()] = m[4];
		else if (m[5]) atts[m[5].toLowerCase()] = m[6];
		else atts[i++] = m[7] ?? m[8] ?? m[9];
	}
	return atts;
}

/** Every [tag ...]...[/tag] or self-closing [tag ...] for the given names. */
export function findShortcodes(html, names) {
	const out = [];
	const re = new RegExp(`\\[(${names.join("|")})\\b([^\\]]*?)(\\/)?\\]`, "g");
	let m;
	while ((m = re.exec(html))) {
		const [open, tag, attrs, selfClose] = m;
		let end = m.index + open.length;
		let inner = null;
		if (!selfClose) {
			const close = html.indexOf(`[/${tag}]`, end);
			const nextOpen = html.slice(end).search(new RegExp(`\\[${tag}\\b`));
			if (close >= 0 && (nextOpen < 0 || end + nextOpen > close)) {
				inner = html.slice(end, close);
				end = close + tag.length + 3;
			}
		}
		out.push({ tag, atts: parseAtts(attrs), open, inner, start: m.index, end, raw: html.slice(m.index, end) });
		re.lastIndex = end;
	}
	return out;
}

// WordPress core shortcodes, plus the theme's link shortcodes (fixes.shortcodes.button)
const SHORTCODE_NAMES = [...new Set(["caption", "wp_caption", "gallery", "embed", "video", "audio", "playlist", ...CONFIG.fixes.shortcodes.button])];
const BUTTONS = new Set(CONFIG.fixes.shortcodes.button);

/**
 * Replace shortcodes with HTML placeholders WordPress-style ([caption] as a
 * figure, [button] as a link) and return what was found.
 */
export function replaceShortcodes(html) {
	const found = findShortcodes(html, SHORTCODE_NAMES);
	let out = "";
	let at = 0;
	found.forEach((sc, i) => {
		out += html.slice(at, sc.start);
		at = sc.end;
		if (BUTTONS.has(sc.tag)) {
			const href = sc.atts.link ?? sc.atts.url ?? "#";
			out += `<a href="${href.replace(/"/g, "&quot;")}" data-fx-sc="${i}">${sc.inner ?? sc.atts.text ?? ""}</a>`;
		} else {
			out += `<figure data-fx-sc="${i}"></figure>`;
		}
	});
	out += html.slice(at);
	return { html: out, shortcodes: found };
}

// --------------------------------------------------------- DOM utilities

export const isEl = (n) => n && typeof n.tagName === "string";
export const attr = (n, name) => n?.attrs?.find((a) => a.name === name)?.value;
export function textContent(n) {
	if (!n) return "";
	if (n.nodeName === "#text") return n.value;
	if (n.nodeName === "#comment") return "";
	if (isEl(n) && n.tagName === "br") return "\n";
	if (n.tagName === "template") return textContent(n.content);
	return (n.childNodes ?? []).map(textContent).join("");
}
export function* walk(n) {
	yield n;
	for (const c of n.childNodes ?? []) yield* walk(c);
	if (n.tagName === "template" && n.content) yield* walk(n.content);
}
export const parseHtml = (html) => parseFragment(html);

// ------------------------------------------------------ the block walker

const BLOCK_TAGS = new Set(["p", "div", "section", "article", "header", "footer", "aside", "nav", "main", "address", "center", "form", "fieldset", "details", "summary", "dl", "dt", "dd", "hgroup", "figcaption", "caption", "tbody", "thead", "tfoot", "tr", "td", "th", "legend", "menu", "font"]);
const ATOM_TAGS = new Set(["img", "pre", "table", "iframe", "object", "embed", "video", "audio", "hr", "figure", "canvas", "svg", "input", "select", "textarea", "button"]);
const SKIP_TAGS = new Set(["script", "style", "noscript", "template", "head", "title", "meta", "link"]);
const HEADINGS = new Set(["h1", "h2", "h3", "h4", "h5", "h6"]);

/**
 * Flatten a DOM fragment into target blocks:
 *   { kind: "text", style, listItem?, level?, text }   text keeps "\n" for <br>
 *   { kind: "atom", tag, node }
 */
export function domToBlocks(root) {
	const blocks = [];
	let buf = "";
	let bufStyle = null;
	let bufEl = null;
	const ctx = { quote: 0, lists: [], liStack: [], el: null };

	const flush = () => {
		if (buf.replace(/[\s​﻿]+/g, "")) {
			const b = { kind: "text", style: bufStyle?.style ?? (ctx.quote ? "blockquote" : "normal"), text: buf, el: bufEl };
			if (bufStyle?.listItem) Object.assign(b, { listItem: bufStyle.listItem, level: bufStyle.level });
			blocks.push(b);
		}
		buf = "";
		bufStyle = null;
		bufEl = null;
	};
	const currentStyle = () => {
		const li = ctx.liStack.at(-1);
		if (li) return { style: "normal", listItem: li.listItem, level: li.level };
		return { style: ctx.quote ? "blockquote" : "normal" };
	};
	const start = () => {
		if (!bufStyle) bufStyle = currentStyle();
		if (!bufEl) bufEl = ctx.el;
	};
	const within = (el, fn) => {
		const prev = ctx.el;
		ctx.el = el;
		try {
			fn();
		} finally {
			ctx.el = prev;
		}
	};

	const visit = (n) => {
		if (n.nodeName === "#text") {
			start();
			// Browsers collapse source whitespace; only <br> makes a line break
			buf += n.value.replace(/[\t\n\r\f ]+/g, " ");
			return;
		}
		if (!isEl(n)) {
			for (const c of n.childNodes ?? []) visit(c);
			return;
		}
		const tag = n.tagName;
		if (SKIP_TAGS.has(tag)) return;
		if (tag === "br") {
			start();
			buf += "\n";
			return;
		}
		if (ATOM_TAGS.has(tag)) {
			flush();
			blocks.push({ kind: "atom", tag, node: n });
			return;
		}
		if (HEADINGS.has(tag)) {
			flush();
			within(n, () => {
				bufStyle = { style: tag };
				bufEl = n;
				for (const c of n.childNodes) visit(c);
				if (buf) bufStyle = { style: tag };
				flush();
			});
			return;
		}
		if (tag === "blockquote") {
			flush();
			ctx.quote++;
			for (const c of n.childNodes) visit(c);
			flush();
			ctx.quote--;
			return;
		}
		if (tag === "ul" || tag === "ol") {
			flush();
			ctx.lists.push(tag === "ol" ? "number" : "bullet");
			within(null, () => {
				for (const c of n.childNodes) visit(c);
			});
			flush();
			ctx.lists.pop();
			return;
		}
		if (tag === "li") {
			flush();
			ctx.liStack.push({ listItem: ctx.lists.at(-1) ?? "bullet", level: Math.max(1, ctx.lists.length) });
			within(n, () => {
				for (const c of n.childNodes) {
					// A <p> inside an <li> is still the list item's text
					if (isEl(c) && c.tagName === "p") {
						for (const cc of c.childNodes) visit(cc);
						start();
						buf += "\n";
					} else visit(c);
				}
			});
			flush();
			ctx.liStack.pop();
			return;
		}
		if (BLOCK_TAGS.has(tag)) {
			flush();
			within(tag === "p" ? n : ctx.el, () => {
				for (const c of n.childNodes) visit(c);
			});
			flush();
			return;
		}
		for (const c of n.childNodes) visit(c);
	};
	visit(root);
	flush();
	return blocks;
}

/**
 * Target blocks for a post as WordPress showed it. Classic posts get
 * wpautop; Gutenberg posts are already block HTML (comments are ignored).
 */
export function wordpressBlocks(rawHtml) {
	const classic = !rawHtml.includes("<!-- wp:");
	const { html, shortcodes } = replaceShortcodes(rawHtml);
	const prepared = classic ? wpautop(html) : html;
	const blocks = domToBlocks(parseHtml(prepared));
	return { classic, blocks, shortcodes, html: prepared };
}

// ------------------------------------------------------------- anchors

const normText = (s) =>
	s
		.toLowerCase()
		.replace(/[‘’‚′]/g, "'")
		.replace(/[“”„″]/g, '"')
		.replace(/[–—]/g, "-")
		.replace(/…/g, "...")
		.replace(/\s+/g, " ")
		.trim();

/** The last 60 characters of text WordPress showed before `offset` in the raw HTML. */
export function textBefore(rawHtml, offset) {
	const head = rawHtml.slice(0, offset).replace(/\[\/?[a-z_]+\b[^\]]*\]/g, "").replace(/<!--[\s\S]*?-->/g, "");
	const html = rawHtml.includes("<!-- wp:") ? head : wpautop(head);
	const blocks = domToBlocks(parseHtml(html)).filter((b) => b.kind === "text");
	const last = blocks.at(-1);
	return last ? normText(last.text).slice(-60) : null;
}

/** Index of the last block whose text contains the anchor (or -1). */
export function findAnchor(blocks, anchor, textOf) {
	if (!anchor) return -1;
	const a = anchor.slice(-40);
	for (let i = blocks.length - 1; i >= 0; i--) if (blocks[i]?._type === "block" && normText(textOf(blocks[i])).includes(a)) return i;
	return -1;
}
