#!/usr/bin/env node
/**
 * Checks every code-block colour against the block's background, in light
 * and dark mode, for WCAG AA (4.5:1). The palette is read from the file that
 * defines it (by default src/components/pt/CodeBlock.astro, from the working
 * directory), so this stays true as colours change.
 *
 *   node scripts/check-code-contrast.mjs [path/to/file.astro|.css] [--file path]
 *
 * It reads declarations of the form
 *   --code-bg: light-dark(#rrggbb, #rrggbb);   --tok-k: light-dark(#rrggbb, #rrggbb);
 * so point it at the site's theme CSS if you override the palette there.
 * Exits 1 when any colour falls short. No dependencies.
 */
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

const argv = process.argv.slice(2);
const i = argv.indexOf("--file");
const file = resolve(i >= 0 ? argv[i + 1] : (argv.find((a) => !a.startsWith("--")) ?? "src/components/pt/CodeBlock.astro"));
if (!existsSync(file)) {
	console.error(`No palette file at ${file}. Pass the file that defines --code-bg and the --tok-* colours.`);
	process.exit(2);
}
const css = readFileSync(file, "utf8");
const vars = Object.fromEntries([...css.matchAll(/--((?:code|tok)-[\w]+):\s*light-dark\((#[0-9a-f]{6}),\s*(#[0-9a-f]{6})\)/gi)].map((m) => [m[1], [m[2], m[3]]]));
if (!vars["code-bg"]) {
	console.error(`${file} has no "--code-bg: light-dark(#xxxxxx, #xxxxxx)" declaration (six-digit hex colours only).`);
	process.exit(2);
}

const lum = (hex) => {
	const [r, g, b] = [1, 3, 5].map((k) => parseInt(hex.slice(k, k + 2), 16) / 255).map((c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
	return 0.2126 * r + 0.7152 * g + 0.0722 * b;
};
const ratio = (a, b) => {
	const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p);
	return (x + 0.05) / (y + 0.05);
};

const NAMES = { "code-fg": "text", "tok-c": "comment", "tok-k": "keyword / label", "tok-s": "string", "tok-n": "number / flag", "tok-f": "function / command", "tok-t": "tag / type", "tok-a": "attribute / key", "tok-v": "variable", "tok-p": "punctuation", "tok-ins": "diff +", "tok-del": "diff −", "tok-out": "output" };
let failed = 0;
console.log(`${file}\nrole                 light         dark`);
for (const [name, label] of Object.entries(NAMES)) {
	const pair = vars[name];
	if (!pair) continue;
	const row = [0, 1].map((mode) => {
		const r = ratio(pair[mode], vars["code-bg"][mode]);
		if (r < 4.5) failed++;
		return `${r.toFixed(2)}${r < 4.5 ? " ✗" : "  "}`.padEnd(14);
	});
	console.log(`${label.padEnd(20)} ${row.join("")}`);
}
// The language label sits on the header bar
if (vars["code-bar"] && vars["tok-k"]) {
	const bar = [0, 1].map((m) => ratio(vars["tok-k"][m], vars["code-bar"][m]));
	if (bar.some((r) => r < 4.5)) failed++;
	console.log(`${"label on header".padEnd(20)} ${bar.map((r) => `${r.toFixed(2)}${r < 4.5 ? " ✗" : "  "}`.padEnd(14)).join("")}`);
}
if (failed) {
	console.error(`\n${failed} colour(s) under 4.5:1`);
	process.exit(1);
}
console.log("\nEvery colour meets 4.5:1 in both modes.");
