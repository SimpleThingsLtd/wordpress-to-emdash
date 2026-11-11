/**
 * preview.html for import-comments.mjs: one self-contained page listing what
 * would be imported (threaded, per post) and what was left out, with the reason
 * and every spam signal, so a person can scan it before anything is written.
 * Commenter email addresses are never printed. Author URLs are shown as text,
 * not links, so nobody clicks through to a spam site by accident.
 */

const CATEGORY = {
	spam: ["Spam", "Scored at or above comments.spamThreshold by the heuristics"],
	"not-approved": ["Not approved in WordPress", "Pending, spam or trash in WordPress (comment_approved isn't 1)"],
	pingback: ["Pingbacks and trackbacks", "Off by default; turn on with comments.includePingbacks"],
	"self-pingback": ["Self-pingbacks", "Links from the site to itself (or from a dev copy of it)"],
	orphan: ["Replies to comments that were left out", "comments.orphans decides these"],
	"post-missing": ["Post not on the new site", "The post or its type wasn't imported"],
	config: ["Left out in config", "Listed in comments.exclude"],
	empty: ["Empty", "No text left once the HTML is removed"],
	duplicate: ["Duplicates", "The same author's same text twice on one post; the reply (or the earliest) is kept"],
};

// Addresses people typed into a comment are masked too (the email field is never read here)
const maskEmails = (s) => String(s ?? "").replace(/[\w.+-]+@[\w-]+(?:\.[\w-]+)+/g, (m) => `${m[0]}…@${m.split("@")[1]}`);
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[ch]);

