/**
 * Old WordPress image addresses (/wp-content/uploads/…), gotcha C1.
 *
 * EmDash's redirect middleware deliberately skips paths with file
 * extensions, so the upload redirects add-redirects.mjs creates are looked
 * up here instead. Resized copies (photo-1024x576.jpg) and WordPress's
 * "-scaled" originals fall back to the full-size image.
 *
 * `env.DB` is EmDash's D1 binding; change the name if yours differs in
 * wrangler.jsonc. Check `.gitignore` doesn't hide this file: a bare
 * `uploads` rule (meant for EmDash's local media folder) matches
 * src/pages/wp-content/uploads/ too (gotcha E2). Anchor it as `/uploads`.
 */
import type { APIRoute } from "astro";
import { env } from "cloudflare:workers";

export const prerender = false;

// One indexed read straight from D1: this route runs for file-like paths,
// which EmDash's middleware skips, so it needs nothing else from EmDash.
const LOOKUP = "SELECT destination FROM _emdash_redirects WHERE source = ? AND enabled = 1 LIMIT 1";

export const GET: APIRoute = async ({ url }) => {
	let path: string;
	try {
		path = decodeURIComponent(url.pathname);
	} catch {
		path = url.pathname;
	}
	const candidates = [
		path,
		path.replace(/-\d+x\d+(\.[a-z0-9]+)$/i, "$1"),
		path.replace(/-\d+x\d+(\.[a-z0-9]+)$/i, "-scaled$1"),
	];

	for (const source of [...new Set(candidates)]) {
		const row = await env.DB.prepare(LOOKUP).bind(source).first<{ destination: string | null }>();
		if (row?.destination?.startsWith("/")) {
			return new Response(null, {
				status: 301,
				headers: { Location: row.destination, "Cache-Control": "public, max-age=31536000" },
			});
		}
	}
	// An endpoint's 404 still shows the site's HTML 404 page (gotcha D3); this log line is how you tell
	console.log(`uploads: no redirect for ${path}`);
	return new Response("Not found", { status: 404, headers: { "Cache-Control": "public, max-age=3600" } });
};
