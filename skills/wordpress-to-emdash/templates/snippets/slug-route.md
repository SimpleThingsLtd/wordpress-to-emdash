# Snippet: posts and pages at the root, with WordPress's slug quirks

Goes in `src/pages/[slug].astro`, the route that serves `/<slug>/` for both posts and pages, matching
WordPress's `/%postname%/` permalinks. EmDash's blog template serves `/posts/<slug>` and
`/pages/<slug>` instead; old links need the root route. Prevents gotchas **C3b** (malformed slugs
WordPress guessed) and **C4** (slugs stored percent-encoded).

Needs `src/lib/entry-by-slug.ts` from the templates. Only the frontmatter is shown: render the
entry with your layout and `<Content value={entry.data.content} />` (from
`src/components/Content.astro`).

```astro
---
import { decodeSlug } from "emdash";
import { getEntryBySlug, looseSlug } from "../lib/entry-by-slug";

const slug = decodeSlug(Astro.params.slug);
if (!slug) return Astro.rewrite("/404");

// Posts first, then pages: WordPress kept both at the root
const postResult = await getEntryBySlug("posts", slug);
const pageResult = postResult.entry ? null : await getEntryBySlug("pages", slug);
const entry = postResult.entry ?? pageResult?.entry;

if (!entry) {
	// Old links with odd slugs (".net-awards", "tr.im", "year!") still reached WordPress, which
	// guessed the closest post. Do the same: punctuation to hyphens, then 301 if that matches.
	const loose = looseSlug(slug);
	if (loose && loose !== slug) {
		const match = (await getEntryBySlug("posts", loose)).entry ?? (await getEntryBySlug("pages", loose)).entry;
		if (match) return Astro.redirect(`/${encodeURIComponent(loose)}/`, 301);
	}
	return Astro.rewrite("/404");
}

// When Astro's route cache is on, register the query's cache hint
const cacheHint = (postResult.entry ? postResult : pageResult)!.cacheHint;
if (Astro.cache?.enabled && cacheHint) Astro.cache.set(cacheHint);
const isPost = Boolean(postResult.entry);
---
```

Notes:

- **Section routes win.** A static route such as `src/pages/writing/index.astro` outranks `[slug]`,
  so a WordPress post whose slug is `writing` can no longer be reached (gotcha C7). List your new
  section routes in `newSite.sections`; the audit reports collisions.
- **The 404 page** sees `/404` in `Astro.url`; use `Astro.originPathname` for the address the
  visitor asked for (gotcha D4).
- **Pages replaced by new routes** (an old About page): add a redirect row
  (`urls.replacedPages`, applied by `add-redirects.mjs`) and unpublish the old page
  (`fix-content.mjs --only unpublish`), so the sitemap stops listing it (gotcha C6).

## Year archives (`/2015/`)

WordPress year archives are single-segment paths, so they reach this route. Redirect them only
after the post lookup fails, because a post could be called `2015`. Month and day archives are in
`templates/src/pages/[year]/[...rest].ts`.

```ts
if (!entry) {
	if (/^(19|20)\d{2}$/.test(slug)) return Astro.redirect(`/archive/#y${slug}`, 301);
	// …then the loose-slug fallback, then the 404
}
```
