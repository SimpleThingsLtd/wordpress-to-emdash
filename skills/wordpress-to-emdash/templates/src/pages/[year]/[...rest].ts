/**
 * WordPress month and day archives (/2015/04/, /2015/04/12/) → that year on
 * your archive page. Anything else with this shape isn't ours: 404.
 *
 * Year archives (/2015/) can't live here (that's a single segment, which your
 * [slug] route owns), so templates/snippets/slug-route.md handles them after
 * the post lookup. Set ARCHIVE to your archive page; the "#y2015" anchor
 * assumes year sections with id="y<year>" (drop it if you don't have them).
 * Gotcha C5.
 */
import type { APIRoute } from "astro";

export const prerender = false;

const ARCHIVE = "/archive/";

export const GET: APIRoute = ({ params, redirect }) => {
	const year = params.year ?? "";
	const rest = params.rest ?? "";
	if (/^(19|20)\d{2}$/.test(year) && /^\d{2}(\/\d{2})?\/?$/.test(rest)) return redirect(`${ARCHIVE}#y${year}`, 301);
	return new Response("Not found", { status: 404 });
};
