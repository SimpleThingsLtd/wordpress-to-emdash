/**
 * Command-line helpers shared by the scripts: argument parsing and the
 * dry-run / apply / target rules.
 *
 * Every script that writes is a dry run unless it gets --apply, and --apply
 * needs an explicit --target local|staging. Reads go to the same target
 * (local by default). EMDASH_URL, when set, overrides the target's URL;
 * staging always needs EMDASH_TOKEN (an admin-scope token from `emdash login`).
 */
import { CONFIG } from "./config.mjs";
import { createClient } from "./emdash-api.mjs";

/**
 * Parse argv. `values` lists the options that take a value, so their values
 * aren't mistaken for positional arguments. --config is always one.
 */
export function parseArgs(values = [], argv = process.argv.slice(2)) {
	const takes = new Set(["config", ...values]);
	const flags = new Set();
	const options = new Map();
	const positional = [];
	for (let i = 0; i < argv.length; i++) {
		const a = argv[i];
		if (!a.startsWith("--")) {
			positional.push(a);
			continue;
		}
		const [name, inline] = a.slice(2).split(/=(.*)/s, 2);
		if (inline !== undefined) options.set(name, inline);
		else if (takes.has(name)) {
			const v = argv[i + 1];
			if (v === undefined || v.startsWith("--")) throw new Error(`--${name} needs a value`);
			options.set(name, v);
			i++;
		} else flags.add(name);
	}
	const opt = (n, d) => options.get(n) ?? d;
	return {
		flag: (n) => flags.has(n),
		opt,
		list: (n) => {
			const v = opt(n);
			return v ? v.split(",").map((s) => s.trim()).filter(Boolean) : null;
		},
		positional,
		flags,
		options,
	};
}

/**
 * Where to read and (with --apply) write. Returns { target, url, token, apply }.
 * --apply without --target is refused, as is --target staging without a token.
 */
export function resolveTarget(args, { needsApi = true } = {}) {
	const apply = args.flag("apply");
	if (apply && args.flag("dry-run")) throw new Error("--apply and --dry-run together: pick one");
	const target = args.opt("target", apply ? null : "local");
	if (apply && !target) throw new Error("--apply needs --target local or --target staging");
	if (!["local", "staging"].includes(target)) throw new Error(`--target must be local or staging (got "${target}")`);
	const configured = target === "staging" ? CONFIG.sites.staging : CONFIG.sites.local;
	const url = (process.env.EMDASH_URL ?? configured ?? "").replace(/\/+$/, "");
	if (needsApi && !url) throw new Error(`No URL for --target ${target}: set sites.${target} in migration.config.json or EMDASH_URL`);
	const token = process.env.EMDASH_TOKEN;
	if (needsApi && target === "staging" && !token) throw new Error("--target staging needs EMDASH_TOKEN (an admin-scope API token from `npx emdash login`)");
	return { target, url, token, apply };
}

/** An API client for the target: read-only unless --apply. */
export function clientFor(t) {
	return createClient({ url: t.url, token: t.token, readOnly: !t.apply, label: t.target });
}

/** One line saying what this run will and won't do. */
export function announce(t, what) {
	const mode = t.apply ? "APPLY" : "dry run (nothing is written; add --apply --target local|staging to write)";
	console.log(`${what}: ${t.url} (${t.target}), ${mode}`);
}
