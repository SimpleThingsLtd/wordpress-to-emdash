# The toolkit: scripts and templates

Everything here ships in this skill folder. Copy what you need into the site project, set
`migration.config.json` (`configuration.md`), and read a script before you run it.

## Scripts (`scripts/` → copy to `scripts/wp-migration/`)

Node 20 or later, no dependencies of their own. The content repairs use EmDash's converter
(`@emdash-cms/gutenberg-to-portable-text`), which an EmDash site already has. Playwright
(`playwright-core`, which drives installed Chrome) and sharp are optional and detected; without
them, the browser checks, the self-check and side-by-side screenshots are skipped, with a message.

**Every script that writes is a dry run unless it gets `--apply --target local|staging`.**

| Script | Phase | What it does | Config it reads |
| --- | --- | --- | --- |
| `import-wordpress.mjs` | 3 | Drives EmDash's WXR importer: analyze (all a dry run does), prepare, execute in chunks, media in batches, URL rewrite. Resumable | `paths.wxr`, `import.*` |
| `postprocess-links.mjs` | 3 | Link posts: moves a trailing "read on" link into a URL field; expands shorteners | `linkPosts.*` (off by default) |
| `merge-bylines.mjs` | 3 | Folds the per-chunk duplicate bylines into one per author (A12) | `bylines.merge` |
| `fix-media-urls.mjs` | 3 | Resized, `-scaled`, `http` and stray upload URLs → imported media; uploads strays (B1) | `sites.*` |
| `fix-quotes.mjs` | 3 | Rebuilds quotes the converter emptied, with citations (A1) | `paths.wxr` |
| `fix-content.mjs` (+ `lib/fix/`) | 3, 6 | Audit-driven repairs: titles, brackets, captions, gallery, code, classic, embeds, wpImages, textLoss, unpublish. Proposals, preview, owner decisions, apply from the approved file only, with signature checks | `fixes.*`, `paths.fixes`, `paths.decisions` |
| `add-redirects.mjs` | 4 | Redirect rows: every upload → its media file, replaced pages, your rules | `redirects.*`, `urls.replacedPages` |
| `wp-ids.mjs` | 4 | `src/lib/wp-ids.json` for `?p=` and `?page_id=` (C2) | `paths.wpIds` |
| `audit-content.mjs` | 3 | Quick text check: export text missing from rendered pages | `newSite.selectors` |
| `compare-sites.mjs` (+ `lib/compare-core.mjs`, `lib/compare-report.mjs`) | 6 | The parity audit against live WordPress: pages, elements, media, embeds, URL patterns, screenshots, HTML report. Read-only, cached, `--offline` capable | `sites.*`, `wordpress.*`, `newSite.*`, `urls.*`, `audit.*`, `http.*` |

Shared code in `lib/`: `config.mjs` (finds and validates the config: `--config`, then
`MIGRATION_CONFIG`, then the nearest `migration.config.json`; supports `extends`), `cli.mjs`
(flags and targets), `emdash-api.mjs` (REST client; read-only in dry runs), `wxr.mjs` (export
reader) and `optional.mjs` (optional tools).

## Templates (`templates/` → the site)

| Template | Copy to | Prevents |
| --- | --- | --- |
| `src/worker.ts` | `src/worker.ts` (set `main` in wrangler) | D1, D2, D15 |
| `src/middleware.ts` | `src/middleware.ts` (merge with any existing middleware) | D7 |
| `src/components/Content.astro`, `pt/Quote.astro`, `pt/Columns.astro`, `pt/CodeBlock.astro` | `src/components/` | A1, A2, A7 |
| `src/lib/code-lang.ts`, `src/lib/highlight.ts` | `src/lib/` (`pnpm add shiki`, pinned) | A7, D14 |
| `src/lib/entry-by-slug.ts` + `snippets/slug-route.md` | `src/lib/`, and your `[slug].astro` | C3b, C4 |
| `snippets/home-page-legacy-queries.md` | your home page's frontmatter | C2 |
| `src/pages/wp-content/uploads/[...path].ts` | the same path | C1 |
| `src/pages/_base_/[slug]/[...rest].ts` | once per old permalink base, renamed | C3 |
| `src/pages/category/[parent]/[slug].ts` | the same path, if categories were nested | C5 |
| `src/pages/feed/atom.ts` | the same path, next to your RSS feed | C5 |
| `src/pages/*-sitemap.xml.ts` | `src/pages/`, static files, one per old name | C3c, C5 |
| `scripts/check-code-contrast.mjs` | `scripts/`; pass the CodeBlock file | rendering |

`templates/README.md` has the details: the wrangler settings the Worker needs, and the CSS custom
properties CodeBlock exposes for theming.

## Working folder (gitignored, `paths.work`)

| Path | What |
| --- | --- |
| `site.wxr.xml` | the export (contains commenter emails) |
| `inventory.md` | the Phase 0 record |
| `compare/` | audit output: `report.json`, `summary.md`, `report.html`, `shots/`, `history.json`, cache |
| `fixes/` | `proposals.json`, `proposals.approved.json`, `preview.html`, `decisions.json`, apply logs |
| `backups/` | local D1 backups before bulk applies |
| `tools/` | optional `playwright-core` install |
| `*.emdash` | site packages for staging imports |
