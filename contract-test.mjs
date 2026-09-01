/**
 * Contract test for the tilda-edit MCP's API layer + session jar.
 *
 * Run after a Firefox login (node contract-test.mjs). It exercises the full
 * round trip on a disposable page you own, and — crucially — makes ~10 sequential calls
 * to prove the session SUSTAINS (the bug that motivated the jar was the session
 * dying after a burst). Restores every value it changes.
 */
import { readBlock, writeBlock, renderBlock, readRows, writeRows } from './tilda-api.mjs';

// Point these at a DISPOSABLE page/block you own — the test writes and restores
// one field. Never run it against a page you care about.
const PAGE = process.env.TILDA_TEST_PAGEID;
const RECORD = process.env.TILDA_TEST_RECORDID;
if (!PAGE || !RECORD) {
  console.error('Set TILDA_TEST_PAGEID and TILDA_TEST_RECORDID to a disposable page/block you own.');
  process.exit(2);
}

const results = [];
const check = (name, ok) => {
  results.push({ name, ok: !!ok });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}`);
};

try {
  const before = await readBlock(PAGE, RECORD);
  const originalTitle = before.btitle || '';
  const originalListLen = String(before.list).length;
  check('1  read block as JSON', typeof before.btitle === 'string' && !!before.list);

  const mark = 'MCP-' + Math.floor(Math.random() * 99999);
  const after = await writeBlock(PAGE, RECORD, { btitle: mark });
  check('2  write persists', after.btitle === mark);
  check('3  sibling `list` not blanked', String(after.list).length === originalListLen);

  const rows = await readRows(PAGE, RECORD);
  check('4  read_rows decodes escaped JSON', Array.isArray(rows) && rows.length > 0);
  check('5  rows keep lid', rows.every((r) => 'lid' in r));

  const settings = await readBlock(PAGE, RECORD, 'settings');
  check('6  settings tab readable', !!(settings && settings.tplid));

  const html = await renderBlock(PAGE, RECORD);
  check('7  render reflects the write', html.includes(mark));

  // The point of the jar: keep going without the session dying.
  let sustained = true;
  for (let i = 0; i < 6; i++) {
    const r = await readBlock(PAGE, RECORD);
    if (r.btitle !== mark) sustained = false;
  }
  check('8  session sustains 6 more calls', sustained);

  await writeRows(PAGE, RECORD, rows); // round-trip rows unchanged
  const rowsAfter = await readRows(PAGE, RECORD);
  check('9  rows round-trip intact', JSON.stringify(rowsAfter) === JSON.stringify(rows));

  const restored = await writeBlock(PAGE, RECORD, { btitle: originalTitle });
  check('10 restore original value', restored.btitle === originalTitle);

  const passed = results.filter((r) => r.ok).length;
  console.log(`\n${passed}/${results.length} passed`);
  process.exit(passed === results.length ? 0 : 1);
} catch (e) {
  console.error('\nABORTED:', e.message);
  process.exit(1);
}
