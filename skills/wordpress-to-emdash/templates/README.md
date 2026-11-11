# Site templates

Files a WordPress → EmDash migration needs in the EmDash site itself. Copy each one to the same
path in your site (relative to its root), then read its header comment: most need one name
checked or changed. Gotcha IDs refer to `references/gotchas.md`.

They were written for EmDash 1.4 on Astro 7 and Cloudflare Workers, and assume the migration keeps
WordPress's paths: posts and pages at `/<slug>/`.

## Worker and setup

| File | Goes to | What it does | Prevents |
| --- | --- | --- | --- |
| `src/worker.ts` | `src/worker.ts` | EmDash's Worker plus a page-cache purge the first time each new version serves a request, then two more sweeps from the minute cron. On any host other than `EMDASH_SITE_URL` (staging), rewrites media URLs that point at the final domain back to the serving host. Keeps EmDash's `createScheduledHandler` and `PluginBridge` exports. | D1, D2, D15 |
| `src/middleware.ts` | `src/middleware.ts` (merge with an existing one) | Locks the setup wizard behind a `SETUP_KEY` secret, so the first visitor to a public deployment can't claim the admin account. | D7 |

`src/worker.ts` needs these in `wrangler.jsonc`, before the first content deploy:

```jsonc
"main": "./src/worker.ts",
"version_metadata": { "binding": "CF_VERSION_METADATA" },
"triggers": { "crons": ["* * * * *"] }
```

Then run `npx wrangler types`. The D1 binding is assumed to be `DB` (EmDash's default); change
`env.DB` in `worker.ts` and the uploads route if yours differs.

## Rendering imported content

| File | Goes to | What it does | Prevents |
| --- | --- | --- | --- |
| `src/components/Content.astro` | `src/components/` | One Portable Text wrapper with the overrides below. Use it wherever content renders. | A1, A2, A7 |
| `src/components/pt/Quote.astro` | `src/components/pt/` | Renders a quote's closing "— Name" paragraph (written by `fix-quotes.mjs`) as its `<footer>`. | A1 |
| `src/components/pt/Columns.astro` | `src/components/pt/` | Renders each column through the full Portable Text set, so images inside columns show. | A2 |
| `src/components/pt/CodeBlock.astro` | `src/components/pt/` | Server-highlighted code blocks: language detection, a role colour per token, Copy that skips drawn `$` prompts, `&#91;`/`&#93;` shown as brackets. | A7, D14 |
| `src/lib/code-lang.ts` | `src/lib/` | Detects a block's language from its code; a language set in the admin wins. | A7 |
| `src/lib/highlight.ts` | `src/lib/` | Shiki with the JavaScript regex engine (no WebAssembly) and lazily loaded grammars; emits role classes instead of colours. Needs `shiki`, pinned. | D11, D12, D14 |
| `scripts/check-code-contrast.mjs` | `scripts/` | Checks every code colour against the block background for 4.5:1 in light and dark mode. Takes the palette file as an argument (default `src/components/pt/CodeBlock.astro`). | (accessibility) |

**CodeBlock styling.** Every colour, the font, size, radius, shadow and focus ring is a CSS custom
property with a neutral default, declared at zero specificity, so a plain rule in the site's own
stylesheet overrides it:

```css
.code {
	--code-font: var(--font-mono);
	--code-bg: light-dark(#fffdf8, #191813);
	--tok-k: light-dark(#0b6a65, #74cfc2); /* keyword, also the language label */
}
```

The full list is at the top of `CodeBlock.astro`. Colours are `light-dark()` pairs, which need
`color-scheme: light dark` on the page. After changing any of them, run
`node scripts/check-code-contrast.mjs path/to/the/file/with/your/overrides.css`.

## Old WordPress addresses

| File | Goes to | What it does | Prevents |
| --- | --- | --- | --- |
| `src/pages/wp-content/uploads/[...path].ts` | same path | Old upload URLs, including `-WxH` resized copies and `-scaled` originals, 301 to their media file, read from the redirect rows `add-redirects.mjs` creates. EmDash's redirect middleware skips paths with file extensions, so this route has to exist. | C1, B1 |
| `src/pages/_base_/[slug]/[...rest].ts` | `src/pages/<base>/[slug]/[...rest].ts`, one copy per old base | `/<base>/<slug>/` (and attachment pages under it) → `/<slug>/`. Rename `_base_`: Astro ignores folders starting with `_`, so the template doesn't route as it is. List the bases in `urls.oldPermalinkBases` too, so the audit tests them. | C3, C3b |
| `src/pages/category/[parent]/[slug].ts` | same path | Nested categories `/category/<parent>/<child>/` → `/category/<child>/`. | C5 |
| `src/pages/feed/atom.ts` | same path | `/feed/atom/` → the site's feed. Set `FEED` to where yours is (`/feed/` or the blog template's `/rss.xml`). | C5 |
| `src/pages/sitemap_index.xml.ts`, `post-sitemap.xml.ts`, `page-sitemap.xml.ts`, `category-sitemap.xml.ts`, `post_tag-sitemap.xml.ts`, `author-sitemap.xml.ts`, `wp-sitemap.xml.ts` | `src/pages/` | Each old SEO-plugin or core sitemap address → EmDash's `/sitemap.xml`. Copy only the names your old site served. **One static file per name; never a dynamic `[name].xml.ts` route**, which swallows EmDash's own child sitemaps. | C3c, C5 |
| `src/lib/entry-by-slug.ts` | `src/lib/` | `getEntryBySlug()`, which also finds slugs WordPress stored percent-encoded, and `looseSlug()` for the malformed slugs WordPress used to guess. | C3b, C4 |
| `snippets/slug-route.md` | into `src/pages/[slug].astro` | The frontmatter for posts and pages at the root: posts first, then pages, the encoded-slug fallback, and the loose-slug 301. | C3b, C4, C7 |
| `snippets/home-page-legacy-queries.md` | into `src/pages/index.astro` | `/?s=`, `/?p=`, `/?page_id=` and `/?feed=` redirects, using the ID map from `wp-ids.mjs`. | C2 |

## Before the first build from git

Check that `.gitignore` doesn't hide any of these files. A bare `uploads` rule, meant for EmDash's
local media folder, also matches `src/pages/wp-content/uploads/`, and the route silently drops
out of any build made from git (gotcha E2). Anchor it as `/uploads`, then confirm this prints
nothing:

```sh
git ls-files --others --ignored --exclude-standard -- src
```
