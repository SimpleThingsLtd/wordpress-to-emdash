/**
 * Slug lookups that survive WordPress's slug quirks (gotchas C3b, C4).
 *
 * - getEntryBySlug: some WordPress slugs were stored still percent-encoded
 *   ("…-%c2%b7-…"), while the address arrives decoded ("…-·-…"), so a plain
 *   lookup misses. Try the slug as given, then its encoded form. Use it in
 *   every route that resolves slugs, including the OG card endpoint.
 * - looseSlug: WordPress "guessed" the closest post for slugs that didn't
 *   quite match (".net-awards", "using-tr.im", "year!"). Turn punctuation
 *   into hyphens; if that matches, 301 to it (see snippets/slug-route.md).
 */
import { getEmDashEntry } from "emdash";

type Collection = Parameters<typeof getEmDashEntry>[0];

export async function getEntryBySlug<C extends Collection>(collection: C, slug: string) {
	const result = await getEmDashEntry(collection, slug);
	if (result.entry || !/[^\x00-\x7f]/.test(slug)) return result;
	return getEmDashEntry(collection, encodeURIComponent(slug).toLowerCase() as never);
}

/** The slug WordPress would have guessed: punctuation to hyphens, no doubles, no edges. */
export function looseSlug(slug: string) {
	return slug
		.toLowerCase()
		.replace(/[^\p{L}\p{N}-]+/gu, "-")
		.replace(/-{2,}/g, "-")
		.replace(/^-+|-+$/g, "");
}
