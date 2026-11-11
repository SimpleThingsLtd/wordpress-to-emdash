/**
 * Minimal EmDash REST client for the migration scripts.
 *
 * A local dev server accepts the dev-bypass login; a deployed site needs an
 * admin-scope bearer token (EMDASH_TOKEN, from `npx emdash login`).
 *
 * A read-only client (the default for dry runs) refuses any request that
 * could change something: only GET and HEAD go through, plus requests marked
 * { readOnlySafe: true } (the importer's analyze step, which reads the file
 * it's given and changes nothing).
 */

export function createClient({ url, token, readOnly = true, label = "" } = {}) {
	const BASE = String(url ?? "").replace(/\/+$/, "");
	if (!BASE) throw new Error("createClient needs a url");
	const API = `${BASE}/_emdash/api`;
	let cookie = "";

	async function login() {
		if (token || cookie) return;
		const res = await fetch(`${API}/auth/dev-bypass`, { redirect: "manual" });
		const set = res.headers.getSetCookie?.() ?? [];
		cookie = set.map((c) => c.split(";")[0]).join("; ");
		if (!cookie) throw new Error(`Dev bypass login failed at ${BASE} (${res.status}). Is setup complete? A deployed site needs EMDASH_TOKEN.`);
	}

	async function request(path, init = {}) {
		const method = (init.method ?? "GET").toUpperCase();
		if (readOnly && !["GET", "HEAD"].includes(method) && !init.readOnlySafe) {
			throw new Error(`Refusing ${method} ${path}: this is a dry run (read-only client${label ? ` for ${label}` : ""}). Add --apply --target local|staging to write.`);
		}
		await login();
		const { readOnlySafe: _ignored, ...rest } = init;
		const headers = new Headers(rest.headers);
		headers.set("X-EmDash-Request", "1");
		if (token) headers.set("Authorization", `Bearer ${token}`);
		else headers.set("Cookie", cookie);
		if (rest.body && typeof rest.body === "string" && !headers.has("Content-Type")) headers.set("Content-Type", "application/json");
		const res = await fetch(`${API}${path}`, { ...rest, headers });
		if (!res.ok) {
			const text = await res.text();
			throw new Error(`${method} ${path} -> ${res.status}: ${text.slice(0, 600)}`);
		}
		return res;
	}

	async function api(path, init) {
		const body = await (await request(path, init)).json();
		return body?.data ?? body;
	}

	/** Every item of a cursor-paginated admin list (/media, /redirects, /admin/bylines …). */
	async function* listPages(path, params = {}) {
		let cursor;
		do {
			const qs = new URLSearchParams({ limit: "100", ...params, ...(cursor ? { cursor } : {}) });
			const page = await api(`${path}?${qs}`);
			yield* page.items ?? [];
			cursor = page.nextCursor;
		} while (cursor);
	}

	/** Iterate every item in a collection (summary rows). */
	const listAll = (collection, params = {}) => listPages(`/content/${collection}`, params);

	/** All of a paginated list as an array. */
	async function collect(path, params) {
		const out = [];
		for await (const x of listPages(path, params)) out.push(x);
		return out;
	}

	return { base: BASE, readOnly, login, request, api, listAll, listPages, collect };
}
