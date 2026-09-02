# tilda-edit-mcp

An [MCP](https://modelcontextprotocol.io) server that reads and writes **Tilda**
pages through Tilda's own (undocumented) editor API, authenticating by borrowing
the session from your local **Firefox** — no password, no API key, no token to
paste.

Tilda's *public* API is read-only. Its *editor* has a full write API; this
server wraps it, so an AI agent (or any MCP client) can edit blocks, change
block settings, rewrite repeatable rows, add and delete blocks, swap images,
duplicate pages, and publish — **entirely headlessly**.

## Why it exists

Driving the Tilda editor UI with a browser automation tool is slow and
unreliable — block-type switches, image swaps, and settings changes silently
revert. The editor's network calls, by contrast, are plain
`application/x-www-form-urlencoded` POSTs. This server calls them directly, with
a read-modify-write-verify wrapper so a save either provably lands or throws.

## Tools

### Blocks

| Tool | Purpose |
|------|---------|
| `read_block`  | Read a block's fields (`tab: content` for copy, `settings` for width/colours/typography/background) |
| `write_block` | Write fields (read-modify-write, then verified; pass only what changes) |
| `render_block`| Rendered HTML for one block |
| `read_rows`   | A repeatable block's rows as an array (decodes Tilda's escaped `list` JSON) |
| `write_rows`  | Replace a repeatable block's rows |
| `list_records`| List a page's blocks in order (recordid, tplid, code, hidden?) + page title/alias |
| `set_block_visibility` | Show/hide a block (idempotent) |
| `add_block`   | Add a block by Tilda's numeric block-library id (`tplid`), after or before another block |
| `delete_block`| Delete a block |
| `set_block_image` | Change a block's image from a URL **or a local file**: uploads to Tilda's CDN, then assigns it the way the editor's uploader does |

### Pages

| Tool | Purpose |
|------|---------|
| `duplicate_page` | Copy a page inside its project (returns the new pageid) |
| `set_page_title` | Rename a page |
| `set_page_alias` | Set a page's URL path |
| `publish_page`   | Publish — headless, no browser needed |

A block is a handful of scalar fields plus one `list` JSON blob holding every
repeatable row. `tplid` is the block type; `blockbackground` the section
background; `*_typo` JSON strings (`{"fontsize":"22px","color":"#fff",…}`) drive
typography per field; `filteropacity` the cover overlay.

## Things learned the hard way (all handled by the server)

- **Every field comes back HTML-escaped** from the read endpoint, while the save
  endpoint stores exactly what it is sent. Echoing untouched fields verbatim
  double-escapes them on every write (a `<div>` in a title becomes literal
  `&lt;div&gt;` on the page). `write_block` decodes before echoing.
- **Image fields are ignored by a plain save** — the uploader widget owns them.
  `set_block_image` uploads to `upload.tildaapi.com` (keys come from the page
  itself) and saves only that field with the uploader's `tuinfo` parameters.
- **A save of a partial record blanks every omitted field**, so everything is
  read-modify-write.
- **Rich-text fields reject `<ul>`/`<li>`/`<div>`.** Posting a `<ul>` once
  returned a login page and invalidated the session for every client, Firefox
  included. Use `•  item<br />` for lists.
- **Legacy scalar colour fields** (`buttoncolor`, `bbuttonbgcolor`,
  `title_uppercase`, …) are derived or dropped by the server; set the
  `*_styles` / `*_typo` JSON instead.
- **Publish needs no real CSRF token.** The editor's `getCSRF()` reads a
  `<meta name="csrf">` that ships empty, and the server accepts `csrf=` empty
  for publish, duplicate, alias and delete. Earlier versions of this README
  said publish was browser-only; that was wrong.

## How authentication works

1. Persistent cookies (`hash`, `userid`, `deviceid`, …) are read from Firefox's
   `cookies.sqlite` (unencrypted, unlike Chrome on Windows).
2. Those alone are **not enough**: `hash` is a remember-me token Firefox already
   *consumes on login* to mint a session. The real session key, `PHPSESSID`, is
   a session cookie Firefox keeps **in memory only**.
3. So the live `PHPSESSID` is recovered from Firefox's session-restore file
   (`sessionstore-backups/recovery.jsonlz4`, mozLz4-compressed — decompressed by
   a small built-in decoder, no native dependency).
4. Requests carry the persistent cookies **+** the recovered `PHPSESSID`, plus
   the `Origin`/`Referer`/`X-Requested-With` headers Tilda's origin check
   requires. The session is then stable across calls.

**You must be logged in to tilda.ru in Firefox** for the server to work. If a
call returns "Tilda rejected the session", log in again in Firefox and retry.

## Requirements

- Node.js ≥ 22 (uses the built-in `node:sqlite`, `fetch`, `FormData`; no native modules)
- Firefox, logged in to tilda.ru
- Currently Windows-only (Firefox profile path); the logic ports easily to
  macOS/Linux by adjusting two paths.

## Install

```bash
npm install
```

Register with an MCP client, e.g. Claude Code:

```bash
claude mcp add tilda-edit -s user -- node /absolute/path/to/tilda-edit-mcp/index.mjs
```

Restart the client after updating: a running server keeps the old code.

## Typical flow

```
list_records      → find the recordids
read_block        → see the fields (content and settings)
write_block       → change copy / colours / typography / background
set_block_image   → swap a photo (URL or local file)
add_block         → insert e.g. a full-screen photo block (tplid 160)
publish_page
```

To build a redesign side by side with the live page: `duplicate_page` →
`set_page_title` → `set_page_alias` → edit the copy → `publish_page`.

## Test

The contract test does a full read → write → verify → restore round trip and
checks the session sustains across calls. Point it at a **disposable** page and
block you own:

```bash
TILDA_TEST_PAGEID=123456 TILDA_TEST_RECORDID=7890123 npm test
```

Run it whenever a write mysteriously stops sticking — it is the tripwire for
Tilda changing the API.

## Privacy

Recovering `PHPSESSID` means decompressing `recovery.jsonlz4`, which contains
your **entire** Firefox session (all open tabs, and every site's in-memory
session cookies). The reader decompresses it transiently and returns **only**
the `tilda.ru` `PHPSESSID`; nothing else leaves that module and nothing is
written to disk. Read `recovery-cookies.mjs` if you want to see exactly what it
touches.

## Caveats

- **Undocumented API.** Tilda can change or break it without notice. The
  contract test exists to catch that early.
- **Terms of service.** Automating the Tilda editor may not be permitted under
  Tilda's ToS. Check before relying on it, especially commercially.
- **Session coupling.** Logging out of Tilda in any browser invalidates the
  account's sessions globally.
- **`delete_block` has no undo** from the API side.
- **Zero Block** (Tilda's free-form designer) is not supported; standard blocks only.

## License

MIT — see [LICENSE](LICENSE).

---

*Not affiliated with or endorsed by Tilda Publishing.*
