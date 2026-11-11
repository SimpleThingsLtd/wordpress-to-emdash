# Phase 6: the parity audit

The import's success message proves nothing. The audit compares what visitors **saw** on WordPress
with what the new site **renders**, page by page. Run it before cutover, after every round of fixes,
and once more on the live domain.

The tool: `scripts/compare-sites.mjs` (read-only), with `scripts/lib/compare-report.mjs` for the
report page. The hosts, content selectors, section routes and known-noise rules come from
`migration.config.json`.

```sh
node scripts/wp-migration/compare-sites.mjs                  # cached WordPress, cached staging
node scripts/wp-migration/compare-sites.mjs --refresh        # refetch staging (after fixes or deploys)
node scripts/wp-migration/compare-sites.mjs --refresh-old    # refetch WordPress too (rarely)
node scripts/wp-migration/compare-sites.mjs --only a,b       # just these slugs
node scripts/wp-migration/compare-sites.mjs --render-only    # rebuild the report from report.json
node scripts/wp-migration/compare-sites.mjs --offline      # cache only: no network at all
# also: --refresh-ext --no-browser-checks --shots N --no-shots --no-html
```
Output goes to `.migration/compare/`: `report.json` (every finding: id, kind, severity, slug, old
and new URL, details), `summary.md`, `report.html`, `shots/` and `history.json`.

## What it compares

**Inventory:**
- old side: WordPress REST (`/wp-json/wp/v2/posts`, `pages`, `per_page=100`, paged; `X-WP-Total`)
  and its sitemaps;
- new side: EmDash's `/sitemap.xml`. It lists *final-domain* URLs; swap in the staging host before
  fetching.

**Per page:**
- **Old:** REST `content.rendered`, which has shortcodes and embeds expanded, so it's what visitors
  saw. Not the raw WXR.
- **New:** the `.prose` element of the rendered page. Link posts may have no prose; check their
  link.
- Normalise whitespace, entities, curly versus straight quotes and dashes. Diff paragraph by
  paragraph with a fuzzy match score.
- Count both sides: headings, list items, blockquotes and citations, images (each `src` must return
  200), embeds, tables and code blocks. Code must match exactly after normalising line endings and
  trailing whitespace. Ignore prompts the new renderer draws.
- Compare titles, publish dates, categories and tags, featured images, and internal links (each
  must resolve on the new site).

**Live checks (headless Chrome):** for pages with embed markup or inline scripts, load the old page
and record what *actually displayed*. Embeds that were already dead on WordPress aren't losses.

**URL tests:** sample every pattern in `url-compatibility.md` (20 to 25 of each), against staging,
using WordPress-style paths.

**Screenshots:** the 10 worst pages at 1440px, WordPress on the left, new on the right.

## Severity

| Severity | Examples |
| --- | --- |
| Critical | a section or post type missing; most pages failing |
| High | page missing; gallery collapsed; embed that displayed is gone; raw shortcode visible; paragraphs or list items missing; images that break at cutover; code missing |
| Medium | glued words; code flattened to paragraphs; script source printed as text; double-escaped titles; ID, base and category URL patterns failing; internal links 404 that worked before |
| Low | paragraphs merged with line breaks; lists or quotes flattened; headings demoted; date archives; sitemap listing redirects; hotlinked images already dead |

## Known noise (classify it, don't count it)

The built-in rules cover the common cases. Add site-specific ones in `audit.knownNoise` (a finding
kind plus slug, path, summary or status patterns, and a reason). If comments were deliberately not
migrated, set `audit.commentsAccepted`.

- Things that didn't display on WordPress either: dead embeds, Flash, scripts that ran instead of
  showing.
- Deliberate changes: comments not migrated, pages replaced by new routes, link-post trailers
  removed, shorteners expanded.
- Hotlinked images that were already broken.
- Words that look like shortcodes but are tag names or titles.

## The loop (Rule 7: report and fix together)

1. Run the audit, then group findings by fix type.
2. Write or extend repair scripts (dry run by default; see `import-pipeline.md`).
3. Generate a preview of the changes. Apply the high-confidence mechanical fixes to local and staging.
4. Re-run with `--refresh`. Confirm the finding counts drop and nothing new appears.
5. Report:
   - what was fixed, with before and after counts;
   - what remains, with screenshots;
   - the decisions only the owner can make: embeds, widgets, archives, dropped content.

## Spot-check set (look at these yourself)

- The longest Gutenberg post.
- A classic-editor post from the earliest years.
- A post with a gallery, one with embeds, one with code, and one with quotes and citations.
- A link post.
- The pages with the highest audit scores.
- The home page and an archive.

## Things the audit can't see

- Image identity: new media URLs are opaque IDs, so it matches by count and alt text. A wrong image
  in the right place passes.
- External links, SEO titles and descriptions, and comment content: compare them separately if they
  matter.
- The live domain before DNS moves: re-run the URL tests after cutover.
