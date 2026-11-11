/**
 * Which WordPress comments to bring across, and why the rest stay behind.
 *
 * Order of decisions, per comment:
 *   1. comments.exclude (by WordPress comment ID): out, with the reason given.
 *   2. Its post isn't on the new site, or its post type isn't imported: out.
 *   3. Not approved in WordPress (comment_approved != 1): out.
 *   4. Pingbacks and trackbacks: out unless comments.includePingbacks; even then,
 *      self-pingbacks (from the site itself or a dev host) stay out.
 *   5. Spam heuristics, skipped for WordPress users and comments.trustedAuthors:
 *      each signal adds points; at comments.spamThreshold (default 3) it's out.
 *   6. Empty bodies, and the same author's same text twice on one post: out
 *      (of a pair, the reply is kept, else the earliest).
 *   7. comments.include (by ID) overrides 3 to 6.
 *   8. Replies whose parent stayed out (comments.orphans):
 *      "reattach" (default): hang it under the nearest kept ancestor; if the whole
 *        thread above it is gone, leave it out too (an answer to a spam question
 *        reads oddly on its own);
 *      "drop": leave it out;  "promote": keep it, top level if nothing above is kept.
 *
 * Every signal is listed in the preview, including those under the threshold,
 * so a person can see the near misses and move them with include/exclude.
 */

// Built-in spam vocabulary. Matched as words in the body and author name; as
// substrings in URLs and email addresses (see HOST_TERMS).
const SPAM_VOCAB = {
	pharma: ["viagra", "cialis", "levitra", "kamagra", "phentermine", "phen375", "xanax", "valium", "tramadol", "oxycodone", "adderall", "propecia", "online pharmacy", "diet pills?", "weight loss pills?", "garcinia", "male enhancement", "erectile", "penis enlargement"],
	casino: ["casino", "poker", "roulette", "blackjack", "baccarat", "slot machines?", "slot online", "sports betting", "bookmaker", "gambling", "judi", "togel", "sbobet", "jackpot"],
	seo: ["seo services?", "seo company", "seo agency", "backlinks?", "link building", "pagerank", "page rank", "scrapebox", "xrumer", "gsa ser", "traffic to your (?:site|website|blog)", "first page of google", "buy (?:followers|likes|traffic)", "increase (?:your )?traffic"],
	money: ["payday loans?", "cash loans?", "quick loans?", "make money online", "work from home", "earn money", "bitcoin", "crypto(?:currency)?", "forex", "binary options?"],
	adult: ["porn", "xxx", "sex", "escorts?", "adult dating", "hook ?up", "cam girls?", "nude"],
	replica: ["replica watches", "louis vuitton", "michael kors", "ugg boots", "cheap jerseys", "ray-?ban", "oakley sunglasses", "cheap handbags"],
};
// Substrings that give a URL or an email address away
const HOST_TERMS = ["seo", "casino", "viagra", "cialis", "pharma", "poker", "porn", "xxx", "loan", "backlink", "scrapebox", "replica", "dating", "escort", "betting", "forex", "bitcoin"];

// Well-known spinner templates: the same sentences turn up on blogs everywhere
const TEMPLATES = [
	"do you ever run into any (?:web )?browser compatibility",
	"have you ever (?:considered|thought about) (?:writing an e-?book|guest authoring|creating an e-?book)",
	"guest author(?:ing)? on other (?:sites|websites|blogs)",
	"i have joined your (?:rss )?feed",
	"you obviously know how to keep a reader",
	"this (?:design|web ?site|site|blog) is (?:incredible|wicked|steller|spot on)",
	"i(?:'?m| am) really loving the (?:theme|design|template)",
	"add (?:an? )?rss feed (?:feature|button|widget)",
	"i will (?:bookmark|book mark) (?:you|your (?:blog|site|website))",
	"you(?:'?re| are) a very skilled blogger",
	"in (?:reality|fact) a (?:great|good) and helpful piece of info",
	"i am happy that you (?:simply|just) shared this",
	"please keep us (?:informed|up to date)",
	"thumbs up,? you(?:'?ve)? got some good content",
	"see my (?:own )?(?:site|website|blog|page)",
	"(?:check|visit) (?:out )?my (?:site|website|blog|web ?page)",
	"this is very attention-grabbing",
	"i know this is (?:kind of |somewhat )?off topic",
	"hey there just wanted to give you a (?:quick|brief) heads up",
	"(?:this|your) (?:paragraph|piece of writing|post) (?:couldn'?t|could not) be written any better",
	"my (?:brother|cousin|coworker|friend) (?:recommended|suggested) i (?:might|may) like this",
	"(?:it'?s|its) a shame you don'?t have a donate button",
	"quality (?:articles|posts|contents?) (?:or reviews )?is the (?:key|important thing)",
	"(?:what|which) blog platform (?:are you|you have been) using",
	"is (?:this|that) a paid (?:theme|subject matter)",
	"do you mind if i quote",
	"wow,? (?:superb|amazing|awesome) blog layout",
	"i was suggested this (?:web ?site|blog)",
	"(?:hi|hello) (?:there|everyone),? (?:i found your blog|it'?s my first (?:visit|go to see))",
	"(?:pretty|nice) (?:section|portion) of content",
];

