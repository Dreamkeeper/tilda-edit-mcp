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
  // /page/edit/ returns every string HTML-escaped (&quot; &lt; ...) while
  // saverecord stores exactly what it is sent, so an untouched field echoed
  // back verbatim would be double-escaped. Decode once before echoing.
  for (const [k, v] of Object.entries(current)) {
    if (!READONLY.has(k)) body[k] = typeof v === 'string' ? decodeEntities(v) : encode(v);
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
  const current = await readBlock(pageid, recordid);
  // Form blocks (carts, lead forms: they carry `formactiontype`) ignore `list` on
  // save. The editor sends the fields as `forminputs` JSON instead, plus the
  // form type and receivers under record-suffixed keys (captured 19 Sept 2026).
  if (current.formactiontype !== undefined) return writeFormInputs(pageid, recordid, rows, current);
  return writeBlock(pageid, recordid, { list: JSON.stringify(rows) });
}

async function writeFormInputs(pageid, recordid, rows, current) {
  const body = { comm: 'saverecord', pageid, recordid };
  for (const [k, v] of Object.entries(current)) {
    if (['id', 'pageid', 'tplid', 'slideqty', 'list', 'json', 'formactiontype'].includes(k)) continue;
    body[k] = typeof v === 'string' ? decodeEntities(v) : JSON.stringify(v);
  }
  body[`formactiontype${recordid}`] = String(current.formactiontype);
  // Receivers (`json`: array of integration hashes) must be echoed or they are dropped.
  (Array.isArray(current.json) ? current.json : []).forEach((h, i) => (body[`formintegrations${recordid}[${i}]`] = h));
  body.forminputs = JSON.stringify(rows);
  const res = (await tildaPost('/page/submit/', pageid, body)).trim();
  if (res !== 'OK') throw new Error('writeFormInputs: unexpected response: ' + res.slice(0, 160));
  const after = await readBlock(pageid, recordid);
  if (canon(after.list) !== canon(JSON.stringify(rows)) && rowsFromList(after.list).length !== rows.length)
    throw new Error('writeFormInputs: fields did not persist');
  if (JSON.stringify(after.json || []) !== JSON.stringify(current.json || []))
    throw new Error('writeFormInputs: form receivers changed — check the block in the editor');
  return after;
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
  // The editor's getCSRF() reads <meta name="csrf">, which ships EMPTY, and the
  // server accepts an empty csrf for pagepublish (verified 2 Sept 2026) — so no
  // browser is needed after all.
  const text = await tildaPost('/page/publish/', pageid, {
    comm: 'pagepublish',
    pageid,
    csrf: '',
    returnjson: 'yes',
  });
  try {
    return JSON.parse(text);
  } catch {
    throw new Error('publishPage: unexpected response: ' + text.slice(0, 160));
  }
}

// ---------------------------------------------------------------------------
// Page-level ops (dashboard endpoints). csrf is accepted empty on all of them.
// ---------------------------------------------------------------------------

/** Duplicate a page inside its project. Returns the new pageid. */
export async function duplicatePage(pageid) {
  const t = (await tildaPost('/projects/submit/', pageid, { comm: 'dublicatepage', pageid, csrf: '' })).trim();
  if (!/^\d+$/.test(t)) throw new Error('duplicatePage: unexpected response: ' + t.slice(0, 160));
  return { pageid: t };
}

export async function setPageTitle(pageid, title) {
  const t = (await tildaPost('/projects/submit/', pageid, { comm: 'savepagetitle', pageid, title })).trim();
  if (t !== '' && t !== 'OK') throw new Error('setPageTitle: ' + t.slice(0, 160));
  return { pageid, title };
}

export async function setPageAlias(pageid, projectid, alias) {
  const t = (await tildaPost('/projects/submit/', pageid, { comm: 'savepagealias', projectid, pageid, alias, csrf: '' })).trim();
  if (t !== '' && t !== 'OK') throw new Error('setPageAlias: ' + t.slice(0, 160));
  return { pageid, alias };
}

// ---------------------------------------------------------------------------
// Block structure: add / delete.
// ---------------------------------------------------------------------------

