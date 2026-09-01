/**
 * Session manager — mimics a browser cookie jar so the Tilda session sustains.
 *
 * The mistake this fixes: presenting the remember-me token (hash/userid) on
 * every request with no session cookie forces Tilda to re-authenticate each
 * time, which its session-fixation defense punishes by invalidating the token.
 *
 * A browser instead bootstraps ONCE — the first request carries the remember-me
 * token, Tilda issues a PHPSESSID via Set-Cookie — then sends that PHPSESSID
 * (alongside the persistent cookies) on every later request. With a valid
 * session present, the remember-me token is never re-consumed.
 *
 * So: a base jar of the persistent Firefox cookies, plus a session jar that
 * accumulates whatever Tilda sets (PHPSESSID and any rotations). The session
 * jar is persisted to disk so an MCP restart reuses the live session instead of
 * bootstrapping again.
 */
import { readTildaCookies } from './firefox-cookies.mjs';
import { recoverTildaPhpSessid } from './recovery-cookies.mjs';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const JAR_PATH = join(fileURLToPath(new URL('.', import.meta.url)), '.session-jar.json');

// Persistent cookies read from Firefox once per process; refreshed on re-bootstrap.
let baseJar = null;
// Session cookies (PHPSESSID + rotations) captured from Tilda's Set-Cookie.
let sessionJar = loadSessionJar();

function loadSessionJar() {
  try {
    if (existsSync(JAR_PATH)) return JSON.parse(readFileSync(JAR_PATH, 'utf8'));
  } catch {
    /* corrupt jar -> start fresh */
  }
  return {};
}

function saveSessionJar() {
  try {
    writeFileSync(JAR_PATH, JSON.stringify(sessionJar), { mode: 0o600 });
  } catch {
    /* non-fatal: jar just won't survive a restart */
  }
}

function ensureBase() {
  if (!baseJar) baseJar = readTildaCookies(); // { header, names } -> we re-parse below
  return baseJar;
}

function baseCookieMap() {
  // Persistent cookies (hash/userid/deviceid/…) from cookies.sqlite …
  const { header } = readTildaCookies();
  const map = {};
  for (const pair of header.split('; ')) {
    const i = pair.indexOf('=');
    if (i > 0) map[pair.slice(0, i)] = pair.slice(i + 1);
  }
  // … plus the live PHPSESSID, which Firefox keeps in memory and only writes to
  // the session-restore file. This is the key that makes the session valid.
  try {
    const php = recoverTildaPhpSessid();
    if (php) map.PHPSESSID = php;
  } catch {
    // If the recovery file can't be read we fall back to the remember-me
    // bootstrap; the caller will get a clear auth error if that no longer works.
  }
  return map;
}

function cookieHeader() {
  // Session cookies override persistent ones of the same name (e.g. a rotated value).
  const merged = { ...baseCookieMap(), ...sessionJar };
  return Object.entries(merged)
    .map(([k, v]) => `${k}=${v}`)
    .join('; ');
}

function captureSetCookies(res) {
  const list = typeof res.headers.getSetCookie === 'function' ? res.headers.getSetCookie() : [];
  let changed = false;
  for (const sc of list) {
    const first = sc.split(';')[0];
    const i = first.indexOf('=');
    if (i <= 0) continue;
    const name = first.slice(0, i);
    const value = first.slice(i + 1);
    // Deletions (expired/empty) shouldn't poison the jar.
    if (value && value !== 'deleted') {
      sessionJar[name] = value;
      changed = true;
    }
  }
  if (changed) saveSessionJar();
}

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:155.0) Gecko/20100101 Firefox/155.0';
const BASE = 'https://tilda.ru';

/**
 * POST to Tilda with the browser-like jar. On an auth rejection, drop the
 * session jar and retry once — that re-bootstraps from the remember-me token,
 * the single legitimate moment to present it.
 */
export async function tildaPost(path, pageid, fields, _retried = false) {
  ensureBase();
  const res = await fetch(BASE + path, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      'User-Agent': UA,
      Origin: BASE,
      Referer: `${BASE}/page/?pageid=${pageid}`,
      'X-Requested-With': 'XMLHttpRequest',
      Cookie: cookieHeader(),
    },
    body: new URLSearchParams(fields).toString(),
  });
  const text = await res.text();
  captureSetCookies(res);

  if (!res.ok) throw new Error(`${path} -> HTTP ${res.status}: ${text.slice(0, 160)}`);

  if (/not authorized/i.test(text)) {
    if (!_retried) {
      // Session died; forget it and re-bootstrap once from the remember-me token.
      sessionJar = {};
      saveSessionJar();
      return tildaPost(path, pageid, fields, true);
    }
    throw new Error(
      'Tilda rejected the session even after re-bootstrapping. ' +
        'Log in at https://tilda.ru in Firefox and retry.'
    );
  }
  return text;
}

/** GET (used for fetching the editor HTML to read the CSRF token). */
export async function tildaGet(path, pageid) {
  ensureBase();
  const res = await fetch(BASE + path, {
    headers: {
      'User-Agent': UA,
      Referer: `${BASE}/`,
      Cookie: cookieHeader(),
    },
  });
  const text = await res.text();
  captureSetCookies(res);
  return text;
}
