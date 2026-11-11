/**
 * Self-check for the proposals: render each post's Portable Text before and
 * after the fixes, then score both against what WordPress displayed, with
 * the audit's own extraction and comparison code (lib/compare-core.mjs), so
 * the scores mean exactly what the audit's do.
 *
 * analyse() runs in headless Chrome through Playwright, which is optional:
 * without it, verify() returns null and fix-content says the self-check was
 * skipped. The browser is closed in a finally block.
 */
import { wordpressHostPattern } from "../config.mjs";
import { analyse, codeNorm, compareCode, diffParagraphs, gluedParagraphs, missingTexts, selectorsFromConfig, shingles, sq, tokens, wc } from "../compare-core.mjs";
import { launchBrowser, loadPlaywright, PLAYWRIGHT_HINT } from "../optional.mjs";
import { decodeEntities } from "../wxr.mjs";
import { textOf } from "./pt.mjs";

const fx = { sq, tokens, shingles, wc, codeNorm, diffParagraphs, gluedParagraphs, missingTexts, compareCode };
const ON_WP = new RegExp(`^(https?:)?\\/\\/${wordpressHostPattern()}\\/`);

// ------------------------------------------------ Portable Text → HTML

const esc = (s) => String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

function spans(b) {
	const defs = new Map((b.markDefs ?? []).map((d) => [d._key, d]));
	return (b.children ?? [])
		.map((c) => {
			let h = esc(c.text ?? "").replace(/\n/g, "<br>");
			for (const m of c.marks ?? []) {
				const d = defs.get(m);
				if (d?._type === "link") h = `<a href="${esc(d.href)}">${h}</a>`;
				else if (m === "strong") h = `<strong>${h}</strong>`;
				else if (m === "em") h = `<em>${h}</em>`;
				else if (m === "code") h = `<code>${h}</code>`;
			}
			return h;
		})
		.join("");
}

const YT = /(?:youtube\.com\/(?:watch\?v=|embed\/)|youtu\.be\/)([a-zA-Z0-9_-]{11})/;
const VIMEO = /vimeo\.com\/(\d+)/;
const SAFE_IFRAME = /<iframe\b[^>]*src=["'](https:\/\/(?:www\.youtube\.com|player\.vimeo\.com)\/[^"']+)["'][^>]*>(?:<\/iframe>)?/gi;

