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
  for (const [k, v] of Object.entries(current)) {
    if (!READONLY.has(k)) body[k] = v == null ? '' : String(v);
  }
  for (const [k, v] of Object.entries(changes)) body[k] = v == null ? '' : String(v);

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

export async function publishPage(pageid) {
  const editorHtml = await tildaGet(`/page/?pageid=${pageid}`, pageid);
  const m = editorHtml.match(/<meta[^>]+name=["']csrf["'][^>]+content=["']([^"']+)["']/i);
  if (!m) throw new Error('publishPage: could not find CSRF token in editor page');
  const text = await tildaPost('/page/publish/', pageid, {
    comm: 'pagepublish',
    pageid,
    csrf: m[1],
    returnjson: 'yes',
  });
  try {
    return JSON.parse(text);
  } catch {
    throw new Error('publishPage: unexpected response: ' + text.slice(0, 160));
  }
}