export function renderPreview({ title, generated, target, checkedTarget, decisions, counts, siteUrl, entryPath, locale, timeZone, extrasFile, owners = [] }) {
	const fmt = new Intl.DateTimeFormat(locale || "en", { dateStyle: "medium", timeStyle: "short", timeZone: timeZone || undefined });
	const date = (iso) => (iso ? fmt.format(new Date(iso)) : "no date");
	const byId = new Map(decisions.map((d) => [d.c.wpId, d]));
	const ownerSet = new Set(owners.map((n) => n.toLowerCase()));

	const card = (d, { depth = 0, full = true } = {}) => {
		const c = d.c;
		const host = c.url ? c.url.replace(/^https?:\/\//i, "").replace(/\/$/, "") : "";
		const badges = [
			d.ping && `<span class="b">${esc(c.type)}</span>`,
			(d.trusted || ownerSet.has(d.name.toLowerCase())) && `<span class="b ok">trusted</span>`,
			d.existing && `<span class="b ok">already on ${esc(target)}</span>`,
			d.name !== c.author && `<span class="b">renamed from “${esc(c.author)}”</span>`,
			d.status === "import" && d.link && `<span class="b">linked</span>`,
		].filter(Boolean);
		const text = maskEmails(full || c.text.length <= 700 ? c.text : `${c.text.slice(0, 700)}…`);
		const sig = d.signals.length
			? `<ul class="sig">${d.signals
					.sort((a, b) => b.points - a.points)
					.map((s) => `<li><b>+${s.points}</b> ${esc(s.text)}</li>`)
					.join("")}</ul>`
			: "";
		const notes = d.notes.length ? `<p class="note">${d.notes.map(esc).join(" · ")}</p>` : "";
		const why = d.status === "exclude" ? `<p class="why">${esc(d.reason)}</p>` : "";
		return `<article class="c${d.status === "exclude" ? " out" : ""}" style="--d:${Math.min(depth, 4)}" data-cat="${esc(d.category ?? "import")}">
<header><span class="id">#${c.wpId}</span> <strong>${esc(d.name)}</strong>${host ? ` <span class="url">${esc(host)}</span>` : ""} <time datetime="${esc(c.date)}">${esc(date(c.date))}</time> ${badges.join(" ")}${d.score ? ` <span class="score s${Math.min(d.score, 3)}">score ${d.score}</span>` : ""}</header>
${why}<div class="body">${esc(text)}</div>${sig}${notes}</article>`;
	};

	const postLink = (d) => {
		const path = entryPath(d.entry?.slug ?? d.post?.slug ?? "", d.collection ?? "posts");
		return siteUrl ? `<a href="${esc(siteUrl + path)}">${esc(d.post?.title || path)}</a>` : esc(d.post?.title || path);
	};

	// Will import: per post, threaded as it will show (one level in EmDash, deeper here for reading)
	const kept = decisions.filter((d) => d.status === "import");
	const posts = new Map();
	for (const d of kept) {
		const key = d.c.postWpId;
		if (!posts.has(key)) posts.set(key, []);
		posts.get(key).push(d);
	}
	const thread = (list) => {
		const ids = new Set(list.map((d) => d.c.wpId));
		const kids = new Map();
		const roots = [];
		for (const d of list) {
			if (d.parentWpId && ids.has(d.parentWpId)) {
				if (!kids.has(d.parentWpId)) kids.set(d.parentWpId, []);
				kids.get(d.parentWpId).push(d);
			} else roots.push(d);
		}
		const walk = (d, depth) => [card(d, { depth }), ...(kids.get(d.c.wpId) ?? []).map((k) => walk(k, depth + 1))].join("\n");
		return roots.map((d) => walk(d, 0)).join("\n");
	};
	const importHtml = [...posts.values()]
		.sort((a, b) => b.length - a.length)
		.map((list) => `<section class="post"><h3>${postLink(list[0])} <span class="n">${list.length}</span></h3>\n${thread(list)}</section>`)
		.join("\n");

	const near = kept.filter((d) => d.score > 0).sort((a, b) => b.score - a.score);
	const nearHtml = near.length
		? `<details open><summary><h2>Kept, with some spam signals <span class="n">${near.length}</span></h2></summary><p class="lead">Under the threshold, so they'll be imported. Move any that are spam into <code>comments.exclude</code>.</p>${near.map((d) => `<div class="on">on ${postLink(d)}</div>${card(d)}`).join("\n")}</details>`
		: "";

	const outGroups = Object.keys(CATEGORY)
		.map((cat) => [cat, decisions.filter((d) => d.status === "exclude" && d.category === cat)])
		.filter(([, list]) => list.length)
		.map(
			([cat, list]) =>
				`<details${cat === "spam" ? " open" : ""}><summary><h2>${esc(CATEGORY[cat][0])} <span class="n">${list.length}</span></h2></summary><p class="lead">${esc(CATEGORY[cat][1])}</p>${list
					.map((d) => {
						const parent = d.c.parentWpId && byId.get(d.c.parentWpId);
						return `<div class="on">on ${postLink(d)}${parent ? ` · reply to #${parent.c.wpId} (${esc(parent.name)})` : ""}</div>${card(d, { full: false })}`;
					})
					.join("\n")}</details>`,
		)
		.join("\n");

	const chips = [
		`<span class="chip ok"><b>${counts.importComments}</b> comments to import</span>`,
		`<span class="chip ok"><b>${counts.importPings}</b> pingbacks to import</span>`,
		`<span class="chip"><b>${counts.excluded}</b> left out</span>`,
		checkedTarget ? `<span class="chip"><b>${counts.existing}</b> already on ${esc(target)}</span>` : `<span class="chip warn">target not checked (--offline)</span>`,
		...Object.entries(counts.byCategory).map(([cat, n]) => `<span class="chip">${esc(CATEGORY[cat]?.[0] ?? cat)}: <b>${n}</b></span>`),
	];

	return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>Comment import preview</title>
<style>
:root{color-scheme:light dark;--bg:light-dark(#f7f6f2,#141412);--card:light-dark(#fff,#1d1c19);--ink:light-dark(#1b1a17,#ecebe6);--muted:light-dark(#6c6a62,#9a978d);--rule:light-dark(#e2dfd6,#34322c);--ok:light-dark(#0b6a4f,#6fd3ac);--warn:light-dark(#9a4d00,#f0b46a);--bad:light-dark(#a3221b,#ff8f86);--chip:light-dark(#eeece5,#26251f)}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--ink);font:15px/1.5 system-ui,-apple-system,"Segoe UI",sans-serif}
main{max-width:58rem;margin:0 auto;padding:24px 16px 80px}
h1{font-size:1.6rem;margin:0 0 4px;letter-spacing:-.02em}h2{display:inline;font-size:1.15rem;margin:0}h3{font-size:1rem;margin:0 0 8px}
.meta{color:var(--muted);font-size:.85rem;margin:0 0 16px}.chips{display:flex;flex-wrap:wrap;gap:6px;margin:0 0 16px}
.chip{background:var(--chip);border-radius:99px;padding:3px 10px;font-size:.85rem}.chip.ok b{color:var(--ok)}.chip.warn{color:var(--warn)}
.tools{position:sticky;top:0;background:var(--bg);padding:8px 0;z-index:1;border-bottom:1px solid var(--rule);margin-bottom:12px}
.tools input{width:100%;padding:8px 10px;border:1px solid var(--rule);border-radius:8px;background:var(--card);color:inherit;font:inherit}
details{margin:18px 0}summary{cursor:pointer;padding:6px 0}.lead{color:var(--muted);margin:2px 0 10px;font-size:.9rem}
.post{margin:16px 0 22px}.n{color:var(--muted);font-weight:400;font-size:.85em}
.c{background:var(--card);border:1px solid var(--rule);border-radius:10px;padding:10px 12px;margin:6px 0 6px calc(var(--d,0)*22px)}
.c.out{border-style:dashed}.c header{font-size:.85rem;display:flex;flex-wrap:wrap;gap:4px 8px;align-items:baseline}
.id{color:var(--muted);font-variant-numeric:tabular-nums}.url{color:var(--muted);word-break:break-all}time{color:var(--muted)}
.b{font-size:.75rem;border:1px solid var(--rule);border-radius:99px;padding:0 7px}.b.ok{color:var(--ok);border-color:currentColor}
.score{font-size:.75rem;font-weight:600;border-radius:99px;padding:0 7px;background:var(--chip)}.score.s3{color:var(--bad)}.score.s2,.score.s1{color:var(--warn)}
.body{white-space:pre-wrap;overflow-wrap:anywhere;margin-top:6px}.why{margin:6px 0 0;color:var(--bad);font-weight:600;font-size:.88rem}
.sig{margin:6px 0 0;padding-left:18px;font-size:.82rem;color:var(--muted)}.sig b{color:var(--ink)}.note{margin:6px 0 0;font-size:.82rem;color:var(--warn)}
.on{font-size:.8rem;color:var(--muted);margin-top:12px}a{color:inherit}code{font-size:.9em}
.hidden{display:none}
</style>
</head>
<body>
<main>
<h1>${esc(title)}: comment import preview</h1>
<p class="meta">Generated ${esc(generated)} · target ${esc(target)} · extras file ${esc(extrasFile)} · email addresses are never shown here (any typed into a comment are masked)</p>
<div class="chips">${chips.join("")}</div>
<div class="tools"><input type="search" placeholder="Filter by name, text, URL or #id…" aria-label="Filter comments"></div>
${nearHtml}
<details open><summary><h2>Will import <span class="n">${kept.length}</span></h2></summary><p class="lead">Threaded as in WordPress. EmDash keeps one level of replies, so deeper replies show under their top-level comment.</p>
${importHtml || "<p>Nothing.</p>"}</details>
${outGroups}
</main>
<script>
const box=document.querySelector(".tools input");
box.addEventListener("input",()=>{const q=box.value.trim().toLowerCase();for(const el of document.querySelectorAll("article.c")){el.classList.toggle("hidden",q&&!el.textContent.toLowerCase().includes(q));}});
</script>
</body>
</html>
`;
}
