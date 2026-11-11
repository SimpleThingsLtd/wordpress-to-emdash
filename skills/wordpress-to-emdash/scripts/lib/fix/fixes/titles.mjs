/**
 * Titles with a visible entity ("Tracking Home Page &amp; Product Event
 * Clicks"): the export escaped them and the site escapes again on output.
 * Store the decoded title.
 */
import { decodeEntities } from "../../wxr.mjs";

const ENTITY = /&(?:amp|lt|gt|quot|apos|nbsp|#\d{2,6}|#x[0-9a-f]{2,5}|[lr]squo|[lr]dquo|hellip|[mn]dash);/i;

export default {
	id: "titles",
	label: "Titles with a visible &amp;",
	order: 1,
	run(entry) {
		if (!ENTITY.test(entry.title ?? "")) return null;
		// Decode until stable ("&amp;amp;" happens)
		let title = entry.title;
		for (let i = 0; i < 3 && ENTITY.test(title); i++) title = decodeEntities(title);
		if (title === entry.title) return null;
		return { title, items: [{ kind: "title", summary: `Title “${entry.title}” → “${title}”`, confidence: "high", before: entry.title, after: title }] };
	},
};
