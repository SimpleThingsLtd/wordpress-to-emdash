/**
 * Pages the new site redirects away from but which are still published, so
 * they sit in the sitemap (gotcha C6). Unpublishing keeps them as drafts.
 *
 * Targets come from migration.config.json:
 *   - urls.replacedPages: every page listed ("old-about" → "/about/");
 *   - urls.listingPages: pages whose address now redirects somewhere else
 *     (a listing page served at its own address stays published);
 *   - fixes.unpublish: anything else, as "collection:slug": "why".
 * Keys in the first two may be "slug" (a page) or "collection:slug".
 */
import { CONFIG } from "../../config.mjs";

const pageCollection = CONFIG.content.postTypes.page ?? "pages";
const keyFor = (k) => (k.includes(":") ? k : `${pageCollection}:${k}`);
const slugOf = (k) => (k.includes(":") ? k.split(":").slice(1).join(":") : k);
const samePath = (a, b) => a.replace(/\/+$/, "").toLowerCase() === b.replace(/\/+$/, "").toLowerCase();

function targets() {
	const out = {};
	for (const [k, to] of Object.entries(CONFIG.urls.replacedPages)) out[keyFor(k)] = `/${slugOf(k)}/ redirects to ${to}, which replaces it`;
	for (const [k, to] of Object.entries(CONFIG.urls.listingPages)) {
		if (to && !samePath(to, `/${slugOf(k)}/`)) out[keyFor(k)] = `/${slugOf(k)}/ redirects to ${to}, which replaces it`;
	}
	return { ...out, ...CONFIG.fixes.unpublish };
}
const TARGETS = targets();

export default {
	id: "unpublish",
	label: "Redirected pages still published (and in the sitemap)",
	order: 100,
	run(entry) {
		const why = TARGETS[`${entry.collection}:${entry.slug}`];
		if (!why || entry.status !== "published") return null;
		return { unpublish: true, items: [{ kind: "unpublish", summary: `Unpublish “${entry.title}”: ${why}. It stays as a draft.`, confidence: "high" }] };
	},
};
