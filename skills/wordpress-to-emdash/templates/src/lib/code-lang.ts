/**
 * Works out what language a code block is in (gotcha A7). Imported
 * WordPress blocks rarely carry one, so this reads the code itself. A
 * language set on the block in the admin always wins.
 *
 * The order of the checks matters (see references/rendering.md). Test it
 * against every real code block in your import and adjust: the first
 * version of this misread 9 of 113 blocks on the site it was written for.
 *
 * "text" means no highlighting; "output" is terminal output or logs, shown
 * as text but labelled as output.
 */

export type CodeLang =
	| "bash"
	| "css"
	| "html"
	| "javascript"
	| "tsx"
	| "php"
	| "nginx"
	| "toml"
	| "yaml"
	| "json"
	| "sql"
	| "diff"
	| "text"
	| "output";

/** What the block's header calls each language */
export const LANG_LABEL: Record<CodeLang, string> = {
	bash: "Shell",
	css: "CSS",
	html: "HTML",
	javascript: "JavaScript",
	tsx: "TypeScript",
	php: "PHP",
	nginx: "nginx",
	toml: "TOML",
	yaml: "YAML",
	json: "JSON",
	sql: "SQL",
	diff: "Diff",
	text: "Text",
	output: "Output",
};

const ALIASES: Record<string, CodeLang> = {
	sh: "bash",
	shell: "bash",
	shellscript: "bash",
	zsh: "bash",
	console: "bash",
	bash: "bash",
	css: "css",
	scss: "css",
	html: "html",
	markup: "html",
	xml: "html",
	svg: "html",
	js: "javascript",
	javascript: "javascript",
	jsx: "tsx",
	ts: "tsx",
	typescript: "tsx",
	tsx: "tsx",
	php: "php",
	nginx: "nginx",
	toml: "toml",
	ini: "toml",
	yaml: "yaml",
	yml: "yaml",
	json: "json",
	sql: "sql",
	diff: "diff",
	text: "text",
	plaintext: "text",
	txt: "text",
	output: "output",
	log: "output",
};

const SHELL_COMMANDS =
	/^(sudo|apt(-get)?|add-apt-repository|brew|git|npm|npx|yarn|pnpm|node|docker(-compose)?|kubectl|mkdir|cd|ls|cp|mv|rm|rsync|chown|chmod|nano|vim?|cat|echo|export|source|curl|wget|tar|unzip|make|go|geth|ssh(-keygen|-add)?|scp|eval|perl|python3?|pip3?|bash|sh|mount|umount|systemctl|service|journalctl|grep|sed|awk|ln|touch|df|du|htop|top|ps|kill|crontab|wp|composer|php|mysql|mysqldump|psql|openssl|certbot|nginx|history|which)\b/;

function share(lines: string[], test: (line: string) => boolean) {
	return lines.length ? lines.filter(test).length / lines.length : 0;
}

export function normaliseLang(language: string | null | undefined): CodeLang | null {
	if (!language) return null;
	return ALIASES[language.trim().toLowerCase()] ?? null;
}

export function detectLang(code: string): CodeLang {
	const text = code.trim();
	if (!text) return "text";
	const lines = text.split("\n").map((l) => l.trim()).filter(Boolean);
	const first = lines[0];

	if (lines.some((l) => /^\$ \S/.test(l))) return "bash";

	if (/^<\?php/.test(text) || /\$_(SERVER|GET|POST|REQUEST)\b|\bdefine\(\s*['"]|\badd_(action|filter)\(|\barray\(/.test(text)) return "php";

	// JSX or TypeScript before HTML: a component file can start with markup
	if (/^import .+ from ['"]|\buse(State|Effect|Ref|Memo|Callback)\(|\bexport (default )?function\b|:\s*(string|number|boolean|Blob|Promise<[^>]+>)\b/m.test(text)) return "tsx";
	if (/^\/\/.*\n\s*</.test(text) && /\{[a-zA-Z]+\}/.test(text)) return "tsx";

	if (/^<(!DOCTYPE|[a-zA-Z][\w-]*)[\s>/]/.test(first) || /^<\/?[a-z]/.test(first)) return "html";

	if (/^\s*[{[]/.test(text) && /"\s*:\s*/.test(text)) {
		try {
			JSON.parse(text);
			return "json";
		} catch {}
	}

	if (share(lines, (l) => /^(location|server|upstream|proxy_\w+|add_header|listen|root|index|fastcgi_\w+|try_files|rewrite|return)\b/.test(l) || l === "}") >= 0.5) return "nginx";

	const cssRule = /^\s*[@.#]?[\w-]+(\s*[:>+~,]\s*[\w-]+(\([\w-]*\))?)*\s*\{/m.test(text);
	const cssDecl = /(^|[{;]\s*)[\w-]+\s*:\s*[^;{}]+;/m.test(text);
	if (cssRule && cssDecl && !/\bfunction\b|=>/.test(text)) return "css";

	// Keywords as declarations, so a path like /var/run doesn't count
	if (/(^|[\s;(])(var|let|const)\s+[\w$[{]|\bfunction\s*[\w$]*\s*\(|console\.\w+\(|\.indexOf\(|document\.|window\.|\$\(['"]/m.test(text) && /[;{}()]/.test(text)) return "javascript";

	// Terminal output, errors and logs
	const looksLikeOutput = (l: string) =>
		/\b(ERRO|ERROR|WARN|fatal|Error|error):?|No such file|Permission denied|Could not|failed|CONTAINER ID|^Code \d+:|^>\s|^\[\w+\]|^\w{3} \d{1,2} \d\d:\d\d|^[A-Z][A-Z ]{3,}$/.test(l);
	if (/^(CONTAINER ID|NAME\s+READY|PID\s)/.test(first) || share(lines, looksLikeOutput) >= 0.5) return "output";

	if (share(lines, (l) => /^\[[\w.\-]+\]$/.test(l) || /^[\w.\-]+\s*=\s*\S/.test(l) || l.startsWith("#")) >= 0.8 && lines.some((l) => l.includes("=")) && !lines.some((l) => /\\$/.test(l))) return "toml";

	if (share(lines, (l) => /^-?\s*[\w.\-]+:(\s+\S.*)?$/.test(l) && !/[;{}]$/.test(l)) >= 0.8 && !/^\w+:\/\//.test(first)) return "yaml";

	if (/^(SELECT|INSERT|UPDATE|DELETE|CREATE|ALTER|DROP)\b/i.test(first)) return "sql";
	if (share(lines, (l) => /^[+\-@ ]/.test(l)) >= 0.8 && lines.some((l) => l.startsWith("@@"))) return "diff";

	// Shell: prompts, known commands, ./scripts, env assignments, line continuations
	const shellish = (l: string) =>
		/^\$ /.test(l) || SHELL_COMMANDS.test(l) || /^\.{1,2}\/\S/.test(l) || /^\/[\w./-]+\s+-{1,2}\w/.test(l) || /^[A-Z_][A-Z0-9_]*=\S*/.test(l) || /\\$/.test(l) || /^#{1,2}\s?\S/.test(l);
	if (share(lines, shellish) >= 0.5) return "bash";

	return "text";
}

/** The language to use for a block: the one set in the admin, else a guess */
export function langFor(code: string, language?: string | null): CodeLang {
	return normaliseLang(language) ?? detectLang(code);
}
