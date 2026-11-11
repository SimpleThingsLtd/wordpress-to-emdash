/**
 * The parity audit's extraction and comparison code, shared by
 * compare-sites.mjs and fix-content's self-check (lib/fix/verify.mjs), so
 * both score pages the same way.
 *
 * analyse() and liveEmbeds() run inside a browser page (Playwright's
 * page.evaluate), so they must stay self-contained: everything they need,
 * including the CSS selectors from migration.config.json, arrives in their
 * argument. selectorsFromConfig() builds that argument.
 */
import { CONFIG, linkTrailerLine } from "./config.mjs";
import { decodeEntities, norm } from "./wxr.mjs";

const asList = (v) => (v == null || v === "" ? [] : Array.isArray(v) ? v : [v]);

/** The selectors analyse() needs, from the config. */
export function selectorsFromConfig() {
	const n = CONFIG.newSite.selectors;
	return {
		content: asList(n.content),
		title: asList(n.title),
		date: asList(n.date),
		categories: asList(n.categories),
		tags: asList(n.tags),
		featured: asList(n.featured),
		isPost: asList(n.isPost),
		comment: asList(n.comment),
		linkUrl: CONFIG.linkPosts.enabled ? asList(CONFIG.linkPosts.newSiteSelector) : [],
		ignoreNew: asList(n.ignore),
		ignoreOld: asList(CONFIG.wordpress.selectors.ignore),
	};
}

// ---------------------------------------------------- in-browser analysis

/**
 * Runs in the page (DOMParser): turns content HTML into comparable parts.
 * mode "old" = REST content.rendered wrapped in #__root, "new" = a whole
 * rendered EmDash page. `sel` comes from selectorsFromConfig().
 */
