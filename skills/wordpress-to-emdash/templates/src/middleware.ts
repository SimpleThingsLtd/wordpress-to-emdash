/**
 * Two jobs, chained with sequence():
 *  - guard EmDash's first-run setup on a public deployment (gotcha D7);
 *  - purge a post's cached page when its comments are moderated (gotcha A13).
 *
 * The setup guard:
 *
 * Until an admin exists, whoever completes the setup wizard becomes the
 * admin. When the SETUP_KEY secret is set, the setup API only accepts writes
 * from a browser that opened the wizard with ?setup_key=<SETUP_KEY>.
 * Reads stay open so the admin can always check whether setup is needed.
 *
 *   npx wrangler secret put SETUP_KEY        # a long random string
 *   open https://<staging>/_emdash/admin?setup_key=<the same string>
 *
 * If the site already has a src/middleware.ts, add these handlers to its
 * sequence() (from "astro:middleware").
 */
import { defineMiddleware, sequence } from "astro:middleware";
import { env } from "cloudflare:workers";

const COOKIE = "emdash_setup_key";

const setupGuard = defineMiddleware(async (context, next) => {
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

/*
 * Comments and the page cache. EmDash 1.4 doesn't purge cached pages when a
 * comment is approved, unapproved or deleted (1.5 does), so an approved comment
 * would only appear when the post's cached page expired, a day or more later.
 * After a moderation call that changes which comments a post shows, and after a
 * submission that's approved at once (a signed-in editor's), purge the post's
 * tags, [collection, id], as EmDash does on publish. Pending and spam
 * submissions purge nothing, so bots can't use up the purge rate limit
 * (5 a minute per account). Remove this once EmDash is 1.5 or later.
 */
const ADMIN_COMMENT = /^\/_emdash\/api\/admin\/comments\/([^/]+)(\/status)?\/?$/;
const PUBLIC_COMMENT = /^\/_emdash\/api\/comments\/([^/]+)\/([^/]+)\/?$/;

const commentCachePurge = defineMiddleware(async (context, next) => {
	const { pathname } = context.url;
	const method = context.request.method;
	const purge = async (tags: string[]) => {
		const unique = [...new Set(tags.filter(Boolean))];
		if (!unique.length || !context.cache?.enabled) return;
		try {
			await context.cache.invalidate({ tags: unique });
		} catch (err) {
			console.error(`comment cache purge failed for ${unique.join(", ")}`, err);
		}
	};

	const pub = method === "POST" && pathname.match(PUBLIC_COMMENT);
	if (pub) {
		const response = await next();
		if (response.ok) {
			const body = (await response.clone().json().catch(() => null)) as { data?: { status?: string } } | null;
			if (body?.data?.status === "approved") await purge([decodeURIComponent(pub[1]), decodeURIComponent(pub[2])]);
		}
		return response;
	}

	const admin = ["PUT", "POST", "DELETE"].includes(method) && pathname.match(ADMIN_COMMENT);
	if (!admin) return next();
	const bulk = admin[1] === "bulk";
	const body = method === "GET" || method === "DELETE" ? null : ((await context.request.clone().json().catch(() => null)) as { ids?: string[]; action?: string; status?: string } | null);
	const ids = bulk ? (body?.ids ?? []) : [decodeURIComponent(admin[1])];
	if (!ids.length || ids.length > 100) return next();
	// Look the comments up first: a deleted one can't be looked up afterwards
	const db = (env as unknown as { DB: D1Database }).DB;
	const { results } = await db
		.prepare(`SELECT collection, content_id, status FROM _emdash_comments WHERE id IN (${ids.map(() => "?").join(",")})`)
		.bind(...ids)
		.all<{ collection: string; content_id: string; status: string }>();
	const response = await next();
	if (!response.ok || !results.length) return response;
	const becomesApproved = (admin[2] && body?.status === "approved") || (bulk && body?.action === "approve");
	const touched = results.filter((r) => becomesApproved || r.status === "approved");
	await purge(touched.flatMap((r) => [r.collection, r.content_id]));
	return response;
});

export const onRequest = sequence(setupGuard, commentCachePurge);
