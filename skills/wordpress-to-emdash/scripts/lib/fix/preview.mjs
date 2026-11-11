/**
 * preview.html: every proposed change, readable, for the owner's approval.
 * One self-contained file (inline CSS, a few lines of inline JS for the
 * filters); thumbnails load from the WordPress site, so it works opened
 * straight from disk.
 */
import { CONFIG } from "../config.mjs";
import { FIXES, FIX_NUMBERS } from "./registry.mjs";
import { plainOf, textOf } from "./pt.mjs";

const esc = (s) => String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const pct = (x) => `${(x * 100).toFixed(1)}%`;
const trunc = (s, n) => (s.length > n ? `${s.slice(0, n)}… <span class="more">(${s.length - n} more characters)</span>` : s);
const CONF = { high: "High", medium: "Medium", low: "Low" };

/** Word-level diff (LCS) with <del>/<ins>, for blocks of modest size. */
function wordDiff(a, b) {
	const ta = a.split(/(\s+)/);
	const tb = b.split(/(\s+)/);
	if (ta.length * tb.length > 400000) return null;
	const n = ta.length;
	const m = tb.length;
	const dp = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));
	for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) dp[i][j] = ta[i] === tb[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
	let i = 0;
	let j = 0;
	let before = "";
	let after = "";
	while (i < n || j < m) {
		if (i < n && j < m && ta[i] === tb[j]) {
			before += esc(ta[i]);
			after += esc(tb[j]);
			i++;
			j++;
		} else if (j < m && (i >= n || dp[i][j + 1] >= dp[i + 1][j])) after += `<ins>${esc(tb[j++])}</ins>`;
		else before += `<del>${esc(ta[i++])}</del>`;
	}
	return { before, after };
}

/** Collapse long unchanged text shared by two strings, keeping some context. */
function trimCommon(a, b, keep = 90) {
	let pre = 0;
	while (pre < a.length && pre < b.length && a[pre] === b[pre]) pre++;
	let suf = 0;
	while (suf < a.length - pre && suf < b.length - pre && a[a.length - 1 - suf] === b[b.length - 1 - suf]) suf++;
	const cut = (s) => {
		let out = s;
		if (pre > keep * 2) {
			const at = out.lastIndexOf(" ", pre - keep);
			if (at > 0) out = `\u2026${out.slice(at)}`;
		}
		const tail = suf > keep * 2 ? out.length - suf + keep : -1;
		if (tail > 0 && tail < out.length) {
			const at = out.indexOf(" ", tail);
			if (at > 0) out = `${out.slice(0, at)} \u2026`;
		}
		return out;
	};
	return { a: cut(a), b: cut(b) };
}

const showBreaks = (html) => html.replace(/\n/g, '<span class="nl">↵</span>\n');

function styleChip(b) {
	if (b._type !== "block") return "";
	if (b.listItem) return `<span class="chip">${b.listItem === "number" ? "1." : "•"}${(b.level ?? 1) > 1 ? ` L${b.level}` : ""}</span>`;
	if (/^h\d$/.test(b.style)) return `<span class="chip">${b.style.toUpperCase()}</span>`;
	if (b.style === "blockquote") return '<span class="chip">Quote</span>';
	return '<span class="chip">¶</span>';
}

