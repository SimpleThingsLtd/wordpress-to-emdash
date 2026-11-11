# Phase 7: cutover and rollback

Cutover is outward-facing and hard to undo once caches and search engines pick it up. **Get the
owner's explicit go-ahead,** in this conversation, for this step.

## Before the window

- Gate 6 has passed, and the owner has signed off staging.
- `EMDASH_SITE_URL` is already the final domain, so passkeys made on staging keep working.
- B2 is clear: no content still loads assets from the old host.
- The WordPress copy is untouched and can still serve the site, on its own IP or a hosts-file entry,
  for comparison and rollback.
- DNS TTLs on the apex and `www` are lowered to 300 s a day ahead.
- A list of 20 to 30 test URLs, covering every pattern in `url-compatibility.md` plus the 10 most
  visited pages.

## The window

1. In Cloudflare DNS, delete the apex and `www` records that point at the old host. Cloudflare won't
   attach a Worker custom domain while another record owns the hostname (D10).
2. Add `{ "pattern": "example.com", "custom_domain": true }` and the `www` equivalent to
   `routes`, then deploy.
3. Re-run the URL tests and spot checks against the live domain: `/feed/`, 2012-era URLs,
   `/wp-content/uploads/…`, `?p=`, search, OG cards, admin sign-in.
4. Re-run the parity audit's URL tests on the live hostname.
5. Submit the sitemap in Search Console. Watch 404s in the Worker logs (`wrangler tail`) for a day,
   and add redirects for anything real.

## Rollback

If something serious breaks and can't be fixed forward quickly:
1. Remove the custom-domain routes and redeploy (or detach the domains in the dashboard).
2. Restore the old DNS records, using the values noted before the window.
3. WordPress serves again as soon as DNS propagates, which is why the TTL was lowered.

## After

- Leave WordPress untouched for two weeks. Then archive it (files plus a database dump) and retire
  it, with the owner's approval.
- Keep `.migration/` (export, caches, audit history). It's the record of what moved and why.
