# Changelog

## 1.2.0 (2026-11-11)

### Added
- Comments: a moderated form. `Comments.astro` takes `form`, `publishedAt` (the form closes after
  `commentsClosedAfterDays`, as EmDash does), `turnstileSiteKey` and `formLabels`. It themes
  EmDash's `CommentForm` and says whether comments are read before they appear.
- `templates/src/middleware.ts` purges a post's cached page when its comments are approved,
  unapproved or deleted, which EmDash 1.4 doesn't do (gotcha A13).
- `templates/workers/redirects/`: a cache-free Worker that redirects `www` and the staging host to
  the final domain (gotcha D16).
- Gotchas D16 (Workers Cache isn't keyed by hostname) and more on D10, E1 and A13.

### Changed
- `references/cutover.md` follows the cutover as it worked: one deployer, a DNS-edit token, the
  zone's records saved, an archive copy of WordPress at its own hostname (clone, URL rewrite,
  noindex, DNS-only certificate then proxied), the window in order, and rollback limits.
- The Worker template can redirect other hostnames itself (`REDIRECT_HOSTS`), for sites without
  Workers Cache.

## 1.1.0 (2026-11-11)

### Added
- `import-comments.mjs`: brings a site's approved WordPress comments into EmDash with their dates,
  threading and approval, after spam heuristics and a preview for the owner. It imports through
  EmDash's exporter endpoint, using a temporary feed behind a Cloudflare quick tunnel. Author URLs
  and WordPress IDs, which EmDash doesn't store, go to `wp-comment-extras.json`. Idempotent, with a
  ledger and a check after each run (gotcha A13).
- `templates/src/components/comments/`: a threaded comments component that reads that file. It
  links names to the commenters' sites, badges the owner and keeps old `#comment-<id>` anchors.
- The parity audit counts the comments each page shows against the import's plan, and reports a
  short page as `comments-missing` (`newSite.selectors.comment`).
- `templates/src/pages/[year]/[...rest].ts`, and a year section in `snippets/slug-route.md`: month,
  day and year archives redirect to the archive page's year.
- `templates/src/pages/_retired_/[...path].ts`: a retired section or plugin post type redirects to
  the page that replaced it.
- `fix-content` embeds: an `image` option for GIF hosts.
- The parity audit reads `decisions.json`. An embed shown as a card, an image or quoted text, or
  left out, and a script shown as code, are known findings, marked `decided`. `fix-content` still
  acts on decided findings, so a decision recorded but not yet applied is never skipped.

### Changed
- `fix-content` embeds: the `html` option now writes EmDash's `iframe` block, with a fixed height
  per provider, instead of an isolated HTML block. That block's sandbox has no
  `allow-same-origin`, so CodePen and most other players wouldn't load in it. Re-running upgrades
  blocks written by 1.0.0.
- `fix-content` embeds: a tweet or other embed replaced by a quote keeps its figure caption, as
  an italic line under the quote. A `leave` decision counts as settled instead of waiting for the
  owner.
- Parity audit, fewer false findings:
  - a nested category that redirects to `/category/<child>/` passes, as the template does;
  - a sampled upload that WordPress itself no longer serves is known, not high;
  - an old hotlinked image that now returns an HTML page counts as already broken;
  - WordPress's hidden post-embed quote and CodePen's "See the Pen" fallback paragraph aren't
    compared as text.
- Gotcha A6 and the audit's suggested fixes: the embed options, and providers that can't be
  checked headlessly (CodePen, SlideShare).

## 1.0.0 (2026-11-11)

First public release.
