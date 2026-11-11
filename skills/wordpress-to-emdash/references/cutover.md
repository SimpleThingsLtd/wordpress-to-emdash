# Phase 7: cutover and rollback

Cutover is outward-facing and hard to undo once caches and search engines pick it up. **Get the
owner's explicit go-ahead,** in this conversation, for this step.

## Before the window

- Gate 6 has passed, and the owner has signed off staging.
- `EMDASH_SITE_URL` is already the final domain, so passkeys made on staging keep working.
- B2 is clear: no content still loads assets from the old host.
- **One deployer.** Run `npx wrangler deployments list` and look for versions you didn't make.
  Find every other worktree or session that deploys this Worker (gotcha E1). Build the cutover from
  a tree that includes everything that's live, and make sure no one deploys afterwards from a tree
  without the new routes: that would detach the domain.
- **A Cloudflare API token** with Zone → DNS → Edit for the zone (and Zone → Zone Settings → Read).
  Wrangler's own login can't read or edit DNS records. Have the owner store it in their keychain
  (`security add-generic-password -a "$USER" -s cloudflare-<site> -w` on a Mac) rather than paste
  it into chat. Check that what was saved is a bare token: copying Cloudflare's test snippet saves
  the `curl` line instead.
- **Save the zone's DNS records** (`GET /zones/<zone id>/dns_records`) to the work folder, and the
  SSL mode (`/settings/ssl`). Rollback restores from that file.
- **An archive copy of WordPress** at its own hostname, such as `old.example.com`, so the old site
  stays browsable after cutover (see below).
- **The old server's certificate:** note its expiry. After cutover it can't renew (HTTP-01 reaches
  the Worker now), which matters for rollback.
- A list of 20 to 30 test URLs covering every pattern in `url-compatibility.md`, plus the 10 most
  visited pages. Run it against staging first, so you know what passing looks like.
- Proxied records have automatic TTLs, and both the old record and the Worker's domain answer with
  Cloudflare's IPs, so visitors' DNS caches don't matter. Lower the TTL a day ahead only for
  DNS-only records.

## The archive copy of WordPress

Leave the original install untouched: it's the rollback. Clone it to a new hostname instead.

1. Create the hostname on the old host as a subdomain with its own document root, using the same
   PHP version as the original.
2. Clone files and database. With Plesk's WordPress Toolkit:
   `plesk ext wp-toolkit --clone -source-instance-id <id> -target-domain-name old.example.com
   -target-path / -force-overwrite yes` (it only overwrites the new subdomain's placeholder).
   Elsewhere: copy the files, dump and import the database, and edit `wp-config.php`.
3. Rewrite the clone's URLs. A clone tool usually updates `home` and `siteurl` and most content,
   but check what's left with a dry run, and skip GUIDs:
   ```sh
   wp search-replace "://example.com" "://old.example.com" --dry-run --all-tables-with-prefix --skip-columns=guid --format=count
   wp search-replace ":\/\/example.com" ":\/\/old.example.com" --all-tables-with-prefix --skip-columns=guid   # JSON in block attributes
   wp search-replace "://example.com" "://old.example.com" --all-tables-with-prefix --skip-columns=guid
   wp cache flush
   ```
   Then run the dry run against the original as well, to confirm it still has all its own URLs.
4. Keep it out of search engines: `wp option update blog_public 0` on the clone only.
5. DNS and certificate: create the record **DNS-only**, issue a Let's Encrypt certificate on the
   old host (HTTP-01 needs the request to reach it), then switch the record to proxied. Under SSL
   mode Full (strict), Cloudflare rejects the old host's default certificate.
6. Test it by hostname before DNS exists: `curl --resolve old.example.com:443:<origin IP>`.

## The window

1. Delete the apex record that points at the old host (from your saved list). Wrangler won't take
   it over by itself (gotcha D10).
2. Deploy the site Worker with only the final domain in `routes`:
   `[{ "pattern": "example.com", "custom_domain": true }]`. Do it straight after step 1: the
   domain has no DNS in between.
3. Deploy the redirect Worker (`templates/workers/redirects/`) for `www` and the staging host. A
   redirect inside the site's Worker doesn't work for cached pages (gotcha D16). If those hosts
   are attached to the site's Worker now, deploy the redirect Worker first: it takes them over
   without a DNS gap. Then remove them from the site's `routes` and deploy the site again.
4. Re-run the URL list and spot checks on the live domain: `/feed/`, the oldest URLs,
   `/wp-content/uploads/…`, `?p=`, search, OG cards, the admin sign-in page, a post with comments,
   and `www` and staging redirects on a page that's already cached.
5. Point the migration config at the new layout: `sites.wordpress` is the archive copy,
   `sites.staging` the live domain (the scripts' `--target staging`).
6. Submit the sitemap in Search Console. Watch 404s in the Worker logs (`wrangler tail`) for a day,
   and add redirects for anything real.

## Rollback

If something serious breaks and can't be fixed forward quickly:
1. Remove the final domain from the site Worker's `routes` and deploy (or detach it in the
   dashboard: Workers → the Worker → Domains).
2. Recreate the apex record from the saved list, proxied as it was.
3. WordPress serves again at once. If its certificate has expired since cutover, Full (strict)
   gives a 526 error: set the record DNS-only, reissue the certificate on the old host, then proxy
   it again.

## After

- Leave both WordPress copies untouched for two weeks. Then archive the original (files plus a
  database dump) and retire it, with the owner's approval. Keep the archive copy for as long as
  the owner wants it.
- Keep `.migration/` (export, caches, audit history, the saved DNS records). It's the record of
  what moved and why.
