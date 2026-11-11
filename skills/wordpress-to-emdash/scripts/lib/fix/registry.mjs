/**
 * The content repairs, in the order they run. Each fix sees the content the
 * previous one produced, so shortcode and code clean-ups come before the
 * classic re-segmentation, which needs their placeholders gone.
 *
 * A fix module exports { id, label, order, run(entry, content, ctx) } and
 * run() returns null (nothing to do) or
 *   { content, items: [{ kind, summary, confidence, notes?, images?, embeds? }],
 *     notes?: [], title?: string, unpublish?: true, needsOwner?: [ … ] }
 * Items that need the owner's decision go in needsOwner and are not in
 * `content` until decisions.json picks an option.
 */
import titles from "./fixes/titles.mjs";
import brackets from "./fixes/brackets.mjs";
import captions from "./fixes/captions.mjs";
import gallery from "./fixes/gallery.mjs";
import code from "./fixes/code.mjs";
import classic from "./fixes/classic.mjs";
import embeds from "./fixes/embeds.mjs";
import wpImages from "./fixes/wp-images.mjs";
import textLoss from "./fixes/text-loss.mjs";
import unpublish from "./fixes/unpublish.mjs";

export const FIXES = [titles, brackets, captions, gallery, code, classic, embeds, wpImages, textLoss, unpublish].sort((a, b) => a.order - b.order);

/** Fix ids as the brief numbers them, for the preview. */
export const FIX_NUMBERS = { gallery: 1, captions: 2, classic: 3, embeds: 4, code: 5, wpImages: 6, titles: 7, brackets: 8, textLoss: 9, unpublish: 10 };
