#!/usr/bin/env node
/**
 * tilda-edit MCP server.
 *
 * Exposes Tilda's editor write API as MCP tools, authenticated via the local
 * Firefox session (see session.mjs for the browser-like cookie jar). No token
 * is ever stored by the user; the process reads the session from Firefox and
 * maintains a PHPSESSID jar the way a browser does.
 *
 * Requires Firefox to be logged in at https://tilda.ru.
 */
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import {
  readBlock,
  writeBlock,
  renderBlock,
  readRows,
  writeRows,
  listRecords,
  setBlockVisibility,
  publishPage,
  duplicatePage,
  setPageTitle,
  setPageAlias,
  addBlock,
  deleteBlock,
  setBlockImageFrom,
} from './tilda-api.mjs';

const tools = [
  {
    name: 'read_block',
    description:
      "Read a block's fields as JSON. tab='content' for copy, tab='settings' for width/colours/cover overlay. Returns the record object; a block is scalar fields plus one `list` JSON blob of repeatable rows.",
    inputSchema: {
      type: 'object',
      properties: {
        pageid: { type: 'string' },
        recordid: { type: 'string' },
        tab: { type: 'string', enum: ['content', 'settings'], default: 'content' },
      },
      required: ['pageid', 'recordid'],
    },
    run: (a) => readBlock(a.pageid, a.recordid, a.tab || 'content'),
  },
  {
    name: 'write_block',
    description:
      "Write fields to a block (read-modify-write, then verified). Pass only the fields to change in `changes`; the rest are preserved. Use tab='settings' for width12/filteropacity etc. Throws if a field does not persist.",
    inputSchema: {
      type: 'object',
      properties: {
        pageid: { type: 'string' },
        recordid: { type: 'string' },
        changes: { type: 'object', additionalProperties: { type: 'string' } },
        tab: { type: 'string', enum: ['content', 'settings'], default: 'content' },
      },
      required: ['pageid', 'recordid', 'changes'],
    },
    run: (a) => writeBlock(a.pageid, a.recordid, a.changes, a.tab || 'content'),
  },
  {
    name: 'render_block',
    description: "Rendered HTML for one block — to inspect a change without reloading the editor.",
    inputSchema: {
      type: 'object',
      properties: { pageid: { type: 'string' }, recordid: { type: 'string' } },
      required: ['pageid', 'recordid'],
    },
    run: (a) => renderBlock(a.pageid, a.recordid),
  },
  {
    name: 'read_rows',
    description:
      "Read a repeatable block's rows as an array (decodes the escaped `list` JSON). Each row keeps its lid; loff:'y' means a saved-but-hidden row.",
    inputSchema: {
      type: 'object',
      properties: { pageid: { type: 'string' }, recordid: { type: 'string' } },
      required: ['pageid', 'recordid'],
    },
    run: (a) => readRows(a.pageid, a.recordid),
  },
  {
    name: 'write_rows',
    description:
      "Replace a repeatable block's rows. Pass the full array (row shape is block-specific: li_title, li_descr, li_img, lid, loff…). Preserve lid on existing rows.",
    inputSchema: {
      type: 'object',
      properties: {
        pageid: { type: 'string' },
        recordid: { type: 'string' },
        rows: { type: 'array', items: { type: 'object' } },
      },
      required: ['pageid', 'recordid', 'rows'],
    },
    run: (a) => writeRows(a.pageid, a.recordid, a.rows),
  },
  {
    name: 'list_records',
    description:
      "List a page's blocks in order, plus its page info. Returns { page:{title,alias,descr,published}, records:[{recordid,tplid,code,off}] }. off=true means hidden. This is the headless way to enumerate a page's record IDs before editing.",
    inputSchema: {
      type: 'object',
      properties: { pageid: { type: 'string' } },
      required: ['pageid'],
    },
    run: (a) => listRecords(a.pageid),
  },
  {
    name: 'set_block_visibility',
    description:
      "Show or hide a block (idempotent). Pass visible:true to show, false to hide. Reads current state and toggles only if needed. Use to hide booking/price blocks until dates are confirmed, or reveal them later.",
    inputSchema: {
      type: 'object',
      properties: {
        pageid: { type: 'string' },
        recordid: { type: 'string' },
        visible: { type: 'boolean' },
      },
      required: ['pageid', 'recordid', 'visible'],
    },
    run: (a) => setBlockVisibility(a.pageid, a.recordid, a.visible),
  },
  {
    name: 'publish_page',
    description: 'Publish a page (makes changes public). Returns {link,…}. Works headlessly — Tilda accepts an empty CSRF token here.',
    inputSchema: {
      type: 'object',
      properties: { pageid: { type: 'string' } },
      required: ['pageid'],
    },
    run: (a) => publishPage(a.pageid),
  },
  {
    name: 'duplicate_page',
    description:
      'Duplicate a page inside its project (same as the dashboard "Duplicate"). Returns {pageid} of the copy — titled "Copy of …", no alias, unpublished. Use set_page_title / set_page_alias next.',
    inputSchema: { type: 'object', properties: { pageid: { type: 'string' } }, required: ['pageid'] },
    run: (a) => duplicatePage(a.pageid),
  },
  {
    name: 'set_page_title',
    description: "Rename a page (the dashboard/editor title, also the <title>).",
    inputSchema: {
      type: 'object',
      properties: { pageid: { type: 'string' }, title: { type: 'string' } },
      required: ['pageid', 'title'],
    },
    run: (a) => setPageTitle(a.pageid, a.title),
  },
  {
    name: 'set_page_alias',
    description: "Set a page's URL alias (the path after the domain). Needs the projectid too.",
    inputSchema: {
      type: 'object',
      properties: { pageid: { type: 'string' }, projectid: { type: 'string' }, alias: { type: 'string' } },
      required: ['pageid', 'projectid', 'alias'],
    },
    run: (a) => setPageAlias(a.pageid, a.projectid, a.alias),
  },
  {
    name: 'add_block',
    description:
      "Add a new block of type `tplid` (Tilda's numeric block-library id, e.g. 160 = IM02 full-screen image, 30 = TL02 title+text, 127 = TX02 text, 792 = PL305 price) after `afterid` or before `beforeid`. Returns {recordid}. The block comes with the library's placeholder content — write_block it next.",
    inputSchema: {
      type: 'object',
      properties: {
        pageid: { type: 'string' },
        tplid: { type: 'string' },
        afterid: { type: 'string' },
        beforeid: { type: 'string' },
      },
      required: ['pageid', 'tplid'],
    },
    run: (a) => addBlock(a.pageid, a.tplid, { afterid: a.afterid || '', beforeid: a.beforeid || '' }),
  },
  {
    name: 'delete_block',
    description: 'Delete a block from a page. Irreversible from the API (the editor keeps an undo buffer; this does not).',
    inputSchema: {
      type: 'object',
      properties: { pageid: { type: 'string' }, recordid: { type: 'string' } },
      required: ['pageid', 'recordid'],
    },
    run: (a) => deleteBlock(a.pageid, a.recordid),
  },
  {
    name: 'set_block_image',
    description:
      "Change a block's image. `source` is an http(s) URL or a local file path; it is uploaded to Tilda's CDN and assigned to `field` (default `img`) the way the editor's uploader does. Plain write_block cannot change image fields — use this.",
    inputSchema: {
      type: 'object',
      properties: {
        pageid: { type: 'string' },
        recordid: { type: 'string' },
        source: { type: 'string' },
        field: { type: 'string', default: 'img' },
      },
      required: ['pageid', 'recordid', 'source'],
    },
    run: (a) => setBlockImageFrom(a.pageid, a.recordid, a.field || 'img', a.source),
  },
];

const server = new Server(
  { name: 'tilda-edit', version: '1.1.0' },
  { capabilities: { tools: {} } }
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: tools.map(({ name, description, inputSchema }) => ({ name, description, inputSchema })),
}));

server.setRequestHandler(CallToolRequestSchema, async (req) => {
  const tool = tools.find((t) => t.name === req.params.name);
  if (!tool) throw new Error(`Unknown tool: ${req.params.name}`);
  try {
    const result = await tool.run(req.params.arguments || {});
    return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
  } catch (e) {
    return { content: [{ type: 'text', text: 'ERROR: ' + e.message }], isError: true };
  }
});

const transport = new StdioServerTransport();
await server.connect(transport);
console.error('tilda-edit MCP server running on stdio');
