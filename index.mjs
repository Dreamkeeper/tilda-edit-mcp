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
  publishPage,
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
    name: 'publish_page',
    description: 'Publish a page (makes changes public). Returns {link,…}. Fetches the CSRF token itself.',
    inputSchema: {
      type: 'object',
      properties: { pageid: { type: 'string' } },
      required: ['pageid'],
    },
    run: (a) => publishPage(a.pageid),
  },
];

const server = new Server(
  { name: 'tilda-edit', version: '1.0.0' },
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