// Praise that says nothing about the post
const GENERIC = [
	"\\b(?:great|nice|good|excellent|awesome|informative|useful|helpful|interesting|wonderful|fantastic|amazing|very nice) (?:post|article|blog|site|website|info|information|read|share|stuff|content|job|work|data)\\b",
	"\\bthanks? (?:you )?(?:so much |very much )?for (?:sharing|the (?:post|article|info|information|share|read|informative read))\\b",
	"\\bkeep (?:it up|up the (?:good|great|nice|excellent) work)\\b",
	"\\bwaiting for more\\b",
	"\\bsounds fascinating\\b",
	"\\bvery (?:helpful|informative|useful) (?:post|article|blog)\\b",
	"\\bi like this post\\b",
	"\\bthank(?:y|ity)\\b",
];
const SHORT_PRAISE = /\b(?:thanks?|thank you|great|nice|good|awesome|helpful|useful|cool|wow|kudos|love it)\b/i;

// Words that make an author "name" read as keywords
const NAME_VOCAB = new Set("seo marketing design designer designs website websites web services service company agency solutions reviews review questions answers interview bonds bail loans loan insurance lawyer attorney cheap best buy online shop store deals discount sale free download downloads music movie movies games casino dating login account gmail email content blog news tips hosting plumber plumbing roofing cleaning dentist repair rental hotel travel tours jobs crypto bitcoin forex pills health fitness diet beauty fashion jewelry wholesale ltd inc llc pty good cheap".split(" "));

const DEFAULT_TLDS = ["ru", "cn", "xyz", "top", "info", "biz", "click", "loan", "win", "bid", "stream", "pw", "tk", "ml", "ga", "cf", "gq", "work", "party", "review", "date", "racing", "download", "men", "icu", "buzz", "cyou", "rest", "monster", "su", "kim", "country", "science", "trade", "webcam", "accountant", "faith", "cricket"];
const BIG_SITES = new Set(["yahoo.com", "facebook.com", "google.com", "gmail.com", "hotmail.com", "outlook.com", "live.com", "msn.com", "bing.com", "youtube.com", "twitter.com", "x.com", "instagram.com", "linkedin.com", "amazon.com", "wikipedia.org", "apple.com", "microsoft.com", "aol.com", "ebay.com"]);
const DEV_HOST = /(^localhost$|\.local$|\.test$|\.localhost$|\.example$|\.invalid$|^127\.|^10\.|^192\.168\.|^172\.(1[6-9]|2\d|3[01])\.|^\[?::1\]?$)/i;

