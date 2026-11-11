# WordPress → EmDash

An agent skill for moving a WordPress site to [EmDash](https://emdashcms.com), the CMS built on
Astro and Cloudflare Workers, **without losing content, media or links**.

EmDash's importer reports success while dropping things: quotes, galleries, embeds, shortcodes,
code blocks, classic-editor paragraph breaks and old URLs. This skill gives an AI coding agent (or
you) the procedure, the scripts and the site files to find and repair every one of them. It proves
the result with a page-by-page comparison against the live WordPress site.

It was built from a real migration of a 600-post, 18-year-old blog. Every issue that migration hit
is documented, with how to detect it and fix it.

## What you get

- **A phased procedure** (`SKILL.md`): inventory, set up, schema, import and repair, legacy URLs,
  staging, parity audit, cutover. Each phase ends in a gate.
- **A catalogue of failures** (`references/gotchas.md`): about 50 issues, each with detect, cause,
  fix and prevent.
- **Scripts** (`scripts/`, Node 20 or later, no dependencies):
  - a resumable WXR import driver;
  - repairs for the converter's losses;
  - legacy URL redirects;
  - a parity audit with screenshots and an HTML report.

  Every script is configured by one `migration.config.json`, dry-runs by default, and is safe to
  re-run.
- **Site templates** (`templates/`): drop-in files for an EmDash site:
  - a deploy-time cache purge;
  - a setup-wizard guard;
  - Portable Text overrides (quotes with citations, columns, highlighted code);
  - routes for every old WordPress URL pattern.

## Install

**Claude Code (plugin):**
```
/plugin marketplace add SimpleThingsLtd/wordpress-to-emdash
/plugin install wordpress-to-emdash@simple-things
```

**Any agent that reads skills** (Claude Code, Codex, Cursor and others): copy the skill folder into
your skills directory.
```sh
git clone https://github.com/SimpleThingsLtd/wordpress-to-emdash
cp -R wordpress-to-emdash/skills/wordpress-to-emdash ~/.claude/skills/      # personal
# or, per project: .claude/skills/ or .agents/skills/
```

Then ask your agent something like *"Migrate example.com from WordPress to EmDash"*, or *"Audit
our EmDash site against the old WordPress site"*.

## Requirements

- An EmDash site (1.4 or later) on Cloudflare: Workers (the Paid plan: EmDash is over the free
  plan's size limit), D1 and R2.
- Access to WordPress: a WXR export (wp-cli or Tools → Export) and the public REST API.
- Node 20 or later. Playwright is optional, for embed checks and screenshots.

## How it stays safe

- WordPress is never modified, and stays live until two weeks after cutover.
- Every bulk change runs as a dry run first, with an HTML preview, and is applied only from an
  approved proposal file, with restore points taken beforehand.
- DNS changes, cutover and anything public wait for the site owner's explicit go-ahead.

## Layout

```
.claude-plugin/              plugin and marketplace manifests
skills/wordpress-to-emdash/
  SKILL.md                   the procedure
  references/                phase detail, gotchas, configuration, case study
  scripts/                   migration tools (copy into your project)
  templates/                 files for your EmDash site
  migration.config.example.json
```

## Contributing

Found a new way WordPress content goes missing? Open an issue or a pull request. A gotcha needs a
**detect / cause / fix** entry, plus a repair or audit check if one is possible.

## Licence

MIT © Simple Things Ltd
