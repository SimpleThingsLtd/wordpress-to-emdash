/**
 * Server-side syntax highlighting with Shiki, using its JavaScript regex
 * engine (no Oniguruma WebAssembly), with each grammar loaded the first time
 * a page needs it.
 *
 * The theme doesn't hold real colours. Each scope is mapped to a role
 * (comment, keyword, string...) and every token is emitted with that role's
 * short class. The colours live in CSS (src/components/pt/CodeBlock.astro)
 * as light-dark() pairs, so light and dark mode, and contrast, are tuned in
 * one place, and the HTML stays small (gotchas A7, D12, D14).
 *
 * Needs `shiki` (pin an exact version at least two weeks old). Only the
 * JavaScript regex engine and the grammars below are bundled, each loaded the
 * first time a page needs it, which keeps the Worker small (gotcha D11).
 */
import { createHighlighterCore, type HighlighterCore, type ThemeRegistration } from "shiki/core";
import { createJavaScriptRegexEngine } from "shiki/engine/javascript";
import type { CodeLang } from "./code-lang";

const GRAMMARS: Partial<Record<CodeLang, () => Promise<unknown>>> = {
	bash: () => import("shiki/langs/bash.mjs"),
	css: () => import("shiki/langs/css.mjs"),
	html: () => import("shiki/langs/html.mjs"),
	javascript: () => import("shiki/langs/javascript.mjs"),
	tsx: () => import("shiki/langs/tsx.mjs"),
	php: () => import("shiki/langs/php.mjs"),
	nginx: () => import("shiki/langs/nginx.mjs"),
	toml: () => import("shiki/langs/toml.mjs"),
	yaml: () => import("shiki/langs/yaml.mjs"),
	json: () => import("shiki/langs/json.mjs"),
	sql: () => import("shiki/langs/sql.mjs"),
	diff: () => import("shiki/langs/diff.mjs"),
};

/** Roles, and the scopes that take them. Order matters: later, more specific rules win. */
const ROLES: Array<[role: string, scopes: string[]]> = [
	["p", ["punctuation", "meta.brace", "keyword.operator", "punctuation.definition.tag"]],
	["v", ["variable.other.normal.shell", "variable.other.php", "variable.parameter", "variable.other.env", "punctuation.definition.variable"]],
	["a", ["entity.other.attribute-name", "support.type.property-name", "meta.object-literal.key", "entity.name.tag.yaml", "support.type.property-name.json", "support.type.property-name.toml", "variable.other.key.toml", "keyword.other.definition.ini"]],
	["t", ["entity.name.tag", "entity.name.type", "entity.name.class", "support.class", "entity.other.inherited-class", "support.type", "entity.other.attribute-name.class.css", "entity.other.attribute-name.id.css", "entity.other.attribute-name.pseudo-class.css", "entity.other.attribute-name.pseudo-element.css"]],
	["f", ["entity.name.function", "support.function", "meta.function-call entity.name.function", "entity.name.command", "support.function.builtin.shell"]],
	["n", ["constant.numeric", "constant.language", "constant.character", "constant.other", "support.constant", "keyword.other.unit", "constant.other.color", "variable.language"]],
	["s", ["string", "string.quoted", "string.template", "string.unquoted", "punctuation.definition.string", "markup.inline.raw", "string.regexp"]],
	["k", ["keyword", "storage", "storage.type", "storage.modifier", "keyword.control", "keyword.operator.new", "keyword.operator.expression", "keyword.other.important", "keyword.other.special-method"]],
	["h", ["entity.name.section", "markup.heading", "support.type.property-name.table.toml", "entity.other.attribute-name.table.toml"]],
	["c", ["comment", "punctuation.definition.comment"]],
	["ins", ["markup.inserted"]],
	["del", ["markup.deleted"]],
];

// One unique placeholder colour per role; tokens are mapped back by colour
const FOREGROUND = "#010101";
const placeholder = (i: number) => `#0000${(i + 16).toString(16).padStart(2, "0")}`;
const ROLE_BY_COLOUR = new Map(ROLES.map(([role], i) => [placeholder(i), role]));

const THEME: ThemeRegistration = {
	name: "code-roles",
	type: "light",
	colors: { "editor.foreground": FOREGROUND, "editor.background": "#ffffff" },
	settings: [
		{ settings: { foreground: FOREGROUND } },
		...ROLES.map(([, scope], i) => ({ scope, settings: { foreground: placeholder(i) } })),
		// Shell arguments stay plain, so only commands, flags and real strings take colour
		{ scope: ["string.unquoted.argument.shell"], settings: { foreground: FOREGROUND } },
	],
};

let highlighter: Promise<HighlighterCore> | undefined;
function getHighlighter() {
	highlighter ??= createHighlighterCore({ themes: [THEME], langs: [], engine: createJavaScriptRegexEngine() });
	return highlighter;
}

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

/** One line of tokens as HTML, merging neighbours that share a role */
function lineHtml(tokens: Array<{ content: string; color?: string }>) {
	let out = "";
	let role: string | undefined;
	let buf = "";
	const flush = () => {
		if (!buf) return;
		out += role ? `<span class="${role}">${esc(buf)}</span>` : esc(buf);
		buf = "";
	};
	for (const t of tokens) {
		const r = ROLE_BY_COLOUR.get((t.color ?? "").toLowerCase());
		if (r !== role) {
			flush();
			role = r;
		}
		buf += t.content;
	}
	flush();
	return out;
}

async function tokenLines(code: string, lang: CodeLang) {
	const load = GRAMMARS[lang];
	if (!load) return null;
	const hl = await getHighlighter();
	const id = lang === "bash" ? "shellscript" : lang;
	if (!hl.getLoadedLanguages().includes(id)) await hl.loadLanguage((await load()) as never);
	// PHP's grammar only highlights inside <?php; snippets usually leave it off
	const wrapPhp = lang === "php" && !/^\s*<\?/.test(code);
	const { tokens } = hl.codeToTokens(wrapPhp ? `<?php\n${code}` : code, { lang: id, theme: "code-roles" });
	return wrapPhp ? tokens.slice(1) : tokens;
}

export type Highlighted = {
	/** Lines as HTML, each wrapped in <span class="line"> and joined with newlines */
	html: string;
	lines: number;
	/** A shell session: "$ " lines are commands, the rest is output */
	session: boolean;
};

export async function highlight(code: string, lang: CodeLang): Promise<Highlighted> {
	const source = code.replace(/\r\n?/g, "\n").replace(/^(\s*\n)+/, "").replace(/\s+$/, "");
	const lines = source.split("\n");

	// A shell session: highlight the commands, show the rest as output, and
	// draw the prompt so it isn't copied
	if (lang === "bash" && lines.some((l) => /^\$ \S/.test(l))) {
		const commands = lines.filter((l) => /^\$ \S/.test(l)).map((l) => l.slice(2));
		const highlighted = (await tokenLines(commands.join("\n"), "bash")) ?? [];
		let n = 0;
		const html = lines
			.map((l) =>
				/^\$ \S/.test(l)
					? `<span class="line" data-cmd><span class="prompt" aria-hidden="true" data-nocopy>$ </span>${lineHtml(highlighted[n++] ?? [])}</span>`
					: `<span class="line out">${esc(l)}</span>`,
			)
			.join("\n");
		return { html, lines: lines.length, session: true };
	}

	const tokens = await tokenLines(source, lang);
	const html = tokens
		? tokens.map((t) => `<span class="line">${lineHtml(t)}</span>`).join("\n")
		: lines.map((l) => `<span class="line">${esc(l)}</span>`).join("\n");
	return { html, lines: lines.length, session: false };
}