/** Roughly what EmDash renders (Embed.astro, Image.astro …), enough for analyse(). */
export function renderPortableText(blocks) {
	let out = "";
	let i = 0;
	const media = (b) => {
		switch (b._type) {
			case "image":
				return `<figure class="emdash-image"><img src="${esc(b.asset?.url ?? b.asset?._ref)}" alt="${esc(b.alt ?? "")}">${b.caption ? `<figcaption>${esc(b.caption)}</figcaption>` : ""}</figure>`;
			case "gallery":
				return `<div class="emdash-gallery">${(b.images ?? []).map((im) => `<figure><img src="${esc(im.asset?.url ?? im.asset?._ref)}" alt="${esc(im.alt ?? "")}">${im.caption ? `<figcaption>${esc(im.caption)}</figcaption>` : ""}</figure>`).join("")}</div>`;
			case "code":
				return `<pre><code>${esc(b.code)}</code></pre>`;
			case "embed": {
				const u = b.url ?? "";
				let inner;
				if (b.provider === "video") inner = `<video controls src="${esc(u)}"></video>`;
				else if (b.provider === "audio") inner = `<audio controls src="${esc(u)}"></audio>`;
				else if (YT.test(u)) inner = `<iframe src="https://www.youtube.com/embed/${u.match(YT)[1]}"></iframe>`;
				else if (VIMEO.test(u)) inner = `<iframe src="https://player.vimeo.com/video/${u.match(VIMEO)[1]}"></iframe>`;
				else if (b.html) inner = `<div class="emdash-embed-html">${[...b.html.matchAll(SAFE_IFRAME)].map((m) => `<iframe src="${esc(m[1])}"></iframe>`).join("") || esc("")}</div>`;
				else inner = `<a href="${esc(u)}">${esc(u)}</a>`;
				return `<figure class="emdash-embed">${inner}${b.caption ? `<figcaption>${esc(b.caption)}</figcaption>` : ""}</figure>`;
			}
			case "htmlBlock":
				if (b.isolated) return `<iframe class="emdash-html-block" srcdoc="${esc(b.html)}"></iframe>`;
				return `<div class="emdash-html-block">${(b.html ?? "").replace(/<script[\s\S]*?<\/script>/gi, "").replace(/<iframe\b(?![^>]*src=["']https:\/\/(?:www\.youtube\.com|player\.vimeo\.com))[^>]*>(?:<\/iframe>)?/gi, "")}</div>`;
			case "columns":
				return `<div class="emdash-columns">${(b.columns ?? []).map((c) => `<div>${renderPortableText(c.content ?? [])}</div>`).join("")}</div>`;
			case "cover":
				return `<div class="emdash-cover">${renderPortableText(b.content ?? [])}</div>`;
			case "buttons":
				return `<div>${(b.buttons ?? []).map((x) => `<a href="${esc(x.url)}">${esc(x.text)}</a>`).join(" ")}</div>`;
			case "break":
				return "<hr>";
			case "table":
				return `<table>${(b.rows ?? []).map((r) => `<tr>${(r.cells ?? []).map((c) => `<td>${esc(typeof c === "string" ? c : textOf(c))}</td>`).join("")}</tr>`).join("")}</table>`;
			default:
				return "";
		}
	};
	while (i < blocks.length) {
		const b = blocks[i];
		if (b._type !== "block") {
			out += media(b);
			i++;
			continue;
		}
		if (b.listItem) {
			// A run of list items, nested by level
			let html = "";
			const stack = [];
			while (i < blocks.length && blocks[i]._type === "block" && blocks[i].listItem) {
				const li = blocks[i];
				const level = li.level ?? 1;
				const tag = li.listItem === "number" ? "ol" : "ul";
				while (stack.length < level) {
					html += `<${tag}>`;
					stack.push(tag);
				}
				while (stack.length > level) html += `</${stack.pop()}>`;
				html += `<li>${spans(li)}</li>`;
				i++;
			}
			while (stack.length) html += `</${stack.pop()}>`;
			out += html;
			continue;
		}
		if (b.style === "blockquote") {
			let html = "";
			while (i < blocks.length && blocks[i]._type === "block" && blocks[i].style === "blockquote" && !blocks[i].listItem) html += `<p>${spans(blocks[i++])}</p>`;
			out += `<blockquote>${html}</blockquote>`;
			continue;
		}
		const tag = /^h[1-6]$/.test(b.style) ? b.style : "p";
		out += `<${tag}>${spans(b)}</${tag}>`;
		i++;
	}
	return out;
}

// ------------------------------------------------------------- scoring