function renderBlock(b, thumb, html) {
	switch (b._type) {
		case "block":
			return `<div class="pt pt-${b.listItem ? "li" : b.style}">${styleChip(b)}<span class="txt">${html ?? showBreaks(trunc(esc(textOf(b)), 900))}</span></div>`;
		case "image": {
			const src = b.asset?.url ?? b.asset?._ref;
			return `<figure class="img"><img loading="lazy" src="${esc(thumb(src))}" alt=""><figcaption><b>Image</b>${b.alignment ? ` · ${b.alignment}` : ""}${b.caption ? ` · caption “${esc(b.caption)}”` : " · no caption"}${b.link ? ` · links to ${esc(b.link.href ?? b.link)}` : ""}<br><span class="url">${esc(src)}</span></figcaption></figure>`;
		}
		case "gallery":
			return `<div class="gallery"><b>Gallery</b> · ${b.images?.length ?? 0} images · ${b.columns ?? "default"} columns<div class="thumbs">${(b.images ?? []).map((im) => `<figure><img loading="lazy" src="${esc(thumb(im.asset?.url ?? im.asset?._ref))}" alt="">${im.caption ? `<figcaption>${esc(im.caption)}</figcaption>` : ""}</figure>`).join("")}</div></div>`;
		case "code":
			return `<div class="code"><b>Code block</b>${b.language ? ` · ${esc(b.language)}` : ""}<pre>${esc(b.code.split("\n").slice(0, 18).join("\n"))}${b.code.split("\n").length > 18 ? `\n… ${b.code.split("\n").length - 18} more lines` : ""}</pre></div>`;
		case "embed":
			return `<div class="embed"><b>Embed</b>${b.provider ? ` · ${esc(b.provider)}` : ""} · <a href="${esc(b.url)}">${esc(b.url)}</a>${b.caption ? `<br>caption “${esc(b.caption)}”` : ""}${b.html ? `<br><span class="url">html: ${esc(b.html.slice(0, 160))}</span>` : ""}</div>`;
		case "htmlBlock":
			return `<div class="embed"><b>HTML block</b>${b.isolated ? " (isolated)" : ""}<pre>${esc((b.html ?? "").slice(0, 300))}</pre></div>`;
		case "columns":
			return `<div class="embed"><b>Columns</b> · ${(b.columns ?? []).length}<div class="cols">${(b.columns ?? []).map((c) => `<div>${(c.content ?? []).map((x) => renderBlock(x, thumb)).join("")}</div>`).join("")}</div></div>`;
		default:
			return `<div class="embed"><b>${esc(b._type)}</b> ${esc(plainOf(b).slice(0, 200))}</div>`;
	}
}

/** Before/after for one hunk, with the changes marked. */
function renderHunk(h, thumb) {
	const before = h.before ?? [];
	const after = h.after ?? [];
	let bHtml;
	let aHtml;
	const oneText = before.length === 1 && before[0]._type === "block";
	const allText = after.every((b) => b._type === "block");
	if (oneText && allText && after.length > 1) {
		// A block split into several: mark where each new block starts
		let text = esc(trunc(textOf(before[0]), 1600));
		for (let i = 0; i + 1 < after.length; i++) {
			const tail = esc(textOf(after[i]).slice(-14));
			const head = esc(textOf(after[i + 1]).slice(0, 14));
			if (!tail || !head) continue;
			const glued = `${tail}${head}`;
			if (text.includes(glued)) text = text.replace(glued, `${tail}<mark class="cut" title="Run together: a break goes here">|</mark>${head}`);
		}
		bHtml = renderBlock(before[0], thumb, showBreaks(text));
		aHtml = after.map((b, i) => `<div class="${i ? "newblock" : ""}">${renderBlock(b, thumb)}</div>`).join("");
	} else if (before.length === 1 && after.length === 1 && before[0]._type === "block" && after[0]._type === "block") {
		const t = trimCommon(textOf(before[0]), textOf(after[0]));
		const d = wordDiff(t.a, t.b);
		bHtml = renderBlock(before[0], thumb, d ? showBreaks(d.before) : showBreaks(esc(t.a)));
		aHtml = renderBlock(after[0], thumb, d ? showBreaks(d.after) : showBreaks(esc(t.b)));
	} else {
		// Trim text the first and last blocks share, so the change shows
		const bx = new Map();
		const ax = new Map();
		const pair = (bi, ai) => {
			const b = before[bi];
			const a = after[ai];
			if (b?._type !== "block" || a?._type !== "block") return;
			const t = trimCommon(textOf(b), textOf(a));
			const d = wordDiff(t.a, t.b);
			bx.set(bi, d ? d.before : esc(t.a));
			ax.set(ai, d ? d.after : esc(t.b));
		};
		if (before.length === 1 && before[0]._type === "block" && after.length > 1) {
			// One block became text + something else: diff it against the text that's left
			const joined = after.filter((b) => b._type === "block").map(textOf).join("\n\n");
			const t = trimCommon(textOf(before[0]), joined);
			const d = wordDiff(t.a, t.b);
			bx.set(0, d ? d.before : esc(t.a));
			after.forEach((a, i) => {
				if (a._type !== "block") return;
				const tt = trimCommon(textOf(before[0]), textOf(a));
				ax.set(i, esc(i === 0 ? tt.b : textOf(a).length > 600 ? `${textOf(a).slice(0, 400)} \u2026` : textOf(a)));
			});
		} else {
			pair(0, 0);
			if (before.length > 1 || after.length > 1) pair(before.length - 1, after.length - 1);
		}
		bHtml = before.map((b, i) => renderBlock(b, thumb, bx.has(i) ? showBreaks(bx.get(i)) : null)).join("") || '<p class="none">(nothing here)</p>';
		aHtml = after.map((b, i) => renderBlock(b, thumb, ax.has(i) ? showBreaks(ax.get(i)) : null)).join("") || '<p class="none">(removed)</p>';
	}
	return `<div class="hunk"><div class="side before"><div class="lbl">Now</div>${bHtml}</div><div class="side after"><div class="lbl">Proposed</div>${aHtml}</div></div>`;
}

