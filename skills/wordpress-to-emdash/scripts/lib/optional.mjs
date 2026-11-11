/**
 * Optional tools. None of them is a dependency: each loader returns null when
 * the package isn't installed, and the caller skips that step with a message.
 *
 * Playwright drives headless Chrome for the audit's page analysis, live embed
 * checks, screenshots and fix-content's self-check. It's looked for in the
 * project's node_modules, then in paths.tools (by default .migration/tools),
 * so the site's package.json can stay as it is:
 *   npm install --prefix .migration/tools playwright-core
 * It launches the system Chrome (channel "chrome"); `npx playwright install
 * chromium` and channel-less launch work too.
 */
import { createRequire } from "node:module";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { CONFIG } from "./config.mjs";

async function importFrom(spec) {
	// The project's own node_modules first, then the tools folder
	for (const base of [join(CONFIG.paths.root, "package.json"), join(CONFIG.paths.tools, "package.json")]) {
		try {
			const req = createRequire(base);
			return await import(pathToFileURL(req.resolve(spec)).href);
		} catch {}
	}
	try {
		return await import(spec);
	} catch {}
	return null;
}

export const PLAYWRIGHT_HINT = `Install it outside the site's dependencies with: npm install --prefix ${CONFIG.paths.tools} playwright-core`;

/** Playwright's module (with .chromium), or null. */
export async function loadPlaywright() {
	for (const spec of ["playwright", "playwright-core"]) {
		const mod = await importFrom(spec);
		if (mod) return mod.chromium ? mod : mod.default;
	}
	return null;
}

/** Headless Chrome: the system Chrome when present, else Playwright's own Chromium. */
export async function launchBrowser(pw) {
	try {
		return await pw.chromium.launch({ channel: "chrome", headless: true });
	} catch (err) {
		try {
			return await pw.chromium.launch({ headless: true });
		} catch {
			throw err;
		}
	}
}

/** sharp (for side-by-side screenshots), or null. */
export async function loadSharp() {
	const mod = await importFrom("sharp");
	return mod ? (mod.default ?? mod) : null;
}

/** The Gutenberg converter (parseGutenbergBlocks, parseInlineContent), or a clear error. */
export async function loadConverter() {
	const mod = await importFrom("@emdash-cms/gutenberg-to-portable-text");
	if (!mod) throw new Error("@emdash-cms/gutenberg-to-portable-text isn't installed. It ships with EmDash's WordPress importer; add it as a dev dependency (pnpm add -D @emdash-cms/gutenberg-to-portable-text).");
	return mod;
}

/** Resolve a package the converter depends on (parse5), from the converter's own location. */
export async function loadFromConverter(spec) {
	for (const base of [join(CONFIG.paths.root, "package.json"), join(CONFIG.paths.tools, "package.json")]) {
		try {
			const conv = createRequire(base).resolve("@emdash-cms/gutenberg-to-portable-text");
			return await import(pathToFileURL(createRequire(conv).resolve(spec)).href);
		} catch {}
	}
	const mod = await importFrom(spec);
	if (!mod) throw new Error(`Couldn't load ${spec} (a dependency of @emdash-cms/gutenberg-to-portable-text). Install the converter in the site first.`);
	return mod;
}
