/**
 * A WordPress section that has no direct equivalent on the new site, such as
 * a plugin post type (/portfolio/…) or a retired listing, sends everything
 * beneath it to the section that replaced it.
 *
 * Copy once per retired base and rename the folder: _retired_ → portfolio.
 * Set TARGET. Use _base_/[slug]/[...rest].ts instead when the items still
 * exist at /<slug>/. Gotchas A14, C5.
 */
import type { APIRoute } from "astro";

export const prerender = false;

const TARGET = "/projects/";

export const GET: APIRoute = ({ redirect }) => redirect(TARGET, 301);
