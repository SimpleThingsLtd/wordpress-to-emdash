# Configuration: `migration.config.json`

Every site-specific value the scripts in `scripts/` use comes from one file at the root of the
EmDash site: `migration.config.json`. Start from `migration.config.example.json` (every key, with
example values), delete what you don't need, and fill in the rest. Only `sites.wordpress` is
required everywhere; a few scripts need one or two more keys and say so when they're missing.

## How it's found and read

- **Where:** `--config <path>` on any script's command line, else the `MIGRATION_CONFIG`
  environment variable, else the nearest `migration.config.json` from the working directory
  upward. Run the scripts from the site root and the default just works.
- **Paths:** relative values under `paths` resolve against the file that sets them, so the
  config can live at the root and use `.migration/…`.
- **`extends`:** `"extends": "../base.config.json"` loads another config first. Objects merge key
  by key; arrays and plain values replace. Useful for a second config that points the outputs
  elsewhere (a test run, a second staging site) without copying everything.
- **Notes:** keys starting with `//` or `$` are ignored, so `"//": "why this is here"` is fine.
- **Typos:** keys the toolkit doesn't know are reported on stderr and ignored.

Environment variables still apply on top: `EMDASH_URL` overrides the target's URL and
`EMDASH_TOKEN` is the admin-scope token for a deployed site (from `npx emdash login`).

## Safety flags (every script that writes)

