# Phase 4: keep every old address working

Rule: every URL WordPress answered must, after cutover, either serve the same content, 301 to its new
home, or be an explicit owner-approved drop. Search engines, old posts, other people's sites and
bookmarks all hold these URLs.

## How EmDash routes them

- **EmDash's redirect table** (`_emdash_redirects`, Admin → Redirects): exact-path 301s, created by
  the import and `add-redirects.mjs`. Its middleware **skips paths with file extensions** (C1).
- **Astro routes** for patterns (copy them from `templates/src/pages/`): a small endpoint per pattern that returns a 301. Keep them
  `prerender = false`.
- **The home page frontmatter** for query-string addresses (`/?p=`, `/?s=`), since they all hit `/`.

## Patterns

| WordPress address | Serve with | Test |
| --- | --- | --- |
| `/<slug>/` (posts and pages at the root) | the site's `src/pages/[slug].astro`, posts first, then pages (`templates/snippets/slug-route.md`) | every slug in the export returns 200 |
| `/<slug>/` with percent-encoded characters (`%c2%b7`) | the same route, with `templates/src/lib/entry-by-slug.ts` as a fallback (C4) | the encoded slugs return 200 |
| `/wp-content/uploads/YYYY/MM/file.ext`, plus `-WxH` and `-scaled` copies | `templates/src/pages/wp-content/uploads/[...path].ts`: read the redirect row by `env.DB`, fall back to the original name, 301 to `/_emdash/api/media/file/<key>` | 40 random rows, half with a size suffix added, all 301 |
| `/?p=<id>`, `/?page_id=<id>` | `templates/snippets/home-page-legacy-queries.md`, with `src/lib/wp-ids.json` from `scripts/wp-ids.mjs` | 20 IDs land on the right post |
| `/?s=<q>` | home page → `/search/?q=` | a 301 to search |
| `/?feed=rss2`, `/feed/`, `/feed/atom/` | `/feed/` endpoint (RSS at the old address) plus small redirects | the feed validates; old feed URLs 301 |
| Old permalink bases, such as `/blog/<slug>/`. **Sites accumulate several** over the years. Find them in old internal links in the WXR, not just the redirect plugin's rules | `templates/src/pages/_base_/[slug]/[...rest].ts`, renamed per base, → `/<slug>/` (this also covers attachment pages under the base). **Not `<base>/[...path]`:** that also captures the bare `/<base>/`, which can be a real post's slug | 10 old-base URLs 301 to 200 |
| Malformed slugs that WordPress "guessed" (`/writing/.net-awards-2013`, `…-tr.im`) | the `[slug]` route (`templates/snippets/slug-route.md`): if nothing matches, loosen the slug (dots to hyphens, trim punctuation), and 301 if that matches | the old internal links resolve |
| `/category/<slug>/`, `/tag/<slug>/` | term archive routes | every term returns 200 |
| `/category/<parent>/<child>/` | `templates/src/pages/category/[parent]/[slug].ts` → `/category/<child>/` | nested terms 301 |
| `/author/<name>/` | redirect to `/about/` or an author page | a 301 |
| `/YYYY/`, `/YYYY/MM/`, `/YYYY/MM/DD/` | owner decision; usually the archive page with a year anchor | archives 301 |
| `/page/N/`, `/<section>/page/N/` | owner decision; usually the archive | a 301 |
| Attachment pages `/<post>/<attachment>/`, `/<attachment>/` | owner decision; usually the parent post | a 301 |
| `/sitemap_index.xml`, `/post-sitemap.xml`, `/wp-sitemap.xml` | one small static route per old name (`templates/src/pages/*-sitemap.xml.ts`) → EmDash's `/sitemap.xml`. **Not a dynamic `[name].xml` route:** it captures EmDash's own child sitemaps (`/sitemap-posts.xml`) and empties the sitemap | a 301 |
| `/wp-admin/`, `/wp-login.php`, `/xmlrpc.php` | 404, or redirect to `/_emdash/admin` (admin only) | they don't serve WordPress |
| Pages deliberately replaced (`/old-about-page/` → `/about/`) | redirect-table row; **unpublish the old page** so the sitemap drops it (C6) | a 301; not in the sitemap |

## Before cutover

- Test patterns against **staging with WordPress hostnames swapped in** (the parity audit does this).
- List WordPress slugs that equal new section routes (`writing`, `search`, `work`, `links`) and get
  a decision for each (C7).
- Check that the sitemap lists only URLs that return 200.
- Find absolute URLs to the old domain in content (B2). They work until cutover, then break.
