/**
 * Comments from a WXR export: every <wp:comment>, with the post it belongs to.
 *
 * WordPress keeps comment bodies as HTML (with its own autop applied on
 * display). EmDash stores and renders a comment body as plain text, so
 * bodies are converted here: links become "text (url)", paragraphs become
 * blank lines, entities are decoded.
 */
import { readFile } from "node:fs/promises";
import { decodeEntities, field, items, safeDecode } from "../wxr.mjs";

const COMMENT_RE = /<wp:comment>([\s\S]*?)<\/wp:comment>/g;
const ZERO_DATE = /^0000-00-00/;

/**
 * Read the export. Returns { posts: Map<wpPostId, post>, comments: comment[] }.
 * Every comment is returned, approved or not: the filter decides.
 */
export async function readWxrComments(path, { timeZone } = {}) {
	const xml = await readFile(path, "utf8");
	const posts = new Map();
	const comments = [];
	for (const item of items(xml)) {
		const own = item.replace(COMMENT_RE, "");
		const wpId = Number(field(own, "wp:post_id"));
		if (!wpId) continue;
		const post = {
			wpId,
			type: field(own, "wp:post_type"),
			slug: field(own, "wp:post_name"),
			title: decodeEntities(field(own, "title")),
			status: field(own, "wp:status"),
		};
		posts.set(wpId, post);
		for (const m of item.matchAll(COMMENT_RE)) {
			const c = m[1];
			const html = field(c, "wp:comment_content");
			comments.push({
				wpId: Number(field(c, "wp:comment_id")),
				postWpId: wpId,
				parentWpId: Number(field(c, "wp:comment_parent")) || null,
				author: decodeEntities(field(c, "wp:comment_author")).replace(/\s+/g, " ").trim(),
				email: field(c, "wp:comment_author_email").trim(),
				url: decodeEntities(field(c, "wp:comment_author_url")).trim(),
				userId: Number(field(c, "wp:comment_user_id")) || 0,
				approved: field(c, "wp:comment_approved").trim(),
				type: field(c, "wp:comment_type").trim() || "comment",
				date: toIsoUtc(field(c, "wp:comment_date_gmt"), field(c, "wp:comment_date"), timeZone),
				html,
				text: htmlToText(html),
			});
		}
	}
	return { posts, comments };
}

/** WordPress "YYYY-MM-DD HH:MM:SS" (GMT) as ISO 8601 UTC; local time in `timeZone` when GMT is the zero date. */
export function toIsoUtc(gmt, local, timeZone) {
	if (gmt && !ZERO_DATE.test(gmt)) {
		const d = new Date(`${gmt.trim().replace(" ", "T")}Z`);
		if (!Number.isNaN(d.getTime())) return d.toISOString();
	}
	if (local && !ZERO_DATE.test(local)) {
		const asUtc = new Date(`${local.trim().replace(" ", "T")}Z`);
		if (Number.isNaN(asUtc.getTime())) return null;
		if (!timeZone) return asUtc.toISOString();
		// Shift by the zone's offset at that moment (approximate around DST changes, as WordPress itself is)
		const parts = Object.fromEntries(
			new Intl.DateTimeFormat("en-US", { timeZone, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit" })
				.formatToParts(asUtc)
				.map((p) => [p.type, p.value]),
		);
		const zoned = Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, parts.second);
		return new Date(asUtc.getTime() - (zoned - asUtc.getTime())).toISOString();
	}
	return null;
}

const stripTags = (s) => s.replace(/<[^>]+>/g, "");
const sameUrl = (a, b) => a.replace(/^https?:\/\/(www\.)?/i, "").replace(/\/+$/, "").toLowerCase() === b.replace(/^https?:\/\/(www\.)?/i, "").replace(/\/+$/, "").toLowerCase();

/** A comment's HTML as the plain text EmDash stores: "text (url)" links, blank lines between paragraphs. */
export function htmlToText(html) {
	let s = String(html ?? "").replace(/\r\n?/g, "\n");
	// Entities are decoded once, at the end, so encoded "<" in text never meets the tag stripper
	s = s.replace(/<a\b[^>]*?href\s*=\s*(["'])(.*?)\1[^>]*>([\s\S]*?)<\/a\s*>/gi, (_, _q, href, inner) => {
		const text = stripTags(inner).replace(/\s+/g, " ").trim();
		const url = href.trim();
		if (!/^https?:\/\//i.test(url)) return text;
		const plain = decodeEntities(text);
		const plainUrl = decodeEntities(url);
		if (!text || sameUrl(plain, plainUrl) || plain.includes(plainUrl)) return url;
		return `${text} (${url})`;
	});
	s = s
		.replace(/<br\s*\/?>/gi, "\n")
		.replace(/<\/p\s*>/gi, "\n\n")
		.replace(/<\/?(p|div|blockquote|pre|ul|ol|li|h[1-6]|table|tr)\b[^>]*>/gi, "\n")
		.replace(/<[^>]+>/g, "");
	s = decodeEntities(s);
	return s
		.split("\n")
		.map((l) => l.replace(/[ \t ]+/g, " ").trim())
		.join("\n")
		.replace(/\n{3,}/g, "\n\n")
		.trim();
}

/** Slug variants to look an entry up by: as exported, decoded, and lower-cased encoded. */
export function slugKeys(slug) {
	const raw = String(slug ?? "");
	const decoded = safeDecode(raw);
	return [...new Set([raw, decoded, raw.toLowerCase(), encodeURIComponent(decoded).toLowerCase()])].filter(Boolean);
}