Every script that changes content is a **dry run by default**: it reads, reports, and writes
nothing. To write, pass `--apply --target local` or `--apply --target staging`; `--apply` without
`--target` is refused, and `--target staging` needs `EMDASH_TOKEN`. In a dry run the API client
itself refuses anything but reads. `--dry-run` is accepted and changes nothing (it's the default).

`fix-content.mjs` adds an approval step: `--apply` reads only
`<paths.fixes>/proposals.approved.json` (a copy of a reviewed `proposals.json`), and skips any
post whose change no longer matches the approved signature. See `import-pipeline.md`.

## Keys

Script names below are abbreviated: `import` = `import-wordpress.mjs`, `links` =
`postprocess-links.mjs`, `bylines` = `merge-bylines.mjs`, `media` = `fix-media-urls.mjs`,
`quotes` = `fix-quotes.mjs`, `fix` = `fix-content.mjs`, `redirects` = `add-redirects.mjs`,
`ids` = `wp-ids.mjs`, `text` = `audit-content.mjs`, `audit` = `compare-sites.mjs`, `comments` =
`import-comments.mjs`.

### `site`: reporting

| Key | Type | Default | Example | Used by |
| --- | --- | --- | --- | --- |
| `site.name` | string | the WordPress host | `"Example Journal"` | audit (report title), fix (preview title) |
| `site.locale` | BCP 47 tag | system locale | `"en-GB"` | audit (dates in `report.html`) |
| `site.timeZone` | IANA zone | system zone | `"Europe/London"` | audit (dates in `report.html`) |

### `sites`: the four addresses

| Key | Type | Default | Example | Used by |
| --- | --- | --- | --- | --- |
| `sites.wordpress` | origin URL | **required** | `"https://example.com"` | all: the live WordPress site, source of truth. `www.` and the bare host are both treated as WordPress |
| `sites.staging` | origin URL | none | `"https://new.example.com"` | audit (**required**), `--target staging` for every writer, fix (preview links) |
| `sites.final` | origin URL | `sites.wordpress` | `"https://example.com"` | links (own-site links aren't link-post targets). It's the domain `EMDASH_SITE_URL` should hold from day one |
| `sites.local` | origin URL | `"http://localhost:4321"` | | `--target local` for every writer, text (`--site` default) |

### `paths`: files and folders

All relative to the config file unless absolute. The work folder holds the export (it contains
commenter emails), caches and reports: keep it out of git.

| Key | Type | Default | Used by |
| --- | --- | --- | --- |
| `paths.root` | path | the folder holding the (base) config | fix (runs `wrangler` here), the Playwright lookup, base for the other paths |
| `paths.work` | path | `".migration"` | default parent of the paths below |
| `paths.wxr` | path | `<work>/site.wxr.xml` | import, quotes, redirects, ids, text, fix, audit (comments, uploads, attachment pages). Scripts that take the export as an argument default to this |
| `paths.compare` | path | `<work>/compare` | audit (writes `report.json`, `summary.md`, `report.html`, `shots/`, `history.json`); fix reads `report.json` |
| `paths.compareCache` | path | `<work>/compare-cache` | audit (every response, so re-runs don't hit WordPress again); fix reuses its WordPress REST pages |
| `paths.fixes` | path | `<work>/fixes` | fix (`proposals.json`, `preview.html`, `decisions.template.json`, `proposals.approved.json`, apply logs, `cache/`) |
| `paths.decisions` | path | `<fixes>/decisions.json` | fix: the owner's choices (format below) |
| `paths.tools` | path | `<work>/tools` | audit, fix: where optional Playwright and sharp are looked for after the site's own `node_modules` (`npm install --prefix .migration/tools playwright-core`) |
| `paths.wpIds` | path | `"src/lib/wp-ids.json"` | ids (output; the home-page snippet imports it) |

### `d1`

| Key | Type | Default | Example | Used by |
| --- | --- | --- | --- | --- |
| `d1.database` | string | none | `"example-journal"` | fix (**required**): the dry run reads the local D1 copy with `wrangler d1 execute <database> --local`, SELECT only. The `database_name` in `wrangler.jsonc` |

### `content`: what was imported, and where it lives

| Key | Type | Default | Example | Used by |
| --- | --- | --- | --- | --- |
| `content.postTypes` | map, WordPress type → collection | `{ "post": "posts", "page": "pages" }` | add `"project": "projects"` | import (which types to import, and where), quotes, media, fix, text, ids. Types not listed aren't imported |
| `content.entryPath` | string with `{slug}` (and `{collection}`) | `"/{slug}/"` | | ids, text, fix (preview links). The toolkit assumes the new site keeps WordPress's paths |
| `content.bylineCollections` | collection names | every collection in `postTypes` | `["posts", "pages", "projects"]` | bylines |

### `import`: options for EmDash's WXR importer

| Key | Type | Default | Used by |
| --- | --- | --- | --- |
| `import.importMenus` | boolean | `false` | import (rebuild menus by hand in the new theme) |
| `import.importSiteTitle` | boolean | `false` | import |
| `import.importLogo` | boolean | `false` | import |
| `import.importSeo` | boolean | `true` | import (SEO plugin titles and descriptions) |
| `import.skipExisting` | boolean | `true` | import (re-runs skip slugs that exist) |
| `import.mediaBatchSize` | number | `5` | import (attachments per request; keeps each under Worker CPU limits) |

### `wordpress`: the old site

| Key | Type | Default | Example | Used by |
| --- | --- | --- | --- | --- |
| `wordpress.extraPostTypes` | list of REST bases, or `{ rest, kind }` | `[]` | `[{ "rest": "jetpack-portfolio", "kind": "portfolio" }]` | audit: other public post types to check (gotcha A14). Their pages count as `kind` in findings |
| `wordpress.sitemap` | path | `"/sitemap_index.xml"` | `"/wp-sitemap.xml"` | audit (old sitemap inventory) |
| `wordpress.selectors.content` | CSS selector | `".entry-content"` | `".post-content"` | audit: the theme's content element, for the live embed checks |
| `wordpress.selectors.ignore` | CSS selector | Jetpack's sharing, likes and related-posts boxes | | audit, fix (self-check): removed from both sides before comparing |

### `newSite`: the EmDash site

| Key | Type | Default | Example | Used by |
| --- | --- | --- | --- | --- |
| `newSite.sitemap` | path | `"/sitemap.xml"` | | audit |
| `newSite.sections` | paths | `[]` | `["/archive/", "/search/"]` | audit: section routes at the root. WordPress addresses they now own are listed (gotcha C7), and used to spot shadowed posts when `selectors.isPost` isn't set |
| `newSite.categoryBase` | string | `"category"` | | audit (category links on the page → slugs) |
| `newSite.tagBase` | string | `"tag"` | | audit (tag links → slugs) |
| `newSite.selectors.content` | selector or list, tried in order | `["article .prose", ".prose"]` | | audit, fix (self-check): the rendered content element |
| `newSite.selectors.title` | selector or list | `["h1"]` | `[".entry-title", "h1"]` | audit (title comparison) |
| `newSite.selectors.date` | selector, or `null` | `"article time[datetime]"` | `".byline time"` | audit: its `datetime` is compared with WordPress's date. `null` skips the date check |
| `newSite.selectors.categories` | selector, or `null` | `null` | `".entry-kicker a"` | audit: category links; `null` skips the check |
| `newSite.selectors.tags` | selector, or `null` | `null` | `".entry-tags a"` | audit: tag links; `null` skips the check |
| `newSite.selectors.featured` | selector, or `null` | `null` | `".entry-figure img"` | audit: featured image; `null` skips the check |
| `newSite.selectors.isPost` | selector, or `null` | `null` | `".byline"` | audit: present only on post pages, to catch a post whose address now serves another page (falls back to `newSite.sections`) |
| `newSite.selectors.comment` | selector, or `null` | `".comment__card"` | `".comment-body"` | audit: one element per rendered comment (the default is the template's card). Each page's count is checked against `import-comments.mjs`'s plan; `null` skips the check |
| `newSite.selectors.ignore` | selector, or `null` | `".code__bar"` | | audit, fix: chrome left out of the text comparison (the default is the template CodeBlock's header) |

The theme-specific selectors default to `null` because a guess would report noise on every page.
Set them once you have a post template, and check one post's findings before trusting the rest.

### `urls`: old addresses

| Key | Type | Default | Example | Used by |
| --- | --- | --- | --- | --- |
| `urls.oldPermalinkBases` | list of names | `[]` | `["blog", "writing"]` | audit: tests `/<base>/<slug>/` for each (gotchas C3, C3b). Pair each with the template route `src/pages/<base>/[slug]/[...rest].ts` |
| `urls.replacedPages` | map, slug (or `collection:slug`) → new path | `{}` | `{ "about-me": "/about/" }` | audit (known, not counted), redirects (adds the redirect row), fix (`unpublish` drops it from the sitemap; gotcha C6) |
| `urls.listingPages` | map, slug → path | `{}` | `{ "archive": "/archive/" }` | audit: WordPress pages now served by a new-site route aren't compared. fix unpublishes those whose path changed |
| `urls.acceptedRedirects` | map, old path → path or paths | `{}` | `{ "/category/news/": "/archive/" }` | audit: extra destinations that count as a pass for that old address |
| `urls.authorArchiveTarget` | path, or `null` | `null` | `"/about/"` | audit: where author archives should land; `null` accepts any page but the home page |

### `audit`: the parity audit

| Key | Type | Default | Used by |
| --- | --- | --- | --- |
| `audit.searchTerm` | string | `"test"` | audit: the `/?s=` test (pick a word the site uses) |
| `audit.permalinkSamples` | number | `10` | audit: posts tested per old permalink base |
| `audit.idSamples` | number | `18` | audit: `?p=` tests |
| `audit.uploadSamples` | number | `20` | audit: `/wp-content/uploads/` tests |
| `audit.resizedSamples` | number | `5` | audit: resized (`-WxH`) upload tests |
| `audit.attachmentPageSamples` | number | `6` | audit: attachment page tests |
| `audit.extraUrlTests` | list of `{ path, severity?, expect?, group? }` | `[]` | audit: site-specific addresses. `expect` is `"any200"` (default), `"any200NotHome"`, `"feed"`, `"xml"`, `"image"`, `{ "path": "/x/" }` or `{ "paths": [...] }`; `severity` is `low` (default), `medium` or `high` |
| `audit.knownNoise` | list of rules | `[]` | audit: findings to record as known instead of counting them (format below) |
| `audit.commentsAccepted` | string, or `null` | `null` | audit: the owner's decision about comments (gotcha A13). Set, the comment finding is known; unset, it's an open medium finding |
| `audit.shots` | number | `10` | audit: side-by-side screenshots of the worst pages (`--shots N` overrides) |

The built-in URL tests cover `?p=`, `?page_id=`, uploads, resized uploads, attachment pages, every
category and tag, `/feed/`, `/feed/atom/`, `/comments/feed/`, `/?feed=rss2`, `/page/2/`,
`/sitemap_index.xml`, `/post-sitemap.xml`, `/?s=`, author archives and every year and month
archive.

**Known-noise rules.** Each rule needs `kind` (a finding kind, a list of kinds, or `"*"`) and
`reason`, plus any of:
- `slug`: a regular expression tested against the finding's slug;
- `path`: a regular expression tested against its decoded new-site path;
- `summary`: a regular expression tested against its summary;
- `status`: the HTTP status, for page and URL findings.

All the conditions given must match. Keep rules narrow and give the reason in words the owner
will recognise: the report lists every known item with its reason.

```json
"knownNoise": [
	{ "kind": "page-missing", "path": "·", "status": 404, "reason": "Slugs with “·” 404 until the encoded-slug fix ships" },
	{ "kind": ["images-missing", "image-broken-external"], "slug": "^2009-", "reason": "Hotlinked images on 2009 posts were already dead" }
]
```

### `linkPosts`: an opt-in convention (gotcha A11)

Some sites saved link-log posts as a paragraph ending in a trailer such as "— Read on
&lt;a&gt;…&lt;/a&gt;". With `enabled`, `postprocess-links.mjs` moves the URL into a field and removes
the trailer, the audit stops counting the trailer as lost text, and the classic-post repair
expects it to be gone. Leave it off unless your site has such a convention.

| Key | Type | Default | Example | Used by |
| --- | --- | --- | --- | --- |
| `linkPosts.enabled` | boolean | `false` | `true` | links, audit, fix |
| `linkPosts.collection` | collection | `"posts"` | | links, fix |
| `linkPosts.field` | field name | `"link_url"` | | links (writes it; add the field to the schema first), fix |
| `linkPosts.trailerBeforeLink` | regular expression (string) | `"—\\s*Read on\\s*$"` | `"→\\s*Via\\s*$"` | links: matches the text span just before the link |
| `linkPosts.trailerWords` | strings | `["Read on", "Read it on"]` | `["Via"]` | audit, fix: the trailer's words, wherever it appears |
| `linkPosts.category` | category slug, or `null` | `null` | `"links"` | links: posts in it without a trailer fall back to a final bare-URL paragraph, then the last outbound link |
| `linkPosts.newSiteSelector` | CSS selector, or `null` | `null` | `"a.link-post__source"` | audit: the rendered link-post destination; without it, no page counts as a link post |
| `linkPosts.expandShorteners` | boolean | `true` | | links: follows ift.tt, bit.ly and the rest to the real URL |
| `linkPosts.shorteners` | hostnames | ift.tt, bit.ly, t.co, goo.gl, ow.ly, buff.ly, j.mp, tinyurl.com | | links (expanded), audit (a destination that differs only by a shortener is known) |

### `bylines` (gotcha A12)

| Key | Type | Default | Used by |
| --- | --- | --- | --- |
| `bylines.merge` | list of `{ target, duplicates }` | `[]` | bylines: `target` is the byline to keep (`slug`, `displayName`, optional `websiteUrl`, `isGuest`); created if missing. `duplicates` is a regular expression for the per-chunk bylines to fold into it, such as `"^jsmith(-\\d+)?$"` |

### `comments`: WordPress comments (gotcha A13)

`import-comments.mjs` imports only comments approved in WordPress, then drops spam, duplicates and
(by default) pingbacks. The preview (`<work>/comments/preview.html`) lists every decision and its
reason. IDs below are WordPress comment IDs (`wp:comment_id`), shown as `#123` in the preview.

| Key | Type | Default | Example | Used by |
| --- | --- | --- | --- | --- |
| `comments.includePingbacks` | boolean | `false` | `true` | comments: import pingbacks and trackbacks too. Self-pingbacks (from the site itself or a dev host) stay out either way. Both kinds are listed in the preview |
| `comments.keepEmails` | boolean | `true` | `false` | comments: store each commenter's email in EmDash, where only the admin sees it (moderation; first-time-commenter checks if comments reopen). `false` stores an empty address. Emails are never rendered, and never written to the preview or `plan.json` |
| `comments.spamThreshold` | number | `3` | `4` | comments: a comment with this many spam points or more is left out |
| `comments.maxLinks` | number | `2` | `1` | comments: more links than this in one comment scores 3 points |
| `comments.spamPhrases` | regular expressions (strings) | `[]` | `["\\bessay writing\\b"]` | comments: extra spam phrases, 3 points each, on top of the built-in pharma, casino, SEO, loan, adult and replica vocabulary and the known spinner templates |
| `comments.spammyTlds` | TLDs, or `null` | `null` (a built-in list: `ru`, `cn`, `xyz`, `top`, `info`, `biz` …) | `["ru", "xyz"]` | comments: an author URL or link on one of these scores 2 points |
| `comments.trustedAuthors` | author names | `[]` | `["Jane Smith"]` | comments: never scored as spam (WordPress users, `comment_user_id` > 0, are trusted already); the preview marks them |
| `comments.renameAuthors` | map, WordPress name → name to store | `{}` | `{ "jsmith": "Jane Smith" }` | comments: one name per person |
| `comments.include` | IDs, or map ID → reason | `[]` | `[8571]` | comments: kept whatever the filter says (unapproved, spam, pingback or duplicate), unless the post isn't on the new site |
| `comments.exclude` | IDs, or map ID → reason | `[]` | `{ "827": "Boilerplate praise" }` | comments: left out, with the reason shown in the preview |
| `comments.orphans` | `"reattach"`, `"drop"` or `"promote"` | `"reattach"` | | comments: replies whose parent was left out. `reattach` hangs them under the nearest kept comment above, and drops them if there's none (an answer to a spam question reads oddly alone). `drop` leaves them all out. `promote` keeps them all, at the top level if needed |
| `comments.extrasFile` | path in the site | `"src/components/comments/wp-comment-extras.json"` | | comments (`--apply` writes it): author URLs and WordPress IDs, which EmDash doesn't store, for the `Comments.astro` template. Commit it |
| `comments.pageSize` | number | `100` | `50` | comments: comments per import request (keeps each under Worker limits) |

The spam signals and their points: spam vocabulary in the text or name (3); spam terms in the
author URL (3) or email (2); a known spinner template (3); letters from another alphabet hiding
in Latin words (3); a copy of an earlier comment by someone else (3); too many links (3); a short
comment carrying a link (2); a link with keyword anchor text (2); an author URL on a spammy TLD
(2) or that's just a big site's home page (2); an author name made of keywords (1 or 2) or a
sentence (1), or the same as its site's domain (1); generic praise (1), and short with it (1).
Pingbacks are checked for vocabulary, links and templates only.

### `redirects`

| Key | Type | Default | Example | Used by |
| --- | --- | --- | --- | --- |
| `redirects.rules` | list of `{ source, destination, type?, groupName? }` | `[]` | `{ "source": "/author/[...path]", "destination": "/about/" }` | redirects: extra rows for EmDash's redirect table (301 unless `type` says otherwise). Pages in `urls.replacedPages` are added automatically |
| `redirects.group` | string | `"wordpress"` | | redirects: group name for those rows |
| `redirects.uploadsGroup` | string | `"wp-uploads"` | | redirects: group name for the `/wp-content/uploads/…` rows |

### `fixes`: content repairs

| Key | Type | Default | Example | Used by |
| --- | --- | --- | --- | --- |
| `fixes.waybackTimestamp` | `YYYY` or `YYYYMMDD` | `"2014"` | `"2012"` | fix: when an image or media file is gone, the Wayback Machine copy closest to this date is offered. Pick a date when the old site's hotlinks still worked |
| `fixes.unpublish` | map, `collection:slug` → reason | `{}` | `{ "pages:old-contact": "Replaced by the footer" }` | fix: more entries to unpublish, besides replaced and moved listing pages |
| `fixes.shortcodes.layout` | shortcode names | `one_half` … `three_fourth_last`, `box` | add `"column"` | fix (their tags are removed, the text kept; gotcha A4b), audit (shortcode inventory) |
| `fixes.shortcodes.button` | shortcode names | `["button"]` | `["button", "btn"]` | fix (`[button link="…"]Label[/button]` becomes a link) |

### `http`

| Key | Type | Default | Used by |
| --- | --- | --- | --- |
| `http.userAgent` | string | a desktop Chrome string ending in `wordpress-to-emdash` | audit, fix, media |
| `http.concurrency.wordpress` | number | `4` | audit, fix: most requests in flight to WordPress, the browser's included. Keep it low; it's a production server |
| `http.concurrency.new` | number | `12` | audit: requests in flight to staging |
| `http.concurrency.external` | number | `4` | audit, fix: requests to third-party hosts (hotlinked images, embed providers) |

## `decisions.json`

Owner decisions for `fix-content.mjs`, at `paths.decisions`. Each dry run writes
`decisions.template.json` with every open decision and its recommended option (or `null` where
it's the owner's call); copy it, edit it, and re-run the dry run.

```json
{
	"some-post:code:script-text": "remove",
	"another-post:embeds:codepen": "card",
	"provider:spotify": "card",
	"old-post:embeds:tweet": "leave"
}
```

- `<slug>:code:script-text`: `"code"` (show the script or CSS as code blocks) or `"remove"`
  (gotcha A8).
- `<slug>:embeds:<provider>`: `"card"` (an embed block EmDash draws as a link with a caption;
  tweets become a quote with a citation), `"html"` (an isolated HTML block with the provider's
  embed; check the CSP) or `"leave"` (gotcha A6).
- `provider:<provider>`: the same choice for every post with that provider. A per-post key wins.

Decisions are applied with medium confidence, so they go in with the default apply.
