/**
 * Recover Firefox's live, memory-only PHPSESSID for tilda.ru.
 *
 * Why this is needed: the persistent cookies in cookies.sqlite (hash/userid)
 * are a remember-me token that Firefox already CONSUMES on login to mint a
 * PHPSESSID. That PHPSESSID is a session cookie (no expiry), so Firefox keeps
 * it in memory — the only on-disk copy is the session-restore file. Reading it
 * lets a standalone process ride the browser's actual live session instead of
 * re-consuming a spent remember-me token (proven 2 Sept 2026).
 *
 * Privacy note: recovery.jsonlz4 holds the FULL session (all tabs, all sites'
 * session cookies). We decompress it transiently and return ONLY the tilda.ru
 * PHPSESSID; nothing else leaves this module.
 */
import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

// --- mozLz4 (magic + uint32 size + raw LZ4 block) ----------------------------
function lz4BlockDecompress(src, outSize) {
  const out = Buffer.alloc(outSize);
  let i = 0;
  let o = 0;
  const n = src.length;
  while (i < n) {
    const token = src[i++];
    let lit = token >> 4;
    if (lit === 15) {
      let b;
      do {
        b = src[i++];
        lit += b;
      } while (b === 255);
    }
    src.copy(out, o, i, i + lit);
    o += lit;
    i += lit;
    if (i >= n) break;
    const offset = src[i] | (src[i + 1] << 8);
    i += 2;
    let mlen = token & 0xf;
    if (mlen === 15) {
      let b;
      do {
        b = src[i++];
        mlen += b;
      } while (b === 255);
    }
    mlen += 4;
    let start = o - offset;
    for (let j = 0; j < mlen; j++) out[o++] = out[start++]; // overlapping copy is intentional
  }
  return out.subarray(0, o);
}

function mozLz4Decompress(path) {
  const data = readFileSync(path);
  if (data.subarray(0, 8).toString('latin1') !== 'mozLz40\0') {
    throw new Error('recovery file has unexpected magic bytes');
  }
  const outSize = data.readUInt32LE(8);
  return lz4BlockDecompress(data.subarray(12), outSize);
}

function findRecoveryFile() {
  const base = join(homedir(), 'AppData', 'Roaming', 'Mozilla', 'Firefox', 'Profiles');
  if (!existsSync(base)) throw new Error(`Firefox profiles dir not found at ${base}`);
  const candidates = [];
  for (const profile of readdirSync(base)) {
    for (const name of ['recovery.jsonlz4', 'recovery.baklz4']) {
      const p = join(base, profile, 'sessionstore-backups', name);
      if (existsSync(p)) candidates.push(p);
    }
  }
  if (!candidates.length) throw new Error('No Firefox session-restore file found.');
  // freshest first
  candidates.sort((a, b) => readFileSync(b).length - readFileSync(a).length); // cheap tiebreak; mtime below
  candidates.sort(
    (a, b) => statMtime(b) - statMtime(a)
  );
  return candidates[0];
}

import { statSync } from 'node:fs';
function statMtime(p) {
  try {
    return statSync(p).mtimeMs;
  } catch {
    return 0;
  }
}

/** Return the tilda.ru PHPSESSID value, or null if the session isn't present. */
export function recoverTildaPhpSessid() {
  const raw = mozLz4Decompress(findRecoveryFile());
  const json = JSON.parse(raw.toString('utf8'));
  const cookies = json.cookies || [];
  const hit = cookies.find((c) => c.host === 'tilda.ru' && c.name === 'PHPSESSID');
  return hit ? hit.value : null;
}