function metrics(fx, oldA, newA, title) {
	const para = fx.diffParagraphs(oldA.lines, newA, false);
	const glued = fx.gluedParagraphs(oldA.lines, newA).length;
	const newLinesSq = fx.sq(newA.lines.join(" "));
	const li = fx.missingTexts(oldA.listItems, newA.listItems, newLinesSq);
	const h = fx.missingTexts(oldA.headings.map((x) => x.text), newA.headings.map((x) => x.text), newLinesSq);
	const quotesOld = oldA.blockquotes.filter((b) => !b.tweet);
	const newQuoteSq = newA.blockquotes.map((b) => fx.sq(b.text));
	const quotesLost = quotesOld.filter((q) => {
		const s = fx.sq(q.text).slice(0, 60);
		return s.length > 8 && !newQuoteSq.some((n) => n.includes(s));
	}).length;
	const code = fx.compareCode(oldA.pres, newA.pres.map((p) => ({ ...p })));
	const codeOld = oldA.pres.filter((p) => !p.codepen && fx.codeNorm(p.text)).length;
	const codeSame = code.pairs.filter((p) => p.status === "same" || p.status === "whitespace").length;
	const oldSq = fx.sq(oldA.lines.join(" "));
	const oldSh = new Set(oldA.lines.flatMap((l) => fx.shingles(fx.tokens(l))));
	const addedWords = newA.lines
		.filter((l) => {
			const s = fx.sq(l);
			if (s.length < 16 || oldSq.includes(s)) return false;
			const sh = fx.shingles(fx.tokens(l));
			return sh.length && sh.filter((x) => oldSh.has(x)).length / sh.length < 0.5;
		})
		.reduce((n, l) => n + fx.wc(l), 0);
	const shown = (list) => list.filter((e) => ["iframe", "video", "audio"].includes(e.kind)).length;
	const capOld = new Set(oldA.figcaptions.map(fx.sq));
	return {
		textMatch: para.checked ? para.matched / para.checked : 1,
		checked: para.checked,
		missingParagraphs: para.missing.length,
		glued,
		paragraphs: newA.pCount,
		paragraphsOld: oldA.pCount,
		listItemsInLists: oldA.listItems.length - li.lost.length - li.demoted.length,
		listItemsOld: oldA.listItems.length,
		headingsOk: oldA.headings.length - h.lost.length - h.demoted.length,
		headingsOld: oldA.headings.length,
		quotesOk: quotesOld.length - quotesLost,
		quotesOld: quotesOld.length,
		captionsOk: newA.figcaptions.filter((c) => capOld.has(fx.sq(c))).length,
		captionsOld: oldA.figcaptions.length,
		images: newA.images.length,
		imagesOld: oldA.images.length,
		imagesOnWp: newA.images.filter((i) => ON_WP.test(i.src)).length,
		embeds: shown(newA.embeds),
		embedsOld: shown(oldA.embeds),
		codeSame,
		codeOld,
		addedWords,
		shortcodes: newA.shortcodes.length,
		escapedBrackets: newA.pres.reduce((n, p) => n + (p.text.match(/&#9[13];/g) ?? []).length, 0),
	};
}

const pct = (x) => `${(x * 100).toFixed(1)}%`;
const sum = (rows, k) => rows.reduce((n, r) => n + (r[k] ?? 0), 0);

/** What each fix type is judged on. */
const MEASURES = {
	gallery: [["images", "imagesOld", "images shown (WordPress showed)"]],
	captions: [["shortcodes", null, "raw shortcodes visible"], ["captionsOk", "captionsOld", "WordPress captions present"]],
	classic: [["glued", null, "run-together paragraph breaks"], ["paragraphs", "paragraphsOld", "paragraphs (WordPress had)"], ["listItemsInLists", "listItemsOld", "list items in a list"], ["headingsOk", "headingsOld", "headings kept as headings"], ["quotesOk", "quotesOld", "quotes kept as quotes"]],
	embeds: [["embeds", "embedsOld", "embeds that play (WordPress had)"]],
	code: [["codeSame", "codeOld", "code blocks matching WordPress"], ["addedWords", null, "words WordPress didn't show (script/CSS source)"]],
	wpImages: [["imagesOnWp", null, "images still loading from the WordPress host"]],
	brackets: [["escapedBrackets", null, "&#91;/&#93; left in code"]],
	textLoss: [["missingParagraphs", null, "WordPress paragraphs missing"], ["listItemsInLists", "listItemsOld", "list items in a list"], ["captionsOk", "captionsOld", "WordPress captions present"]],
};

export async function verify(proposals, ctx) {
	const pw = await loadPlaywright();
	if (!pw) {
		console.log(`  Self-check skipped: Playwright isn't installed. ${PLAYWRIGHT_HINT}`);
		return null;
	}
	const browser = await launchBrowser(pw);
	const sel = selectorsFromConfig();
	const perPost = [];
	try {
		const page = await browser.newPage();
		await page.goto("about:blank");
		const run = (arg) => page.evaluate(analyse, { ...arg, sel });
		for (const p of proposals) {
			const rendered = ctx.wpRendered({ slug: p.slug });
			if (!rendered) continue;
			const base = p.urls.wordpress;
			const oldA = await run({ html: `<!doctype html><html><body><div id="__root">${rendered.html}</div></body></html>`, mode: "old", base });
			const doc = (blocks) => `<!doctype html><html><body><article><div class="prose">${renderPortableText(blocks)}</div></article></body></html>`;
			const before = metrics(fx, oldA, await run({ html: doc(p.before), mode: "new", base: p.urls.new }));
			const after = metrics(fx, oldA, await run({ html: doc(p.after), mode: "new", base: p.urls.new }));
			const titleOld = decodeEntities(rendered.title);
			perPost.push({ slug: p.slug, fixes: p.fixes.filter((f) => f.applied).map((f) => f.fix), before: { ...before, title: p.title === titleOld ? 1 : 0 }, after: { ...after, title: p.titleAfter === titleOld ? 1 : 0 } });
			p.verify = { before, after };
		}
	} finally {
		await browser.close();
	}

	const byFix = {};
	const fixes = [...new Set(perPost.flatMap((r) => r.fixes))];
	for (const fix of fixes) {
		const rows = perPost.filter((r) => r.fixes.includes(fix));
		const b = rows.map((r) => r.before);
		const a = rows.map((r) => r.after);
		const checked = sum(b, "checked");
		const wMatch = (xs) => (checked ? xs.reduce((n, r) => n + r.textMatch * r.checked, 0) / checked : 1);
		const measures = (MEASURES[fix] ?? []).map(([k, ref, label]) => ({ label, before: sum(b, k), after: sum(a, k), wordpress: ref ? sum(b, ref) : 0 }));
		if (fix === "titles") measures.push({ label: "titles matching WordPress", before: sum(b, "title"), after: sum(a, "title"), wordpress: rows.length });
		byFix[fix] = {
			posts: rows.length,
			textMatchBefore: wMatch(b),
			textMatchAfter: wMatch(a),
			improved: rows.filter((r) => r.after.textMatch > r.before.textMatch + 1e-9).length,
			worse: rows.filter((r) => r.after.textMatch < r.before.textMatch - 1e-9).map((r) => ({ slug: r.slug, before: r.before.textMatch, after: r.after.textMatch })),
			measures,
			summary: `${rows.length} posts; text match ${pct(wMatch(b))} → ${pct(wMatch(a))}; ${measures.map((m) => `${m.label} ${m.before} → ${m.after}${m.wordpress ? ` (WordPress ${m.wordpress})` : ""}`).join("; ")}`,
		};
	}
	const all = perPost;
	const checkedAll = sum(all.map((r) => r.before), "checked");
	const overall = {
		posts: all.length,
		textMatchBefore: checkedAll ? all.reduce((n, r) => n + r.before.textMatch * r.before.checked, 0) / checkedAll : 1,
		textMatchAfter: checkedAll ? all.reduce((n, r) => n + r.after.textMatch * r.after.checked, 0) / checkedAll : 1,
		worse: all.filter((r) => r.after.textMatch < r.before.textMatch - 1e-9).map((r) => r.slug),
	};
	return { method: "Each post's Portable Text rendered before and after, then compared with WordPress's REST content.rendered using analyse(), diffParagraphs(), gluedParagraphs(), missingTexts() and compareCode() from lib/compare-core.mjs (the audit's own code). Text match = WordPress paragraphs found on the page / paragraphs checked (the audit's paragraphs-missing test).", byFix, overall, perPost };
}
