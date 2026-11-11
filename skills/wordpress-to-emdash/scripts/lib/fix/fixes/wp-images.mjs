/**
 * Images still loading from the WordPress server (gotcha B2): absolute URLs
 * to the old host that no earlier rewrite caught, often from a platform the
 * site used before WordPress. They break at cutover, when the domain moves
 * to EmDash. Where the same file is in the media library, point the block at
 * it; otherwise list it for upload.
 *
 * A filename match is confirmed by size: the WordPress file's
 * Content-Length must equal the media item's size for "high" confidence.
 */
import { wordpressHostPattern } from "../../config.mjs";
import { imageUrl, clone, normaliseFilename } from "../pt.mjs";
import { mediaUrl } from "../media.mjs";

const ON_WP = new RegExp(`^(?:https?:)?\\/\\/${wordpressHostPattern()}\\/`, "i");

export default {
	id: "wpImages",
	label: "Images still served from WordPress",
	order: 70,
	async run(entry, content, ctx) {
		const items = [];
		const needsOwner = [];
		const fix = async (b) => {
			if (b._type !== "image") return b;
			const url = imageUrl(b);
			if (!ON_WP.test(url)) return b;
			const hit = ctx.media.resolve(url);
			const head = await ctx.probe(url.replace(/^\/\//, "https://"));
			if (!hit) {
				needsOwner.push({
					kind: "upload",
					summary: `${url} isn't in the media library: upload it (WordPress ${head.status === 200 ? "still serves it" : `returns ${head.status}`}), then re-run to rewrite it`,
					status: "needs-owner",
					images: [url],
					options: { upload: "Upload it to the media library, then re-run this script" },
				});
				return b;
			}
			const sameSize = head.status === 200 && head.length && hit.item.size && head.length === hit.item.size;
			// The same file uploaded to WordPress as an attachment of this post
			const wp = ctx.wxrFor(entry);
			const attached = wp && ctx.wxr.attachments.some((a) => a.parent === wp.id && normaliseFilename(a.url) === normaliseFilename(hit.item.filename));
			const nb = clone(b);
			nb.asset = { _type: "reference", _ref: hit.item.id, url: mediaUrl(hit.item) };
			if (!nb.width && hit.item.width) nb.width = hit.item.width;
			if (!nb.height && hit.item.height) nb.height = hit.item.height;
			items.push({
				kind: "rewrite",
				summary: `${url.replace(ON_WP, "/")} → media “${hit.item.filename}”${sameSize ? " (same size, same file)" : head.status === 200 ? ` (sizes differ: WordPress ${head.length ?? "?"} bytes, media ${hit.item.size ?? "?"})` : ` (this old path is already a 404 on WordPress; ${attached ? "the file was uploaded to WordPress as an attachment of this post" : "matched by filename only"})`}`,
				confidence: sameSize || attached ? "high" : "medium",
				images: [url],
				via: hit.via,
			});
			return nb;
		};
		const walk = async (blocks) => {
			const out = [];
			for (const b of blocks) {
				if (b._type === "gallery") out.push({ ...b, images: await walk(b.images ?? []) });
				else if (b._type === "columns") out.push({ ...b, columns: await Promise.all((b.columns ?? []).map(async (c) => ({ ...c, content: await walk(c.content ?? []) }))) });
				else out.push(await fix(b));
			}
			return out;
		};
		const next = await walk(content);
		if (!items.length && !needsOwner.length) return null;
		return { content: next, items, needsOwner };
	},
};
