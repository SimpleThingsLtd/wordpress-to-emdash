/**
 * An older WordPress permalink base: /<base>/<slug>/ → /<slug>/ (gotchas C3, C3b).
 *
 * TEMPLATE: copy this folder once per old base and rename `_base_` to the base,
 * for example src/pages/blog/[slug]/[...rest].ts for /blog/<slug>/. Astro
 * ignores folders that start with "_", so the template itself never routes.
 * List the same bases in urls.oldPermalinkBases so the audit tests them.
 *
 * Find the bases in the export's internal links, not only in the redirect
 * plugin's rules: sites change permalink structure more than once.
 *
 * [slug]/[...rest] also covers attachment pages under a post
 * (/<base>/<slug>/<attachment>/), and it doesn't capture the bare /<base>/,
 * so a real post whose slug is the base name still loads. Don't use
 * <base>/[...path].ts: that does capture /<base>/.
 *
 * This assumes posts now live at the root (/<slug>/); change the target if
 * yours don't.
 */
import type { APIRoute } from "astro";

export const prerender = false;

export const GET: APIRoute = ({ params, redirect }) => redirect(`/${encodeURIComponent(params.slug ?? "")}/`, 301);
