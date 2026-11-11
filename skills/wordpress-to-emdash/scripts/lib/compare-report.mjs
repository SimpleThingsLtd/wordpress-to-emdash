/**
 * Renders <paths.compare>/report.json as a self-contained report page
 * (report.html, next to it). Screenshots are referenced as shots/*.
 * Everything site-specific comes from the report itself (site name, hosts,
 * locale and time zone), so --render-only works on an old report.json.
 */

const esc = (s) =>
	String(s ?? "")
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;")
		.replace(/"/g, "&quot;");
const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
const pathOf = (u) => {
	try {
		return decodeURI(new URL(u).pathname);
	} catch {
		return u ?? "";
	}
};

export const KIND_LABELS = {
	"page-missing": "Page missing on the new site",
	"page-wrong-redirect": "Redirects to a different page",
	"listing-page-redirect": "Listing page redirected",
	"page-replaced": "Page replaced",
	"post-shadowed": "Posts hidden behind a new-site page",
	"pattern-p": "?p= and ?page_id= links",
	"pattern-uploads": "/wp-content/uploads/ files",
	"pattern-category": "Category archives",
	"pattern-tag": "Tag archives",
	"pattern-feed": "Feeds",
	"pattern-date-archive": "Year and month archives",
	"pattern-author": "Author archive",
	"pattern-misc": "Other WordPress addresses",
	"pattern-attachment-page": "Attachment pages",
	"sitemap-lists-non-200": "New sitemap lists a broken URL",
	"sitemap-lists-redirect": "New sitemap lists a redirect",
	"missing-from-new-sitemap": "Pages missing from the new sitemap",
	"paragraphs-missing": "Paragraphs missing",
	"paragraphs-changed": "Paragraphs only partly match",
	"paragraphs-glued": "Paragraph breaks lost, words run together",
	"paragraphs-merged": "Paragraphs merged into line breaks",
	"headings-missing": "Headings missing",
	"headings-demoted": "Headings now plain text",
	"list-items-missing": "List items missing",
	"list-items-flattened": "Lists flattened to text",
	"quotes-missing": "Blockquotes missing",
	"quotes-flattened": "Blockquotes now plain paragraphs",
	"citations-missing": "Quote citations missing",
	"citations-unstyled": "Quote citations no longer styled",
	"captions-missing": "Image captions missing",
	"tables-missing": "Tables missing",
	"shortcode-visible": "Raw shortcodes shown as text",
	"markup-visible": "HTML shown as text",
	"entities-visible": "HTML entities shown as text",
	"code-shown-as-text": "Script or CSS source printed as text",
	"text-added": "Text WordPress didn't show",
	"no-prose": "No content element",
	"embed-lost": "Embeds that displayed on WordPress are gone",
	"embed-degraded": "Embeds reduced to a link or text",
	"embed-not-shown-on-old": "Embeds that didn't display on WordPress either",
	"gallery-missing": "Galleries missing",
	"images-missing": "Images missing",
	"images-missing-dead-on-old": "Images not migrated (already broken)",
	"image-broken": "Images that don't load",
	"image-broken-external": "Hotlinked images that don't load (same on WordPress)",
	"image-src-old-host": "Images still pointing at WordPress (will redirect)",
	"image-breaks-at-cutover": "Images that break at cutover",
	"internal-link-broken": "Internal links that now 404",
	"internal-link-broken-before": "Internal links already broken on WordPress",
	"code-missing": "Code blocks missing",
	"code-flattened": "Code blocks turned into paragraphs",
	"code-different": "Code text differs",
	"code-double-escaped": "Code shows escaped entities",
	"code-whitespace": "Code differs in whitespace only",
	"code-extra": "Code blocks WordPress didn't show",
	"code-empty-on-old": "Code boxes already empty on WordPress",
	"title-different": "Titles differ",
	"title-double-escaped": "Titles show escaped entities",
	"date-different": "Publish dates differ",
	"date-missing": "Publish date missing",
	"categories-different": "Categories differ",
	"tags-different": "Tags differ",
	"featured-missing": "Featured image missing",
	"featured-hidden-link-post": "Featured image hidden on link posts",
	"link-url-different": "Link-post destination differs",
	"comments-not-imported": "Comments not imported",
	"shortcodes-in-export": "Shortcodes in the export",
	"listing-page": "Listing pages rebuilt as templates",
};
const baseOf = (k) => k.match(/^pattern-(.+)-base$/)?.[1];
const label = (k) => KIND_LABELS[k] ?? (baseOf(k) ? `Old /${baseOf(k)}/<slug>/ addresses` : k);
const SEVERITIES = ["critical", "high", "medium", "low"];

function pageLinks(f) {
	const parts = [];
	if (f.oldUrl) parts.push(`<a href="${esc(f.oldUrl)}" target="_blank" rel="noopener">WordPress</a>`);
	if (f.newUrl) parts.push(`<a href="${esc(f.newUrl)}" target="_blank" rel="noopener">New</a>`);
	return parts.length ? `<span class="links">${parts.join("")}</span>` : "";
}

function evidence(f) {
	const d = f.details ?? {};
	const out = [];
	if (d.paragraphs?.length) {
		out.push(
			`<ol class="paras">${d.paragraphs
				.slice(0, 12)
				.map(
					(p) =>
						`<li><blockquote>${esc(p.text)}</blockquote><p class="meta">${p.words} words · ${Math.round(p.score * 100)}% of its word pairs found${p.closest ? ` · closest new text (${Math.round(p.closestScore * 100)}%): “${esc(p.closest)}”` : ""}</p></li>`,
				)
				.join("")}</ol>${d.paragraphs.length > 12 ? `<p class="meta">…and ${d.paragraphs.length - 12} more in report.json</p>` : ""}`,
		);
	}
	if (d.oldSnippet !== undefined && d.newSnippet !== undefined) {
		out.push(
			`<p class="meta">First difference at line ${d.line} (${d.oldLines} → ${d.newLines} lines, ${d.oldChars} → ${d.newChars} characters)</p><div class="code-pair"><div><span class="side">WordPress</span><pre>${esc(d.oldSnippet)}</pre></div><div><span class="side">New</span><pre>${esc(d.newSnippet)}</pre></div></div>`,
		);
	}
	if (d.blocks?.length && typeof d.blocks[0] === "string") out.push(d.blocks.slice(0, 4).map((b) => `<pre>${esc(b || "(empty)")}</pre>`).join(""));
	for (const key of ["lost", "demoted", "quotes", "captions", "citations", "shortcodes", "markup", "entities", "examples", "lines"]) {
		const v = d[key];
		if (Array.isArray(v) && v.length && typeof v[0] === "string")
			out.push(`<p class="meta">${esc(key)}</p><ul class="plain">${v.slice(0, 15).map((x) => `<li>${esc(x)}</li>`).join("")}</ul>`);
	}
	if (d.images?.length) {
		out.push(
			`<ul class="plain mono">${d.images
				.slice(0, 15)
				.map((i) => (typeof i === "string" ? `<li>${esc(i)}</li>` : `<li>${esc(i.status)} · ${esc(i.src)}${i.tested && i.tested !== i.src ? ` (tested ${esc(i.tested)})` : ""}</li>`))
				.join("")}</ul>`,
		);
	}
	if (d.unmatchedOld?.length) out.push(`<p class="meta">WordPress images with no counterpart (all load on WordPress)</p><ul class="plain mono">${d.unmatchedOld.slice(0, 15).map((s) => `<li>${esc(s)}</li>`).join("")}</ul>${d.unmatchedOld.length > 15 ? `<p class="meta">…${d.unmatchedOld.length - 15} more</p>` : ""}`);
	if (d.links?.length) out.push(`<ul class="plain mono">${d.links.slice(0, 15).map((l) => `<li>${esc(l.status)} · ${esc(l.href)}${l.oldStatus ? ` (WordPress: ${esc(l.oldStatus)})` : ""}</li>`).join("")}</ul>`);
	if (d.oldEmbeds?.length) out.push(`<ul class="plain mono">${d.oldEmbeds.slice(0, 8).map((e) => `<li>${esc(e.kind)} · ${esc(e.src ?? "(no src)")}</li>`).join("")}</ul>`);
	if (d.why?.length) out.push(`<p class="meta">Why it didn't show on WordPress: ${esc(d.why.join("; "))}</p>`);
	if (d.old !== undefined && d.new !== undefined && !Array.isArray(d.old)) out.push(`<p class="meta">WordPress: ${esc(d.old)}<br>New: ${esc(d.new)}</p>`);
	if (Array.isArray(d.old) && Array.isArray(d.new)) out.push(`<p class="meta">WordPress: ${esc(d.old.join(", ") || "none")}<br>New: ${esc(d.new.join(", ") || "none")}</p>`);
	if (d.hops?.length) out.push(`<p class="meta mono">${d.hops.map((h) => `${esc(pathOf(h.url) || h.url)} ${esc(h.status)}`).join(" → ")}</p>`);
	if (d.paths?.length) out.push(`<ul class="plain mono">${d.paths.slice(0, 30).map((p) => `<li>${esc(p)}</li>`).join("")}</ul>`);
	return out.join("");
}

function findingRow(f) {
	const ev = evidence(f);
	const where = f.slug ? `/${esc(f.slug)}/` : f.newUrl ? esc(pathOf(f.newUrl)) : "";
	const search = esc(`${f.slug ?? ""} ${f.title ?? ""} ${f.summary} ${f.kind}`.toLowerCase());
	return `<li class="f-row" data-sev="${f.severity}" data-q="${search}">
	<div class="f-head"><span class="chip sev-${f.severity}">${f.severity}</span><span class="f-where">${f.title ? `<strong>${esc(f.title)}</strong> <span class="mono slug">${where}</span>` : `<span class="mono">${where}</span>`}</span>${pageLinks(f)}</div>
	<p class="f-sum">${esc(f.summary)}</p>
	${ev ? `<details class="ev"><summary>Evidence</summary>${ev}</details>` : ""}
</li>`;
}

function kindBlock(kind, list) {
	const sev = list[0].severity;
	const head = list.slice(0, 10);
	const rest = list.slice(10);
	return `<section class="kind" data-kind="${esc(kind)}">
	<h4><span class="chip sev-${sev}">${sev}</span> ${esc(label(kind))} <span class="count">${list.length}</span></h4>
	<ul class="findings">${head.map(findingRow).join("")}</ul>
	${rest.length ? `<details class="more"><summary>Show ${rest.length} more</summary><ul class="findings">${rest.map(findingRow).join("")}</ul></details>` : ""}
</section>`;
}

function patternTable(tests) {
	const groups = new Map();
	for (const t of tests) {
		if (!groups.has(t.group)) groups.set(t.group, []);
		groups.get(t.group).push(t);
	}
	const names = { p: "?p= / ?page_id=", uploads: "Uploads", "attachment-page": "Attachment pages", category: "Categories", tag: "Tags", feed: "Feeds", misc: "Other", author: "Author", "date-archive": "Date archives" };
	const nameOf = (g) => names[g] ?? (/-base$/.test(g) ? `/${g.replace(/-base$/, "")}/<slug>/` : g);
	const rows = [...groups.entries()].map(([g, list]) => {
		const pass = list.filter((t) => t.pass).length;
		const fails = list.filter((t) => !t.pass);
		const sample = fails.slice(0, 3).map((t) => `${esc(t.label)}: ${esc(t.result)}`).join("<br>");
		return `<tr><th scope="row">${esc(nameOf(g))}</th><td class="num">${pass}/${list.length}</td><td><span class="bar"><span style="width:${Math.round((pass / list.length) * 100)}%"></span></span></td><td class="small">${fails.length ? sample + (fails.length > 3 ? `<br>…${fails.length - 3} more` : "") : "all pass"}</td></tr>`;
	});
	return `<div class="table-wrap"><table class="patterns"><thead><tr><th>Old address pattern</th><th class="num">Pass</th><th></th><th>Failures (first three)</th></tr></thead><tbody>${rows.join("")}</tbody></table></div>`;
}

/**
 * Proposed fixes, built from what the run found. Each names the finding
 * kinds it covers; fixes with nothing to fix are left out.
 */
const FIX_RULES = [
	{
		type: "mechanical",
		kinds: ["gallery-missing", "images-missing"],
		title: "Rebuild galleries and missing images from the WXR",
		html: "For each affected post, read the gallery’s attachment IDs (the <code>ids=</code> list, or the post’s attached images for a bare <code>[gallery]</code>) from the export, look each file up in the EmDash media library and put a Portable Text <code>gallery</code> block where the shortcode was. <code>fix-content.mjs --only gallery</code> does this (gotcha A5).",
	},
	{
		type: "mechanical",
		kinds: ["shortcode-visible", "captions-missing"],
		title: "Turn leftover [caption] shortcodes into captioned images",
		html: "Find paragraphs holding <code>[caption …]</code> text, take the image and the caption text before <code>[/caption]</code>, and write an image block with that caption. <code>fix-content.mjs --only captions</code> does this, and removes old theme layout shortcodes (gotchas A4, A4b).",
	},
	{
		type: "mechanical",
		kinds: ["paragraphs-glued", "paragraphs-merged"],
		title: "Restore classic-editor paragraphs with wpautop",
		html: "The converter took classic (pre-Gutenberg) bodies without WordPress’s <code>wpautop</code>, so blank-line paragraph breaks became <code>&lt;br&gt;</code> runs or vanished, gluing sentences together. <code>fix-content.mjs --only classic</code> lines each block up against a wpautop port of the export and splits it there, keeping every span (gotcha A3).",
	},
	{
		type: "mechanical",
		kinds: ["embed-lost", "embed-degraded"],
		match: (f) => ["youtube", "vimeo", "video", "audio"].includes(f.details?.type),
		title: "Restore YouTube, Vimeo, video and audio embeds",
		html: "For each lost embed whose provider EmDash’s <code>Embed</code> block already renders (YouTube, Vimeo, self-hosted video or audio), insert an <code>embed</code> block with the original URL where the WordPress embed sat. The live check lists every URL in the evidence; <code>fix-content.mjs --only embeds</code> does the insert (gotcha A6).",
	},
	{
		type: "mechanical",
		kinds: ["code-missing", "code-flattened", "code-different", "code-double-escaped", "code-whitespace"],
		title: "Re-import the affected code blocks",
		html: "Classic posts often kept their <code>&lt;pre&gt;</code> code as paragraphs with line breaks. Replace each listed block with a Portable Text <code>code</code> block holding the text WordPress rendered (the old side of the evidence). <code>fix-content.mjs --only code,brackets</code> does this; re-run the audit to confirm the text matches exactly (gotcha A7).",
	},
	{
		type: "mechanical",
		kinds: ["featured-missing", "date-different", "date-missing", "categories-different", "tags-different", "title-different"],
		title: "Re-sync metadata from the WordPress REST API",
		html: "Set featured image, publish date, categories and tags from <code>/wp-json/wp/v2/posts</code> for the listed posts. The values are in <code>report.json</code> under each finding’s <code>details</code>.",
	},
	{
		type: "mechanical",
		kinds: ["sitemap-lists-non-200", "sitemap-lists-redirect", "missing-from-new-sitemap"],
		title: "Keep the new sitemap to URLs that return 200",
		html: "Unpublish pages that now redirect (<code>fix-content.mjs --only unpublish</code>, from <code>urls.replacedPages</code>) and fix slugs that 404 (gotchas C4, C6). Anything else is site code.",
	},
	{
		type: "mechanical",
		kindTest: (k) => /^pattern-.+-base$/.test(k),
		title: "Redirect old permalink bases to /<slug>/",
		html: "WordPress still answers older permalink structures (such as <code>/blog/&lt;slug&gt;/</code>) with a 301 to the post, and old posts link that way. Add one route per base, <code>src/pages/&lt;base&gt;/[slug]/[...rest].ts</code> (from the templates), that redirects to <code>/[slug]/</code>; then internal links of that shape resolve too (gotchas C3, C3b).",
	},
	{
		type: "mechanical",
		kinds: ["image-breaks-at-cutover", "image-src-old-host"],
		title: "Point remaining WordPress image URLs at R2 media",
		html: "Some images still use full WordPress <code>/wp-content/uploads/…</code> URLs. They load today because WordPress serves them. Where the file has no redirect on the new site they 404 after cutover. Import the missing files and rewrite the URLs: <code>fix-media-urls.mjs</code>, then <code>fix-content.mjs --only wpImages</code> (gotchas B1, B2).",
	},
	{
		type: "mechanical",
		kinds: ["title-double-escaped"],
		title: "Decode entities in imported titles",
		html: "Titles with “&amp;” were stored as <code>&amp;amp;</code>, so the page shows “&amp;amp;”. <code>fix-content.mjs --only titles</code> decodes them (gotcha A9).",
	},
	{
		type: "mechanical",
		kinds: ["pattern-uploads"],
		title: "Check the /wp-content/uploads/ redirects",
		html: "Old upload addresses must 301 to their media file. EmDash’s redirect middleware skips paths with file extensions, so they need <code>src/pages/wp-content/uploads/[...path].ts</code> from the templates, plus the redirect rows from <code>add-redirects.mjs</code>. If every sampled upload fails, check the deployed build includes that route (gotchas C1, E2); if a few fail, add those files.",
	},
	{
		type: "judgement",
		kinds: ["post-shadowed"],
		title: "Decide about posts hidden by new routes",
		html: "A WordPress post’s address now serves a new-site page instead (a section route such as an archive). If the post is an empty placeholder, let it go. Otherwise give it a new slug and redirect (gotcha C7).",
	},
	{
		type: "judgement",
		kinds: ["page-missing", "page-wrong-redirect"],
		title: "Decide what happens to the missing pages",
		html: "Content WordPress still serves isn’t on the new site. Check whether the export left out a post type (gotcha A14): if so, export it and import it, or recreate it; otherwise retire each address with a redirect to its nearest replacement.",
	},
	{
		type: "judgement",
		kinds: ["embed-lost", "embed-degraded"],
		match: (f) => !["youtube", "vimeo", "video", "audio"].includes(f.details?.type),
		title: "Choose how other embeds render",
		html: "EmDash’s Embed block plays only YouTube and Vimeo; anything else (CodePen, Spotify, SlideShare, tweets …) becomes a bare link. The options per provider or per post: a link card, an isolated HTML block with the provider’s embed (check the CSP), or leaving it out. Record each choice in <code>decisions.json</code> and re-run <code>fix-content.mjs</code> (gotcha A6).",
	},
	{
		type: "judgement",
		kinds: ["code-shown-as-text", "tables-missing", "markup-visible"],
		title: "Rebuild or drop interactive widgets",
		html: "Posts that ran their own script on WordPress now print the script source as text. Each needs a call: show it as a code block, remove it, or rebuild the widget as an isolated HTML block. Record it in <code>decisions.json</code> as <code>&lt;slug&gt;:code:script-text</code> (gotcha A8).",
	},
	{
		type: "judgement",
		kinds: ["pattern-p", "pattern-date-archive", "pattern-feed", "pattern-misc", "pattern-attachment-page", "pattern-category", "pattern-tag", "pattern-author"],
		title: "Pick destinations for old WordPress address patterns",
		html: "Decide where ?p= shortlinks, /YYYY/ and /YYYY/MM/ archives, /page/N/, attachment pages, nested categories and the old sitemap addresses should go: a redirect, or an honest 404 or 410. Once decided, the redirects are mechanical; the templates cover ?p=, feeds, nested categories and sitemaps (gotchas C2, C5).",
	},
	{
		type: "judgement",
		kinds: ["internal-link-broken", "internal-link-broken-before"],
		title: "Repoint internal links that 404",
		html: "Most point at pages that no longer exist. Pick a target for each (the nearest post or page, or unlink); then a script can rewrite them across posts (gotcha C8).",
	},
	{
		type: "judgement",
		kinds: ["embed-not-shown-on-old"],
		title: "Optionally revive embeds that were already dead",
		html: "Some embeds (often Flash-era players) didn’t display on WordPress either. Where the video still exists, an <code>embed</code> block would bring it back. It isn’t migration loss, so it’s optional.",
	},
	{
		type: "judgement",
		kinds: ["paragraphs-missing", "paragraphs-changed", "headings-missing", "list-items-missing", "quotes-missing"],
		title: "Review the remaining text losses page by page",
		html: "After the mechanical repairs, re-run the audit. Whatever is still missing needs a read-through. Common causes: footnotes blocks, gallery and embed captions, social-icon lists, and list items that start with a bare URL. <code>fix-content.mjs --only textLoss</code> restores the unambiguous ones (gotcha A10).",
	},
];

export function proposeFixes(report) {
	const open = report.findings.filter((f) => !f.known);
	const all = report.findings;
	return FIX_RULES.map((rule) => {
		const kinds = rule.kinds ?? [];
		const hasKind = (k) => kinds.includes(k) || Boolean(rule.kindTest?.(k));
		const hits = (kinds.includes("embed-not-shown-on-old") ? all : open).filter((f) => hasKind(f.kind) && (!rule.match || rule.match(f)));
		if (rule.kindTest) kinds.push(...new Set(hits.map((f) => f.kind)));
		if (!hits.length) return null;
		const pages = new Set(hits.map((f) => f.slug).filter(Boolean));
		return {
			type: rule.type,
			title: rule.title,
			html: rule.html,
			kinds,
			affects: `${plural(hits.length, "finding")}${pages.size ? ` on ${plural(pages.size, "page")}` : ""}`,
		};
	}).filter(Boolean);
}

export function renderReportHtml(report, fixes = report.fixes ?? proposeFixes(report)) {
	const c = report.counts;
	const inv = c.inventory;
	const open = report.findings.filter((f) => !f.known);
	const known = report.findings.filter((f) => f.known);
	const patternFindings = open.filter((f) => f.kind.startsWith("pattern-"));
	const generated = new Date(report.generatedAt);
	const locale = report.site?.locale || undefined;
	const timeZone = report.site?.timeZone || undefined;
	const when = generated.toLocaleString(locale, { dateStyle: "medium", timeStyle: "long", timeZone });
	const siteName = report.site?.name || report.sites.old.replace(/^https?:\/\//, "");
	const oldTotal = inv.oldPosts + inv.oldPages + (inv.oldExtraTotal ?? inv.oldPortfolio ?? 0);

	// Top issues: one per kind/page, highest severity and score first
	const top = [...open]
		.filter((f) => !f.kind.startsWith("pattern-"))
		.sort((a, b) => SEVERITIES.indexOf(a.severity) - SEVERITIES.indexOf(b.severity) || (b.score ?? 0) - (a.score ?? 0))
		.slice(0, 10);

	const groupsHtml = report.groups
		.map((g) => {
			const fs = open.filter((f) => f.group === g.key && !f.kind.startsWith("pattern-"));
			const byKind = new Map();
			for (const f of fs) {
				if (!byKind.has(f.kind)) byKind.set(f.kind, []);
				byKind.get(f.kind).push(f);
			}
			const kinds = [...byKind.entries()].sort((a, b) => SEVERITIES.indexOf(a[1][0].severity) - SEVERITIES.indexOf(b[1][0].severity) || b[1].length - a[1].length);
			const extra = g.key === "pages" && report.urlTests?.length ? `<h4 class="sub">Old URL patterns on the new site <span class="count">${inv.urlTests - inv.urlTestsFailed}/${inv.urlTests} pass</span></h4>${patternTable(report.urlTests)}` : "";
			return `<section class="group" id="g-${g.key}">
	<h3>${esc(g.title)} <span class="count">${fs.length + (g.key === "pages" ? patternFindings.length : 0)}</span></h3>
	${kinds.length ? kinds.map(([k, list]) => kindBlock(k, list)).join("") : `<p class="empty">Nothing found.</p>`}
	${extra}
</section>`;
		})
		.join("");

	const shots = (report.shots ?? [])
		.map(
			(s, i) => `<figure class="shot">
	<figcaption><span class="rank">${i + 1}</span><span><strong>${esc(s.title)}</strong> <span class="mono slug">/${esc(s.slug)}/</span></span>${pageLinks(s)}<a href="${esc(s.file)}" target="_blank" rel="noopener" class="full">Full size</a></figcaption>
	${s.fileNew ? `<div class="shot-pair"><div class="shot-frame"><img src="${esc(s.file)}" alt="WordPress page: ${esc(s.title)}" loading="lazy"></div><div class="shot-frame"><img src="${esc(s.fileNew)}" alt="New EmDash page: ${esc(s.title)}" loading="lazy"></div></div>` : `<div class="shot-frame"><img src="${esc(s.file)}" alt="WordPress page on the left, new EmDash page on the right: ${esc(s.title)}" loading="lazy"></div>`}
</figure>`,
		)
		.join("");

	const onlyOld = report.onlyOld ?? [];
	const onlyNew = report.onlyNew ?? [];
	const knownBy = new Map();
	for (const f of known) knownBy.set(f.known, [...(knownBy.get(f.known) ?? []), f]);

	const fixesHtml = ["mechanical", "judgement"]
		.map((type) => {
			const list = fixes.filter((x) => x.type === type);
			if (!list.length) return "";
			return `<section class="fix-col"><h3>${type === "mechanical" ? "Mechanical: a script can do it" : "Needs the owner’s judgement"}</h3><ol class="fixes">${list
				.map((x) => `<li><h4>${esc(x.title)}</h4><p>${x.html}</p>${x.affects ? `<p class="meta">${esc(x.affects)}</p>` : ""}</li>`)
				.join("")}</ol></section>`;
		})
		.join("");

	// URL groups whose pass rate fell between runs (staging changed mid-audit)
	const hist = report.history ?? [];
	const latest = hist.at(-1);
	const drops = [];
	if (latest)
		for (const [g, [pass, total]] of Object.entries(latest.urlGroups ?? {})) {
			const ratio = (h) => h.urlGroups[g][0] / h.urlGroups[g][1];
			const prev = hist.slice(0, -1).filter((h) => h.urlGroups?.[g]).sort((a, b) => ratio(b) - ratio(a))[0];
			if (!prev) continue;
			const [pp, pt] = prev.urlGroups[g];
			if (pass / total < pp / pt) drops.push({ g, pass, total, pp, pt, prevAt: prev.at, at: latest.at });
		}
	const fmt = (iso) => new Date(iso).toISOString().slice(11, 16) + " UTC";
	const callout = drops.length
		? `<aside class="callout" role="note"><p class="eyebrow">Staging changed during the audit</p>${drops
				.map(
					(d) =>
						`<p><strong>${esc(d.g === "uploads" ? "Old /wp-content/uploads/ addresses" : d.g)}:</strong> ${d.pp} of ${d.pt} resolved at ${fmt(d.prevAt)}, ${d.pass} of ${d.total} at ${fmt(d.at)}. ${d.g === "uploads" ? "If every upload address now gets the site’s HTML 404 page, the deployed build no longer reaches <code>src/pages/wp-content/uploads/[...path].ts</code>: check for a deploy from another working tree or an ignored file (gotchas E1, E2). That’s a regression in the build, not lost content; the image findings that depend on these redirects inherit it." : ""}</p>`,
				)
				.join("")}</aside>`
		: "";

	const sevTiles = SEVERITIES.map((s) => `<button type="button" class="tile sev-${s}" data-filter="${s}" aria-pressed="false"><span class="n">${c.bySeverity[s]}</span><span class="l">${s}</span></button>`).join("");

	return `<title>${esc(siteName)} migration audit</title>
<meta name="claude:viewport-fit-sides" content="cover">
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700;800&family=Source+Serif+4:ital,opsz,wght@0,8..60,400;0,8..60,600;1,8..60,400&family=Geist+Mono:wght@400;500&display=swap">
<style>
/* Layout: one report column on a paper-and-ink palette; severity carries the only extra colour. */
:root {
	--paper: #f6f3eb; --raised: #fbf9f4; --sunk: #ece7da; --ink: #18170f; --ink-soft: #45423a; --muted: #6f6a58;
	--rule: #d9d2c1; --rule-strong: #b9b09b; --accent: #0b6a65; --accent-soft: #dcebe6;
	--critical: #a3241b; --high: #b8461a; --medium: #8a6300; --low: #4d6378; --info: #6f6a58;
	--font-ui: "Inter", ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif;
	--font-read: "Source Serif 4", Georgia, "Times New Roman", serif;
	--font-mono: "Geist Mono", ui-monospace, "SF Mono", Menlo, Consolas, monospace;
	--step--1: 0.8125rem; --step-0: 0.9375rem; --step-1: 1.125rem; --step-2: 1.5rem; --step-3: 2.25rem;
	--measure: 72rem;
}
@media (prefers-color-scheme: dark) { :root:not([data-theme="light"]) {
	--paper: #11110e; --raised: #191814; --sunk: #1d1c17; --ink: #ede8db; --ink-soft: #c3bdae; --muted: #9a9483;
	--rule: #2e2c25; --rule-strong: #4a463b; --accent: #74cfc2; --accent-soft: #15302d;
	--critical: #ff8a7a; --high: #ffa36b; --medium: #e6c15c; --low: #9fb4c8; --info: #9a9483; color-scheme: dark;
} }
:root[data-theme="dark"] {
	--paper: #11110e; --raised: #191814; --sunk: #1d1c17; --ink: #ede8db; --ink-soft: #c3bdae; --muted: #9a9483;
	--rule: #2e2c25; --rule-strong: #4a463b; --accent: #74cfc2; --accent-soft: #15302d;
	--critical: #ff8a7a; --high: #ffa36b; --medium: #e6c15c; --low: #9fb4c8; --info: #9a9483; color-scheme: dark;
}
* { box-sizing: border-box; }
body { background: var(--paper); color: var(--ink); font: 400 var(--step-0)/1.55 var(--font-ui); margin: 0;
	padding-left: max(16px, env(safe-area-inset-left, 0px)); padding-right: max(16px, env(safe-area-inset-right, 0px)); }
.wrap { max-width: var(--measure); margin: 0 auto; padding-block: 2.5rem 4rem; display: grid; grid-template-columns: minmax(0, 1fr); gap: 3rem; }
.wrap > * { min-width: 0; }
a { color: var(--accent); text-underline-offset: 2px; }
a:focus-visible, button:focus-visible, summary:focus-visible, input:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; border-radius: 4px; }
h1, h2, h3, h4 { font-family: var(--font-ui); text-wrap: balance; margin: 0; }
h1 { font-size: var(--step-3); font-weight: 800; letter-spacing: -0.03em; line-height: 1.05; }
h2 { font-size: var(--step-2); font-weight: 800; letter-spacing: -0.02em; }
h3 { font-size: var(--step-1); font-weight: 700; display: flex; align-items: baseline; gap: 0.6rem; }
h4 { font-size: var(--step-0); font-weight: 650; display: flex; align-items: center; gap: 0.5rem; flex-wrap: wrap; }
.mono { font-family: var(--font-mono); font-size: 0.92em; }
.eyebrow { font: 500 var(--step--1)/1.3 var(--font-mono); letter-spacing: 0.08em; text-transform: uppercase; color: var(--muted); margin: 0; }
.count { font: 500 var(--step--1) var(--font-mono); color: var(--muted); font-variant-numeric: tabular-nums; }
.meta { color: var(--muted); font-size: var(--step--1); margin: 0.25rem 0 0; }
.small { font-size: var(--step--1); }
header.top { display: grid; gap: 1rem; }
.lede { font: 400 1.1875rem/1.5 var(--font-read); color: var(--ink-soft); max-width: 46rem; margin: 0; }
.sites { display: flex; flex-wrap: wrap; gap: 0.4rem 1.25rem; font: 500 var(--step--1) var(--font-mono); }
.tiles { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 0.75rem; }
.tile { appearance: none; text-align: left; cursor: pointer; font: inherit; color: var(--ink); background: var(--raised); border: 1px solid var(--rule); border-top: 4px solid var(--sev, var(--rule-strong)); border-radius: 6px; padding: 0.85rem 1rem; display: grid; gap: 0.1rem; }
.tile .n { font: 800 var(--step-3)/1 var(--font-ui); letter-spacing: -0.03em; font-variant-numeric: tabular-nums; color: var(--sev); }
.tile .l { font: 500 var(--step--1) var(--font-mono); text-transform: uppercase; letter-spacing: 0.08em; color: var(--muted); }
.tile[aria-pressed="true"] { background: var(--sunk); border-color: var(--sev); }
.sev-critical { --sev: var(--critical); } .sev-high { --sev: var(--high); } .sev-medium { --sev: var(--medium); } .sev-low { --sev: var(--low); } .sev-info { --sev: var(--info); }
.facts { display: grid; grid-template-columns: repeat(auto-fit, minmax(9.5rem, 1fr)); gap: 0.5rem 1.5rem; margin: 0; }
.facts div { border-top: 1px solid var(--rule); padding-top: 0.5rem; }
.facts dt { font: 500 var(--step--1) var(--font-mono); color: var(--muted); letter-spacing: 0.04em; }
.facts dd { margin: 0; font-weight: 650; font-variant-numeric: tabular-nums; }
section > h2 { margin-bottom: 1rem; padding-bottom: 0.5rem; border-bottom: 2px solid var(--ink); display: flex; justify-content: space-between; align-items: baseline; gap: 1rem; flex-wrap: wrap; }
.toplist { margin: 0; padding: 0; list-style: none; counter-reset: top; display: grid; }
.toplist li { counter-increment: top; display: grid; grid-template-columns: 2.25rem minmax(0, 1fr) auto; gap: 0.75rem; align-items: baseline; padding: 0.6rem 0; border-bottom: 1px solid var(--rule); }
.toplist li::before { content: counter(top); font: 800 var(--step-1) var(--font-ui); color: var(--muted); font-variant-numeric: tabular-nums; }
.toplist .what { min-width: 0; }
.toplist .what strong { font-weight: 650; }
.chip { display: inline-block; font: 500 0.6875rem/1 var(--font-mono); letter-spacing: 0.08em; text-transform: uppercase; color: var(--sev); background: color-mix(in srgb, var(--sev) 13%, transparent); border: 1px solid color-mix(in srgb, var(--sev) 35%, transparent); padding: 0.3rem 0.45rem; border-radius: 4px; white-space: nowrap; }
.links { display: inline-flex; gap: 0.75rem; font: 500 var(--step--1) var(--font-ui); white-space: nowrap; }
.links a::after { content: " ↗"; }
.toolbar { display: flex; flex-wrap: wrap; gap: 0.75rem; align-items: center; position: sticky; top: env(safe-area-inset-top, 0px); z-index: 5; background: var(--paper); padding-block: 0.6rem; border-bottom: 1px solid var(--rule); }
.toolbar input { font: inherit; flex: 1 1 16rem; min-width: 0; padding: 0.55rem 0.75rem; border: 1px solid var(--rule-strong); border-radius: 6px; background: var(--raised); color: var(--ink); }
.toolbar .status { font: 500 var(--step--1) var(--font-mono); color: var(--muted); }
.toolbar button { font: 500 var(--step--1) var(--font-ui); background: none; border: 1px solid var(--rule-strong); color: var(--ink); border-radius: 6px; padding: 0.5rem 0.75rem; cursor: pointer; }
.group { display: grid; gap: 1.25rem; padding-top: 1.5rem; }
.group > h3 { font-size: var(--step-2); font-weight: 800; letter-spacing: -0.02em; }
.kind { display: grid; gap: 0.5rem; }
.findings { list-style: none; margin: 0; padding: 0; display: grid; border-top: 1px solid var(--rule); }
.f-row { padding: 0.7rem 0; border-bottom: 1px solid var(--rule); display: grid; gap: 0.25rem; min-width: 0; }
.f-head { display: flex; flex-wrap: wrap; align-items: center; gap: 0.35rem 0.75rem; }
.f-where { flex: 1 1 18rem; min-width: 0; overflow-wrap: anywhere; }
.slug { color: var(--muted); }
.f-sum { margin: 0; color: var(--ink-soft); overflow-wrap: anywhere; }
details > summary { cursor: pointer; font: 500 var(--step--1) var(--font-ui); color: var(--accent); width: fit-content; }
.ev { margin-top: 0.25rem; }
.ev[open] { background: var(--raised); border: 1px solid var(--rule); border-radius: 6px; padding: 0.5rem 0.85rem 0.85rem; }
.more > summary { padding: 0.6rem 0; }
.paras { margin: 0.5rem 0 0; padding-left: 1.25rem; display: grid; gap: 0.75rem; }
.paras blockquote { margin: 0; font: 400 1.0625rem/1.5 var(--font-read); color: var(--ink); border-left: 3px solid var(--rule-strong); padding-left: 0.75rem; overflow-wrap: anywhere; }
.plain { margin: 0.35rem 0 0; padding-left: 1.1rem; overflow-wrap: anywhere; }
pre { font: 400 0.8125rem/1.5 var(--font-mono); background: var(--sunk); border-radius: 6px; padding: 0.6rem 0.75rem; overflow-x: auto; white-space: pre; margin: 0.35rem 0 0; max-height: 18rem; }
.code-pair { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 0.75rem; }
.side { font: 500 var(--step--1) var(--font-mono); color: var(--muted); }
.table-wrap { overflow-x: auto; }
table { border-collapse: collapse; width: 100%; font-size: var(--step--1); }
th, td { text-align: left; padding: 0.5rem 0.6rem; border-bottom: 1px solid var(--rule); vertical-align: top; }
thead th { font: 500 0.75rem var(--font-mono); letter-spacing: 0.06em; text-transform: uppercase; color: var(--muted); }
.num { text-align: right; font-variant-numeric: tabular-nums; white-space: nowrap; }
.bar { display: block; width: 7rem; height: 6px; background: color-mix(in srgb, var(--critical) 25%, transparent); border-radius: 3px; overflow: hidden; margin-top: 0.45rem; }
.bar span { display: block; height: 100%; background: var(--accent); }
.h4.sub, h4.sub { margin-top: 1rem; font-size: var(--step-1); }
.shots { display: grid; gap: 2rem; }
.shot { margin: 0; display: grid; gap: 0.5rem; }
.shot figcaption { display: flex; flex-wrap: wrap; align-items: baseline; gap: 0.4rem 0.9rem; }
.shot .rank { font: 800 var(--step-1) var(--font-ui); color: var(--muted); }
.shot .full { font-size: var(--step--1); }
.shot-frame { max-height: 42rem; overflow: auto; border: 1px solid var(--rule); border-radius: 6px; background: var(--sunk); }
.shot-frame img { display: block; width: 100%; height: auto; }
.shot-pair { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 0.75rem; }
.twocol { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 2rem; }
.twocol > * { min-width: 0; }
.urllist { list-style: none; padding: 0; margin: 0.5rem 0 0; font: 400 var(--step--1)/1.5 var(--font-mono); max-height: 22rem; overflow: auto; border-top: 1px solid var(--rule); }
.urllist li { padding: 0.3rem 0; border-bottom: 1px solid var(--rule); overflow-wrap: anywhere; }
.known { display: grid; gap: 0.75rem; margin: 0; padding: 0; list-style: none; }
.known li { border-left: 3px solid var(--rule-strong); padding-left: 0.85rem; }
.fixes-grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 2rem; }
.fix-col { min-width: 0; display: grid; gap: 0.75rem; align-content: start; }
.fix-col > h3 { padding-bottom: 0.4rem; border-bottom: 1px solid var(--rule-strong); }
.fixes { margin: 0; padding-left: 1.25rem; display: grid; gap: 1rem; }
.fixes h4 { display: block; }
.fixes p { margin: 0.2rem 0 0; color: var(--ink-soft); }
.rerun pre { max-height: none; }
.empty { color: var(--muted); }
.callout { border: 1px solid color-mix(in srgb, var(--high) 45%, transparent); background: color-mix(in srgb, var(--high) 8%, var(--raised)); border-radius: 8px; padding: 1rem 1.25rem; display: grid; gap: 0.4rem; }
.callout p { margin: 0; max-width: 62rem; }
.callout .eyebrow { color: var(--high); }
code { font-family: var(--font-mono); font-size: 0.88em; background: var(--sunk); padding: 0.05em 0.3em; border-radius: 3px; overflow-wrap: anywhere; }
@media (max-width: 760px) {
	.tiles { grid-template-columns: repeat(2, minmax(0, 1fr)); }
	.twocol, .fixes-grid, .code-pair { grid-template-columns: minmax(0, 1fr); }
	.toplist li { grid-template-columns: 1.75rem minmax(0, 1fr); }
	.toplist li .links { grid-column: 2; }
	h1 { font-size: 1.875rem; }
}
@media (prefers-reduced-motion: reduce) { * { scroll-behavior: auto !important; } }
</style>

<div class="wrap">
<header class="top">
	<p class="eyebrow">WordPress → EmDash · content loss audit</p>
	<h1>${esc(siteName)} migration audit</h1>
	<p class="lede">Every published WordPress post and page compared with what the EmDash staging site renders: pages, paragraphs, blocks, media, embeds, code and metadata. Embeds were loaded in a real browser on both sites to see what actually displayed.</p>
	<div class="sites"><span>Old: <a href="${esc(report.sites.old)}" target="_blank" rel="noopener">${esc(report.sites.old.replace("https://", ""))}</a></span><span>New: <a href="${esc(report.sites.new)}" target="_blank" rel="noopener">${esc(report.sites.new.replace("https://", ""))}</a></span><span>Run ${esc(when)}</span></div>
	<div class="tiles" role="group" aria-label="Filter findings by severity">${sevTiles}</div>
	<dl class="facts">
		<div><dt>Old content URLs resolving</dt><dd>${inv.pagesOk} of ${oldTotal}</dd></div>
		<div><dt>Pages compared</dt><dd>${inv.pagesCompared}</dd></div>
		<div><dt>Pages with findings</dt><dd>${inv.pagesWithFindings}</dd></div>
		<div><dt>Old URL patterns passing</dt><dd>${inv.urlTests - inv.urlTestsFailed} of ${inv.urlTests}</dd></div>
		<div><dt>Images checked</dt><dd>${inv.imagesChecked}</dd></div>
		<div><dt>Internal links checked</dt><dd>${inv.internalLinksChecked}</dd></div>
		<div><dt>Known, not failures</dt><dd>${c.known}</dd></div>
	</dl>
</header>

${callout}

<section aria-labelledby="top-h">
	<h2 id="top-h">Top 10 issues</h2>
	<ol class="toplist">${top.map((f) => `<li><span class="what"><span class="chip sev-${f.severity}">${f.severity}</span> <strong>${esc(f.title ?? label(f.kind))}</strong> ${f.slug ? `<span class="mono slug">/${esc(f.slug)}/</span>` : ""}<br><span class="f-sum">${esc(f.summary)}</span></span>${pageLinks(f)}</li>`).join("")}</ol>
</section>

<section aria-labelledby="find-h">
	<h2 id="find-h">Ranked findings <span class="count">${open.length} open</span></h2>
	<div class="toolbar"><input id="q" type="search" placeholder="Filter by slug, title or text" aria-label="Filter findings"><button type="button" id="clear">Show all</button><span class="status" id="status" aria-live="polite"></span></div>
	${groupsHtml}
</section>

${shots ? `<section aria-labelledby="shots-h"><h2 id="shots-h">The ${report.shots.length} worst pages, side by side <span class="count">1440px wide · WordPress left, new right</span></h2><div class="shots">${shots}</div></section>` : ""}

<section aria-labelledby="fix-h">
	<h2 id="fix-h">Proposed fixes</h2>
	<div class="fixes-grid">${fixesHtml}</div>
</section>

<section aria-labelledby="one-h">
	<h2 id="one-h">URLs on one side only</h2>
	<div class="twocol">
		<div><h3>Old URLs that don’t resolve on the new site <span class="count">${onlyOld.length}</span></h3><p class="meta">From the WordPress sitemaps (taxonomies, authors, archives), excluding posts and pages listed above.</p><ul class="urllist">${onlyOld.map((u) => `<li>${esc(u.path)}/ · ${esc(u.status)}${u.final && u.final !== u.path ? ` at ${esc(u.final)}` : ""} <span class="slug">(${esc(u.source)})</span></li>`).join("") || "<li>None</li>"}</ul></div>
		<div><h3>New-only URLs <span class="count">${onlyNew.length}</span></h3><p class="meta">In the EmDash sitemap but not on WordPress. Expected: the new site’s own pages.</p><ul class="urllist">${onlyNew.map((u) => `<li>${esc(u.path)} <span class="slug">(${esc(u.source)})</span></li>`).join("") || "<li>None</li>"}</ul></div>
	</div>
</section>

<section aria-labelledby="known-h">
	<h2 id="known-h">Known, not counted as failures <span class="count">${known.length}</span></h2>
	<ul class="known">${[...knownBy.entries()]
		.map(([why, list]) => `<li><strong>${esc(why)}</strong> <span class="count">${list.length}</span><p class="meta">${list
			.slice(0, 8)
			.map((f) => (f.slug ? `<a href="${esc(f.newUrl ?? f.oldUrl)}" target="_blank" rel="noopener">/${esc(f.slug)}/</a> ${esc(f.summary)}` : esc(f.summary)))
			.join("<br>")}${list.length > 8 ? `<br>…${list.length - 8} more` : ""}</p></li>`)
		.join("")}</ul>
</section>

<section aria-labelledby="rerun-h" class="rerun">
	<h2 id="rerun-h">Re-run</h2>
	<pre>node compare-sites.mjs                 # cached WordPress, cached staging
node compare-sites.mjs --refresh       # refetch staging pages and checks
node compare-sites.mjs --only slug-a,slug-b --no-shots</pre>
	<p class="meta">Other flags: --refresh-old (refetch WordPress), --refresh-ext, --offline, --no-browser-checks, --shots N, --no-html, --render-only. Output: report.json, summary.md, shots/ and report.html in the compare folder. Run took ${esc(report.durationSeconds)}s; WordPress requests this run: ${esc(report.counts.requests.old)}.${report.skipped?.length ? ` Skipped: ${esc(report.skipped.join(", "))}.` : ""}</p>
</section>
</div>

<script>
(() => {
	const rows = [...document.querySelectorAll(".f-row")];
	const kinds = [...document.querySelectorAll(".kind")];
	const tiles = [...document.querySelectorAll(".tile")];
	const q = document.getElementById("q");
	const status = document.getElementById("status");
	let sev = null;
	function apply() {
		const term = q.value.trim().toLowerCase();
		let shown = 0;
		for (const r of rows) {
			const ok = (!sev || r.dataset.sev === sev) && (!term || r.dataset.q.includes(term));
			r.hidden = !ok;
			if (ok) shown++;
		}
		for (const k of kinds) {
			const any = k.querySelector(".f-row:not([hidden])");
			k.hidden = !any;
			const more = k.querySelector("details.more");
			if (more && (term || sev)) more.open = !!more.querySelector(".f-row:not([hidden])");
		}
		status.textContent = term || sev ? shown + " of " + rows.length + " findings" : rows.length + " findings";
	}
	tiles.forEach((t) => t.addEventListener("click", () => {
		sev = sev === t.dataset.filter ? null : t.dataset.filter;
		tiles.forEach((x) => x.setAttribute("aria-pressed", String(x.dataset.filter === sev)));
		apply();
		document.getElementById("find-h").scrollIntoView({ behavior: "smooth", block: "start" });
	}));
	q.addEventListener("input", apply);
	document.getElementById("clear").addEventListener("click", () => { q.value = ""; sev = null; tiles.forEach((x) => x.setAttribute("aria-pressed", "false")); apply(); });
	apply();
})();
</script>
`;
}
