# Case study: one real migration, with numbers

The skill was built from migrating a personal blog and link log (surfthedream.com.au, 2008–2026) from
WordPress 7.1 on a Plesk server to EmDash 1.4 on Cloudflare Workers. These numbers are for
calibration: expect losses of this kind and scale on a site of similar age. None of the procedure
depends on them.

## The site

| | |
| --- | --- |
| Posts | 646 (601 published, 45 drafts), Gutenberg and classic-editor content mixed |
| Pages | 22 |
| Attachments | 486, about 525 MB |
| Comments | 173 approved (151 comments, 22 pingbacks and trackbacks); not migrated, by decision |
| Tags and categories | 507 tags; nested categories |
| Plugin post types | 1 (a Jetpack portfolio), missed by the export (gotcha A14) |
| Permalink history | 3 older bases still linked from old posts (gotcha C3) |

## Import

The importer mapped every field and reported success. The import worked; the losses only showed
when the pages were compared with WordPress.

## First parity audit (before repairs)

- **Findings:** 95 high (24 of them a staging deploy fault, gotcha E2), 123 medium, 358 low.
- **Pages:** 206 of 601 had at least one finding.
- **Old-URL tests:** 526 of 747 passed.
- **The biggest losses:**

| Loss | Scale |
| --- | --- |
| Classic-editor paragraph structure | 192 posts; 74 places where words ran together |
| Raw shortcodes on the page | 15 posts, 141 shortcodes; 41 captions missing |
| Galleries | 4 posts; 48 images shown as 1 |
| Embeds that displayed on WordPress | 23 lost, 7 reduced to links |
| Code blocks flattened into paragraphs | 13 posts; 1,383 words of script printed as text |
| Images still loading from WordPress | 9 posts, 14 images |
| `?p=` links, old permalink bases | all failing |

## One repair round

Fixed with `fix-content` and legacy URL routes:
- 223 posts changed;
- every rebuilt block was checked to contain exactly the original characters;
- applied to staging and local from the same approved proposals.

| Measure | Before → after (WordPress) |
| --- | --- |
| Run-together paragraph breaks | 74 → 1 |
| List items inside lists | 414 → 579 (583) |
| Headings kept as headings | 292 → 309 (309) |
| Raw shortcodes visible | 141 → 0 |
| Gallery images | 1 → 48 (48) |
| Code blocks matching WordPress | 2 → 25 (25) |
| YouTube and Vimeo embeds that play | 0 → 9 (9) |
| Findings (high / medium / low) | 71 / 123 / 358 → 26 / 34 / 231 |
| Pages with findings | 206 → 92 |
| Old-URL tests passing | 550 → 584 of 747 |

Most of what remained needed the owner's decision rather than more code:
- 16 high findings were embeds from providers EmDash doesn't play;
- 151 low findings were date archives.

## What cost the most time

1. Silent converter losses: found only by the page-by-page audit.
2. The deploy cache: stale HTML pointing at deleted CSS after every deploy, until the purge
   (gotcha D1).
3. Two agents deploying the same Worker from different trees (gotcha E1).
4. A `.gitignore` rule that hid a route from git (gotcha E2).
5. A catch-all route that silently emptied the sitemap (gotcha C3c). The audit caught it on the
   next run.
