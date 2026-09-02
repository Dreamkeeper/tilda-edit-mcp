# tilda-edit-mcp

An [MCP](https://modelcontextprotocol.io) server that reads and writes **Tilda**
pages through Tilda's own (undocumented) editor API, authenticating by borrowing
the session from your local **Firefox** — no password, no API key, no token to
paste.

Tilda's *public* API is read-only. Its *editor* has a full write API; this
server wraps it, so an AI agent (or any MCP client) can edit blocks, change
block settings, rewrite repeatable rows, and publish pages.

## Why it exists

Driving the Tilda editor UI with a browser automation tool is slow and
unreliable — block-type switches, image swaps, and settings changes silently
revert. The editor's network calls, by contrast, are plain
`application/x-www-form-urlencoded` POSTs. This server calls them directly, with
a read-modify-write-verify wrapper so a save either provably lands or throws.

## Tools

| Tool | Purpose |
|------|---------|
| `read_block`  | Read a block's fields (`tab: content` for copy, `settings` for width/colours/cover overlay) |
| `write_block` | Write fields (read-modify-write, then verified; pass only what changes) |
| `render_block`| Rendered HTML for one block |
| `read_rows`   | A repeatable block's rows as an array (decodes Tilda's escaped `list` JSON) |
| `write_rows`  | Replace a repeatable block's rows |
| `list_records`| List a page's blocks in order (recordid, tplid, code, hidden?) + page title/alias/descr. Enumerate a page headlessly. |
| `set_block_visibility` | Show/hide a block (idempotent). Hide booking/price blocks until dates are set, reveal them later. |
| `publish_page`| Publish a page — **browser-assisted only** (see Caveats) |

A block is a handful of scalar fields plus one `list` JSON blob holding every
repeatable row. `tplid` is the block type; `width12` the column width;
`filteropacity` the cover overlay.

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

**You must be logged in to tilda.ru in Firefox** for the server to work.

## Requirements

- Node.js ≥ 22 (uses the built-in `node:sqlite`; no native modules)
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
- **State-changing "dangerous" ops need a browser.** Reads and content edits
  (read/write/render/rows/list/visibility) work headlessly. But **publish**,
  **delete-page** and **page-settings save** (title/alias) require a CSRF token
  Tilda generates client-side — the `<meta name="csrf">` ships empty. Do those in
  a browser context or the Tilda UI. Everything the MCP edits is saved as a draft
  regardless, so only the final publish needs the browser.

## License

MIT — see [LICENSE](LICENSE).

---

*Not affiliated with or endorsed by Tilda Publishing.*
