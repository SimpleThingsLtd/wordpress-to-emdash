# Platform: Cloudflare, Workers, Astro and EmDash setup

Set these up in Phase 1, before content arrives. Each item prevents a gotcha.

## Cloudflare resources

- `wrangler.jsonc`: D1 (`DB`), R2 (`MEDIA`), the `version_metadata` binding (`CF_VERSION_METADATA`),
  a minute cron (EmDash's scheduled tasks, plus the cache-purge sweeps), and the staging route as a
  custom domain. Without IDs, wrangler creates the D1 database and R2 bucket on the first deploy; add
  the IDs afterwards so a renamed database never gets created twice.
- Vars: `EMDASH_SITE_URL` set to the **final** domain from day one (passkeys and canonical URLs),
  and `EMDASH_ALLOWED_ORIGINS` set to the staging origin.
- Secrets: `SETUP_KEY` (D7), plus integration keys. Never put them in `wrangler.jsonc`.
- **Plan:** Workers Paid. EmDash plus Astro is already over the free plan's 3 MB compressed limit
  (D11).

## The custom worker (`templates/src/worker.ts`)

Wrap EmDash's handler; don't replace it:
```ts
import handler, { createScheduledHandler, PluginBridge } from "@emdash-cms/cloudflare/worker";
export { PluginBridge };
const maintenance = createScheduledHandler();
// fetch: on the first request of an isolate, sweep(env, "request")
// scheduled: sweep(env, "cron") and maintenance(...)
```
`sweep` purges the page cache once per new Worker version (D1):
- read `env.CF_VERSION_METADATA.id`;
- `CREATE TABLE IF NOT EXISTS site_deploys (version, seen_at, sweeps)`;
- `INSERT OR IGNORE` the version; if it inserted, purge;
- from the cron, purge up to twice more, at least 60 s apart (old-version isolates re-cache briefly);
- `const { cache } = await import("cloudflare:workers")`, guarded with
  `typeof cache?.purge === "function"`, because local workerd has none.

## Guarding setup (`templates/src/middleware.ts`)

When `SETUP_KEY` is set, the setup API accepts writes only from a browser that opened
`/_emdash/admin/setup?setup_key=<key>` (a cookie is set). Reads stay open. Share the link only with
the owner, and tell them not to tick "sample content".

## Astro and EmDash rules that bite

- All CMS pages are server-rendered. No `getStaticPaths` for content.
- Pass content query cache hints to `Astro.cache.set` (a `hint()` helper). Cached routes need
  collection tags so publishing purges them, including search and 404 pages (D5).
- A 404 `Response` from an endpoint renders the custom 404 page (D3). On that page use
  `Astro.originPathname`, not `Astro.url` (D4).
- EmDash's redirect middleware skips paths with file extensions (C1).
- Image fields are objects (`{ src, alt }`); `entry.id` is the slug, `entry.data.id` the ULID.
- Taxonomy names in queries must match the seed's `name` exactly.

## WebAssembly and heavy libraries

The Cloudflare Vite plugin turns `import x from "./f.wasm"` (or `?module`) into a compiled
`WebAssembly.Module`, and `./f.bin` into an `ArrayBuffer`. Declare both in `src/env.d.ts`. Prefer
"standalone" builds that accept the module through `init()`. Verify that every such library starts
in workerd (`astro dev` runs workerd) before building on it (D12).

## Deploying

```sh
npx wrangler deployments list | tail -4    # is anyone else deploying this Worker?
git ls-files --others --ignored --exclude-standard -- src   # must print nothing
pnpm run deploy                             # astro build && wrangler deploy
```
Afterwards:
- Check that the live HTML references the new `/_astro/` CSS hash. Pass a cache-busting query
  string to see a fresh render.
- Check that the key routes answer: home, a post, an old uploads URL, `/feed/`, `/og/index.png`.
- Expect a slow minute right after a deploy while isolates warm up and the purge sweeps run. Measure
  again after that.

## Local development

- `npx astro dev --background`; `astro dev stop` and `astro dev logs` manage it. `astro check`
  breaks the running dev server's fonts (E3), so restart it afterwards.
- The local D1 is a full copy: inspect it with `npx wrangler d1 execute <db> --local --json --command "…"`.
- Test production behaviour with `npx wrangler dev --port 8799`, which runs the built Worker against
  local bindings.
- Debug the deployed Worker with `npx wrangler tail <worker> --format json`.
