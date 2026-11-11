# Phase 3: import and repair

## Set up the toolkit

1. Copy the skill's `scripts/` folder into the site as `scripts/wp-migration/`.
2. Copy `migration.config.example.json` to the site root as `migration.config.json`, and fill it
   in (`configuration.md` explains every key). Only `sites.wordpress` is required to start.
3. Put the WXR export in the work folder (`.migration/` by default) and gitignore that folder.
4. Optional, for the audit's browser checks and `fix-content`'s self-check:
   `npm install --prefix .migration/tools playwright-core` (it drives the installed Chrome).

Run every script from the site root.

**Every script that writes is a dry run unless it gets `--apply --target local|staging`.** In a
dry run the API client refuses anything but reads. `--target local` uses the dev server
(dev-bypass login). `--target staging` needs `EMDASH_TOKEN` (an admin token from `emdash login`;
`emdash whoami --url <staging>` refreshes an expired one).

Order matters. Later repairs assume earlier ones ran, and a full re-import undoes every repair.
That's why each repair is a separate idempotent script that's safe to re-run.

## The sequence (local)

Read each dry run's output before adding `--apply`.

```sh
M=scripts/wp-migration
# 1. Import: posts, pages, media, URL rewrite (a dry run only analyses)
node $M/import-wordpress.mjs                                  # check every field maps
node $M/import-wordpress.mjs --apply --target local
# 2. Site conventions
node $M/postprocess-links.mjs   && node $M/postprocess-links.mjs --apply --target local    # if linkPosts is on
node $M/merge-bylines.mjs       && node $M/merge-bylines.mjs --apply --target local
# 3. Media references the importer didn't map (resized, -scaled, http, strays)
node $M/fix-media-urls.mjs      && node $M/fix-media-urls.mjs --apply --target local
# 4. Converter gaps
node $M/fix-quotes.mjs          && node $M/fix-quotes.mjs --apply --target local           # A1
node $M/fix-content.mjs                                        # proposals + preview (A3–A10): see below
# 5. Old addresses
node $M/add-redirects.mjs       && node $M/add-redirects.mjs --apply --target local        # uploads → media, rules
node $M/wp-ids.mjs                                             # writes src/lib/wp-ids.json
# 6. Check
node $M/audit-content.mjs                                      # export text missing from rendered pages
```

Then package it for staging:
```sh
npx emdash site export --output .migration/site.emdash
npx emdash login --url https://staging.example.com           # approve at https://staging.example.com/_emdash/admin/device
npx emdash site import .migration/site.emdash --analyze --url https://staging.example.com
npx emdash site import .migration/site.emdash --plan <digest> --confirm --url https://staging.example.com
```
After the first staging import, apply every later repair to **both** sites, from the same approved
proposals (see below).

## What the importer does

`import-wordpress.mjs` drives the same API sequence as the admin's Import page:
1. **Analyze:** counts and field mapping. All a dry run does.
2. **Prepare:** creates any missing fields.
3. **Execute,** in chunks. Each chunk creates its own guest byline (A12).
4. **Media,** in batches (`import.mediaBatchSize`). Large libraries take a long time; content-hash
   de-duplication makes re-runs safe.
5. **Rewrite URLs,** for attachment URLs only. Variants need `fix-media-urls.mjs` (B1).

Content goes through `@emdash-cms/gutenberg-to-portable-text`, which handles these `core/*`
blocks: paragraph, heading, list and list-item, quote, pullquote, image, gallery, embed, video,
audio, file, code, preformatted, table, columns, group, media-text, cover, buttons, separator,
spacer, html, shortcode, more, nextpage and verse. Handled doesn't mean faithful: see gotchas A1
to A10.

## Repairs from the audit: `fix-content.mjs`

One driver with a module per fix (`scripts/lib/fix/fixes/`): titles, brackets, captions, gallery,
code, classic, embeds, wpImages, textLoss and unpublish.

1. **Dry run:** `node $M/fix-content.mjs` writes to the fixes folder:
   - `proposals.json`: every change, before and after, with a confidence level;
   - `preview.html`: a readable before-and-after for the owner;
   - `decisions.template.json`.

   It also re-scores the changes in memory with the audit's normaliser, and checks that a second
   pass changes nothing.
2. **Decisions:** the owner's choices (embed rendering, script widgets) go in `decisions.json`,
   per post (`"slug:embeds:codepen": "card"`) or per provider (`"provider:codepen": "card"`). Re-run
   the dry run with them.
3. **Approve:** `cp proposals.json proposals.approved.json`. Apply reads **only** the approved file
   (or `--proposals <file>`), so a later dry run can't change what gets applied (gotcha E6b).
4. **Restore points** (gotcha E6c): back up the local D1 files, and record a Time Travel bookmark
   for staging.
5. **Apply to both sites:** `node $M/fix-content.mjs --apply --target staging`, then
   `--apply --target local`. Each run re-resolves the fix against that site's current content and
   **its own media library** (gotcha B1b), and skips any post whose change differs from the
   approved proposal. High and medium confidence apply by default; `--include-low` adds the rest.
   Filters: `--only`, `--slugs`, `--skip slug[:fix]`, `--limit N`.
6. **Verify:** spot-check the pages, then re-run the audit with `--refresh`.

## Writing a new repair

Follow `fix-quotes.mjs` or a module in `lib/fix/fixes/`:
- **Read the WordPress truth from the WXR** (`lib/wxr.mjs`), and from the live REST API where
  rendered output matters, cached on disk.
- **Locate each fix individually.** Never "the third blockquote run": runs merge (A1).
- **Recognise your own output,** so re-runs report nothing to do.
- **Write only through the EmDash REST API** (`lib/emdash-api.mjs`): GET, change the Portable Text,
  PUT with `_rev`, then publish. Never write to D1 directly: that skips revisions, search indexing
  and publish hooks.
- **Work on the current Portable Text,** never a fresh conversion, so earlier repairs survive.

## Block shapes to emit

The converter's types (`index.d.mts` in the package) are the contract. The ones repairs use most:
```ts
{ _type: "image", _key, asset: { _type: "reference", _ref: "<media id>", url? }, alt?, caption?, alignment?, width?, height? }
{ _type: "gallery", _key, images: [{ _type: "image", _key, asset: { _type: "reference", _ref, url? }, alt?, caption? }] }
{ _type: "embed", _key, url, provider?, html? }      // EmDash plays YouTube and Vimeo
{ _type: "code", _key, code, language? }
{ _type: "columns", _key, columns: [{ _type: "column", _key, content: PortableTextBlock[] }] }
{ _type: "block", _key, style: "normal" | "h2" | "blockquote" …, children: [{ _type: "span", text, marks }], markDefs }
```
Media `_ref`s come from the target site's media table. The import's redirect rows
(`/wp-content/uploads/…` → `/_emdash/api/media/file/<key>`) map WordPress URLs to media keys.
Images with `width` and `height` render through Astro's `<Image>` with absolute URLs (gotcha D15).

## Gate 3 checks

- Entry counts per collection match the inventory, minus deliberate drops.
- `audit-content.mjs` shows only known noise.
- The spot-check set (`parity-audit.md`) looks right beside WordPress.
- `npx astro check` is clean.