/** Add a block of type `tplid` after (or before) another record. Returns the new recordid. */
export async function addBlock(pageid, tplid, { afterid = '', beforeid = '' } = {}) {
  const t = await tildaPost('/page/submit/', pageid, {
    comm: 'addnewrecord', pageid, afterid, beforeid, tplid: String(tplid), with_code: '',
  });
  const m = t.match(/recordid=[\\"']*(\d+)/);
  if (!m) throw new Error('addBlock: unexpected response: ' + t.slice(0, 200));
  return { recordid: m[1], tplid: String(tplid) };
}

export async function deleteBlock(pageid, recordid) {
  const t = (await tildaPost('/page/submit/', pageid, { comm: 'deleterecord', pageid, recordid, csrf: '' })).trim();
  if (t !== '' && t !== 'OK') throw new Error('deleteBlock: ' + t.slice(0, 160));
  return { recordid: String(recordid), deleted: true };
}

// ---------------------------------------------------------------------------
// Images. A plain saverecord IGNORES image fields (`img`, `li_img`, …): the
// editor's uploader owns them. The working path is: upload to Tilda's CDN
// (upload.tildaapi.com — by URL, or multipart with field `file`), then save
// ONLY that field with the uploader's tuinfo parameters.
// ---------------------------------------------------------------------------

const UPLOAD_API = 'https://upload.tildaapi.com/api/upload/';
let uploadKeysCache;

async function uploadKeys(pageid) {
  if (uploadKeysCache) return uploadKeysCache;
  const g = JSON.parse(await tildaPost('/page/get/getpage/', pageid, { pageid }));
  if (!g.Tildaupload_PUBLICKEY || !g.Tildaupload_UPLOADKEY) throw new Error('uploadKeys: keys missing in getpage response');
  uploadKeysCache = { publickey: g.Tildaupload_PUBLICKEY, uploadkey: g.Tildaupload_UPLOADKEY };
  return uploadKeysCache;
}

function firstUploadResult(text) {
  let j;
  try { j = JSON.parse(text); } catch { throw new Error('upload: response was not JSON: ' + text.slice(0, 200)); }
  const r = j.result && j.result[0];
  if (!r || !r.cdnUrl) throw new Error('upload failed: ' + text.slice(0, 300));
  return { cdnUrl: r.cdnUrl, uuid: r.uuid, name: r.name, width: r.width, height: r.height, size: r.size };
}

/** Upload an image that is already reachable by URL. Returns tuinfo {cdnUrl, uuid, name, width, height, size}. */
export async function uploadImageFromUrl(pageid, url) {
  const k = await uploadKeys(pageid);
  const body = new URLSearchParams({ url, publickey: k.publickey, uploadkey: k.uploadkey, acceptedFiles: '' }).toString();
  const r = await fetch(UPLOAD_API, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8', Origin: 'https://tilda.ru', Referer: 'https://tilda.ru/' },
    body,
  });
  return firstUploadResult(await r.text());
}

/** Upload a local image file (multipart, field `file`). Returns tuinfo. */
export async function uploadImageFile(pageid, path) {
  const { readFile } = await import('node:fs/promises');
  const { basename } = await import('node:path');
  const k = await uploadKeys(pageid);
  const bytes = await readFile(path);
  const name = basename(path).replace(/[^\w.-]+/g, '_');
  const type = /\.png$/i.test(name) ? 'image/png' : /\.gif$/i.test(name) ? 'image/gif' : /\.webp$/i.test(name) ? 'image/webp' : 'image/jpeg';
  const fd = new FormData();
  fd.append('publickey', k.publickey);
  fd.append('uploadkey', k.uploadkey);
  fd.append('file', new Blob([bytes], { type }), name);
  const r = await fetch(UPLOAD_API, { method: 'POST', headers: { Origin: 'https://tilda.ru', Referer: 'https://tilda.ru/' }, body: fd });
  return firstUploadResult(await r.text());
}

/** Assign an uploaded image (tuinfo from uploadImage*) to a block's image field (default `img`). */
export async function setBlockImage(pageid, recordid, field, info) {
  const t = (await tildaPost('/page/submit/', pageid, {
    comm: 'saverecord', pageid, recordid, onlythisfield: field,
    [`${field}-uploadmethod`]: 'tu',
    [`${field}-tuinfo-uuid`]: info.uuid || '',
    [`${field}-tuinfo-cdnurl`]: info.cdnUrl,
    [`${field}-tuinfo-name`]: info.name || '',
    [`${field}-tuinfo-width`]: String(info.width || ''),
    [`${field}-tuinfo-size`]: String(info.size || ''),
  })).trim();
  if (t !== 'OK') throw new Error('setBlockImage: ' + t.slice(0, 200));
  const after = await readBlock(pageid, recordid, 'content');
  if (decodeEntities(after[field] || '') !== info.cdnUrl) throw new Error(`setBlockImage: ${field} did not persist`);
  return { recordid: String(recordid), field, cdnUrl: info.cdnUrl };
}

/** Convenience: upload (by URL or local path) and assign in one go. */
export async function setBlockImageFrom(pageid, recordid, field, source) {
  const info = /^https?:\/\//i.test(source) ? await uploadImageFromUrl(pageid, source) : await uploadImageFile(pageid, source);
  return setBlockImage(pageid, recordid, field || 'img', info);
}
