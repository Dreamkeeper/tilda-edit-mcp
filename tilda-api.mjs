/**
 * HTTP layer for Tilda's editor API (undocumented; captured 2 Sept 2026).
 * Auth and the browser-like cookie jar live in session.mjs.
 *
 *   /page/edit/    editrecordcontent  pageid recordid tab=content|settings -> {record}
 *   /page/submit/  saverecord         pageid recordid <fields>             -> "OK"
 *   /page/get/     getrecordhtml      pageid recordid with_code            -> html
 *   /page/publish/ pagepublish        pageid csrf returnjson=yes           -> {link}
 *
 * Data model: a block is scalar fields plus one `list` JSON blob holding every
 * repeatable row. tplid = block type, width12 = column width. Server-owned
 * fields (below) must never be echoed back on save.
 */
import { tildaPost, tildaGet } from './session.mjs';

const READONLY = new Set(['id', 'pageid', 'tplid', 'slideqty', 'formactiontype']);

function decodeEntities(s) {
  return String(s)
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&');
}

// Compare JSON-valued fields structurally: the server stores \uXXXX-escaped
// Cyrillic where JSON.stringify emits literal characters — same data, other bytes.
function canon(v) {
  const s = decodeEntities(v == null ? '' : v);
  if (s[0] !== '[' && s[0] !== '{') return s;
  try {
    return JSON.stringify(JSON.parse(s));
  } catch {
    return s;
  }
}

export async function readBlock(pageid, recordid, tab = 'content') {
  const text = await tildaPost('/page/edit/', pageid, {
    comm: 'editrecordcontent',
    pageid,
    recordid,
    tab,
  });
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    throw new Error('readBlock: response was not JSON: ' + text.slice(0, 160));
  }
  if (!json.record) throw new Error('readBlock: no record in response');
  return json.record;
}

/** Read-modify-write, then re-read to confirm — saverecord persists exactly what it is sent. */
export async function writeBlock(pageid, recordid, changes, tab = 'content') {
  const current = await readBlock(pageid, recordid, tab);
  const body = { comm: 'saverecord', pageid, recordid };
  const encode = (v) => {
    if (v == null) return '';
    // Array/object fields (e.g. a cart block's `json` receiver hashes) must be
    // JSON-serialised; String() would mangle them into "[object Object]" / CSV.
    if (typeof v === 'object') return JSON.stringify(v);
    return String(v);
  };
  for (const [k, v] of Object.entries(current)) {
    if (!READONLY.has(k)) body[k] = encode(v);
  }
  for (const [k, v] of Object.entries(changes)) body[k] = encode(v);

  const res = await tildaPost('/page/submit/', pageid, body);
  if (res.trim() !== 'OK') throw new Error('writeBlock: unexpected response: ' + res.slice(0, 160));

  const after = await readBlock(pageid, recordid, tab);
  const bad = Object.keys(changes).filter((k) => canon(after[k]) !== canon(changes[k]));
  if (bad.length) throw new Error('writeBlock: fields did not persist: ' + bad.join(', '));
  return after;
}

export async function renderBlock(pageid, recordid) {
  return tildaPost('/page/get/', pageid, { comm: 'getrecordhtml', pageid, recordid, with_code: '' });
}

export function rowsFromList(listValue) {
  if (!listValue) return [];
  const parsed = JSON.parse(decodeEntities(listValue));
  if (Array.isArray(parsed)) return parsed;
  return Object.keys(parsed)
    .sort((a, b) => Number(a) - Number(b))
    .map((k) => parsed[k]);
}

export async function readRows(pageid, recordid) {
  return rowsFromList((await readBlock(pageid, recordid)).list);
}

export async function writeRows(pageid, recordid, rows) {
  return writeBlock(pageid, recordid, { list: JSON.stringify(rows) });
}
/**
 * List a page's blocks (records) plus its page-level info — the headless
 * equivalent of opening the editor to read the structure.
 * Returns { page:{title,alias,descr,published}, records:[{recordid,tplid,code,off}] }
 * in on-page order. `off:true` means the block is hidden.
 */
export async function listRecords(pageid) {
  const text = await tildaPost('/page/get/getpage/', pageid, { pageid });
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    throw new Error('listRecords: response was not JSON: ' + text.slice(0, 160));
  }
  const records = (json.records || []).map((r) => {
    const h = String(r.html || '');
    return {
      recordid: (h.match(/recordid=["']?(\d+)/) || [])[1] || null,
      tplid: r.tplid,
      code: (h.match(/data-record-cod=["']?([A-Za-z0-9]+)/) || [])[1] || null,
      off: /\boff=["']?y/.test(h),
    };
  });
  const pg = json.page || {};
  return {
    page: { title: pg.title, alias: pg.alias, descr: pg.descr, published: pg.published },
    records,
  };
}

/**
 * Show or hide a block. `offrecord` is a server-side TOGGLE with no on/off flag,
 * so we read the current state first and toggle only when it differs from the
 * requested one — making this idempotent. Returns { recordid, visible }.
 */
export async function setBlockVisibility(pageid, recordid, visible) {
  const before = await listRecords(pageid);
  const rec = before.records.find((r) => r.recordid === String(recordid));
  if (!rec) throw new Error(`setBlockVisibility: record ${recordid} not found on page ${pageid}`);

  if (!rec.off !== visible) {
    // offrecord is a toggle; it replies with the new off-state ("y"/"n"), not "OK".
    // Don't gate on the reply text — verify the result by re-reading the page.
    await tildaPost('/page/submit/', pageid, { comm: 'offrecord', pageid, recordid });
    const after = await listRecords(pageid);
    const now = after.records.find((r) => r.recordid === String(recordid));
    if (!now || !now.off !== visible) throw new Error('setBlockVisibility: toggle did not take effect');
  }
  return { recordid: String(recordid), visible };
}


export async function publishPage(pageid) {
  const editorHtml = await tildaGet(`/page/?pageid=${pageid}`, pageid);
  // The csrf <meta> ships EMPTY (content="") — Tilda's editor fills it client-side
  // via getCSRF(), so a standalone process cannot obtain it. Publishing therefore
  // has to happen in a browser context (the in-page client, or Tilda's UI).
  const tag = editorHtml.match(/<meta[^>]*name=["']csrf["'][^>]*>/i);
  const token = tag && tag[0].match(/content=["']([^"']+)["']/i);
  if (!token) {
    throw new Error(
      'publish is not supported from the standalone MCP: the CSRF token is ' +
        'generated client-side and is empty in the fetched HTML. Publish via the ' +
        'in-page client (window.Tilda.publishPage) or the Tilda editor UI. ' +
        'All edits made through this MCP are saved; only the final publish needs a browser.'
    );
  }
  const text = await tildaPost('/page/publish/', pageid, {
    comm: 'pagepublish',
    pageid,
    csrf: token[1],
    returnjson: 'yes',
  });
  try {
    return JSON.parse(text);
  } catch {
    throw new Error('publishPage: unexpected response: ' + text.slice(0, 160));
  }
}
