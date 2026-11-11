/**
 * Embeds WordPress displayed that the new page lost (or shows as a bare link).
 *
 * EmDash's embed block plays YouTube and Vimeo itself from the URL
 * (Embed.astro), and self-hosted video/audio with provider "video"/"audio":
 *   { _type: "embed", _key, url, provider?, html?, caption? }
 * Its html is sanitised to iframes from www.youtube.com and player.vimeo.com
 * only, so a YouTube playlist goes in as a /playlist URL plus that iframe.
 *
 * Everything else (CodePen, Spotify, Kickstarter, Giphy, Gfycat, SlideShare,
 * tweets, JSFiddle and so on) is listed for the owner with the URL it needs
 * and two ways to show it:
 *   card  an embed block with the URL and a caption: EmDash draws it as a
 *         link with a caption (no code change needed). Tweets become a
 *         quote with the tweet's text and a citation line instead.
 *   html  an isolated HTML block with the provider's embed markup; it runs in
 *         EmDash's sandboxed frame (check the site's CSP allows the provider)
 * Nothing changes for those until decisions.json picks one, per post
 * ("<slug>:embeds:<provider>": "card") or per provider ("provider:codepen": "card").
 */
import { loadConverter } from "../../optional.mjs";
import { isTextBlock, newKey, textOf } from "../pt.mjs";
import { decodeEntities } from "../../wxr.mjs";
import { findAnchor, textBefore } from "../wp-structure.mjs";

const { parseInlineContent } = await loadConverter();