const URL_IN_TEXT = /https?:\/\/[^\s<>"')\]]+|\bwww\.[a-z0-9-]+\.[^\s<>"')\]]+/gi;
const BARE_DOMAIN = /(?<![\w@./-])[a-z0-9][a-z0-9-]{1,62}\.(?:com|net|org|info|biz|co|io|me|us|uk|au|de|ru|cn|in|id|xyz|top|online|site|store|shop)\b(?![\w@-])/gi;

const words = (s) => s.split(/\s+/).filter(Boolean);
const normBody = (s) => s.toLowerCase().normalize("NFKD").replace(/[^a-z0-9]/g, "");
const rx = (list) => list.map((p) => new RegExp(`\\b(?:${p})\\b`, "i"));

export function hostOf(url) {
	try {
		return new URL(url).hostname.toLowerCase().replace(/^www\./, "");
	} catch {
		return "";
	}
}

/** True when the URL could be a public link: http(s) and not a dev or private host. */
export function isPublicUrl(url) {
	if (!/^https?:\/\//i.test(url ?? "")) return false;
	const host = hostOf(url);
	return Boolean(host) && host.includes(".") && !DEV_HOST.test(host);
}

/** Letters from another script inside a Latin word: Cyrillic "і" for "i", Cherokee "Ꮤ" for "W" … */
function homoglyphWords(text) {
	const out = [];
	for (const w of words(text)) {
		const letters = [...w].filter((ch) => /\p{L}/u.test(ch));
		const latin = letters.filter((ch) => /\p{Script=Latin}/u.test(ch)).length;
		if (latin && latin < letters.length) out.push(w);
	}
	return out;
}

/**
 * Build the classifier for one run. `opts` is CONFIG.comments plus
 * { postTypes, ownHosts: Set } (the WordPress and final hosts).
 */
export function makeFilter(opts) {
	const vocab = Object.entries(SPAM_VOCAB).flatMap(([kind, list]) => list.map((p) => ({ kind, re: new RegExp(`\\b(?:${p})\\b`, "i") })));
	const extra = (opts.spamPhrases ?? []).map((p) => ({ kind: "configured", re: new RegExp(p, "i") }));
	const templates = rx(TEMPLATES);
	const generic = rx(GENERIC);
	const tlds = new Set((opts.spammyTlds ?? DEFAULT_TLDS).map((t) => t.replace(/^\./, "").toLowerCase()));
	const trusted = new Set((opts.trustedAuthors ?? []).map((n) => n.toLowerCase()));
	const maxLinks = opts.maxLinks ?? 2;

	const tldOf = (host) => host.split(".").pop();

	/** Spam signals for one comment: [{ code, points, text }] (one per code). */
	function signals(c) {
		const out = [];
		const add = (code, points, text) => {
			if (!out.some((s) => s.code === code)) out.push({ code, points, text });
		};
		const body = c.text;
		const name = c.author;
		const authorHost = hostOf(c.url);

		for (const { kind, re } of [...vocab, ...extra]) {
			const m = body.match(re) ?? name.match(re);
			if (m) add(`vocab:${kind}`, 3, `${kind === "configured" ? "matches a configured spam phrase" : `${kind} spam word`}: “${m[0]}”`);
		}
		const hostHit = HOST_TERMS.find((t) => c.url.toLowerCase().includes(t));
		if (hostHit) add("url-terms", 3, `author URL contains “${hostHit}”`);
		const emailHit = HOST_TERMS.find((t) => c.email.toLowerCase().includes(t));
		if (emailHit) add("email-terms", 2, `email address contains “${emailHit}”`);

		const tpl = templates.find((re) => re.test(body));
		if (tpl) add("template", 3, `known spam template: “${body.match(tpl)[0]}”`);

		const glyphs = homoglyphWords(`${name} ${body}`);
		if (glyphs.length) add("homoglyphs", 3, `look-alike letters from another alphabet: ${glyphs.slice(0, 3).map((w) => `“${w}”`).join(", ")}`);

		const urls = [...new Set(body.match(URL_IN_TEXT) ?? [])];
		const bare = [...new Set((body.replace(URL_IN_TEXT, " ").match(BARE_DOMAIN) ?? []).map((d) => d.toLowerCase()))];
		const linkCount = urls.length + bare.length;
		if (linkCount > maxLinks) add("links", 3, `${linkCount} links (comments.maxLinks is ${maxLinks})`);

		const textWords = words(body.replace(URL_IN_TEXT, " ").replace(BARE_DOMAIN, " "));
		if (linkCount && textWords.length <= 15) add("short-with-link", 2, `short comment (${textWords.length} words) carrying a link`);
		const anchors = [...c.html.matchAll(/<a\b[^>]*>([\s\S]*?)<\/a\s*>/gi)].map((m) => m[1].replace(/<[^>]+>/g, "").trim());
		const keywordAnchor = anchors.find((t) => words(t).length >= 2 && !/^(?:https?:\/\/|www\.)/i.test(t) && !/\.[a-z]{2,}\b/i.test(t));
		if (keywordAnchor) add("keyword-anchor", 2, `link with keyword anchor text “${keywordAnchor}”`);

		const hostTld = authorHost && tldOf(authorHost);
		const linkTlds = [...urls.map(hostOf), ...bare].map(tldOf).filter((t) => tlds.has(t));
		if (hostTld && tlds.has(hostTld)) add("tld", 2, `author URL on .${hostTld}`);
		else if (linkTlds.length) add("tld", 2, `link on .${linkTlds[0]}`);

		if (authorHost && BIG_SITES.has(authorHost) && /^https?:\/\/[^/]+\/?$/i.test(c.url)) add("big-site-url", 2, `author URL is just ${authorHost}`);

		// A pingback's "author" is the linking page's title and its body an excerpt: no name or praise checks
		if (c.type === "pingback" || c.type === "trackback") return out;

		const g = generic.find((re) => re.test(body));
		const short = textWords.length <= 12;
		if (g) add("generic", 1, `generic praise: “${body.match(g)[0]}”`);
		else if (short && SHORT_PRAISE.test(body)) add("generic", 1, "generic praise");
		if ((g || SHORT_PRAISE.test(body)) && short) add("short", 1, `only ${textWords.length} word${textWords.length === 1 ? "" : "s"}`);

		// The author name: keywords, a sentence, or words run together
		const nameWords = words(name.toLowerCase().replace(/[^\p{L}\p{N}\s]/gu, " "));
		const inVocab = nameWords.filter((w) => NAME_VOCAB.has(w));
		if (nameWords.length && (inVocab.length === nameWords.length || inVocab.length >= 2)) add("keyword-name", 2, `author name reads as keywords (${inVocab.join(", ")})`);
		else if (inVocab.length) add("keyword-name", 1, `author name contains “${inVocab[0]}”`);
		if (nameWords.length >= 5) add("sentence-name", 1, `author name is ${nameWords.length} words long`);
		const run = name.replace(/\s+/g, "").toLowerCase();
		if (nameWords.length === 1 && run.length >= 10 && /^[a-z0-9]+$/.test(run)) {
			const inside = [...NAME_VOCAB].find((w) => w.length >= 4 && run.includes(w));
			if (inside) add("keyword-name", 2, `author name runs keywords together (“${inside}”)`);
			if (authorHost && authorHost.split(".")[0].replace(/-/g, "") === run) add("name-is-domain", 1, `author name is the site's domain (${authorHost})`);
		}
		return out;
	}

	const isTrusted = (c) => c.userId > 0 || trusted.has(c.author.toLowerCase());
	const isPing = (c) => c.type === "pingback" || c.type === "trackback";
	const listed = (list, id) => (Array.isArray(list) ? list.map(Number).includes(id) : Object.hasOwn(list ?? {}, String(id)));
	const listedReason = (list, id) => (Array.isArray(list) ? null : list?.[String(id)]);

	/**
	 * Decide every comment. `entryFor(post)` returns { collection, entry } where
	 * entry is null when the post isn't on the new site (or undefined when that
	 * couldn't be checked: offline). Returns decisions in WordPress ID order.
	 */
	function classify(comments, posts, entryFor) {
		const decisions = new Map();
		const sorted = [...comments].sort((a, b) => (a.date ?? "").localeCompare(b.date ?? "") || a.wpId - b.wpId);

		// Copies of an earlier comment by someone else (spinners reuse real comments)
		const copies = new Map();
		const seen = [];
		for (const c of sorted) {
			const n = normBody(c.text);
			if (n.length >= 30 && !isTrusted(c)) {
				const orig = seen.find((o) => o.author !== c.author && (lcp(o.n, n) >= 40 || (o.n.length >= 40 && n.includes(o.n))));
				if (orig) copies.set(c.wpId, orig.wpId);
			}
			seen.push({ wpId: c.wpId, author: c.author, n });
		}

		// The same author posting the same text twice on one post (a reply re-posted at the top level, a double submit):
		// keep the reply if one of them is a reply, else the earliest
		const dupOf = new Map();
		const groups = new Map();
		for (const c of sorted) {
			const n = normBody(c.text);
			if (n.length < 20) continue;
			const key = `${c.postWpId}|${c.author.toLowerCase()}|${n}`;
			if (!groups.has(key)) groups.set(key, []);
			groups.get(key).push(c);
		}
		for (const list of groups.values()) {
			if (list.length < 2) continue;
			const keep = list.find((c) => c.parentWpId) ?? list[0];
			for (const c of list) if (c !== keep) dupOf.set(c.wpId, keep.wpId);
		}

		for (const c of sorted) {
			const post = posts.get(c.postWpId);
			const { collection, entry } = entryFor(post);
			const d = {
				c,
				post,
				collection,
				entry,
				ping: isPing(c),
				trusted: isTrusted(c),
				name: opts.renameAuthors?.[c.author] ?? c.author,
				signals: [],
				score: 0,
				status: "import",
				category: null,
				reason: null,
				notes: [],
				parentWpId: c.parentWpId,
			};
			const out = (category, reason) => {
				d.status = "exclude";
				d.category ??= category;
				d.reason ??= reason;
			};

			if (!d.trusted || d.ping) {
				d.signals = signals(c);
				const copy = copies.get(c.wpId);
				if (copy) d.signals.push({ code: "copy", points: 3, text: `copies an earlier comment (#${copy}) by someone else` });
				d.score = d.signals.reduce((t, s) => t + s.points, 0);
			}

			if (listed(opts.exclude, c.wpId)) out("config", `left out in comments.exclude${listedReason(opts.exclude, c.wpId) ? `: ${listedReason(opts.exclude, c.wpId)}` : ""}`);
			if (!collection) out("post-missing", `its post type “${post?.type ?? "?"}” isn't imported (content.postTypes)`);
			else if (entry === null) out("post-missing", `its ${post.type} “${post.slug}” isn't on the new site`);

			const forced = listed(opts.include, c.wpId);
			if (forced) d.notes.push("kept by comments.include");
			if (!forced) {
				if (c.approved !== "1") out("not-approved", `not approved in WordPress (status “${c.approved || "0"}”)`);
				if (d.ping) {
					const own = hostOf(c.url);
					if (!opts.includePingbacks) out("pingback", `${c.type}: comments.includePingbacks is off`);
					else if (!c.url) out("pingback", `${c.type} with no source URL`);
					else if (!isPublicUrl(c.url) || opts.ownHosts.has(own)) out("self-pingback", `self-${c.type} from ${own || "a dev host"}`);
				}
				if (d.score >= (opts.spamThreshold ?? 3)) out("spam", `spam score ${d.score}`);
				if (!c.text.trim()) out("empty", "empty comment");
				if (dupOf.has(c.wpId)) {
					out("duplicate", `duplicate of #${dupOf.get(c.wpId)} (same author, same text)`);
					if (d.category === "duplicate") d.dupOf = dupOf.get(c.wpId);
				}
			}
			decisions.set(c.wpId, d);
		}

		// Threads: decide replies after their parents
		const depth = (d, seenIds = new Set()) => {
			const p = d.parentWpId && decisions.get(d.parentWpId);
			if (!p || seenIds.has(d.c.wpId)) return 0;
			seenIds.add(d.c.wpId);
			return 1 + depth(p, seenIds);
		};
		const byDepth = [...decisions.values()].sort((a, b) => depth(a) - depth(b) || a.c.wpId - b.c.wpId);
		const mode = opts.orphans ?? "reattach";
		for (const d of byDepth) {
			if (!d.parentWpId) continue;
			const parent = decisions.get(d.parentWpId);
			if (!parent) {
				d.notes.push(`its parent #${d.parentWpId} isn't in the export: shown at the top level`);
				d.parentWpId = null;
				continue;
			}
			if (d.status !== "import" || parent.status === "import") continue;
			// A reply to a dropped duplicate belongs under the copy that was kept, whatever comments.orphans says
			if (parent.dupOf && decisions.get(parent.dupOf)?.status === "import") {
				d.notes.push(`threaded under #${parent.dupOf}: its parent #${parent.c.wpId} was a duplicate of it`);
				d.parentWpId = parent.dupOf;
				continue;
			}
			// Walk up to the nearest kept comment; a dropped duplicate leads to the copy that was kept
			let up = parent;
			const walked = new Set();
			while (up && up.status !== "import" && !walked.has(up.c.wpId)) {
				walked.add(up.c.wpId);
				up = up.dupOf ? decisions.get(up.dupOf) : up.parentWpId ? decisions.get(up.parentWpId) : null;
			}
			if (up?.status !== "import") up = null;
			const forced = listed(opts.include, d.c.wpId);
			if (mode === "drop" && !forced) {
				d.status = "exclude";
				d.category = "orphan";
				d.reason = `reply to #${parent.c.wpId}, which was left out (comments.orphans is “drop”)`;
			} else if (up) {
				d.notes.push(`reattached under #${up.c.wpId}: its parent #${parent.c.wpId} was left out`);
				d.parentWpId = up.c.wpId;
			} else if (mode === "promote" || forced) {
				d.notes.push(`shown at the top level: its parent #${parent.c.wpId} was left out`);
				d.parentWpId = null;
			} else {
				d.status = "exclude";
				d.category = "orphan";
				d.reason = `reply to #${parent.c.wpId}, which was left out, with no kept comment above it`;
			}
		}
		return [...decisions.values()].sort((a, b) => a.c.wpId - b.c.wpId);
	}

	/** The author link to show, or null: public http(s) only, never for a dev host. */
	const authorLink = (d) => (isPublicUrl(d.c.url) ? d.c.url : null);

	return { classify, signals, authorLink };
}

function lcp(a, b) {
	let i = 0;
	while (i < a.length && i < b.length && a[i] === b[i]) i++;
	return i;
}
