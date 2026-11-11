# Phase 0: inventory WordPress

The audit can only find losses you know to look for. Inventory first, and write it down in
`.migration/inventory.md` (gitignored), with counts, so each later gate has something to check
against.

## Getting at WordPress

**REST API (no access needed):**
```sh
B=https://example.com
for t in posts pages media categories tags comments; do
  printf "%-10s %s\n" $t "$(curl -sI "$B/wp-json/wp/v2/$t?per_page=1" | grep -i x-wp-total | tr -d '\r' | cut -d' ' -f2)"
done
curl -s "$B/wp-json/wp/v2/types" | python3 -m json.tool | grep '"slug"'   # every REST-visible post type
```

**wp-cli over SSH.** Run it as the site's own system user. On Plesk, also use Plesk's PHP binary
(cPanel: `/opt/cpanel/ea-php82/root/usr/bin/php`; managed hosts often provide `wp` directly):
```sh
ssh root@host 'cd /var/www/vhosts/example.com/httpdocs &&
  W="sudo -u <sysuser> -H /opt/plesk/php/8.2/bin/php /usr/local/bin/wp";
  $W core version; $W option get permalink_structure;
  $W plugin list --status=active --fields=name,version;
  $W post-type list --fields=name,public;
  $W post list --post_type=any --post_status=publish --format=count;
  $W db size --human-readable'
```
If wp-cli crashes on a plugin, add `--skip-plugins --skip-themes`, **but then plugin post types
aren't registered** (gotcha A14). Take post-type counts from a run with plugins loaded.

## The export

```sh
$W export --dir=/tmp/emdash-export --filename_format=site.wxr.xml --max_file_size=-1
scp root@host:/tmp/emdash-export/site.wxr.xml .migration/
grep -c "<item>" .migration/site.wxr.xml
grep -o "<wp:post_type><!\[CDATA\[[a-z_-]*" .migration/site.wxr.xml | sort | uniq -c   # types actually exported
grep -c "<wp:comment>" .migration/site.wxr.xml
```
Check that every post type in `wp post-type list` with published items appears in the export. A
missing type is a missing section of the site.

## Checklist

| Item | How | Why it matters |
| --- | --- | --- |
| Counts per post type, status | REST `X-WP-Total`, `wp post list --format=count` | Gate 3 compares against these |
| Post types from plugins | `wp post-type list` with plugins loaded | A14: silently missing from exports |
| Gutenberg versus classic posts | `<!-- wp:` present in `content:encoded` or not | A3: classic posts need `wpautop` |
| Shortcodes in use | `grep -o '\[[a-z_-]\+' wxr \| sort \| uniq -c` (expect noise; confirm each) | A4/A5: they print as raw text |
| Embed providers | grep for `wp:embed`, `youtube.com`, `vimeo.com`, `codepen.io`, `open.spotify.com`, `twitter-tweet`, and bare URLs on their own line | A6: EmDash plays only YouTube and Vimeo |
| Code blocks and their language classes | `wp:code`, `<pre class="language-…">`, `&#91;` | A7 |
| Custom HTML with `<script>` | `wp:html` plus `<script` | A8 |
| Footnotes, tables, columns, galleries | `wp:footnotes`, `wp:table`, `wp:columns`, `wp:gallery`, `[gallery` | A2, A5, A10 |
| Link-post or other theme conventions | Read 5 posts of each format | A11 |
| Comments and pingbacks | `<wp:comment>` count, `<wp:comment_type>` | A13: not imported |
| Media size and count | `du -sh wp-content/uploads`, attachments count | B4: plan a long import |
| Absolute URLs to the old domain in content | `grep -o 'https\?://example\.com/[^"]*' wxr \| sort -u \| wc -l` | B2: break at cutover |
| Current permalink structure | `wp option get permalink_structure` | C3 |
| Older permalink bases still redirected | Redirect plugin rules (`wp redirection list` or the plugin's table), `.htaccess`, old internal links | C3 |
| Category hierarchy | `wp term list category --fields=slug,parent` | C5: nested category URLs |
| Date archives, attachment pages, `/page/N/` | Spot-check `/2015/`, an attachment page, `/page/2/` | C5 |
| SEO plugin sitemaps and meta | `/sitemap_index.xml`, `/wp-sitemap.xml`; Yoast or RankMath titles and descriptions | C5, metadata |
| Slugs with non-ASCII or encoded characters | `grep -o "<wp:post_name>[^<]*%[0-9a-f][0-9a-f]" wxr` | C4 |
| WordPress slugs that collide with new routes | Compare slugs against planned section routes (`writing`, `search`, `work`) | C7 |
| Embedded third-party widgets and forms | View the 10 most-visited pages | Owner decision |

## No SSH?

Managed hosts without shell access: use **Tools → Export** in wp-admin ("All content"), plus the
REST API for counts. Check that the export includes every post type: the admin exporter lists
registered types, and plugin types appear only while their plugin is active.

## Output

`.migration/inventory.md` with:
- the counts table;
- the lists of shortcodes, embed providers, URL patterns and old permalink bases;
- for every item EmDash won't carry by default, a decision line: *carry* (with how), *replace*
  (with what), or *drop* (owner-approved).
