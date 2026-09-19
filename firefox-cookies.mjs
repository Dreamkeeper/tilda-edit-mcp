/**
 * Read the Tilda session cookie from the local Firefox profile.
 *
 * Firefox stores cookies unencrypted in SQLite (unlike Chrome's DPAPI on
 * Windows), so the session can be borrowed without decrypting anything and
 * without the user pasting a token. We touch the store as little as possible:
 *
 *  - We only ever SELECT rows whose host matches tilda; other sites' cookies
 *    are never read into memory.
 *  - Firefox keeps the DB in WAL mode while running, so we copy the db (plus
 *    -wal/-shm) to a temp file, read the copy, and delete it immediately.
 *  - Nothing is written back; the original profile is never opened for write.
 *
 * If Firefox has never logged in to tilda.ru, or the session expired, the
 * caller gets a clear error telling the user to log in there.
 */
import { DatabaseSync } from 'node:sqlite';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { readdirSync, statSync, copyFileSync, existsSync, rmSync, mkdtempSync } from 'node:fs';

function firefoxProfilesDir() {
  // Windows path; extend here if this ever needs to run on macOS/Linux.
  const base = join(homedir(), 'AppData', 'Roaming', 'Mozilla', 'Firefox', 'Profiles');
  if (!existsSync(base)) throw new Error(`Firefox profiles directory not found at ${base}`);
  return base;
}

/** Pick the profile whose cookies.sqlite was modified most recently. */
function pickProfileCookieDb() {
  const base = firefoxProfilesDir();
  const candidates = readdirSync(base)
    .map((name) => join(base, name, 'cookies.sqlite'))
    .filter((p) => existsSync(p))
    .map((p) => ({ p, mtime: statSync(p).mtimeMs }))
    .sort((a, b) => b.mtime - a.mtime);
  if (!candidates.length) throw new Error('No Firefox profile with a cookies.sqlite was found.');
  return candidates[0].p;
}

/**
 * Return { header, names } for the current Tilda session.
 * `header` is ready to drop into a Cookie: request header.
 */
export function readTildaCookies() {
  const src = pickProfileCookieDb();
  const dir = mkdtempSync(join(tmpdir(), 'tilda-ck-'));
  const dst = join(dir, 'c.sqlite');
  try {
    // Firefox briefly locks these files while writing (EBUSY on Windows), so
    // retry the db and WAL; the -shm index is optional — SQLite rebuilds it.
    const copyRetry = (from, to) => {
      for (let i = 0; ; i++) {
        try { return copyFileSync(from, to); }
        catch (e) {
          if (e.code !== 'EBUSY' || i >= 9) throw e;
          Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 150);
        }
      }
    };
    copyRetry(src, dst);
    if (existsSync(src + '-wal')) copyRetry(src + '-wal', dst + '-wal');
    if (existsSync(src + '-shm')) { try { copyFileSync(src + '-shm', dst + '-shm'); } catch { /* optional */ } }
    const db = new DatabaseSync(dst, { readOnly: true });
    // Scope the query to tilda hosts only — we never pull other sites' cookies.
    const rows = db
      .prepare("SELECT name, value FROM moz_cookies WHERE host LIKE '%tilda%'")
      .all();
    db.close();

    const jar = {};
    for (const { name, value } of rows) jar[name] = value;

    // hash + userid are the actual admin session; without them we are not logged in.
    if (!jar.hash || !jar.userid) {
      throw new Error(
        'No active Tilda admin session in Firefox (missing hash/userid cookies). ' +
          'Log in at https://tilda.ru in Firefox, then retry.'
      );
    }

    const header = Object.entries(jar)
      .map(([k, v]) => `${k}=${v}`)
      .join('; ');
    return { header, names: Object.keys(jar).sort() };
  } finally {
    // Best-effort cleanup of the temp copy and its WAL sidecars.
    rmSync(dir, { recursive: true, force: true });
  }
}