function badge(conf) {
	return conf ? `<span class="badge ${conf}">${CONF[conf]}</span>` : "";
}

function renderNeedsOwner(nj, slug) {
	const opts = nj.options ? `<ul class="opts">${Object.entries(nj.options).map(([k, v]) => `<li><code>${esc(k)}</code> ${esc(v)}${nj.recommend === k ? ' <span class="rec">recommended</span>' : ""}</li>`).join("")}</ul>` : "";
	const embeds = (nj.embeds ?? []).map((e) => `<div class="url">URL it needs: <a href="${esc(e.url ?? e.src)}">${esc(e.url ?? e.src)}</a>${e.status != null ? ` · status ${e.status || "no response"}` : ""}${e.archived ? ` · archived copy <a href="${esc(e.archived)}">${esc(e.archived)}</a>` : ""}</div>`).join("");
	const imgs = (nj.images ?? []).map((u) => `<div class="url">${esc(u)}</div>`).join("");
	const preview = (nj.preview ?? []).map((t) => `<pre>${esc(t)}</pre>`).join("");
	return `<div class="owner"><span class="badge owner">Needs the owner</span> ${esc(nj.summary)}${nj.notes?.length ? `<div class="note">${nj.notes.map(esc).join("<br>")}</div>` : ""}${embeds}${imgs}${opts}${preview}${nj.decisionKey ? `<div class="key">decisions.json key: <code>${esc(nj.decisionKey)}</code></div>` : ""}</div>`;
}

function renderFix(p, f, thumb) {
	const items = f.items.filter((it) => it.status !== "needs-owner");
	const nj = [...f.items.filter((it) => it.status === "needs-owner"), ...(f.needsOwner ?? [])];
	const notApplied = items.length && !f.applied;
	return `<div class="fix">
<div class="fixhead"><b>${esc(f.label)}</b> ${badge(f.confidence)} ${f.applied ? '<span class="tag ok">in the default apply</span>' : items.length ? '<span class="tag off">not applied by default (low confidence; --include-low)</span>' : ""}${f.error ? `<span class="tag err">error: ${esc(f.error.slice(0, 200))}</span>` : ""}</div>
${items.length ? `<ul class="items">${items.map((it) => `<li>${badge(it.confidence)}${it.applied === false ? ' <span class="tag off">held back</span>' : ""} ${esc(it.summary)}${it.notes?.length ? `<div class="note">${it.notes.map(esc).join("<br>")}</div>` : ""}${it.images?.length && f.fix !== "gallery" ? `<div class="thumbs small">${it.images.slice(0, 6).map((u) => `<img loading="lazy" src="${esc(thumb(u))}" alt="" title="${esc(u)}">`).join("")}</div>` : ""}${it.embeds?.length ? it.embeds.map((e) => `<div class="url">${esc(e.type)}: <a href="${esc(e.url)}">${esc(e.url)}</a></div>`).join("") : ""}</li>`).join("")}</ul>` : ""}
${f.title ? `<div class="hunk"><div class="side before"><div class="lbl">Now</div><div class="pt">${esc(f.title.before)}</div></div><div class="side after"><div class="lbl">Proposed</div><div class="pt">${esc(f.title.after)}</div></div></div>` : ""}
${f.unpublish ? '<div class="hunk single"><div class="side after"><div class="lbl">Proposed</div><div class="pt">Unpublish (kept as a draft; drops out of the sitemap)</div></div></div>' : ""}
${(f.hunks ?? []).map((h) => renderHunk(h, thumb)).join("")}
${items.filter((it) => it.applied === false && it.before).map((it) => `<div class="heldback"><span class="tag off">held back (low confidence)</span>${renderHunk({ before: it.before, after: it.after }, thumb)}</div>`).join("")}
${nj.map((x) => renderNeedsOwner(x, p.slug)).join("")}
${f.notes?.length ? `<div class="note">${f.notes.map(esc).join("<br>")}</div>` : ""}
${notApplied ? "" : ""}
</div>`;
}

