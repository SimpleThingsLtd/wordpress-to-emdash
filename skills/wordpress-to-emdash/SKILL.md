---
name: wordpress-to-emdash
description: Migrate a WordPress site to EmDash CMS (Astro on Cloudflare Workers with D1 and R2) without losing content, media or links. Covers inventory, the WXR import, the gaps in EmDash's Gutenberg converter and the scripts that repair them, keeping every old URL working, Workers cache and deploy pitfalls, a page-by-page parity audit against the live WordPress site, and cutover. Use when asked to move, migrate or port a WordPress site (including one on Plesk, cPanel or managed hosting) to EmDash, to re-run or repair such an import, or to audit a migrated EmDash site against its WordPress original.
---

# WordPress → EmDash migration

A procedure for moving a WordPress site to EmDash on Cloudflare without losing anything, with the
scripts and site files to do it.

**Why it needs a procedure.** EmDash's importer gets most content across, but its losses are
silent. The import reports success while:
- quotes come out empty;
- galleries collapse to one image;
- embeds vanish;
- shortcodes print as raw text;
- classic-editor posts lose their paragraph breaks;
- old URLs 404.

So a migration isn't done when the import finishes. It's done when a page-by-page comparison with
the live WordPress site shows nothing important missing. That comparison is the core of this skill.

**What's in this folder:**

| Path | What |
| --- | --- |
| `references/` | The detail for each phase, and `gotchas.md`, every known failure with how to detect and fix it |
| `scripts/` | Node scripts (Node 20 or later, no dependencies; Playwright optional): import, repairs, redirects, audit. All configured by `migration.config.json` |
| `templates/` | Files to copy into the EmDash site: deploy cache purge, setup guard, Portable Text overrides, legacy URL routes |
| `migration.config.example.json` | Every setting, explained in `references/configuration.md` |

Use alongside EmDash's own skills where present: `building-emdash-site` (schema, queries,
rendering) and `emdash-cli` (login, export, site import).

## Getting started

1. Copy this skill's `scripts/` folder into the site project as `scripts/wp-migration/`, so the
   migration is versioned and repeatable with the site. Copy `migration.config.example.json` to
   `migration.config.json` at the project root and fill it in as you go
   (`references/configuration.md`).
   Every script is a **dry run unless given `--apply --target local|staging`**.
2. Read `references/gotchas.md` once, end to end, before importing anything.
3. Work through the phases below in order.

## Rules

1. **Leave WordPress running until cutover, and for two weeks after.** It's the source of truth
   for the parity audit and the rollback plan. Never modify it.
2. **Ask before anything you can't undo or that faces the public:** DNS changes, cutover, retiring
   WordPress, and bulk content rewrites on a deployed site. Show a dry-run preview first.
3. **Everything is a repeatable script.** Every import and repair step must be safe to re-run
   (idempotent: it recognises its own work), and must support `--dry-run`. Manual admin edits are
   lost on a re-import, and they hide what changed.
4. **Keep the export, caches and secrets in a gitignored work folder** (`.migration/` by default).
   WXR exports contain commenter emails.
5. **Go easy on the WordPress server:** at most 4 requests at a time, with every response cached on
   disk.
6. **Import locally first.** Fix the content there, then move it to staging as an EmDash site
   package. Don't iterate on staging content.
7. **When you find a set of problems, report and fix them together.** Apply the mechanical,
   high-confidence fixes with scripts, re-verify, then present what was fixed alongside what needs
   the owner's decision.
8. **Take restore points before bulk writes:** back up the local D1 files, and record a D1 Time
   Travel bookmark for deployed databases.
9. **Verify every deploy,** and make sure no one else is deploying the same Worker (see Deploy
   discipline below).

## Phases

Each phase ends in a gate. Don't start the next phase until the gate passes.

### Phase 0: Inventory WordPress → `references/inventory.md`

Record:
- counts for every post type, **including plugin post types** (see gotcha A14);
- Gutenberg versus classic-editor content;
- every shortcode and embed provider in use;
- every URL pattern, including *older* permalink bases;
- the media size, and absolute URLs to the old domain;
- comments;
- theme conventions such as link posts.

