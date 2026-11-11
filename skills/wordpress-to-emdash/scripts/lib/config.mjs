/**
 * migration.config.json: every site-specific value the migration scripts use.
 *
 * Loaded once per process, when this module is first imported:
 *   1. `--config <path>` on the command line, else
 *   2. the MIGRATION_CONFIG environment variable, else
 *   3. the nearest migration.config.json from the working directory upward.
 *
 * A config can extend another ("extends": "../base.json"); objects merge key by
 * key, arrays and plain values replace. Relative paths under "paths" resolve
 * against the file that sets them. Keys starting with "//" or "$" are ignored,
 * so a config can carry notes.
 *
 * Every key and its default is documented in references/configuration.md.
 */
import { existsSync, readFileSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";

export const DEFAULTS = {
	site: { name: "", locale: undefined, timeZone: undefined },
	sites: { wordpress: "", staging: "", final: "", local: "http://localhost:4321" },
	paths: {
		root: null,
		work: ".migration",
		wxr: null,
		compare: null,
		compareCache: null,
		fixes: null,
		decisions: null,
		tools: null,
		wpIds: "src/lib/wp-ids.json",
	},
	d1: { database: "" },
	content: {
		postTypes: { post: "posts", page: "pages" },
		entryPath: "/{slug}/",
		bylineCollections: null,
	},
	import: {
		importMenus: false,
		importSiteTitle: false,
		importLogo: false,
		importSeo: true,
		skipExisting: true,
		mediaBatchSize: 5,
	},
	wordpress: {
		extraPostTypes: [],
		sitemap: "/sitemap_index.xml",
		selectors: {
			content: ".entry-content",
			ignore: ".sharedaddy, .jp-relatedposts, #jp-post-flair, .jetpack-likes-widget-wrapper, .wpcnt",
		},
	},
	newSite: {
		sitemap: "/sitemap.xml",
		sections: [],
		categoryBase: "category",
		tagBase: "tag",
		selectors: {
			content: ["article .prose", ".prose"],
			title: ["h1"],
			date: "article time[datetime]",
			categories: null,
			tags: null,
			featured: null,
			isPost: null,
			ignore: ".code__bar",
		},
	},
	urls: {
		oldPermalinkBases: [],
		replacedPages: {},
		listingPages: {},
		acceptedRedirects: {},
		authorArchiveTarget: null,
	},
	audit: {
		searchTerm: "test",
		permalinkSamples: 10,
		idSamples: 18,
		uploadSamples: 20,
		resizedSamples: 5,
		attachmentPageSamples: 6,
		extraUrlTests: [],
		knownNoise: [],
		commentsAccepted: null,
		shots: 10,
	},
	linkPosts: {
		enabled: false,
		collection: "posts",
		field: "link_url",
		trailerBeforeLink: "—\\s*Read on\\s*$",
		trailerWords: ["Read on", "Read it on"],
		category: null,
		newSiteSelector: null,
		expandShorteners: true,
		shorteners: ["ift.tt", "bit.ly", "t.co", "goo.gl", "ow.ly", "buff.ly", "j.mp", "tinyurl.com"],
	},
	bylines: { merge: [] },
	redirects: { rules: [], group: "wordpress", uploadsGroup: "wp-uploads" },
	fixes: {
		waybackTimestamp: "2014",
		unpublish: {},
		shortcodes: {
			layout: ["one_half", "one_half_last", "one_third", "one_third_last", "two_third", "two_third_last", "one_fourth", "one_fourth_last", "three_fourth", "three_fourth_last", "box"],
			button: ["button"],
		},
	},
	http: {
		userAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0 Safari/537.36 wordpress-to-emdash",
		concurrency: { wordpress: 4, new: 12, external: 4 },
	},
};

const isObj = (v) => v && typeof v === "object" && !Array.isArray(v);

function stripNotes(v) {
	if (Array.isArray(v)) return v.map(stripNotes);
	if (!isObj(v)) return v;
	const out = {};
	for (const [k, x] of Object.entries(v)) if (!k.startsWith("//") && !k.startsWith("$")) out[k] = stripNotes(x);
	return out;
}

export function deepMerge(base, over) {
	if (!isObj(base) || !isObj(over)) return over === undefined ? base : over;
	const out = { ...base };
	for (const [k, v] of Object.entries(over)) out[k] = isObj(v) && isObj(base[k]) ? deepMerge(base[k], v) : v;
	return out;
}

/** --config <path>, MIGRATION_CONFIG, or the nearest migration.config.json upward. */
function locate(argv = process.argv.slice(2)) {
	const i = argv.indexOf("--config");
	if (i >= 0) {
		const p = argv[i + 1];
		if (!p || p.startsWith("--")) throw new Error("--config needs a path");
		return resolve(p);
	}
	if (process.env.MIGRATION_CONFIG) return resolve(process.env.MIGRATION_CONFIG);
	let dir = process.cwd();
	for (;;) {
		const f = join(dir, "migration.config.json");
		if (existsSync(f)) return f;
		const up = dirname(dir);
		if (up === dir) return null;
		dir = up;
	}
}

/** One file, with its base merged under it; paths resolved against their own file. */
function readLayer(file, seen = new Set()) {
	if (seen.has(file)) throw new Error(`Config "extends" loop at ${file}`);
	seen.add(file);
	let raw;
	try {
		raw = stripNotes(JSON.parse(readFileSync(file, "utf8")));
	} catch (err) {
		throw new Error(`Couldn't read ${file}: ${err.message}`);
	}
	const dir = dirname(file);
	if (isObj(raw.paths)) {
		for (const [k, v] of Object.entries(raw.paths)) if (typeof v === "string" && v && !isAbsolute(v)) raw.paths[k] = resolve(dir, v);
	}
	let base = { __root: dir };
	if (raw.extends) {
		const parent = resolve(dir, raw.extends);
		base = readLayer(parent, seen);
	}
	const { extends: _ignored, ...rest } = raw;
	return deepMerge(base, rest);
}

const trimSlash = (s) => String(s ?? "").replace(/\/+$/, "");
const hostOf = (u) => {
	try {
		return new URL(u).hostname.toLowerCase();
	} catch {
		return "";
	}
};

function finish(merged, file) {
	const c = deepMerge(DEFAULTS, merged);
	const root = c.paths.root ? resolve(c.paths.root) : merged.__root ?? process.cwd();
	delete c.__root;
	const p = { ...c.paths, root };
	const abs = (v) => (v ? (isAbsolute(v) ? v : resolve(root, v)) : v);
	p.work = abs(p.work);
	p.wxr = abs(p.wxr) ?? join(p.work, "site.wxr.xml");
	p.compare = abs(p.compare) ?? join(p.work, "compare");
	p.compareCache = abs(p.compareCache) ?? join(p.work, "compare-cache");
	p.fixes = abs(p.fixes) ?? join(p.work, "fixes");
	p.decisions = abs(p.decisions) ?? join(p.fixes, "decisions.json");
	p.tools = abs(p.tools) ?? join(p.work, "tools");
	p.wpIds = abs(p.wpIds);
	c.paths = p;

	for (const k of Object.keys(c.sites)) c.sites[k] = trimSlash(c.sites[k]);
	c.sites.final ||= c.sites.wordpress;
	const wpHost = hostOf(c.sites.wordpress);
	const bare = wpHost.replace(/^www\./, "");
	c.hosts = {
		wordpress: new Set(wpHost ? [bare, `www.${bare}`] : []),
		staging: hostOf(c.sites.staging),
		final: hostOf(c.sites.final),
	};
	c.collections = [...new Set(Object.values(c.content.postTypes))];
	c.content.bylineCollections ??= c.collections;
	c.file = file;
	return c;
}

// Keys whose children are the user's own names (slugs, paths, post types), not settings
const MAPS = new Set(["content.postTypes", "urls.replacedPages", "urls.listingPages", "urls.acceptedRedirects", "fixes.unpublish"]);

/** Keys the toolkit doesn't know: almost always a typo, so say so (to stderr) instead of ignoring them. */
export function unknownKeys(layer, defaults = DEFAULTS, prefix = "") {
	const out = [];
	for (const [k, v] of Object.entries(layer ?? {})) {
		const path = prefix ? `${prefix}.${k}` : k;
		if (!prefix && (k === "__root" || k === "extends")) continue;
		if (!(k in (defaults ?? {}))) out.push(path);
		else if (isObj(v) && isObj(defaults[k]) && !MAPS.has(path)) out.push(...unknownKeys(v, defaults[k], path));
	}
	return out;
}

function load() {
	const file = locate();
	if (!file) return { ...finish({}, null), missing: true };
	if (!existsSync(file)) throw new Error(`Config file not found: ${file}`);
	const merged = readLayer(file);
	const unknown = unknownKeys(merged);
	if (unknown.length) console.warn(`${file}: unknown key${unknown.length > 1 ? "s" : ""} ignored: ${unknown.join(", ")} (see references/configuration.md)`);
	return finish(merged, file);
}

/** The loaded config. `CONFIG.missing` is true when no file was found. */
export const CONFIG = load();

/** Fail early, with a pointer to the docs, when a script needs a key that isn't set. */
export function requireConfig(...keys) {
	if (CONFIG.missing) {
		throw new Error("No migration.config.json found. Copy migration.config.example.json to your project root (see references/configuration.md), or pass --config <path>.");
	}
	const missing = keys.filter((k) => {
		const v = k.split(".").reduce((o, part) => o?.[part], CONFIG);
		return v === undefined || v === null || v === "";
	});
	if (missing.length) throw new Error(`${CONFIG.file} needs: ${missing.join(", ")} (see references/configuration.md)`);
	return CONFIG;
}

// ------------------------------------------------------------ helpers

/** True for the WordPress host, with or without www. */
export const isWordPressHost = (host) => CONFIG.hosts.wordpress.has(String(host ?? "").toLowerCase());

/** Regex source matching the WordPress origin, with or without www and either scheme. */
export function wordpressHostPattern() {
	const bare = [...CONFIG.hosts.wordpress][0] ?? "";
	return `(?:www\\.)?${bare.replace(/^www\./, "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`;
}

/** An entry's path on both sites (the toolkit assumes WordPress paths are kept). */
export function entryPath(slug, collection = "posts") {
	return CONFIG.content.entryPath.replace("{slug}", slug).replace("{collection}", collection);
}

/** WXR post type → EmDash collection, and back. */
export const collectionFor = (wpType) => CONFIG.content.postTypes[wpType] ?? null;
export const wpTypeFor = (collection) => Object.entries(CONFIG.content.postTypes).find(([, c]) => c === collection)?.[0] ?? null;

/** Built from linkPosts.trailerWords: matches "— Read on <link text>" at the end of a line. */
export function linkTrailerLine() {
	if (!CONFIG.linkPosts.enabled) return null;
	const words = CONFIG.linkPosts.trailerWords.map((w) => w.trim().split(/\s+/).map(escapeRe).join(" ")).join("|");
	return new RegExp(`\\s*(?:—|–|-{1,2})?\\s*(?:${words})\\s+\\S.*$`, "i");
}

/** The same trailer with whitespace removed (for skeleton text comparisons). */
export function linkTrailerSkeleton() {
	if (!CONFIG.linkPosts.enabled) return null;
	const words = CONFIG.linkPosts.trailerWords.map((w) => escapeRe(w.replace(/\s+/g, ""))).join("|");
	return new RegExp(`^(?:—|–|-)*(?:${words})`, "i");
}

export const escapeRe = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
