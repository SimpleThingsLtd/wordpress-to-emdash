/**
 * A port of WordPress's wpautop() (wp-includes/formatting.php, WP 6.x).
 *
 * WordPress runs it on every classic-editor post: a blank line becomes a
 * paragraph, a single newline becomes <br />. The importer didn't, so the
 * repair uses this to know where WordPress put each break.
 */

const ALLBLOCKS =
	"(?:table|thead|tfoot|caption|col|colgroup|tbody|tr|td|th|div|dl|dd|dt|ul|ol|li|pre|form|map|area|blockquote|address|style|p|h[1-6]|hr|fieldset|legend|section|article|aside|hgroup|header|footer|nav|figure|figcaption|details|menu|summary)";

/** wp_replace_in_html_tags(): replace inside tags and comments only. */
function replaceInHtmlTags(text, from, to) {
	return text
		.split(/(<!--[\s\S]*?-->|<[^>]*>?)/)
		.map((part, i) => (i % 2 === 1 ? part.split(from).join(to) : part))
		.join("");
}

export function wpautop(input, br = true) {
	if (!input || !input.trim()) return "";
	let text = `${input}\n`;
	const preTags = new Map();

	if (text.includes("<pre")) {
		const parts = text.split("</pre>");
		const last = parts.pop();
		text = "";
		let i = 0;
		for (const part of parts) {
			const start = part.indexOf("<pre");
			if (start === -1) {
				text += part;
				continue;
			}
			const name = `<pre wp-pre-tag-${i}></pre>`;
			preTags.set(name, `${part.slice(start)}</pre>`);
			text += part.slice(0, start) + name;
			i++;
		}
		text += last;
	}

	text = text.replace(/<br\s*\/?>\s*<br\s*\/?>/g, "\n\n");
	text = text.replace(new RegExp(`(<${ALLBLOCKS}[\\s/>])`, "g"), "\n\n$1");
	text = text.replace(new RegExp(`(</${ALLBLOCKS}>)`, "g"), "$1\n\n");
	text = text.replace(/(<hr\s*?\/?>)/g, "$1\n\n");
	text = text.replace(/\r\n|\r/g, "\n");
	text = replaceInHtmlTags(text, "\n", " <!-- wpnl --> ");

	if (text.includes("<option")) {
		text = text.replace(/\s*<option/g, "<option");
		text = text.replace(/<\/option>\s*/g, "</option>");
	}
	if (text.includes("</object>")) {
		text = text.replace(/(<object[^>]*>)\s*/g, "$1");
		text = text.replace(/\s*<\/object>/g, "</object>");
		text = text.replace(/\s*(<\/?(?:param|embed)[^>]*>)\s*/g, "$1");
	}
	if (text.includes("<source") || text.includes("<track")) {
		text = text.replace(/([<[](?:audio|video)[^>\]]*[>\]])\s*/g, "$1");
		text = text.replace(/\s*([<[]\/(?:audio|video)[>\]])/g, "$1");
		text = text.replace(/\s*(<(?:source|track)[^>]*>)\s*/g, "$1");
	}
	if (text.includes("<figcaption")) {
		text = text.replace(/\s*(<figcaption[^>]*>)/g, "$1");
		text = text.replace(/<\/figcaption>\s*/g, "</figcaption>");
	}

	text = text.replace(/\n\n+/g, "\n\n");
	const paragraphs = text.split(/\n\s*\n/).filter((p) => p !== "");
	text = "";
	for (const p of paragraphs) text += `<p>${p.replace(/^\n+|\n+$/g, "")}</p>\n`;

	text = text.replace(/<p>\s*<\/p>/g, "");
	text = text.replace(/<p>([^<]+)<\/(div|address|form)>/g, "<p>$1</p></$2>");
	text = text.replace(new RegExp(`<p>\\s*(</?${ALLBLOCKS}[^>]*>)\\s*</p>`, "g"), "$1");
	text = text.replace(/<p>(<li.+?)<\/p>/g, "$1");
	text = text.replace(/<p><blockquote([^>]*)>/gi, "<blockquote$1><p>");
	text = text.split("</blockquote></p>").join("</p></blockquote>");
	text = text.replace(new RegExp(`<p>\\s*(</?${ALLBLOCKS}[^>]*>)`, "g"), "$1");
	text = text.replace(new RegExp(`(</?${ALLBLOCKS}[^>]*>)\\s*</p>`, "g"), "$1");

	if (br) {
		text = text.replace(/<(script|style|svg|math)[\s\S]*?<\/\1>/g, (m) => m.split("\n").join("<WPPreserveNewline />"));
		text = text.split("<br>").join("<br />").split("<br/>").join("<br />");
		text = text.replace(/(?<!<br \/>)\s*\n/g, "<br />\n");
		text = text.split("<WPPreserveNewline />").join("\n");
	}

	text = text.replace(new RegExp(`(</?${ALLBLOCKS}[^>]*>)\\s*<br />`, "g"), "$1");
	text = text.replace(/<br \/>(\s*<\/?(?:p|li|div|dl|dd|dt|th|pre|td|ul|ol)[^>]*>)/g, "$1");
	text = text.replace(/\n<\/p>$/, "</p>");

	for (const [name, original] of preTags) text = text.split(name).join(original);
	if (text.includes("<!-- wpnl -->")) text = text.split(" <!-- wpnl --> ").join("\n").split("<!-- wpnl -->").join("\n");
	return text;
}
