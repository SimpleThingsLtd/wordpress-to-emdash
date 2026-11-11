/**
 * EmDash's Worker, plus:
 *  - a page-cache purge each time a new version goes live (gotchas D1, D2);
 *  - on preview hosts (staging, before cutover), media URLs pointed back at the
 *    host serving the page (gotcha D15).
 *  - after cutover, other hostnames (www, the old staging host) redirected to
 *    the site's domain (REDIRECT_HOSTS).
 *
 * Cached HTML outlives a deploy (the Workers cache isn't keyed by version),
 * and it points at hashed /_astro/ files the new deploy no longer has, so
 * stale pages would load unstyled. The first request a new version serves
 * records it in D1 and purges everything; the minute cron sweeps twice more
 * over the next few minutes, for pages old instances cached while the rollout
 * settled.
 *
 * Needs, in wrangler.jsonc:
 *   "main": "./src/worker.ts",
 *   "version_metadata": { "binding": "CF_VERSION_METADATA" },
 *   "triggers": { "crons": ["* * * * *"] },        // EmDash's own tasks use it too
 *   "d1_databases": [{ "binding": "DB", … }]       // EmDash's database
 *   "vars": { "EMDASH_SITE_URL": "https://example.com" }   // the final domain
 *   and at cutover: "REDIRECT_HOSTS": "www.example.com,staging.example.com"
 * then `npx wrangler types` so Env knows both bindings. Add this before the
 * first content deploy.
 */
import handler, { createScheduledHandler, PluginBridge } from "@emdash-cms/cloudflare/worker";

// EmDash's plugin sandbox bridge must stay exported from the custom worker
export { PluginBridge };

// EmDash's scheduled tasks (publishing, plugin jobs, maintenance) still run from the cron
const maintenance = createScheduledHandler();

const SWEEPS = 3;
let checked = false;

async function sweep(env: Env, from: "request" | "cron") {
	const version = env.CF_VERSION_METADATA?.id;
	if (!version) return;
	const db = env.DB;
	const now = Date.now();
	await db
		.prepare("CREATE TABLE IF NOT EXISTS site_deploys (version TEXT PRIMARY KEY, seen_at INTEGER NOT NULL, sweeps INTEGER NOT NULL)")
		.run();
	const first = await db
		.prepare("INSERT OR IGNORE INTO site_deploys (version, seen_at, sweeps) VALUES (?, ?, 1)")
		.bind(version, now)
		.run();
	let purge = first.meta.changes > 0;
	if (!purge && from === "cron") {
		const again = await db
			.prepare("UPDATE site_deploys SET sweeps = sweeps + 1 WHERE version = ? AND sweeps < ? AND seen_at < ?")
			.bind(version, SWEEPS, now - 60_000)
			.run();
		purge = again.meta.changes > 0;
	}
	if (purge) {
		// Imported lazily, as @astrojs/cloudflare's cache provider does
		const { cache } = await import("cloudflare:workers");
		// Local workerd has no page cache to purge
		if (typeof cache?.purge !== "function") return;
		const result = await cache.purge({ purgeEverything: true });
		console.log(`deploy ${version}: purged page cache (${from})`, result.success ? "ok" : result.errors);
	}
}

/*
 * Media on a preview host (gotcha D15).
 *
 * EMDASH_SITE_URL is the final domain, so passkeys and canonical URLs survive
 * cutover. EmDash also uses it to make media URLs absolute (images with stored
 * dimensions go through Astro's <Image>), and until cutover that domain still
 * serves WordPress, where those files 404. When a page is served from any
 * other host, point those media URLs back at the host serving it. After
 * cutover the hosts match and this does nothing.
 */
const MEDIA_ATTRS: Array<[selector: string, attr: string]> = [
	["img[src]", "src"],
	["img[srcset]", "srcset"],
	["source[srcset]", "srcset"],
	["video[poster]", "poster"],
	["a[href]", "href"],
	["[style]", "style"],
];

function previewMedia(request: Request, env: Env, response: Response) {
	const configured = (env as unknown as { EMDASH_SITE_URL?: string }).EMDASH_SITE_URL;
	const site = configured ? new URL(configured).origin : null;
	const here = new URL(request.url).origin;
	if (!site || site === here || !response.headers.get("content-type")?.includes("text/html")) return response;
	const plain = `${site}/_emdash/`;
	const encoded = encodeURIComponent(plain);
	const encodedHere = encodeURIComponent(`${here}/_emdash/`);
	const rewriter = new HTMLRewriter();
	for (const [selector, attr] of MEDIA_ATTRS) {
		rewriter.on(selector, {
			element(el) {
				const value = el.getAttribute(attr);
				if (value && (value.includes(plain) || value.includes(encoded))) {
					el.setAttribute(attr, value.replaceAll(plain, "/_emdash/").replaceAll(encoded, encodedHere));
				}
			},
		});
	}
	return rewriter.transform(response);
}

/*
 * Other hostnames for the site (www, and the staging host once the site has
 * moved to its final domain) 301 to EMDASH_SITE_URL, so search engines see one
 * copy. List them in REDIRECT_HOSTS (comma-separated); set it at cutover, not
 * before, or staging redirects to a domain that still serves WordPress.
 * EmDash's own paths (/_emdash/…) aren't redirected, so the admin, the CLI and
 * API clients keep working on those hosts.
 */
function hostRedirect(request: Request, env: Env): Response | null {
	const vars = env as unknown as { REDIRECT_HOSTS?: string; EMDASH_SITE_URL?: string };
	if (!vars.REDIRECT_HOSTS || !vars.EMDASH_SITE_URL) return null;
	const url = new URL(request.url);
	const hosts = vars.REDIRECT_HOSTS.split(",").map((h) => h.trim().toLowerCase());
	if (!hosts.includes(url.hostname.toLowerCase()) || url.pathname.startsWith("/_emdash/")) return null;
	return Response.redirect(new URL(url.pathname + url.search, vars.EMDASH_SITE_URL).href, 301);
}

export default {
	...handler,
	async fetch(request, env, ctx) {
		if (!checked) {
			checked = true;
			ctx.waitUntil(sweep(env, "request").catch((err) => console.error("deploy sweep failed", err)));
		}
		return hostRedirect(request, env) ?? previewMedia(request, env, await handler.fetch!(request, env, ctx));
	},
	scheduled(controller, env, ctx) {
		ctx.waitUntil(sweep(env, "cron").catch((err) => console.error("deploy sweep failed", err)));
		return maintenance(controller, env, ctx);
	},
} satisfies ExportedHandler<Env>;
