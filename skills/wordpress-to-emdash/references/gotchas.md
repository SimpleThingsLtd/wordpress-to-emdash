# Gotchas

Every failure a real WordPress → EmDash migration hit. Each entry has:
- **Detect:** how to find out whether it affects your site;
- **Cause:** why it happens;
- **Fix:** with the script or template that does it;
- **Prevent:** where that applies.

Most are silent: nothing errors, content is just missing or wrong. Assume each applies until the
detection says otherwise. The parity audit (`scripts/compare-sites.mjs`) reports most of them by
finding kind, given in brackets.

---

## A. Content conversion (WXR → Portable Text)

### A1. Quotes arrive empty, and citations are lost
- **Detect:** `wp:quote` blocks in the WXR; the audit reports `quotes-missing` and
  `citations-unstyled`.
- **Cause:** since WordPress 5.8, `core/quote` keeps its paragraphs as inner blocks. EmDash's
  Gutenberg converter reads only the quote's own HTML, so the paragraphs are dropped. Classic
  `<figure><blockquote>` quotes can be dropped too.
- **Fix:** `scripts/fix-quotes.mjs` rebuilds each quote from the WXR and appends the citation as a
  final `— Name` paragraph. `templates/src/components/pt/Quote.astro` renders that paragraph as the quote's
  `<footer>`.
- **Careful:** EmDash merges *consecutive* blockquote blocks into one `blockquoteGroup`, so two
  adjacent quotes look like one. Match each WordPress quote individually, and make the repair
  recognise quotes it has already rebuilt.

### A2. Images inside columns disappear
- **Detect:** `wp:columns` containing `wp:image`; "missing image" placeholders on the page.
- **Cause:** EmDash's built-in Columns renderer doesn't render nested image blocks.
- **Fix:** `templates/src/components/pt/Columns.astro` renders each column's content through `PortableText`
  with the page's overrides.

### A3. Classic-editor posts lose their paragraph breaks
- **Detect:** posts with no `<!-- wp:` comments in `content:encoded`. The audit reports:
  - `paragraphs-merged` (several paragraphs in one block);
  - `paragraphs-glued` (words fused where a newline was dropped: "listings.As");
  - `list-items-flattened`, `headings-demoted`, `quotes-flattened`.
- **Cause:** classic content is stored without `<p>` tags. WordPress adds them at display time
  with `wpautop`: a blank line is a paragraph, a single newline a `<br>`. The importer doesn't run
  `wpautop`.
- **Fix:**
  - *Before importing:* run `wpautop` on classic content.
  - *After importing:* use the targeted repair (`fix-content` → `classic`). Don't re-import: a
    re-import undoes every later repair. The repair:
    1. runs a port of `wpautop` on the WXR, to learn where WordPress put every paragraph, `<br>`,
       list item, heading and quote;
    2. lines up each block's visible characters, ignoring whitespace, against that;
    3. splits blocks and sets styles there, keeping every existing span (text, marks, links)
       exactly as it is.
- **Guard:** a rebuilt block's characters, whitespace aside, must equal the original's, or the
  script stops. Run the shortcode and code repairs first, so leftover text doesn't block the
  alignment.

### A4. Shortcodes print as raw text
- **Detect:** `grep -o '\[[a-z_]\+' wxr | sort | uniq -c`, then confirm each one, since many
  bracketed words aren't shortcodes. The audit reports `shortcode-visible`.
- **Cause:** WordPress expands shortcodes at render time. The export holds them raw, and the
  converter keeps them as text.
- **Fix:** `fix-content` → `captions` turns `[caption]` into an image block with `caption`, and
  theme shortcodes such as `[button link=…]` into links. Extend it for your theme's shortcodes.

### A4b. Layout shortcodes from a removed theme
- **Detect:** `[one_half]`, `[one_third]`, `[column]` and similar in the WXR.
- **Cause:** a theme or plugin that's gone. WordPress itself may now show them raw.
- **Fix:** remove the tags, or rebuild them as `columns` blocks if the layout matters.

### A5. Galleries collapse
- **Detect:** `[gallery` or `wp:gallery` in the WXR; the audit reports `gallery-missing`.
- **Cause:** galleries reference attachment IDs, which the converter can't resolve.
- **Fix:** `fix-content` → `gallery` resolves the IDs against WXR attachments, maps each to its
  imported EmDash media item (on the *target* site; see B1b), and emits a `gallery` block.

