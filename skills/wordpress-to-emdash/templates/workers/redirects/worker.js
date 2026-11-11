/**
 * Redirects every request to SITE (the final domain), keeping the path and query.
 * Attach the hostnames that should point at the site: www, and the staging host
 * once the site has moved (gotcha D16).
 *
 * A Worker of its own because the site's Worker has Workers Cache in front of it,
 * and that cache isn't keyed by hostname: on a cache hit the site's Worker never
 * runs, so a redirect inside it only happens on misses.
 * GET and HEAD get a 301; anything else a 308, so API clients keep their method.
 */
export default {
	fetch(request, env) {
		const url = new URL(request.url);
		const to = new URL(url.pathname + url.search, env.SITE);
		const status = request.method === "GET" || request.method === "HEAD" ? 301 : 308;
		return new Response(null, { status, headers: { Location: to.href, "Cache-Control": "public, max-age=3600" } });
	},
};
