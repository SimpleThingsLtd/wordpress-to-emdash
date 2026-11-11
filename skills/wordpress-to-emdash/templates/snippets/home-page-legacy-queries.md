# Snippet: WordPress query-string addresses on the home page

WordPress answered `/?p=123`, `/?page_id=45`, `/?s=term` and `/?feed=rss2`. They all arrive at `/`,
so they're handled at the top of the home page's frontmatter (`src/pages/index.astro`), before
anything else renders. Prevents gotcha **C2** (`?p=` links landing on the home page).

1. Generate the ID map from the export:

   ```sh
   node scripts/wp-migration/wp-ids.mjs        # writes paths.wpIds (src/lib/wp-ids.json)
   ```

   Re-run it after any re-export. It maps every published post and page ID to its address
   (`content.entryPath`, `/<slug>/` by default).

2. Add this to the top of the home page's frontmatter:

   ```astro
   ---
   import WP_IDS from "../lib/wp-ids.json";

   // Old WordPress query addresses: the search form (/?s=), post and page IDs
   // (/?p=123, /?page_id=45) and the feed (/?feed=rss2)
   const params = Astro.url.searchParams;
   const legacySearch = params.get("s");
   if (legacySearch !== null) {
   	return Astro.redirect(`/search/?q=${encodeURIComponent(legacySearch)}`, 301);
   }
   const legacyId = params.get("p") ?? params.get("page_id");
   if (legacyId && legacyId in WP_IDS) return Astro.redirect((WP_IDS as Record<string, string>)[legacyId], 301);
   if (params.has("feed")) return Astro.redirect("/feed/", 301);

   // … the rest of the home page
   ---
   ```

Adjust the two targets to the new site: `/search/?q=` is EmDash's blog-template search page, and
`/feed/` assumes RSS stays at WordPress's address (see `src/pages/feed/atom.ts`; use `/rss.xml` if
you kept the template's feed).

Check that the home page's route cache varies by query string, or a cached home page would answer
`/?p=123` too. The audit's `?p=` URL tests catch this: run `compare-sites.mjs --refresh` after
deploying.