### A6. Embeds vanish or become plain links
- **Detect:** `wp:embed`, and bare provider URLs on their own line in classic posts (WordPress
  auto-embeds these). The audit's live checks report `embed-lost` and `embed-degraded`.
- **Cause:**
  - EmDash's embed block plays only YouTube and Vimeo;
  - nothing converts classic posts' auto-embedded bare URLs;
  - tweets arrive as a `blockquote.twitter-tweet` with the script stripped.
- **Fix:** `fix-content` → `embeds` emits `embed` blocks for YouTube and Vimeo, from both sources.
  For other providers, the owner chooses in `decisions.json`:
  - a link card (an embed block with URL and caption; no code change needed);
  - a sandboxed HTML embed (check the CSP first);
  - drop it.

  Tweets keep their text as a quote with a citation line.
- **Careful:** check what WordPress *actually displayed*. Embeds from dead services (Flash, closed
  hosts) weren't working there either, and aren't migration losses.

### A7. Code blocks flattened, unlabelled, or showing entities
- **Detect:** `<pre>` and `<code>` in classic posts; `class="language-…"`; `&#91;` inside code. The
  audit reports `code-flattened`, `code-missing` and `code-whitespace`.
- **Cause:**
  - `<pre>` in classic content isn't always recognised;
  - Prism's `language-*` classes aren't carried over;
  - WordPress stores `[` and `]` in code as `&#91;` and `&#93;` so they aren't read as
    shortcodes, and nothing decodes them.
- **Fix:**
  - `fix-content` → `code` rebuilds blocks from the WXR;
  - `templates/src/lib/code-lang.ts` detects the language at render time, with an
    editor-set language winning;
  - `templates/src/components/pt/CodeBlock.astro` decodes `&#91;`/`&#93;` for display, and `fix-content` → `brackets` fixes
    the stored text.

### A8. Inline scripts and widgets print as text
- **Detect:** `wp:html` or classic content containing `<script`; the audit reports
  `code-shown-as-text` and `markup-visible`.
- **Cause:** custom HTML ran on WordPress. The converter keeps it as text.
- **Fix:** the owner decides for each page: rebuild the widget, show it as a code block, or remove
  it. Never publish raw script text.

### A9. Titles show `&amp;`
- **Detect:** the audit reports `title-double-escaped`; or `grep '&amp;amp;' wxr`.
- **Cause:** entities escaped twice between the export and the import.
- **Fix:** `fix-content` → `titles`.

### A10. Footnotes, list items and odd paragraphs lost
- **Detect:** `wp:footnotes`; the audit reports `paragraphs-missing` and `list-items-missing`.
- **Cause:** blocks the converter doesn't handle, and malformed sources.
- **Fix:** `fix-content` → `textLoss` restores what the WXR makes unambiguous and lists the rest
  for the owner. Footnotes come back as a list, without back-links.

### A11. Theme conventions carried in the body
- **Detect:** read five posts of each format. Look for link posts with a "Read on…" trailer,
  "via" lines, or custom meta shown inline.
- **Cause:** site conventions, not WordPress features.
- **Fix:** `scripts/postprocess-links.mjs` (configured under `linkPosts`) moves a link post's URL
  into a field and strips the trailer. Adapt the pattern to your site's convention, or turn it off.

### A12. One author becomes many bylines
- **Detect:** after importing, check the bylines list for `name`, `name-2`, `name-3`….
- **Cause:** the chunked import creates a guest byline per chunk for the same author.
- **Fix:** `scripts/merge-bylines.mjs` (configured under `bylines`).

### A13. Comments aren't imported
- **Detect:** `grep -c "<wp:comment>" wxr`.
- **Cause:** the WXR contains comments, but EmDash's WXR import skips them.
- **Fix:** an owner decision. Import them with the EmDash Exporter WordPress plugin, or accept the
  loss explicitly (`audit.commentsAccepted`, so the audit stops reporting it).

### A14. A whole post type is missing from the export
- **Detect:** compare `wp post-type list` and the per-type counts, taken **with plugins loaded**,
  against `<wp:post_type>` values in the WXR. The audit reports `page-missing` on that type's URLs.
- **Cause:** `wp --skip-plugins --skip-themes export` is often needed to stop wp-cli crashing on
  hosted sites. But skipping plugins means plugin post types (portfolios, products, events) are
  never registered, and `wp export` only exports registered types. It drops them without a
  warning.