export function analyse({ html, mode, base, sel }) {
	const doc = new DOMParser().parseFromString(html, "text/html");
	const abs = (u) => {
		if (!u) return null;
		try {
			return new URL(u, base).href;
		} catch {
			return u;
		}
	};
	const clean = (s) =>
		(s || "")
			.replace(/[   ]/g, " ")
			.replace(/[​-‍﻿]/g, "")
			.replace(/\s+/g, " ")
			.trim();
	const hostType = (u) => {
		const s = (u || "").toLowerCase();
		if (/youtube(-nocookie)?\.com|youtu\.be/.test(s)) return "youtube";
		if (/vimeo\.com/.test(s)) return "vimeo";
		if (/codepen\.io/.test(s)) return "codepen";
		if (/slideshare\.net/.test(s)) return "slideshare";
		if (/twitter\.com|\/\/x\.com|twimg/.test(s)) return "tweet";
		if (/gist\.github/.test(s)) return "gist";
		if (/instagram\.com/.test(s)) return "instagram";
		if (/spotify\.com/.test(s)) return "spotify";
		if (/soundcloud\.com/.test(s)) return "soundcloud";
		if (/google\.[a-z.]+\/maps|maps\.google/.test(s)) return "map";
		if (/docs\.google\.com/.test(s)) return "google-docs";
		if (/\.(mp4|m4v|webm|mov|ogv)(\?|$)/.test(s)) return "video";
		if (/\.(mp3|m4a|ogg|wav)(\?|$)/.test(s)) return "audio";
		const host = (s.match(/^(?:https?:)?\/\/(?:www\.)?([^/:?#]+)/) || [])[1];
		return host || "other";
	};
	const S = sel || {};
	const list = (v) => (Array.isArray(v) ? v : v ? [v] : []);
	/** First element matching any selector, tried in order. */
	const first = (sels) => {
		for (const s of list(sels)) {
			const el = doc.querySelector(s);
			if (el) return el;
		}
		return null;
	};
	/** First non-empty text among the selectors, tried in order. */
	const firstText = (sels) => {
		for (const s of list(sels)) {
			const t = doc.querySelector(s)?.textContent;
			if (t) return t;
		}
		return "";
	};
	const all = (sels) => (list(sels).length ? [...doc.querySelectorAll(list(sels).join(", "))] : []);

	const out = { meta: null };
	let root;
	if (mode === "old") {
		root = doc.getElementById("__root") || doc.body;
	} else {
		const prose = first(S.content);
		root = prose || doc.querySelector("main") || doc.body;
		out.meta = {
			hasProse: !!prose,
			title: clean(firstText(S.title)),
			datetime: list(S.date).length ? first(S.date)?.getAttribute("datetime") || null : undefined,
			categories: all(S.categories).map((a) => ({ href: abs(a.getAttribute("href")), label: clean(a.textContent) })),
			tags: all(S.tags).map((a) => ({ href: abs(a.getAttribute("href")), label: clean(a.textContent) })),
			featured: abs(first(S.featured)?.getAttribute("src")) || null,
			linkUrl: first(S.linkUrl)?.getAttribute("href") || null,
			isPost: list(S.isPost).length ? !!first(S.isPost) : null,
			comments: list(S.comment).length ? all(S.comment).length : null,
			docTitle: clean(doc.title),
			is404: /not found|404/i.test(clean(doc.title)) && !prose,
		};
	}

	// Embeds, before scripts are stripped
	const embeds = [];
	root.querySelectorAll("iframe").forEach((f) => {
		const src = f.getAttribute("src") || f.getAttribute("data-src") || "";
		if (!src && f.hasAttribute("srcdoc")) {
			const inner = new DOMParser().parseFromString(f.getAttribute("srcdoc"), "text/html");
			const nested = [...inner.querySelectorAll("iframe[src], video, audio, .codepen, blockquote.twitter-tweet")].map((n) => hostType(n.getAttribute("src") || n.className));
			embeds.push({ kind: "html-block", type: nested[0] || "html", src: null });
			return;
		}
		embeds.push({ kind: "iframe", type: hostType(src), src: abs(src) });
	});
	root.querySelectorAll("object, embed").forEach((o) => {
		if (o.tagName === "EMBED" && o.closest("object")) return;
		const src = o.getAttribute("data") || o.querySelector('param[name="movie" i], param[name="src" i]')?.getAttribute("value") || o.getAttribute("src") || "";
		embeds.push({ kind: "flash", type: hostType(src), src: abs(src) });
	});
	root.querySelectorAll("video, audio").forEach((v) => {
		const src = v.getAttribute("src") || v.querySelector("source")?.getAttribute("src") || "";
		const t = v.tagName.toLowerCase();
		embeds.push({ kind: t, type: t, src: abs(src) });
	});
	root.querySelectorAll("blockquote.twitter-tweet").forEach((b) => {
		const links = b.querySelectorAll("a[href]");
		embeds.push({ kind: "tweet", type: "tweet", src: links.length ? abs(links[links.length - 1].getAttribute("href")) : null });
	});
	root.querySelectorAll(".codepen, [data-slug-hash]").forEach((c) => {
		const user = c.getAttribute("data-user");
		const hash = c.getAttribute("data-slug-hash") || c.getAttribute("data-href");
		embeds.push({ kind: "codepen", type: "codepen", src: user && hash ? `https://codepen.io/${user}/pen/${hash}` : null, tag: c.tagName.toLowerCase() });
	});
	root.querySelectorAll("script[src]").forEach((s) => {
		const src = s.getAttribute("src") || "";
		if (/gist\.github/.test(src)) embeds.push({ kind: "gist", type: "gist", src: abs(src) });
	});
	root.querySelectorAll("figure.wp-block-embed, figure.emdash-embed").forEach((f) => {
		if (f.querySelector("iframe, video, audio, object, embed, blockquote")) return;
		const a = f.querySelector("a[href]");
		const url = a?.getAttribute("href") || clean(f.textContent);
		const provider = [...f.classList].find((c) => c.startsWith("is-provider-"))?.slice(12);
		embeds.push({ kind: "embed-link", type: provider || hostType(url), src: abs(url) });
	});
	const scripts = [...root.querySelectorAll("script")].map((s) => s.getAttribute("src") || "(inline)");
	const galleries = root.querySelectorAll(".gallery, .wp-block-gallery, .tiled-gallery, .emdash-gallery").length;

	root.querySelectorAll(["script", "style", "noscript", "template", ...list(S.ignoreOld)].join(", ")).forEach((n) => n.remove());
	// Embed fallbacks visitors didn't see once the player loaded: WordPress's post-embed quote and
	// CodePen's "See the Pen …" paragraph. The embeds themselves were counted above.
	if (mode === "old") root.querySelectorAll("blockquote.wp-embedded-content, p.codepen, p[data-slug-hash]").forEach((n) => n.remove());

	// Code blocks: text only, so renderer markup changes don't matter
	const codeOf = (el) => {
		const c = el.cloneNode(true);
		c.querySelectorAll("button, .line-number, .line-numbers-rows, .copy, .code-copy").forEach((n) => n.remove());
		return c.textContent;
	};
	const pres = [...root.querySelectorAll("pre")].filter((p) => !p.parentElement?.closest("pre")).map((p) => ({ text: codeOf(p), cls: p.className || "", codepen: p.matches(".codepen") }));
	root.querySelectorAll(".emdash-code, [data-code-block]").forEach((el) => {
		if (!el.querySelector("pre")) pres.push({ text: codeOf(el), cls: String(el.className), codepen: false });
	});

	const headings = [...root.querySelectorAll("h1,h2,h3,h4,h5,h6")].map((h) => ({ level: Number(h.tagName[1]), text: clean(h.textContent) }));
	const listItems = [...root.querySelectorAll("li")].map((li) => clean(li.textContent)).filter(Boolean);
	const DASH = /^\s*(?:—|―|–|-{1,2}|~)\s*\S/;
	const blockquotes = [...root.querySelectorAll("blockquote")]
		.filter((b) => !b.parentElement?.closest("blockquote"))
		.map((b) => {
			let cite = b.querySelector("cite, footer")?.textContent;
			if (!cite) {
				const ps = b.querySelectorAll("p");
				const last = ps[ps.length - 1];
				if (ps.length > 1 && last && DASH.test(last.textContent)) cite = last.textContent;
			}
			return { text: clean(b.textContent).slice(0, 240), cite: cite ? clean(cite) : null, tweet: b.matches(".twitter-tweet") };
		});
	const figcaptions = [...root.querySelectorAll("figcaption, .wp-caption-text, .gallery-caption")].map((f) => clean(f.textContent)).filter(Boolean);
	const SKIP_IMG = /s\.w\.org\/images\/core\/emoji|feeds\.feedburner|stats\.wordpress|pixel\.wp\.com|\/smilies\//i;
	const images = [...root.querySelectorAll("img")]
		.map((img) => ({
			src: abs(img.getAttribute("src") || img.getAttribute("data-src") || img.getAttribute("data-lazy-src") || ""),
			alt: clean(img.getAttribute("alt") || ""),
			width: Number(img.getAttribute("width")) || null,
			inGallery: !!img.closest(".gallery, .wp-block-gallery, .tiled-gallery, .emdash-gallery"),
			smiley: img.matches(".wp-smiley, .emoji"),
		}))
		.filter((i) => i.src && !i.smiley && !SKIP_IMG.test(i.src) && i.width !== 1);
	const tables = [...root.querySelectorAll("table")].map((t) => ({ rows: t.querySelectorAll("tr").length, text: clean(t.textContent).slice(0, 160) }));
	const links = [...root.querySelectorAll("a[href]")].map((a) => ({ href: a.getAttribute("href"), abs: abs(a.getAttribute("href")), text: clean(a.textContent).slice(0, 80) }));

	// One line per block; <br> splits lines; code and media left out
	const textRoot = root.cloneNode(true);
	textRoot.querySelectorAll(["pre", ".emdash-code", "figure.code", ...list(S.ignoreNew), "button", "iframe", "object", "embed", "video", "audio"].join(", ")).forEach((n) => n.remove());
	textRoot.querySelectorAll("br").forEach((br) => br.replaceWith("\n"));
	const BLOCK = "p,h1,h2,h3,h4,h5,h6,li,dt,dd,blockquote,figcaption,figure,div,section,article,aside,header,footer,ul,ol,dl,table,thead,tbody,tr,td,th,caption,cite,hr,details,summary,center,address";
	textRoot.querySelectorAll(BLOCK).forEach((el) => {
		el.before("\n");
		el.after("\n");
	});
	const lines = textRoot.textContent.split("\n").map(clean).filter(Boolean);

	// Visible markup or entities that should have been rendered (inline <code> is allowed to show tags)
	const visible = root.cloneNode(true);
	visible.querySelectorAll("pre, code, .emdash-code, figure.code, button, kbd, samp").forEach((n) => n.remove());
	const visText = visible.textContent;
	const markup = [...visText.matchAll(/<\/?(?:p|div|span|a|img|iframe|script|code|br|strong|em|b|i|ul|ol|li|h[1-6]|blockquote|pre|object|embed|table)\b[^>]{0,80}>/gi)].map((m) => m[0]);
	const entities = [...visText.matchAll(/&(?:#\d{2,5}|#x[0-9a-f]{2,4}|[a-z]{2,8});/gi)].map((m) => m[0]);
	const shortcodes = [
		...visText.matchAll(
			/\[\/?(?:gallery|caption|video|audio|embed|codepen|youtube|vimeo|playlist|soundcloud|gist|tweet|wpvideo|slideshare|sourcecode|code|php|js|css|html|contact-form[^\]\s]*|jetpack[^\]\s]*|(?:one|two|three)_(?:half|third|fourth|fifth)(?:_last)?|column|row|button|box|toggle|tabs?)\b[^\]]{0,120}\]/gi,
		),
	].map((m) => m[0]);

	return {
		...out,
		lines,
		pCount: root.querySelectorAll("p").length,
		brCount: root.querySelectorAll("br").length,
		headings,
		listItems,
		blockquotes,
		figcaptions,
		images,
		embeds,
		galleries,
		tables,
		pres,
		links,
		scripts,
		markup,
		entities,
		shortcodes,
		words: clean(root.textContent).split(" ").filter(Boolean).length,
	};
}

/** Runs in a live page: which embeds actually display. `selectors` are tried in order. */
export function liveEmbeds(selectors) {
	const hostType = (u) => {
		const s = (u || "").toLowerCase();
		if (/youtube(-nocookie)?\.com|youtu\.be/.test(s)) return "youtube";
		if (/vimeo\.com/.test(s)) return "vimeo";
		if (/codepen\.io/.test(s)) return "codepen";
		if (/slideshare\.net/.test(s)) return "slideshare";
		if (/twitter\.com|\/\/x\.com|twimg/.test(s)) return "tweet";
		if (/gist\.github/.test(s)) return "gist";
		if (/instagram\.com/.test(s)) return "instagram";
		if (/spotify\.com/.test(s)) return "spotify";
		if (/soundcloud\.com/.test(s)) return "soundcloud";
		if (/google\.[a-z.]+\/maps|maps\.google/.test(s)) return "map";
		if (/\.(mp4|m4v|webm|mov|ogv)(\?|$)/.test(s)) return "video";
		if (/\.(mp3|m4a|ogg|wav)(\?|$)/.test(s)) return "audio";
		const host = (s.match(/^(?:https?:)?\/\/(?:www\.)?([^/:?#]+)/) || [])[1];
		return host || "other";
	};
	let root = null;
	for (const s of Array.isArray(selectors) ? selectors : [selectors]) if (s && !root) root = document.querySelector(s);
	root = root || document.querySelector("article") || document.body;
	const box = (el) => {
		const r = el.getBoundingClientRect();
		const cs = getComputedStyle(el);
		return { w: Math.round(r.width), h: Math.round(r.height), hidden: cs.display === "none" || cs.visibility === "hidden" };
	};
	const out = [];
	root.querySelectorAll("iframe").forEach((f) => {
		const b = box(f);
		const src = f.getAttribute("src") || "";
		const type = f.hasAttribute("srcdoc") && !src ? "html" : hostType(src);
		out.push({ kind: "iframe", type, src, ...b, shown: !b.hidden && b.w >= 60 && b.h >= 40 });
	});
	root.querySelectorAll("video, audio").forEach((v) => {
		const b = box(v);
		const t = v.tagName.toLowerCase();
		const src = v.currentSrc || v.getAttribute("src") || v.querySelector("source")?.getAttribute("src") || "";
		out.push({ kind: t, type: t, src, ...b, shown: !b.hidden && b.w >= 60 && b.h >= 20 });
	});
	root.querySelectorAll("object, embed").forEach((o) => {
		if (o.tagName === "EMBED" && o.closest("object")) return;
		const b = box(o);
		const src = o.getAttribute("data") || o.querySelector('param[name="movie" i]')?.getAttribute("value") || o.getAttribute("src") || "";
		out.push({ kind: "flash", type: hostType(src), src, ...b, shown: false, note: "Flash: no browser plays it" });
	});
	root.querySelectorAll("blockquote.twitter-tweet").forEach((q) => {
		const b = box(q);
		out.push({ kind: "tweet-text", type: "tweet", src: "", ...b, shown: false, note: "tweet script didn't render it; text only" });
	});
	root.querySelectorAll(".codepen").forEach((c) => {
		const b = box(c);
		out.push({ kind: "codepen-placeholder", type: "codepen", src: "", ...b, shown: false, note: "CodePen script didn't run" });
	});
	return out;
}

// ------------------------------------------------------------- comparing

const deaccent = (s) => s.normalize("NFKD").replace(/[̀-ͯ]/g, "");
export const sq = (s) => deaccent(norm(s).replace(/×/g, "x")).replace(/[^a-z0-9]/g, "");
export const tokens = (s) => deaccent(norm(s).replace(/×/g, "x")).split(/[^a-z0-9]+/).filter(Boolean);
export const shingles = (t) => (t.length < 4 ? t.map((w) => `1:${w}`) : t.slice(1).map((w, i) => `${t[i]} ${w}`));
export const wc = (s) => tokens(s).length;
export const codeNorm = (s) =>
	(s ?? "")
		.replace(/\r\n?/g, "\n")
		.split("\n")
		.map((l) => l.replace(/[ \t]+$/, ""))
		.join("\n")
		.replace(/^\n+|\n+$/g, "");
/** Shell prompts ("$ ") are drawn by the new renderer and left out of copies; ignore them either way. */
export const codeCmp = (s) =>
	codeNorm(s)
		.split("\n")
		.map((l) => l.replace(/^\$ /, ""))
		.join("\n");
/** The link-post trailer ("— Read on <a>"), from linkPosts.trailerWords; null when link posts are off. */
export const LINK_TRAILER = linkTrailerLine();
const BARE_URL = /^(https?:\/\/|www\.)\S+$/i;

function bestNewLine(oldLine, newLines) {
	const os = new Set(shingles(tokens(oldLine)));
	let best = { score: 0, text: "" };
	for (const nl of newLines) {
		const ns = shingles(tokens(nl));
		if (!ns.length) continue;
		let common = 0;
		for (const s of ns) if (os.has(s)) common++;
		const score = (2 * common) / (os.size + ns.length);
		if (score > best.score) best = { score, text: nl };
	}
	return best;
}

export function diffParagraphs(oldLines, newA, isLinkPost) {
	const newLines = newA.lines;
	const newSq = sq(newLines.join(" "));
	const newShingles = new Set(newLines.flatMap((l) => shingles(tokens(l))));
	const missing = [];
	const changed = [];
	let checked = 0;
	let matched = 0;
	for (let raw of oldLines) {
		if (isLinkPost && LINK_TRAILER) {
			if (BARE_URL.test(raw)) continue;
			raw = raw.replace(LINK_TRAILER, "").trim();
		}
		const s = sq(raw);
		if (s.length < 16) continue;
		checked++;
		if (newSq.includes(s)) {
			matched++;
			continue;
		}
		const sh = shingles(tokens(raw));
		const hit = sh.filter((x) => newShingles.has(x)).length;
		const score = sh.length ? hit / sh.length : 0;
		if (score >= 0.9) {
			matched++;
			continue;
		}
		const closest = bestNewLine(raw, newLines);
		const entry = {
			text: raw.length > 400 ? `${raw.slice(0, 400)}…` : raw,
			words: wc(raw),
			score: Math.round(score * 100) / 100,
			closest: closest.score > 0.2 ? closest.text.slice(0, 240) : null,
			closestScore: Math.round(closest.score * 100) / 100,
		};
		(score < 0.5 ? missing : changed).push(entry);
	}
	return { checked, matched, missing, changed };
}

export function gluedParagraphs(oldLines, newA) {
	const joined = norm(newA.lines.join(" "));
	const glued = [];
	for (let i = 0; i + 1 < oldLines.length; i++) {
		const a = norm(oldLines[i]);
		const b = norm(oldLines[i + 1]);
		if (a.length < 12 || b.length < 12) continue;
		const pair = a.slice(-12) + b.slice(0, 12);
		if (joined.includes(pair)) glued.push(`${oldLines[i].slice(-40)}⏎${oldLines[i + 1].slice(0, 40)}`);
	}
	return glued;
}

export function missingTexts(oldList, newList, newLinesSq) {
	const newSet = new Set(newList.map(sq));
	const lost = [];
	const demoted = [];
	for (const t of oldList) {
		const s = sq(t);
		if (!s || newSet.has(s)) continue;
		if ([...newSet].some((n) => n.includes(s) || (s.length > 20 && s.includes(n) && n.length > s.length * 0.8))) continue;
		if (s.length >= 4 && newLinesSq.includes(s)) demoted.push(t);
		else lost.push(t);
	}
	return { lost, demoted };
}

function sharedRatio(a, b) {
	const ta = new Set(tokens(a));
	const tb = tokens(b);
	if (!ta.size || !tb.length) return 0;
	return tb.filter((t) => ta.has(t)).length / Math.max(ta.size, tb.length);
}

export function compareCode(oldPres, newPres) {
	const olds = oldPres.filter((p) => !p.codepen && codeNorm(p.text));
	const used = new Set();
	const pairs = [];
	for (const o of olds) {
		const on = codeNorm(o.text);
		const oc = codeCmp(o.text);
		let j = newPres.findIndex((n, k) => !used.has(k) && codeCmp(n.text) === oc);
		if (j === -1) j = newPres.findIndex((n, k) => !used.has(k) && !n.matchedCodepen && sq(n.text).length && sharedRatio(on, n.text) > 0.5);
		if (j === -1) j = newPres.findIndex((n, k) => !used.has(k) && !n.matchedCodepen);
		if (j === -1) {
			pairs.push({ old: on, new: null, status: "missing" });
			continue;
		}
		used.add(j);
		const nn = codeNorm(newPres[j].text);
		if (codeCmp(newPres[j].text) === oc) {
			pairs.push({ status: "same" });
			continue;
		}
		let status = "different";
		if (nn.replace(/\s+/g, "") === on.replace(/\s+/g, "")) status = "whitespace";
		else if (decodeEntities(nn) === on) status = "double-escaped";
		const ol = on.split("\n");
		const nl = nn.split("\n");
		let line = 0;
		while (line < ol.length && line < nl.length && ol[line] === nl[line]) line++;
		pairs.push({
			status,
			line: line + 1,
			oldLine: (ol[line] ?? "(end)").slice(0, 160),
			newLine: (nl[line] ?? "(end)").slice(0, 160),
			oldLines: ol.length,
			newLines: nl.length,
			oldChars: on.length,
			newChars: nn.length,
			oldSnippet: on.slice(0, 600),
			newSnippet: nn.slice(0, 600),
		});
	}
	const extra = newPres.filter((n, k) => !used.has(k)).map((n) => codeNorm(n.text).slice(0, 200));
	return { pairs, extra };
}

/** The provider an embed URL belongs to (Node side; the browser functions carry their own copy). */
export function hostType(u) {
	const s = (u || "").toLowerCase();
	if (/youtube(-nocookie)?\.com|youtu\.be/.test(s)) return "youtube";
	if (/vimeo\.com/.test(s)) return "vimeo";
	if (/codepen\.io/.test(s)) return "codepen";
	if (/slideshare\.net/.test(s)) return "slideshare";
	if (/twitter\.com|\/\/x\.com|twimg/.test(s)) return "tweet";
	if (/gist\.github/.test(s)) return "gist";
	if (/instagram\.com/.test(s)) return "instagram";
	if (/spotify\.com/.test(s)) return "spotify";
	if (/soundcloud\.com/.test(s)) return "soundcloud";
	if (/google\.[a-z.]+\/maps|maps\.google/.test(s)) return "map";
	if (/docs\.google\.com/.test(s)) return "google-docs";
	if (/\.(mp4|m4v|webm|mov|ogv)(\?|$)/.test(s)) return "video";
	if (/\.(mp3|m4a|ogg|wav)(\?|$)/.test(s)) return "audio";
	return (s.match(/^(?:https?:)?\/\/(?:www\.)?([^/:?#]+)/) || [])[1] || "other";
}
