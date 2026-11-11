# Rendering what WordPress content needs

EmDash's `PortableText` from `emdash/ui` renders the standard blocks. WordPress content needs a few
overrides. Put them all in one wrapper and use it everywhere content renders (posts, pages,
projects):

```astro
---
// templates/src/components/Content.astro → src/components/Content.astro
import { PortableText } from "emdash/ui";
import CodeBlock from "./pt/CodeBlock.astro";
import Columns from "./pt/Columns.astro";
import Quote from "./pt/Quote.astro";
const { value } = Astro.props;
---
<PortableText value={value ?? []} components={{ type: { blockquoteGroup: Quote, columns: Columns, code: CodeBlock } }} />
```
Components receive `{ node }`. Nested content (columns, quote paragraphs) must go back through
`PortableText` with the same `components`, or the overrides stop at the first level.

## Quotes with citations: `templates/src/components/pt/Quote.astro`
EmDash groups consecutive blockquote blocks into one `blockquoteGroup` node (`node.blocks`). The
quote repair (A1) puts the citation in a final paragraph starting with `—`, `―`, `–` or `--`.
The override:
- renders the earlier paragraphs as the quote body, with `style: "normal"`;
- strips the dash from the last paragraph and renders it as `<footer>`.

This also tidies imported tweet embeds, which arrive as a quote plus "— Name (@handle) date".

## Columns that keep images: `templates/src/components/pt/Columns.astro`
Render each `column.content` through `PortableText` with the page's components (A2). Stack the
columns below about 40rem.

## Code blocks: `templates/src/components/pt/CodeBlock.astro`, `templates/src/lib/highlight.ts`, `templates/src/lib/code-lang.ts`
- **Language:** `node.language` if set; otherwise detect it from the code. The detection order
  matters:
  1. a `$ ` prompt → shell session;
  2. PHP markers (`<?php`, `$_SERVER`, `add_action(`, `array(`);
  3. JSX/TS (`import … from`, hooks, type annotations), before HTML;
  4. HTML (starts with a tag);
  5. JSON (parses);
  6. nginx (most lines are directives);
  7. CSS (a selector `{` plus `prop: value;`);
  8. JavaScript (keywords used as declarations, so `/var/run` doesn't count);
  9. output and logs (`ERROR`, `fatal:`, `CONTAINER ID`, timestamps), before TOML/YAML;
  10. TOML, YAML, SQL, diff;
  11. shell (known commands, `./x`, `VAR=`, line continuations);
  12. text.

  Test the detector against **every** real block; the first version misread 9 of 113.
- **Highlighting:** server-side Shiki with `shiki/core` and the JavaScript regex engine, lazy
  per-language grammars, pinned at least two weeks old. Map TextMate scopes to roles (keyword,
  string, number, function, tag, attribute, variable, punctuation, comment), emit short role
  classes, and define each role's colour as a CSS `light-dark()` pair.
- **Contrast:** every role colour must reach WCAG AA (4.5:1) against the block background in both
  modes. `templates/scripts/check-code-contrast.mjs` reads the palette from the component and checks it.
- **Details that matter:**
  - decode `&#91;`/`&#93;` (A7) and trim leading blank lines, or one-liners count as several lines;
  - shell sessions: draw `$` prompts that can't be selected or copied, and show output quieter;
  - Copy copies the commands only;
  - one-liners stay compact; multi-line blocks get a header (language or filename, and Copy) and
    break out wider than the text;
  - long lines scroll horizontally inside a focusable region; the page never overflows.

## Embeds
EmDash's `embed` block plays YouTube and Vimeo. For other providers the owner decides (A6), and
`fix-content` → `embeds` applies the choice from `decisions.json`:

| Choice | What it emits | Use for |
| --- | --- | --- |
| `html`: live embed | EmDash's `iframe` block: `{ _type: "iframe", src, title, height, allow, allowFullscreen }` | players and demos that are the point of the post: CodePen, Spotify, SlideShare |
| `card` | an `embed` block with the URL and a caption (renders as a link) | dead campaigns, tools, anything where a link will do |
| `card` for tweets | the tweet's text as quote paragraphs plus a "— Author (@handle) date" line | tweets: no X script, no tracking |
| `image` | the provider's image in an isolated HTML block (sizes to fit) | GIFs (Giphy) |
| `leave` | nothing | services that no longer exist |

**Use the `iframe` block for live embeds, never an isolated HTML block.** EmDash sandboxes isolated
HTML blocks without `allow-same-origin`, and nested frames inherit that. Embeds that need cookies
or storage, including anything behind a bot check (CodePen, SlideShare), then fail with
"cookies are disabled". The `iframe` block gives the embed its own origin, accepts only `https`
sources, and sizes by height (fixed) or width and height (aspect ratio).

Spotify: 152 px for a single track, 380 px for playlists.

## Typography that imported content exercises
Old posts lean on blockquotes, lists, captions, `hr`, tables and inline code. Style all of them in
the prose stylesheet, then check a 2010-era classic post, a 2020s Gutenberg post and a code-heavy
post before calling the theme done.

## Social cards (optional, but expected of a modern site)
WordPress sites often had an SEO plugin's og:image. One option is a card for every page at
`/og/<path>.png`, rendered in the Worker with Satori and resvg and stored in R2. See gotchas D12 and D13
for the WebAssembly, font and caching rules. Use the request origin for the `og:image` URL.
