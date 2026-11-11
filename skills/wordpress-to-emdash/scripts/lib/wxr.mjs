/**
 * Tiny WXR reader for the migration scripts: published posts and pages (or
 * whichever post types content.postTypes maps) with their raw Gutenberg or
 * classic HTML, plus text helpers shared by the checks.
 */
import { readFile } from "node:fs/promises";
import { CONFIG } from "./config.mjs";

/** One element's text from an <item>, CDATA unwrapped. */
export const field = (item, tag) => {
	const m = item.match(new RegExp(`<${tag}>(?:<!\\[CDATA\\[)?([\\s\\S]*?)(?:\\]\\]>)?</${tag}>`));
	return m ? m[1] : "";
};

/** Every <item> body in the export. */
export const items = (xml) => [...xml.matchAll(/<item>([\s\S]*?)<\/item>/g)].map((m) => m[1]);

export async function readWxr(path = CONFIG.paths.wxr, { types = Object.keys(CONFIG.content.postTypes) } = {}) {
	const xml = await readFile(path, "utf8");
	const out = [];
	for (const item of items(xml)) {
		const type = field(item, "wp:post_type");
		if (!types.includes(type)) continue;
		out.push({
			type,
			collection: CONFIG.content.postTypes[type] ?? `${type}s`,
			title: field(item, "title"),
			slug: safeDecode(field(item, "wp:post_name")),
			status: field(item, "wp:status"),
			html: field(item, "content:encoded"),
		});
	}
	return out;
}

export function safeDecode(s) {
	try {
		return decodeURIComponent(s);
	} catch {
		return s;
	}
}

const ENTITIES = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", hellip: "…", mdash: "—", ndash: "–", rsquo: "’", lsquo: "‘", rdquo: "”", ldquo: "“" };

export function decodeEntities(s) {
	return s
		.replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
		.replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)))
		.replace(/&([a-z]+);/gi, (m, n) => ENTITIES[n.toLowerCase()] ?? m);
}

/** Visible text, one line per block element. */
export function htmlToLines(html) {
	return decodeEntities(
		html
			.replace(/<!--[\s\S]*?-->/g, "")
			.replace(/<(script|style)[\s\S]*?<\/\1>/gi, "")
			.replace(/<br\s*\/?>/gi, " ")
			.replace(/<\/?(p|h[1-6]|li|blockquote|figcaption|pre|div|tr|td|th|cite|figure|ul|ol)\b[^>]*>/gi, "\n")
			.replace(/<[^>]+>/g, ""),
	)
		.split("\n")
		.map((l) => l.replace(/\s+/g, " ").trim())
		.filter(Boolean);
}

/** For fuzzy containment checks: lowercase, straight quotes, single spaces. */
export function norm(s) {
	return s
		.toLowerCase()
		.replace(/[‘’‚′]/g, "'")
		.replace(/[“”„″]/g, '"')
		.replace(/[–—]/g, "-")
		.replace(/…/g, "...")
		.replace(/\s+/g, " ")
		.trim();
}
