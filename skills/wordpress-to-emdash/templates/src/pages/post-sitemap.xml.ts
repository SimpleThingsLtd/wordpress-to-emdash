/**
 * /post-sitemap.xml, an old WordPress or SEO-plugin sitemap address → EmDash's /sitemap.xml.
 *
 * One small static file per old name, on purpose: a dynamic [name].xml.ts
 * route outranks EmDash's own child sitemaps (/sitemap-posts.xml …) and
 * empties the sitemap (gotcha C3c). Copy only the names your old site served
 * (open /sitemap_index.xml or /wp-sitemap.xml on WordPress to see them).
 */
import type { APIRoute } from "astro";

export const prerender = false;

export const GET: APIRoute = ({ redirect }) => redirect("/sitemap.xml", 301);