- **Fix:** export the missing types with plugins loaded (`wp export --post_type=<type>`), or
  recreate them.

---

## B. Media

### B1. Posts point at resized and variant images
- **Detect:** in the WXR, `-\d+x\d+\.(jpg|png)`, `-scaled.`, `http://` uploads URLs, and images
  that aren't attachments.
- **Cause:** content references WordPress's resized copies, `-scaled` originals, `http://` variants
  and unregistered images. The importer maps only each attachment's own URL.
- **Fix:** `scripts/fix-media-urls.mjs` normalises filenames (strips `-WxH` and `-scaled`,
  lowercases, decodes), maps each to the imported original, uploads strays, and rewrites content.

### B1b. Local and staging have different media IDs
- **Detect:** compare one image's `/_emdash/api/media/file/<key>` on local and on staging.
- **Cause:** the local import and the staging site-package import generate different file keys.
- **Fix:** any repair that writes media references must resolve them against the **target** site's
  media library at apply time (`fix-content` does). Never copy `_ref` or `url` values between
  sites.

### B2. Images still served by WordPress
- **Detect:** search content for the old domain; the audit reports `image-breaks-at-cutover`
  (it runs with WordPress images blocked).
- **Cause:** absolute URLs to the old host that no rewrite caught. They work until cutover.
- **Fix:** `fix-content` → `wpImages` rewrites the ones already in media and lists the rest to
  import.

### B3. Hotlinked external images already dead
- **Detect:** the audit reports `image-broken-external`.
- **Cause:** images hotlinked from other sites that disappeared. They're broken on WordPress too.
- **Fix:** none. Classify them as already broken.

### B4. Large media libraries
- Media imports run for a long time (500 MB is a long background job). The importer batches uploads
  and de-duplicates by content hash, so it's safe to interrupt and re-run.

---

## C. URLs and redirects

### C1. Old image addresses 404, although the redirects exist
- **Detect:** request a `/wp-content/uploads/…` URL on staging.
- **Cause:** EmDash's redirect middleware skips paths with file extensions.
- **Fix:** `templates/src/pages/wp-content/uploads/[...path].ts` reads the redirect row from D1 and
  falls back from `-WxH` and `-scaled` names to the original.

### C2. `?p=123` and `?page_id=45` land on the home page
- **Detect:** the audit's `?p=` URL tests.
- **Fix:** `scripts/wp-ids.mjs` maps IDs to addresses; `templates/snippets/home-page-legacy-queries.md`
  redirects `?p=`, `?page_id=`, `?s=` and `?feed=` from the home page.

### C3. Old permalink bases 404
- **Detect:** old internal links in the WXR (`grep -o 'href="/[a-z]*/'`), the redirect plugin's
  rules, and `.htaccess`. The audit reports `internal-link-broken` and `pattern-*-base`.
- **Cause:** the permalink structure changed over the years. WordPress kept redirecting the old
  bases, often several of them.
- **Fix:** copy `templates/src/pages/_base_/[slug]/[...rest].ts` once per base, renaming `_base_`
  (→ `/<slug>/`). It also covers attachment pages under the base. List the bases in
  `urls.oldPermalinkBases`, so the audit tests them.

### C3b. Malformed slugs that WordPress "guessed"
- **Detect:** internal links with dots or punctuation in the slug, such as `/.net-awards-2013` or
  `…-tr.im`, that resolved on WordPress.
- **Cause:** WordPress redirects an unmatched slug to the closest post.
- **Fix:** the loose-slug fallback in `templates/snippets/slug-route.md`: turn punctuation into
  hyphens, and 301 if that matches.

### C3c. A catch-all route swallowed EmDash's own routes
- **Detect:** after adding redirects, the audit reports `missing-from-new-sitemap` for most pages,
  or `/sitemap-posts.xml` returns 404.
- **Cause:** a dynamic root route (`[name].xml.ts`) outranked EmDash's injected child-sitemap
  routes. A `<base>/[...path]` route also captures the bare `/<base>/`, which may be a real post's
  slug.
- **Fix:** static files per old address (`templates/src/pages/*-sitemap.xml.ts`), and
  `<base>/[slug]/[...rest]` instead of `<base>/[...path]`.
- **Prevent:** re-run the audit after every routing change.

