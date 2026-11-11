/**
 * WordPress stores [ and ] in code as &#91; and &#93; so its shortcode
 * parser leaves them alone. The renderer already shows "[ ]"; this fixes
 * the stored text so search, copy and the editor see real brackets.
 */
import { clone } from "../pt.mjs";

const ESC = /&#(?:91|93|x5b|x5d);/gi;
const DECODE = { "&#91;": "[", "&#93;": "]", "&#x5b;": "[", "&#x5d;": "]" };

export default {
	id: "brackets",
	label: "Escaped brackets (&#91; &#93;) in code blocks",
	order: 2,
	run(entry, content) {
		let count = 0;
		const items = [];
		const next = content.map((b) => {
			if (b._type !== "code" || !ESC.test(b.code ?? "")) return b;
			ESC.lastIndex = 0;
			const n = (b.code.match(ESC) ?? []).length;
			count += n;
			const nb = clone(b);
			nb.code = b.code.replace(ESC, (m) => DECODE[m.toLowerCase()]);
			items.push({ kind: "brackets", summary: `${n} escaped bracket${n > 1 ? "s" : ""} decoded in a code block`, confidence: "high", count: n });
			return nb;
		});
		ESC.lastIndex = 0;
		return count ? { content: next, items } : null;
	},
};