**Gate 0:** a written inventory with a decision for each item EmDash won't carry by default.

### Phase 1: Set up EmDash and staging → `references/platform.md`

1. Start from an EmDash template: D1, R2, and a Worker on a staging custom domain.
2. Set `EMDASH_SITE_URL` to the **final** domain from day one.
3. Add the setup guard (`templates/src/middleware.ts`).
4. Add the deploy-time cache purge (`templates/src/worker.ts`) **before the first content deploy**.
   The Workers page cache isn't keyed by Worker version (gotcha D1).
5. Check that `.gitignore` hides no source files (gotcha E2).

**Gate 1:** the owner has completed setup with the key; `emdash login` works (gotcha D6).

### Phase 2: Schema

Model what the site actually has, usually `posts`, `pages` and the custom post types, plus fields
WordPress kept in content or meta, such as a link post's URL. See `building-emdash-site`.

### Phase 3: Import and repair (local) → `references/import-pipeline.md`

1. Export the WXR with every post type.
2. Import with `scripts/import-wordpress.mjs`.
3. Run the repair scripts for the converter's known gaps: quotes, galleries, shortcodes,
   classic-post paragraphs (`wpautop`), code, embeds, entities, media variants, bylines, and the
   site's conventions.
4. Add the rendering overrides from `templates/` (`references/rendering.md`).
5. Run a quick text check with `scripts/audit-content.mjs`.

**Gate 3:** counts match the inventory; the text check shows only known noise; the spot-check set
looks right beside WordPress.

### Phase 4: Keep old URLs working → `references/url-compatibility.md`

Every address WordPress answered must serve, redirect or be dropped with approval. That includes
`/wp-content/uploads/…` (EmDash's redirect middleware skips paths with file extensions), `?p=`,
old permalink bases, feeds, categories, archives and sitemaps.

**Gate 4:** every pattern has a passing test URL, or an approved decision.

### Phase 5: Move to staging

1. Locally: `npx emdash site export`.
2. On staging: `emdash site import --analyze`, then `--plan <digest> --confirm`.
3. Deploy, which runs the cache purge.

From here on, apply every repair to both local and staging, from the same approved proposals
(gotcha E6b).

### Phase 6: Parity audit → `references/parity-audit.md`

Run `scripts/compare-sites.mjs`. It compares every published page with what WordPress visitors
*saw* (REST `content.rendered` and live pages), checks every old URL pattern, and screenshots the
worst pages. Then loop: fix (Rule 7), apply to local and staging, re-run with `--refresh`.

**Gate 6:** no high-severity findings except owner-accepted ones; old-URL tests pass; the owner has
seen the report.

### Phase 7: Cutover → `references/cutover.md`

Get the owner's explicit go-ahead. Then, in one window: remove the old DNS records, attach the
Worker's custom domain, re-run the URL tests. Keep WordPress untouched for two weeks.

## Deploy discipline

- **One branch, one deployer.** Two working trees deploying the same Worker silently overwrite
  each other (gotcha E1). Run `npx wrangler deployments list` before every deploy.
- **Build only from a tree that contains every source file.** Check ignored files before building
  from a fresh worktree (gotcha E2).
- **After every deploy,** check:
  - your version is at 100%;
  - the live HTML references the new `/_astro/` CSS hash;
  - the home page, a post, an old uploads URL, the feed and the sitemap all answer.

## Reference map

| Need | File |
| --- | --- |
| Every known failure: detect, cause, fix, prevent | `references/gotchas.md` |
| What to inventory, and the commands | `references/inventory.md` |
| The import and repair pipeline, in order | `references/import-pipeline.md` |
| Rendering overrides and block shapes | `references/rendering.md` |
| Old URL patterns, and how to serve each | `references/url-compatibility.md` |
| Running and reading the parity audit | `references/parity-audit.md` |
| Cloudflare, Workers, Astro and tooling | `references/platform.md` |
| Cutover and rollback | `references/cutover.md` |
| Scripts and templates: what each does, what to set | `references/toolkit.md`, `references/configuration.md` |
| One real migration, with numbers | `references/case-study.md` |