/** The audit's provider names (compare-sites.mjs hostType). */
export function hostType(u) {
	const s = (u || "").toLowerCase();
	if (/youtube(-nocookie)?\.com|youtu\.be/.test(s)) return "youtube";
	if (/vimeo\.com/.test(s)) return "vimeo";
	if (/codepen\.io/.test(s)) return "codepen";
	if (/slideshare\.net/.test(s)) return "slideshare";
	if (/twitter\.com|\/\/x\.com|twimg/.test(s)) return "tweet";
	if (/spotify\.com/.test(s)) return "spotify";
	if (/\.(mp4|m4v|webm|mov|ogv)(\?|$)/.test(s)) return "video";
	if (/\.(mp3|m4a|ogg|wav)(\?|$)/.test(s)) return "audio";
	return (s.match(/^(?:https?:)?\/\/(?:www\.)?([^/:?#]+)/) || [])[1] || "other";
}

const PLAYED = new Set(["youtube", "vimeo", "video", "audio"]);
const PROVIDER_NAME = { codepen: "CodePen", spotify: "Spotify", "kickstarter.com": "Kickstarter", "giphy.com": "Giphy", "gfycat.com": "Gfycat", slideshare: "SlideShare", tweet: "Twitter/X", "jsfiddle.net": "JSFiddle", "dipity.com": "Dipity", "rpm.newrelic.com": "New Relic", youtube: "YouTube", vimeo: "Vimeo", video: "video", audio: "audio" };

/** Canonical page URL, the id to look for on the page, and embed markup. */
function canonical(type, src, extra = {}) {
	const abs = src.startsWith("//") ? `https:${src}` : src;
	let m;
	switch (type) {
		case "youtube":
			if ((m = abs.match(/[?&]list=([\w-]+)/))) return { url: `https://www.youtube.com/playlist?list=${m[1]}`, id: m[1], playlist: true, iframe: `https://www.youtube.com/embed/videoseries?list=${m[1]}` };
			m = abs.match(/(?:embed\/|watch\?v=|youtu\.be\/|\/v\/)([\w-]{11})/);
			return m ? { url: `https://www.youtube.com/watch?v=${m[1]}`, id: m[1] } : null;
		case "vimeo":
			m = abs.match(/vimeo\.com\/(?:video\/)?(\d+)/);
			return m ? { url: `https://vimeo.com/${m[1]}`, id: m[1] } : null;
		case "codepen": {
			m = abs.match(/codepen\.io\/([\w-]+)\/(?:pen|embed|full|details)\/(?:preview\/)?(\w+)/);
			let user = extra.user ?? m?.[1];
			const hash = extra.hash ?? m?.[2];
			if (!hash) return null;
			if (!user || user === "anon") user = extra.fallbackUser ?? user;
			return { url: `https://codepen.io/${user}/pen/${hash}`, id: hash, iframe: `https://codepen.io/${user}/embed/${hash}?default-tab=result` };
		}
		case "spotify":
			if ((m = abs.match(/spotify:(?:user:[\w.]+:)?(playlist|track|album|artist):(\w+)/))) return { url: `https://open.spotify.com/${m[1]}/${m[2]}`, id: m[2], iframe: `https://open.spotify.com/embed/${m[1]}/${m[2]}` };
			if ((m = abs.match(/open\.spotify\.com\/(?:embed\/)?(playlist|track|album|artist|episode)\/(\w+)/))) return { url: `https://open.spotify.com/${m[1]}/${m[2]}`, id: m[2], iframe: `https://open.spotify.com/embed/${m[1]}/${m[2]}` };
			return null;
		case "kickstarter.com":
			m = abs.match(/kickstarter\.com\/projects\/([\w-]+\/[\w-]+)/);
			return m ? { url: `https://www.kickstarter.com/projects/${m[1]}`, id: m[1], iframe: abs } : null;
		case "giphy.com":
			m = abs.match(/giphy\.com\/(?:embed|gifs|media)\/(?:[\w-]*-)?(\w+)/);
			return m ? { url: `https://giphy.com/gifs/${m[1]}`, id: m[1], iframe: `https://giphy.com/embed/${m[1]}`, image: `https://media.giphy.com/media/${m[1]}/giphy.gif` } : null;
		case "gfycat.com":
			m = abs.match(/gfycat\.com\/(?:ifr\/)?(\w+)/i);
			return m ? { url: `https://gfycat.com/${m[1].toLowerCase()}`, id: m[1], iframe: abs } : null;
		case "slideshare":
			m = abs.match(/embed_code\/(?:key\/)?(\w+)/);
			return { url: extra.page ?? abs, id: m?.[1] ?? abs, iframe: abs };
		case "tweet":
			m = abs.match(/(?:twitter|x)\.com\/(\w+)\/status(?:es)?\/(\d+)/);
			return m ? { url: `https://twitter.com/${m[1]}/status/${m[2]}`, id: m[2] } : null;
		case "jsfiddle.net":
			m = abs.match(/jsfiddle\.net\/((?:[\w-]+\/)?\w+)\//);
			return m ? { url: `https://jsfiddle.net/${m[1]}/`, id: m[1], iframe: abs.replace(/^http:/, "https:") } : null;
		default:
			return { url: abs.replace(/[?&]mode=embed.*$/, "").replace(/^http:/, "https:"), id: abs, iframe: abs };
	}
}

/** Embeds in a post's raw export HTML, in order. */
function wxrEmbeds(html) {
	const out = [];
	const add = (e) => {
		if (out.some((o) => e.start < o.end && o.start < e.end)) return;
		out.push(e);
	};
	// Gutenberg embed blocks and the Jetpack GIF block
	for (const m of html.matchAll(/<!-- wp:(?:core-embed\/[\w-]+|embed) (\{[\s\S]*?\}) -->[\s\S]*?<!-- \/wp:(?:core-embed\/[\w-]+|embed) -->/g)) {
		try {
			const a = JSON.parse(m[1]);
			const cap = m[0].match(/<figcaption[^>]*>([\s\S]*?)<\/figcaption>/)?.[1];
			if (a.url) add({ src: a.url, type: hostType(a.url), start: m.index, end: m.index + m[0].length, caption: cap ? strip(cap) : undefined });
		} catch {}
	}
	for (const m of html.matchAll(/<!-- wp:jetpack\/gif (\{[\s\S]*?\}) \/?-->/g)) {
		try {
			const a = JSON.parse(m[1]);
			if (a.giphyUrl) add({ src: a.giphyUrl, type: "giphy.com", start: m.index, end: m.index + m[0].length, caption: a.caption });
		} catch {}
	}
	for (const m of html.matchAll(/<blockquote\b[^>]*class=["'][^"']*twitter-tweet[^"']*["'][^>]*>([\s\S]*?)<\/blockquote>/gi)) {
		const status = [...m[1].matchAll(/href=["']([^"']*\/status(?:es)?\/\d+[^"']*)["']/g)].map((x) => x[1]).at(-1);
		if (status) add({ src: status, type: "tweet", start: m.index, end: m.index + m[0].length, tweetHtml: m[1] });
	}
	for (const m of html.matchAll(/<(p|pre|div)\b[^>]*class=["'][^"']*codepen[^"']*["'][^>]*>([\s\S]*?)<\/\1>/gi)) {
		m[1] = m[2];
		const tag = m[0].slice(0, m[0].indexOf(">") + 1);
		const hash = tag.match(/data-(?:slug-hash|href)=["'](\w+)/)?.[1];
		const user = tag.match(/data-user=["']([\w-]+)/)?.[1];
		const fallbackUser = m[1].match(/codepen\.io\/([\w-]+)\/pen\//)?.[1];
		if (hash) add({ src: `https://codepen.io/${user ?? fallbackUser ?? "anon"}/pen/${hash}`, type: "codepen", start: m.index, end: m.index + m[0].length, hash, user, fallbackUser, caption: strip(m[1]) });
	}
	for (const m of html.matchAll(/<iframe\b[^>]*\bsrc=["']([^"']+)["'][^>]*>(?:\s*<\/iframe>)?/gi)) {
		const src = decodeEntities(m[1]);
		const near = html.slice(m.index + m[0].length, m.index + m[0].length + 600);
		const fallbackUser = near.match(/codepen\.io\/([\w-]+)\/pen\//)?.[1];
		const page = near.match(/href=["'](https?:\/\/(?:www\.)?slideshare\.net\/(?!slideshow)[^"']+)["']/)?.[1];
		add({ src, type: hostType(src), start: m.index, end: m.index + m[0].length, fallbackUser, page });
	}
	for (const m of html.matchAll(/<(video|audio)\b[^>]*>[\s\S]*?<\/\1>|<(video|audio)\b[^>]*\/?>/gi)) {
		const src = m[0].match(/\bsrc=["']([^"']+)["']/)?.[1];
		if (src) add({ src: decodeEntities(src), type: (m[1] ?? m[2]).toLowerCase(), start: m.index, end: m.index + m[0].length });
	}
	for (const m of html.matchAll(/\[(video|audio)\b([^\]]*)\]/g)) {
		const src = m[2].match(/(?:src|mp4|m4v|webm|mp3|m4a|ogg)=["']([^"']+)["']/)?.[1];
		if (src) add({ src, type: m[1], start: m.index, end: m.index + m[0].length });
	}
	for (const m of html.matchAll(/\[embed[^\]]*\](\S+?)\[\/embed\]/g)) add({ src: m[1], type: hostType(m[1]), start: m.index, end: m.index + m[0].length });
	// Autoembed: a URL alone on its line, or alone in a paragraph
	for (const m of html.matchAll(/^[ \t]*(?:<p>\s*)?(https?:\/\/[^\s<>"]+?)(?:\s*<\/p>)?[ \t]*$/gm)) {
		const t = hostType(m[1]);
		if (["youtube", "vimeo", "tweet", "spotify", "slideshare"].includes(t)) add({ src: decodeEntities(m[1]), type: t, start: m.index, end: m.index + m[0].length, autoembed: true });
	}
	return out.sort((a, b) => a.start - b.start);
}

const strip = (h) => decodeEntities(String(h ?? "").replace(/<[^>]+>/g, " ")).replace(/\s+/g, " ").trim();
const blockHas = (b, id) => {
	if (!id) return false;
	if (b._type === "embed") return (b.url ?? "").includes(id) || (b.html ?? "").includes(id);
	if (b._type === "htmlBlock") return (b.html ?? "").includes(id);
	if (b._type === "block") return textOf(b).includes(id) || (b.markDefs ?? []).some((d) => (d.href ?? "").includes(id));
	return false;
};

function embedBlock(type, c, caption) {
	const b = { _type: "embed", _key: newKey("emb"), url: c.url };
	if (type === "youtube" || type === "vimeo") b.provider = type;
	if (type === "video" || type === "audio") b.provider = type;
	if (c.playlist) b.html = `<iframe src="${c.iframe}" width="560" height="315" frameborder="0" allow="encrypted-media; picture-in-picture" allowfullscreen></iframe>`;
	if (caption) b.caption = caption;
	return b;
}

function cardBlock(type, c, caption) {
	const b = { _type: "embed", _key: newKey("card"), url: c.url, provider: type.replace(/\..*$/, "") };
	b.caption = caption || `${PROVIDER_NAME[type] ?? type}: ${c.url.replace(/^https?:\/\/(www\.)?/, "")}`;
	return b;
}

function htmlOption(type, c, e) {
	if (type === "tweet") return { _type: "htmlBlock", _key: newKey("html"), html: `<blockquote class="twitter-tweet">${e.tweetHtml ?? `<a href="${c.url}">${c.url}</a>`}</blockquote><script async src="https://platform.twitter.com/widgets.js" charset="utf-8"></script>`, isolated: true };
	const height = { spotify: 380, "giphy.com": 270, codepen: 500, "kickstarter.com": 420, slideshare: 485 }[type] ?? 400;
	return { _type: "htmlBlock", _key: newKey("html"), html: `<iframe src="${c.iframe ?? c.url}" width="100%" height="${height}" frameborder="0" allowfullscreen loading="lazy"></iframe>`, isolated: true };
}

/** A tweet as quote paragraphs with its citation line (Quote.astro renders the footer). */
function tweetQuote(e) {
	let n = 0;
	const key = () => `${newKey("tw")}${n++}`;
	const inner = e.tweetHtml ?? "";
	const paras = [...inner.matchAll(/<p\b[^>]*>([\s\S]*?)<\/p>/gi)].map((m) => m[1]);
	const after = inner.replace(/<p\b[^>]*>[\s\S]*?<\/p>/gi, "").trim();
	const out = [];
	for (const p of paras) {
		const { children, markDefs } = parseInlineContent(p.replace(/<br\s*\/?>/gi, "\n"), key);
		out.push({ _type: "block", _key: key(), style: "blockquote", children, ...(markDefs.length ? { markDefs } : {}) });
	}
	if (strip(after)) {
		const { children, markDefs } = parseInlineContent(`— ${after.replace(/^\s*(&mdash;|—)\s*/, "")}`, key);
		out.push({ _type: "block", _key: key(), style: "blockquote", children, ...(markDefs.length ? { markDefs } : {}) });
	}
	return out;
}

export default {
	id: "embeds",
	label: "Embeds WordPress showed and the new page lost",
	order: 60,
	async run(entry, content, ctx) {
		const findings = ctx.audit.kinds(entry.slug, "embed-lost", "embed-degraded");
		if (!findings.length) return null;
		const wp = ctx.wxrFor(entry);
		if (!wp) return null;
		const wanted = new Set(findings.map((f) => f.details?.type));
		const embeds = wxrEmbeds(wp.html).filter((e) => wanted.has(e.type));
		const items = [];
		const needsOwner = [];
		let next = content;

		for (const [ei, e] of embeds.entries()) {
			const c = canonical(e.type, e.src, e);
			if (!c) {
				needsOwner.push({ kind: "unknown", summary: `${PROVIDER_NAME[e.type] ?? e.type} embed ${e.src}: couldn't work out its URL`, status: "needs-owner", embeds: [{ type: e.type, src: e.src }] });
				continue;
			}
			// Tweets WordPress embedded from a URL: their text is in the rendered page
			if (e.type === "tweet" && !e.tweetHtml) {
				const rendered = ctx.wpRendered(entry)?.html ?? "";
				for (const m of rendered.matchAll(/<blockquote\b[^>]*twitter-tweet[^>]*>([\s\S]*?)<\/blockquote>/gi)) if (m[1].includes(c.id)) e.tweetHtml = m[1];
			}
			// What the page has for it now
			const at = next.findIndex((b) => b._type !== "image" && b._type !== "code" && blockHas(b, c.id));
			const here = at >= 0 ? next[at] : null;
			const anchor = textBefore(wp.html, e.start);
			const anchorAt = findAnchor(next, anchor, textOf);
			const now = !here ? "nothing" : here._type === "embed" ? "a link (embed block that EmDash can't play)" : here._type === "htmlBlock" ? "nothing (an HTML block the sanitiser empties)" : textOf(here).trim() === c.url || /^https?:\/\/\S+$/.test(textOf(here).trim()) ? "the bare URL as text" : e.type === "tweet" ? "the tweet's text as a quote" : "its fallback text";
			// Is the URL alive? (cached; never WordPress)
			// CodePen and Twitter/X refuse scripted requests, so their status says nothing
			const checkable = !["youtube", "vimeo", "codepen", "tweet"].includes(e.type);
			const head = checkable ? await ctx.probe(e.type === "video" || e.type === "audio" ? e.src : c.url) : null;

			// Replace an embed/HTML block or a bare-URL paragraph; keep fallback/credit text
			const replaceable = here && (here._type === "embed" || here._type === "htmlBlock" || now === "the bare URL as text");
			const place = (blocks) => {
				if (replaceable) return [...next.slice(0, at), ...blocks, ...next.slice(at + 1)];
				if (here) return [...next.slice(0, at), ...blocks, ...next.slice(at)];
				if (anchorAt >= 0) return [...next.slice(0, anchorAt + 1), ...blocks, ...next.slice(anchorAt + 1)];
				// Nothing before it on WordPress: it opened the post
				if (!anchor) return [...blocks, ...next];
				return null;
			};

			if (PLAYED.has(e.type)) {
				// Already restored (a re-run)
				if (here?._type === "embed" && here.url === c.url) continue;
				const dead = (e.type === "video" || e.type === "audio") && head?.status !== 200;
				if (dead) {
					const archived = await ctx.wayback(e.src);
					needsOwner.push({
						kind: e.type,
						summary: `${e.type === "video" ? "Video" : "Audio"} file ${e.src} no longer loads (${head?.status || "no response"}); the page shows ${now}`,
						status: "needs-owner",
						embeds: [{ type: e.type, src: e.src, url: c.url, status: head?.status ?? 0, archived }],
						options: { upload: archived ? `Upload the archived copy (${archived}) and embed it` : "Upload a copy if you have one", leave: "Leave it out" },
						notes: [archived ? "The Wayback Machine has a copy" : "No archived copy found"],
					});
					continue;
				}
				const block = embedBlock(e.type, c, e.caption);
				const res = place([block]);
				if (!res) {
					needsOwner.push({ kind: e.type, summary: `${PROVIDER_NAME[e.type]} ${c.url}: couldn't find where it goes`, status: "needs-owner", embeds: [{ type: e.type, url: c.url }] });
					continue;
				}
				next = res;
				items.push({
					kind: e.type,
					summary: `${PROVIDER_NAME[e.type]} ${c.playlist ? "playlist" : e.type === "video" || e.type === "audio" ? "file" : "video"} embed restored (${c.url}); the page showed ${now}`,
					confidence: here || anchorAt >= 0 ? (c.playlist ? "medium" : "high") : anchor ? "low" : "medium",
					embeds: [{ type: e.type, src: e.src, url: c.url }],
					notes: c.playlist ? ["EmDash only plays single videos from a URL, so the playlist uses an iframe in the embed's html (www.youtube.com iframes pass the sanitiser)"] : [],
				});
				continue;
			}

			// Undecided providers: list them with the URL each needs
			const alive = head?.status === 200;
			// CodePen's fallback paragraph ("See the Pen … on CodePen.") makes a good caption
			const caption = e.type === "codepen" ? (here?._type === "block" ? textOf(here) : e.caption ?? "").replace(/\s+/g, " ").replace(/\s+([.,)])/g, "$1").replace(/\(\s+/g, "(").trim() : e.caption;
			// Already decided and applied (a re-run)
			if (here?._type === "embed" && here.url === c.url && here._key?.startsWith("card")) continue;
			if (here?._type === "htmlBlock" && here.isolated && c.iframe && (here.html ?? "").includes(c.iframe)) continue;
			const options = {
				card: e.type === "tweet" ? (now === "the tweet's text as a quote" ? "Keep the quote (it already shows the tweet's text and links to it)" : "Show the tweet as a quote with its citation") : `Link card: an embed block with the URL and a caption (EmDash renders a link + caption)`,
				html: `Isolated HTML block with ${PROVIDER_NAME[e.type] ?? e.type}'s embed (sandboxed frame; check the site CSP allows it)`,
				leave: now === "nothing" || now.startsWith("nothing") ? "Leave it out" : `Leave it as ${now}`,
			};
			const decisionKey = `${entry.slug}:embeds:${e.type}`;
			const chosen = ctx.decision(entry.slug, "embeds", e.type) ?? ctx.decisions?.[`provider:${e.type}`] ?? null;
			const record = {
				kind: "undecided",
				provider: PROVIDER_NAME[e.type] ?? e.type,
				summary: `${PROVIDER_NAME[e.type] ?? e.type} embed (${c.url}); the page shows ${now}${head ? `; the URL ${alive ? "still loads" : `returns ${head.status || "no response"}`}` : "; not checked (the provider blocks scripted requests)"}`,
				embeds: [{ type: e.type, src: e.src, url: c.url, status: head?.status ?? null, image: c.image }],
				options,
				recommend: head && !alive ? "leave" : "card",
				decisionKey,
				notes: [
					e.type === "gfycat.com" ? "Gfycat shut down in 2023, so neither option can play it" : null,
					e.type === "dipity.com" ? "Dipity closed years ago" : null,
					e.type === "giphy.com" && c.image ? `The GIF itself is ${c.image}; it could also go in as an image` : null,
				].filter(Boolean),
			};
			if (chosen === "card" || chosen === "html") {
				let blocks;
				if (chosen === "card") {
					if (e.type !== "tweet") blocks = [cardBlock(e.type, c, caption)];
					else if (now === "the tweet's text as a quote") blocks = null;
					else blocks = tweetQuote(e).length ? tweetQuote(e) : [cardBlock(e.type, c, caption)];
				}
				else blocks = [htmlOption(e.type, c, e)];
				if (blocks === null) {
					items.push({ ...record, kind: "undecided-kept", summary: `${record.summary}: kept as a quote`, confidence: "high", decision: chosen });
					continue;
				}
				// A card replaces the fallback paragraph too (it repeats the same link)
				const replaceFallback = chosen === "card" && here && here._type === "block" && e.type === "codepen";
				const res = replaceFallback ? [...next.slice(0, at), ...blocks, ...next.slice(at + 1)] : place(blocks);
				if (res) {
					next = res;
					items.push({ ...record, summary: `${record.summary} → ${chosen === "card" ? "link card" : "isolated HTML block"}`, confidence: "medium", decision: chosen });
					continue;
				}
			}
			needsOwner.push({ ...record, status: "needs-owner" });
		}
		if (!items.length && !needsOwner.length) return null;
		return { content: next, items, needsOwner };
	},
};
