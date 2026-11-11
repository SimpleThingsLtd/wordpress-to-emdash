/**
 * Guard EmDash's first-run setup on a public deployment (gotcha D7).
 *
 * Until an admin exists, whoever completes the setup wizard becomes the
 * admin. When the SETUP_KEY secret is set, the setup API only accepts writes
 * from a browser that opened the wizard with ?setup_key=<SETUP_KEY>.
 * Reads stay open so the admin can always check whether setup is needed.
 *
 *   npx wrangler secret put SETUP_KEY        # a long random string
 *   open https://<staging>/_emdash/admin?setup_key=<the same string>
 *
 * If the site already has a src/middleware.ts, merge this handler into it
 * (Astro's sequence() from "astro:middleware" chains several).
 */
import { defineMiddleware } from "astro:middleware";
import { env } from "cloudflare:workers";

const COOKIE = "emdash_setup_key";

export const onRequest = defineMiddleware(async (context, next) => {
	const key = (env as unknown as { SETUP_KEY?: string }).SETUP_KEY;
	if (!key) return next();

	const { pathname, searchParams } = context.url;
	const offered = searchParams.get("setup_key");
	if (offered && pathname.startsWith("/_emdash/admin") && offered === key) {
		context.cookies.set(COOKIE, key, {
			path: "/_emdash",
			httpOnly: true,
			secure: true,
			sameSite: "strict",
			maxAge: 60 * 60,
		});
	}

	if (pathname.startsWith("/_emdash/api/setup") && context.request.method !== "GET") {
		const cookie = context.cookies.get(COOKIE)?.value;
		if (cookie !== key) {
			return Response.json(
				{ error: { code: "SETUP_LOCKED", message: "Open the setup link you were given to finish setup." } },
				{ status: 403 },
			);
		}
	}
	return next();
});