### C4. Slugs with non-ASCII characters 404
- **Detect:** `grep -o "<wp:post_name>[^<]*%[0-9a-f][0-9a-f]" wxr`.
- **Cause:** the slug was stored still percent-encoded, while the address arrives decoded.
- **Fix:** `templates/src/lib/entry-by-slug.ts` (`getEntryBySlug`) looks up the encoded form as a
  fallback. Use it in every route that resolves slugs (`templates/snippets/slug-route.md`),
  including any OG image endpoint.

### C5. The patterns nobody remembers
- **Detect:** the audit's URL tests.
- **Patterns:**
  - `/feed/atom/`;
  - nested categories (`/category/parent/child/`);
  - date archives;
  - attachment pages;
  - `/page/N/`;
  - SEO-plugin sitemaps (`/sitemap_index.xml`, `/post-sitemap.xml`, `/wp-sitemap.xml`).
- **Fix:** a route or redirect from `templates/`, or an approved drop.

### C6. The new sitemap lists dead or redirecting URLs
- **Detect:** the audit reports `sitemap-lists-non-200` and `sitemap-lists-redirect`.
- **Fix:** unpublish pages that only redirect (`fix-content` → `unpublish`); fix C4.

### C7. A new section route hides an old post
- **Detect:** WordPress slugs equal to a new section route (`writing`, `search`, `work`…). The
  audit reports `post-shadowed`.
- **Fix:** an owner decision for each one.

### C8. Internal links that worked on WordPress now 404
- **Detect:** the audit reports `internal-link-broken`.
- **Fix:** handle the patterns (C3 to C5) first, then retarget what's left.

---

## D. Cloudflare, Workers, Astro and EmDash

### D1. Pages lose their styling after a deploy
- **Detect:** after a redeploy, pages render unstyled and `/_astro/*.css` returns 404.
- **Cause:** the Workers page cache **isn't keyed by Worker version**, so cached HTML outlives the
  deploy that made it.
- **Fix:** `templates/src/worker.ts`:
  - on the first request a new version serves (`version_metadata` binding), record the version in
    a D1 table and purge everything;
  - the minute cron purges twice more, because old-version isolates keep caching for a short while;
  - import `cache` from `cloudflare:workers` dynamically, and guard it: local workerd has no
    `purge`.

### D2. Pages look empty after the import
- **Cause:** pages cached before the content existed. **Fix:** deploy or purge after the import.

### D3. An endpoint's 404 shows the HTML 404 page
- **Cause:** Astro renders the custom 404 page for any 404 response. An HTML 404 doesn't prove your
  route didn't run; debug with `wrangler tail`.

### D4. The 404 page doesn't know the missing path
- **Cause:** `Astro.url` on the 404 page is `/404`. **Fix:** use `Astro.originPathname`.

### D5. Cached search and 404 pages don't update when you publish
- **Fix:** give cached routes collection cache tags and a short `maxAge`.

### D6. The CLI login can't be approved
- **Cause:** `emdash login` builds the device URL from `EMDASH_SITE_URL`, which is the final domain
  and still WordPress.
- **Fix:** approve at `https://<staging>/_emdash/admin/device`. Tokens are short-lived;
  `emdash whoami --url <staging>` refreshes them.

### D7. Anyone could claim the admin account
- **Cause:** on a fresh public deployment, the first visitor to finish setup becomes the admin.
- **Fix:** `templates/src/middleware.ts` plus a `SETUP_KEY` secret.

### D8. Staging is empty although local works
- **Fix:** export a site package locally, then run `emdash site import --analyze` and
  `--plan <digest> --confirm` on staging.

### D9. The new staging domain "doesn't exist" on your machine
- **Cause:** the OS cached the NXDOMAIN answer from before the domain existed.
- **Fix:** flush the DNS cache (macOS: `sudo dscacheutil -flushcache; sudo killall -HUP
  mDNSResponder`) or wait 30 minutes.

### D10. Cutover can't attach the domain
- **Cause:** Cloudflare won't attach a Worker custom domain while another DNS record owns the
  hostname.
- **Fix:** delete the old records, add the routes and deploy, in one window.

### D11. The Worker outgrows the free plan
- EmDash plus Astro is over the free plan's 3 MB compressed limit; server-side image or
  highlighting libraries add more. Use Workers Paid, and measure with
  `npx wrangler deploy --dry-run`.

### D12. WebAssembly libraries fail in workerd
- **Detect:** a library works in Node but throws at import in the Worker (for example `reading
  'href'`).
- **Cause:** Workers can't compile WebAssembly from bytes at runtime. Libraries that bundle base64
  wasm, or probe `import.meta.url`, fail.
