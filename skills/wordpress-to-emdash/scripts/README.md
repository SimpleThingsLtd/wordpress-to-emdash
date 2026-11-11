# Migration scripts

Plain Node ESM (Node 20 or later). No dependencies of their own beyond what an EmDash site already
has; `@emdash-cms/gutenberg-to-portable-text` (EmDash's converter) is needed by the content
repairs. Playwright and sharp are optional and detected.

## Set up

1. Copy this folder into the EmDash site as `scripts/wp-migration/`.
2. Copy `../migration.config.example.json` to the site root as `migration.config.json` and fill
   it in (`../references/configuration.md` explains every key).
3. Put the WXR export in the work folder (`.migration/` by default) and gitignore that folder.
4. Optional, for the audit's page comparison, live embed checks and screenshots, and for
   `fix-content`'s self-check:
   `npm install --prefix .migration/tools playwright-core` (it drives the system Chrome).

Run everything from the site root. `--config <path>` picks a different config.

## Safety

Every script that writes is a **dry run unless it gets `--apply --target local|staging`**, and in
a dry run the API client refuses anything but reads. Staging needs `EMDASH_TOKEN`. Run against
local first; move content to staging as a site package, not by re-running imports there.
`fix-content.mjs --apply` only applies the owner-approved `proposals.approved.json`.

## Scripts

| Script | Phase | What it does |
| --- | --- | --- |
| `import-wordpress.mjs` | 3 | Drives EmDash's WXR importer: analyze (the default, and all a dry run does), prepare, chunked execute, batched media, URL rewrite. Resumable |
| `postprocess-links.mjs` | 3 | Link posts → a URL field, for sites with that convention (`linkPosts`, off by default) |
| `merge-bylines.mjs` | 3 | Folds the per-chunk duplicate bylines into one per author (`bylines.merge`) |
| `fix-media-urls.mjs` | 3 | Resized, `-scaled`, `http` and stray upload URLs → the imported media |
| `fix-quotes.mjs` | 3 | Rebuilds quotes the converter emptied, with citations |
| `fix-content.mjs` (+ `lib/fix/`) | 3, 6 | The audit-driven repairs: titles, brackets, captions, galleries, code, classic paragraphs, embeds, WordPress-hosted images, text losses, unpublishing. Proposals, preview, owner decisions, approval, signature-checked apply |
| `add-redirects.mjs` | 4 | Redirect rows: every upload → its media file, replaced pages, `redirects.rules` |
| `wp-ids.mjs` | 4 | `src/lib/wp-ids.json`, for `?p=` and `?page_id=` |
| `audit-content.mjs` | 3 | Quick text check: export text missing from the rendered pages |
| `compare-sites.mjs` (+ `lib/compare-report.mjs`, `lib/compare-core.mjs`) | 6 | The full parity audit against live WordPress, read-only, cached |

Shared code: `lib/config.mjs` (the config loader), `lib/cli.mjs` (flags and targets),
`lib/emdash-api.mjs` (the REST client), `lib/wxr.mjs` (the export reader), `lib/optional.mjs`
(optional tools).

The site-side files these scripts expect (uploads route, quote and code renderers, old-URL
routes) are in `../templates/`.