export function renderPreview(report, thumb = (u) => u) {
	const { proposals, counts, verification } = report;
	const fixOrder = [...FIXES].sort((a, b) => (FIX_NUMBERS[a.id] ?? 99) - (FIX_NUMBERS[b.id] ?? 99));
	const allNj = proposals.flatMap((p) => p.fixes.flatMap((f) => [...f.items.filter((it) => it.status === "needs-owner"), ...(f.needsOwner ?? [])].map((nj) => ({ p, f, nj }))));
	const embedsNj = allNj.filter((x) => x.f.fix === "embeds" && x.nj.kind === "undecided");
	const otherNj = allNj.filter((x) => !(x.f.fix === "embeds" && x.nj.kind === "undecided"));
	const conf = { high: 0, medium: 0, low: 0 };
	for (const c of Object.values(counts.byFix)) for (const k of Object.keys(conf)) conf[k] += c.confidence[k] ?? 0;

	const summaryRows = fixOrder
		.filter((f) => counts.byFix[f.id])
		.map((f) => {
			const c = counts.byFix[f.id];
			const v = verification?.byFix?.[f.id];
			return `<tr><td>${FIX_NUMBERS[f.id] ?? ""}</td><td><a href="#fix-${f.id}">${esc(f.label)}</a></td><td class="n">${c.posts}</td><td class="n">${c.applied}</td><td class="n">${c.items}</td><td class="n">${c.confidence.high}</td><td class="n">${c.confidence.medium}</td><td class="n">${c.confidence.low}</td><td class="n">${c.needsOwner}</td><td>${v ? `${pct(v.textMatchBefore)} → <b>${pct(v.textMatchAfter)}</b>` : "–"}</td></tr>`;
		})
		.join("");

	const verifyRows = verification
		? fixOrder
				.filter((f) => verification.byFix[f.id])
				.map((f) => {
					const v = verification.byFix[f.id];
					return `<tr><td>${esc(f.label)}</td><td class="n">${v.posts}</td><td>${pct(v.textMatchBefore)} → <b>${pct(v.textMatchAfter)}</b></td><td>${v.measures.map((m) => `${esc(m.label)}: ${m.before} → <b>${m.after}</b>${m.wordpress ? ` <span class="muted">(WordPress ${m.wordpress})</span>` : ""}`).join("<br>")}</td><td>${v.worse.length ? v.worse.map((w) => `<a href="#p-${esc(w.slug)}">${esc(w.slug)}</a> ${pct(w.before)} → ${pct(w.after)}`).join("<br>") : "none"}</td></tr>`;
				})
				.join("")
		: "";

	const embedRows = embedsNj
		.map(({ p, nj }) => {
			const e = nj.embeds?.[0] ?? {};
			return `<tr><td><a href="#p-${esc(p.slug)}">${esc(p.slug)}</a></td><td>${esc(nj.provider)}</td><td><a href="${esc(e.url)}">${esc(e.url)}</a></td><td>${esc(nj.summary.split("; the page shows ")[1]?.split(";")[0] ?? "")}</td><td>${e.status == null ? '<span class="muted">not checked</span>' : e.status === 200 ? "loads" : `<b>${e.status || "no response"}</b>`}</td><td>${esc(nj.recommend)}</td><td><code>${esc(nj.decisionKey)}</code></td></tr>`;
		})
		.join("");

	const sections = fixOrder
		.map((fix) => {
			const posts = proposals.filter((p) => p.fixes.some((f) => f.fix === fix.id));
			if (!posts.length) return "";
			const big = posts.length > 25;
			return `<section id="fix-${fix.id}"><h2>${FIX_NUMBERS[fix.id] ?? ""}. ${esc(fix.label)} <span class="muted">· ${posts.length} posts</span></h2>
${big ? '<p class="muted">Collapsed: open a post to see its changes. Posts with medium or low confidence changes are listed first.</p>' : ""}
${posts
	.map((p) => ({ p, f: p.fixes.find((f) => f.fix === fix.id) }))
	.sort((a, b) => (big ? ({ low: 0, medium: 1, high: 2 }[a.f.confidence] ?? 0) - ({ low: 0, medium: 1, high: 2 }[b.f.confidence] ?? 0) : 0))
	.map(({ p, f }) => {
		const nj = f.items.filter((it) => it.status === "needs-owner").length + (f.needsOwner?.length ?? 0);
		return `<details class="post" id="${fix.id === fixOrder.find((x) => p.fixes.some((y) => y.fix === x.id))?.id ? `p-${esc(p.slug)}` : ""}" data-conf="${f.confidence ?? "none"}" ${big ? "" : "open"}>
<summary><span class="ptitle">${esc(p.titleAfter ?? p.title)}</span> <span class="muted">/${esc(p.slug)}/</span> ${badge(f.confidence)}${nj ? ' <span class="badge owner">Needs the owner</span>' : ""} <span class="muted">${f.items.filter((it) => it.status !== "needs-owner").length} change${f.items.length === 1 ? "" : "s"}</span></summary>
<div class="links"><a href="${esc(p.urls.wordpress)}" target="_blank">WordPress ↗</a> <a href="${esc(p.urls.new)}" target="_blank">New site (staging) ↗</a>${p.verify ? ` <span class="muted">text match ${pct(p.verify.before.textMatch)} → ${pct(p.verify.after.textMatch)} (all fixes)</span>` : ""}${p.fixes.length > 1 ? ` <span class="muted">· also: ${p.fixes.filter((x) => x.fix !== fix.id).map((x) => `<a href="#fix-${x.fix}">${x.fix}</a>`).join(", ")}</span>` : ""}</div>
${renderFix(p, f, thumb)}
</details>`;
	})
	.join("\n")}
</section>`;
		})
		.join("\n");

	return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(CONFIG.site.name ? `${CONFIG.site.name}: content fixes` : "Content fixes preview")}</title>
