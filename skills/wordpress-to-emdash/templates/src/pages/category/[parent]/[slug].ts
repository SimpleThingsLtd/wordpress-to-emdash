/**
 * WordPress nests child categories under their parent
 * (/category/<parent>/<child>/); EmDash's category archive is flat, so send
 * them to the child's own page (gotcha C5).
 *
 * Needs a flat archive at src/pages/category/[slug].astro (EmDash's blog
 * template has one). If WordPress used a different category base
 * (Settings → Permalinks), rename the `category` folder to match, and set
 * newSite.categoryBase.
 */
import type { APIRoute } from "astro";

export const prerender = false;

export const GET: APIRoute = ({ params, redirect }) => redirect(`/category/${encodeURIComponent(params.slug ?? "")}/`, 301);