- **Fix:**
  - import `.wasm` as modules; the Cloudflare Vite plugin compiles `.wasm`, and loads `.bin` as an
    ArrayBuffer;
  - use "standalone" builds with `init()`;
  - known cases: Satori 0.33 and later load harfbuzz at import, so pin 0.29.x; Shiki needs its
    JavaScript regex engine, not Oniguruma.

### D13. Generated social images (optional)
- Satori draws variable fonts at their default weight only, so fetch static weights.
- `lineClamp` needs `display: block` and misfires with `textWrap: balance`.
- Store rendered PNGs in R2, keyed by a design version plus the content hash.
- Build the `og:image` URL from the request origin, so staging previews point at staging.

### D14. Code highlighting details
- Shiki's PHP grammar highlights only inside `<?php`: prepend it, then drop the first line.
- The shell grammar colours every argument as a string; override `string.unquoted.argument.shell`.
- Load grammars lazily: PHP pulls in HTML, JS, CSS, SQL, XML and JSON.

### D15. Images uploaded or rebuilt before cutover 404 on staging
- **Detect:** open a post with images added through the admin, or rebuilt by a repair, on staging.
  Their `src` and `srcset` point at `https://<final domain>/_emdash/api/media/file/…`, which is
  still the old site. Check images **exactly as a browser loads them**: don't swap in the staging
  host first, or you'll hide this.
- **Cause:** `EMDASH_SITE_URL` is the final domain (rightly, for passkeys and canonical URLs).
  EmDash's image component makes media URLs absolute with that origin for images with stored width
  and height (they go through Astro's `<Image>`). Imported images without dimensions stay relative
  and work, which is why only some images break.
- **Fix:** in the Worker, when a page is served from a host other than `EMDASH_SITE_URL`, rewrite
  `<img src/srcset>`, `<source srcset>`, `a[href]` and `style` values that point at
  `<final domain>/_emdash/` to relative paths, using `HTMLRewriter` (`templates/src/worker.ts`).
  After cutover the hosts match and it does nothing.
- **Don't:** point `EMDASH_SITE_URL` at staging to "fix" it. That changes the passkey's relying
  party, and can lock the owner out of the admin.

---

## E. Process and tooling

### E1. Two sessions deploying one Worker overwrite each other
- **Detect:** a deploy "succeeds" but the site doesn't change; `wrangler deployments list` shows
  versions you didn't make.
- **Fix:** one branch and one deployer. Merge feature branches, then build, and check the
  deployment list before every deploy.

### E2. A route disappears from builds made from git
- **Detect:** `git ls-files --others --ignored --exclude-standard -- src` prints anything.
- **Cause:** a broad ignore rule. A bare `uploads` (meant for EmDash's local media folder) also
  matched `src/pages/wp-content/uploads/`, so the route never reached git, and builds from fresh
  worktrees lost it.
- **Fix:** anchor root-level rules (`/uploads`).

### E3. Local dev fonts 404 after `astro check`
- **Cause:** `astro check` regenerates `.astro/`, which the running dev server depends on.
- **Fix:** restart the dev server.

### E4. Headless browsers can't play H.264
- **Fix:** use installed Chrome (`chromium.launch({ channel: "chrome", headless: true })`). Keep
  tests headless, reuse one browser, and close it in `finally`.

### E5. Agents that can't publish rich reports
- Some agent setups can't publish hosted pages. The audit and the fix preview write
  self-contained HTML into the work folder; hand over the path.

### E6. Fresh dependency releases
- Pin exact versions at least two weeks old. Libraries in this space ship breaking releases days
  apart.

### E6b. A verification run overwrote the approved proposals
- **Detect:** applying to the second site skips every post ("differs from the approved
  proposal").
- **Cause:** after applying to the first site, a dry run regenerated `proposals.json` from
  already-fixed content.
- **Fix:** copy the approved file aside (`proposals.approved.json`) and apply every target from
  it. Never dry-run between applies. The safety check working as intended means nothing was
  written.

### E6c. Bulk applies need restore points
- **Local:** `tar` the `.wrangler/state/v3/d1/` SQLite files; stop the dev server before restoring.
- **Deployed:** `npx wrangler d1 time-travel info <db>` records a bookmark;
  `wrangler d1 time-travel restore <db> --bookmark=…` restores it.
- Applies through the API also fire publish hooks (search sync, cache purges). Allow minutes per
  few hundred posts.