<style>
:root{--bg:#fbfbf9;--fg:#1d1d1b;--muted:#6b6b66;--line:#e2e1dc;--card:#fff;--del:#fde2e1;--ins:#dff3e4;--mark:#ffd84d;--high:#1f7a3f;--medium:#9a6700;--low:#6b6b66;--owner:#6d3fc0;--owner-bg:#f4effc;--code:#f3f2ee}
@media (prefers-color-scheme:dark){:root:not([data-theme="light"]){--bg:#161615;--fg:#ecebe6;--muted:#9b9a94;--line:#33322f;--card:#1f1f1d;--del:#4a2523;--ins:#1f3d28;--mark:#8a6d00;--high:#6fd08f;--medium:#e5b44a;--low:#a5a49e;--owner:#b79cf0;--owner-bg:#2a2238;--code:#262624}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--fg);font:15px/1.5 system-ui,-apple-system,"Segoe UI",sans-serif}
main{max-width:1240px;margin:0 auto;padding:24px 16px 80px}
h1{font-size:26px;margin:0 0 4px}h2{font-size:20px;margin:40px 0 12px;padding-top:12px;border-top:1px solid var(--line)}h3{font-size:16px;margin:24px 0 8px}
a{color:inherit}.muted{color:var(--muted)}code{background:var(--code);padding:1px 4px;border-radius:4px;font-size:13px}
table{border-collapse:collapse;width:100%;font-size:14px;margin:8px 0 16px;background:var(--card)}th,td{border:1px solid var(--line);padding:6px 8px;text-align:left;vertical-align:top}th{background:var(--code);font-weight:600}td.n{text-align:right;font-variant-numeric:tabular-nums}
.wrap{overflow-x:auto}
.badge{display:inline-block;font-size:11px;font-weight:600;letter-spacing:.02em;padding:1px 7px;border-radius:9px;border:1px solid currentColor;vertical-align:1px}
.badge.high{color:var(--high)}.badge.medium{color:var(--medium)}.badge.low{color:var(--low)}.badge.owner{color:var(--owner)}
.tag{font-size:12px;padding:1px 6px;border-radius:4px;background:var(--code);margin-left:4px}.tag.off{color:var(--medium)}.tag.err{color:#c62828}.tag.ok{color:var(--high)}
details.post{background:var(--card);border:1px solid var(--line);border-radius:8px;margin:10px 0;padding:0 14px}
details.post>summary{cursor:pointer;padding:12px 0;list-style:none}details.post>summary::-webkit-details-marker{display:none}
details.post>summary:before{content:"▸ ";color:var(--muted)}details.post[open]>summary:before{content:"▾ "}
.ptitle{font-weight:600}.links{margin:0 0 10px;font-size:14px}.links a{margin-right:12px}
.fix{padding-bottom:12px}.fixhead{margin:4px 0 6px}.items{margin:6px 0 10px;padding-left:20px}.items li{margin:3px 0}
.note{font-size:13px;color:var(--muted);margin:2px 0 4px}
.hunk{display:grid;grid-template-columns:1fr 1fr;gap:10px;margin:10px 0}.hunk.single{grid-template-columns:1fr}
@media (max-width:860px){.hunk{grid-template-columns:1fr}}
.side{border:1px solid var(--line);border-radius:6px;padding:8px 10px;min-width:0;overflow-wrap:anywhere}.side.before{background:var(--bg)}.lbl{font-size:11px;text-transform:uppercase;letter-spacing:.06em;color:var(--muted);margin-bottom:4px}
.pt{margin:6px 0;white-space:pre-wrap}.chip{display:inline-block;min-width:22px;font-size:11px;font-weight:700;color:var(--muted);border:1px solid var(--line);border-radius:4px;padding:0 4px;margin-right:6px;text-align:center;white-space:nowrap}
.pt-h2 .txt,.pt-h3 .txt,.pt-h4 .txt{font-weight:700}.pt-blockquote .txt{font-style:italic}
.newblock{border-left:3px solid var(--high);padding-left:6px}
.nl{color:var(--muted);font-size:12px}mark.cut{background:var(--mark);color:#000;padding:0 2px;border-radius:2px}
del{background:var(--del);text-decoration:line-through}ins{background:var(--ins);text-decoration:none}
.more{color:var(--muted);font-size:12px}
figure{margin:6px 0}figure.img{display:flex;gap:10px;align-items:flex-start}figure.img img{width:120px;height:auto;border-radius:4px;border:1px solid var(--line);background:var(--code)}
.thumbs{display:flex;flex-wrap:wrap;gap:6px;margin-top:6px}.thumbs figure{width:110px;margin:0;font-size:11px}.thumbs img{width:110px;height:82px;object-fit:cover;border-radius:4px;border:1px solid var(--line);background:var(--code)}.thumbs.small img{width:70px;height:52px}
.url{font-size:12px;color:var(--muted);word-break:break-all}
pre{background:var(--code);padding:8px;border-radius:6px;overflow-x:auto;font-size:12px;white-space:pre}
.code,.embed,.gallery{margin:6px 0}.cols{display:grid;grid-template-columns:repeat(auto-fit,minmax(140px,1fr));gap:6px}
.owner{background:var(--owner-bg);border:1px solid var(--owner);border-radius:6px;padding:8px 10px;margin:10px 0}.owner pre{max-height:220px}
.opts{margin:6px 0;padding-left:20px}.rec{font-size:11px;color:var(--high);font-weight:600}.key{font-size:12px;margin-top:4px}
.none{color:var(--muted);font-style:italic;margin:4px 0}
nav.toc{font-size:14px}nav.toc a{margin-right:10px;white-space:nowrap}
.filter{margin:10px 0;font-size:14px}.filter button{font:inherit;padding:3px 10px;border:1px solid var(--line);background:var(--card);color:inherit;border-radius:6px;cursor:pointer}.filter button[aria-pressed="true"]{border-color:var(--fg)}
</style></head><body><main>
<h1>Content fixes: preview</h1>
<p class="muted">Dry run, generated ${esc(report.generatedAt)} from the local D1 copy. Nothing has been changed anywhere. ${proposals.length} posts have proposals. Thumbnails load from ${esc(CONFIG.sites.wordpress.replace(/^https?:\/\//, ""))}.</p>
<nav class="toc">${fixOrder.filter((f) => counts.byFix[f.id]).map((f) => `<a href="#fix-${f.id}">${FIX_NUMBERS[f.id]}. ${esc(f.id)}</a>`).join("")}<a href="#owner">Needs the owner</a><a href="#verify">Self-check</a></nav>

<h2 id="counts">Counts per fix</h2>
<div class="wrap"><table><thead><tr><th>#</th><th>Fix</th><th>Posts</th><th>Applied by default</th><th>Changes</th><th>High</th><th>Medium</th><th>Low</th><th>Needs the owner</th><th>Text match before → after</th></tr></thead><tbody>${summaryRows}</tbody>
<tfoot><tr><td></td><td><b>All</b></td><td class="n">${proposals.length}</td><td></td><td class="n">${conf.high + conf.medium + conf.low}</td><td class="n">${conf.high}</td><td class="n">${conf.medium}</td><td class="n">${conf.low}</td><td class="n">${allNj.length}</td><td>${verification ? `${pct(verification.overall.textMatchBefore)} → <b>${pct(verification.overall.textMatchAfter)}</b>` : ""}</td></tr></tfoot></table></div>
<p class="muted">High and medium changes go in by default when this is applied; low ones only with <code>--include-low</code>. “Needs the owner” items change nothing until <code>${esc(CONFIG.paths.decisions.replace(`${CONFIG.paths.root}/`, ""))}</code> picks an option.</p>

<h2 id="owner">Needs the owner (${allNj.length})</h2>
<h3>Embeds EmDash can't play (${embedsNj.length})</h3>
<p>Proposed fallback: a <b>link card</b>, an embed block with the URL and a caption. EmDash draws it as a link with the caption under it, with no code change. Tweets keep (or get back) their text as a quote with a citation line. The other option is an isolated HTML block with the provider's embed, which runs in EmDash's sandboxed frame. Before choosing that, check the site's Content Security Policy lets the provider's frames load. Set a choice per post (<code>"slug:embeds:codepen": "card"</code>) or per provider (<code>"provider:codepen": "card"</code>).</p>
<div class="wrap"><table><thead><tr><th>Post</th><th>Provider</th><th>URL it needs</th><th>Page shows now</th><th>URL status</th><th>Recommend</th><th>Decision key</th></tr></thead><tbody>${embedRows}</tbody></table></div>
<h3>Everything else (${otherNj.length})</h3>
${otherNj.map(({ p, nj }) => `<div><a href="#p-${esc(p.slug)}"><b>/${esc(p.slug)}/</b></a>${renderNeedsOwner(nj, p.slug)}</div>`).join("")}

${verification ? `<h2 id="verify">Self-check: does the page match WordPress more closely?</h2>
<p>${esc(verification.method)} Before = the Portable Text in local D1 now; after = with the default fixes applied in memory.</p>
<div class="wrap"><table><thead><tr><th>Fix</th><th>Posts</th><th>Text match</th><th>Fix-specific measure, before → after</th><th>Posts that score lower</th></tr></thead><tbody>${verifyRows}</tbody></table></div>
<p class="muted">A post can score lower when WordPress itself still shows raw theme shortcode text (such as [one_half] or [button]) because the theme that drew it is gone. Removing the tags goes past parity, and the audit counts the missing tag text as lost. Check any other post that scores lower before applying.</p>` : ""}

<div class="filter">Show posts: <button data-f="all" aria-pressed="true">all</button> <button data-f="medium">medium + low</button> <button data-f="low">low only</button></div>
${sections}
</main>
<script>
for (const b of document.querySelectorAll(".filter button")) b.addEventListener("click", () => {
  for (const x of document.querySelectorAll(".filter button")) x.setAttribute("aria-pressed", String(x === b));
  const f = b.dataset.f;
  for (const d of document.querySelectorAll("details.post")) d.hidden = f === "all" ? false : f === "medium" ? !["medium", "low"].includes(d.dataset.conf) : d.dataset.conf !== "low";
});
</script>
</body></html>`;
}
