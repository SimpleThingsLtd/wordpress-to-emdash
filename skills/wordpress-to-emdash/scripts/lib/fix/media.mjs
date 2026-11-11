/**
 * WordPress upload URL → EmDash media item, for one target site.
 *
 * Local and staging hold the same files under different storage keys, so
 * proposals store the WordPress URL and every run (dry run on local, apply
 * on local or staging) resolves it against that site's own media library:
 *   1. the /wp-content/uploads/… redirect add-redirects.mjs created (exact)
 *   2. the same path without WordPress's -WxH / -scaled suffix
 *   3. the media filename, normalised the way fix-media-urls.mjs does it
 */
import { CONFIG, isWordPressHost } from "../config.mjs";
import { normaliseFilename } from "./pt.mjs";

const FILE_ROUTE = "/_emdash/api/media/file/";

export function mediaUrl(item) {
	return `${FILE_ROUTE}${item.storageKey}`;
}

export class MediaIndex {
	/**
	 * @param {Array<{id, filename, storageKey, mime?, width?, height?, alt?, caption?, size?}>} items
	 * @param {Array<{source, destination}>} redirects
	 */
	constructor(items, redirects, label = "local") {
		this.label = label;
		this.items = items;
		this.byKey = new Map(items.map((m) => [m.storageKey, m]));
		this.byId = new Map(items.map((m) => [m.id, m]));
		this.byName = new Map();
		for (const m of items) {
			const k = normaliseFilename(m.filename);
			if (!this.byName.has(k)) this.byName.set(k, []);
			this.byName.get(k).push(m);
		}
		this.byPath = new Map();
		for (const r of redirects) {
			if (!r.source?.startsWith("/wp-content/uploads/")) continue;
			const key = r.destination?.startsWith(FILE_ROUTE) ? r.destination.slice(FILE_ROUTE.length) : null;
			const item = key && this.byKey.get(key);
			if (item) this.byPath.set(r.source.toLowerCase(), item);
		}
	}

	static fromLocal(mediaRows, redirectRows) {
		return new MediaIndex(
			mediaRows.map((m) => ({ id: m.id, filename: m.filename, storageKey: m.storage_key, mime: m.mime_type, width: m.width, height: m.height, alt: m.alt, caption: m.caption, size: m.size })),
			redirectRows.filter((r) => r.enabled !== 0),
			"local",
		);
	}

	/** Media item from a URL already on this site (/_emdash/api/media/file/KEY). */
	fromSiteUrl(url) {
		const i = String(url ?? "").indexOf(FILE_ROUTE);
		if (i < 0) return null;
		return this.byKey.get(url.slice(i + FILE_ROUTE.length).split(/[?#]/)[0]) ?? null;
	}

	/**
	 * Resolve a WordPress (or any) image URL. Returns { item, via } or null.
	 */
	resolve(url) {
		if (!url) return null;
		const onSite = this.fromSiteUrl(url);
		if (onSite) return { item: onSite, via: "site-url" };
		let path = "";
		try {
			const u = new URL(url, CONFIG.sites.wordpress);
			if (isWordPressHost(u.hostname)) path = decodeURIComponent(u.pathname).toLowerCase();
		} catch {}
		if (path.startsWith("/wp-content/uploads/")) {
			const exact = this.byPath.get(path);
			if (exact) return { item: exact, via: "redirect" };
			const original = path.replace(/-\d+x\d+(\.[a-z0-9]+)$/i, "$1").replace(/-scaled(\.[a-z0-9]+)$/i, "$1");
			const viaOriginal = this.byPath.get(original);
			if (viaOriginal) return { item: viaOriginal, via: "redirect-original" };
		}
		const name = normaliseFilename(url);
		const hits = this.byName.get(name) ?? [];
		if (hits.length === 1) return { item: hits[0], via: "filename" };
		if (hits.length > 1) return { item: hits[0], via: "filename-ambiguous", candidates: hits.length };
		return null;
	}
}

/** An image block in the shape EmDash's editor writes. */
export function imageBlockFor(item, { key, alt, caption, alignment, link, width, height } = {}) {
	const b = {
		_type: "image",
		_key: key,
		asset: { _type: "reference", _ref: item.id, url: mediaUrl(item) },
	};
	const a = alt ?? item.alt;
	if (a) b.alt = a;
	if (caption) b.caption = caption;
	const w = width ?? item.width;
	const h = height ?? item.height;
	if (w) b.width = w;
	if (h) b.height = h;
	if (alignment) b.alignment = alignment;
	if (link) b.link = link;
	return b;
}

/** For images that only exist elsewhere (not in the media library yet). */
export function externalImageBlock(url, { key, alt, caption, alignment } = {}) {
	const b = { _type: "image", _key: key, asset: { _type: "reference", _ref: url, url } };
	if (alt) b.alt = alt;
	if (caption) b.caption = caption;
	if (alignment) b.alignment = alignment;
	return b;
}

export const WP_ALIGN = { alignleft: "left", alignright: "right", aligncenter: "center" };
