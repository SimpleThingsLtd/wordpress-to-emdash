/**
 * A short-lived stand-in for the EmDash Exporter plugin's comments endpoint.
 *
 * EmDash's only import path that keeps a comment's date, threading and status
 * is the exporter import (POST /_emdash/api/import/wordpress-plugin/execute,
 * phase "comments"). It fetches GET <url>/wp-json/emdash/v1/comments from a
 * public address (its SSRF guard refuses localhost and private networks). So
 * this serves the filtered comments in the exporter's format on 127.0.0.1,
 * behind a random Basic token, and publishes it for the length of the run
 * through a Cloudflare quick tunnel (`cloudflared`, no account needed), or
 * through a tunnel you run yourself (--feed-url, pointed at --feed-port).
 * Everything stops when the import finishes, also on failure.
 */
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import http from "node:http";

const DOH = "https://cloudflare-dns.com/dns-query";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Serve `items` (exporter-format comments) and expose them publicly.
 * Returns { url, token, requests, close }.
 */
export async function startFeed(items, { pageSize = 100, publicUrl = null, port = 0, log = console.log } = {}) {
	const token = Buffer.from(`import:${randomBytes(24).toString("base64url")}`).toString("base64");
	const pages = Math.max(1, Math.ceil(items.length / pageSize));
	const requests = [];

	const server = http.createServer((req, res) => {
		const u = new URL(req.url, "http://feed.local");
		const route = u.searchParams.get("rest_route") ?? u.pathname.replace(/^.*?\/wp-json/, "");
		const ok = req.headers.authorization === `Basic ${token}`;
		requests.push({ path: u.pathname, page: u.searchParams.get("page"), ok });
		res.setHeader("Content-Type", "application/json");
		res.setHeader("Cache-Control", "no-store");
		if (!ok) {
			res.statusCode = 401;
			return res.end(JSON.stringify({ code: "rest_forbidden" }));
		}
		if (route.replace(/\/+$/, "") !== "/emdash/v1/comments") {
			res.statusCode = 404;
			return res.end(JSON.stringify({ code: "rest_no_route" }));
		}
		const page = Math.max(1, Number(u.searchParams.get("page")) || 1);
		const slice = items.slice((page - 1) * pageSize, page * pageSize);
		res.end(JSON.stringify({ items: slice, total: items.length, pages, page, per_page: pageSize }));
	});
	await new Promise((resolve, reject) => {
		server.once("error", reject);
		server.listen(Number(port) || 0, "127.0.0.1", resolve);
	});
	const local = `http://127.0.0.1:${server.address().port}`;

	let tunnel = null;
	const close = async () => {
		if (tunnel && tunnel.exitCode === null) {
			tunnel.kill("SIGTERM");
			await Promise.race([new Promise((r) => tunnel.once("exit", r)), sleep(3000)]);
			if (tunnel.exitCode === null) tunnel.kill("SIGKILL");
		}
		await new Promise((r) => server.close(r));
		server.closeAllConnections?.();
	};

	try {
		let url = publicUrl?.replace(/\/+$/, "");
		if (!url) {
			log(`feed: ${items.length} comments on ${local}; opening a Cloudflare quick tunnel (cloudflared)…`);
			tunnel = spawn("cloudflared", ["tunnel", "--no-autoupdate", "--url", local], { stdio: ["ignore", "pipe", "pipe"] });
			url = await new Promise((resolve, reject) => {
				const timer = setTimeout(() => reject(new Error("cloudflared printed no tunnel URL within 60s")), 60_000);
				const onData = (chunk) => {
					const m = String(chunk).match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com/);
					if (m) {
						clearTimeout(timer);
						resolve(m[0]);
					}
				};
				tunnel.stdout.on("data", onData);
				tunnel.stderr.on("data", onData);
				tunnel.once("error", (err) => {
					clearTimeout(timer);
					reject(err.code === "ENOENT" ? new Error("cloudflared isn't installed (brew install cloudflared), or pass --feed-url with your own tunnel to --feed-port") : err);
				});
				tunnel.once("exit", (code) => {
					clearTimeout(timer);
					reject(new Error(`cloudflared exited (${code}) before the tunnel was up`));
				});
			});
		} else {
			log(`feed: ${items.length} comments on ${local}, expected at ${url}`);
		}
		await waitForDns(new URL(url).hostname, log);
		return { url, token, requests, close };
	} catch (err) {
		await close();
		throw err;
	}
}

/**
 * Wait until the tunnel's hostname resolves over DNS-over-HTTPS, the way
 * EmDash's SSRF guard resolves it. (Asking the system resolver too early makes
 * macOS cache the miss for a minute or more.)
 */
async function waitForDns(hostname, log, timeoutMs = 180_000) {
	const start = Date.now();
	let said = false;
	while (Date.now() - start < timeoutMs) {
		try {
			const res = await fetch(`${DOH}?name=${encodeURIComponent(hostname)}&type=A`, { headers: { Accept: "application/dns-json" } });
			const body = await res.json();
			if (body.Answer?.some((a) => a.type === 1)) {
				await sleep(2000);
				return;
			}
		} catch {}
		if (!said) {
			log(`feed: waiting for ${hostname} to resolve…`);
			said = true;
		}
		await sleep(3000);
	}
	throw new Error(`${hostname} didn't resolve within ${timeoutMs / 1000}s`);
}
