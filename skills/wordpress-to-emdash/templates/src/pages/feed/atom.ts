/**
 * WordPress's Atom feed address (/feed/atom/) → the site's RSS feed (gotcha C5).
 *
 * Set FEED to wherever the new site publishes its feed. Keeping RSS at
 * WordPress's own /feed/ (a src/pages/feed/index.ts endpoint) means existing
 * subscribers never notice the move; EmDash's blog template serves /rss.xml,
 * so either add that endpoint or point FEED (and a /feed/ redirect) there.
 */
import type { APIRoute } from "astro";

export const prerender = false;

const FEED = "/feed/";

export const GET: APIRoute = ({ redirect }) => redirect(FEED, 301);
