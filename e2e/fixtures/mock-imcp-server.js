#!/usr/bin/env node
// Mock of iMCP's `imcp-server` bridge for tests: an MCP server on stdio that
// offers the two tools Steno uses, `phone_calls_fetch` and `contacts_search`.
// Point the app at it with STENOAI_IMCP_SERVER=<this file>.
//
// Driven by environment variables, all optional:
//   MOCK_IMCP_TOOLS     comma-separated tool names to offer (default: both)
//   MOCK_IMCP_CALLS     path to a JSON array of call entries, in the shape iMCP
//                       returns them in `itemListElement`; re-read on every call
//   MOCK_IMCP_CONTACTS  path to a JSON object mapping a number to the array of
//                       schema.org Person objects `contacts_search` returns
//   MOCK_IMCP_REFUSE=1  close the connection on initialize, as iMCP does when
//                       the user refuses a client in its approval window
//
// Stdio MCP is newline-delimited JSON-RPC; this answers the legacy handshake.
const fs = require('node:fs');
const readline = require('node:readline');

const offered = (process.env.MOCK_IMCP_TOOLS ?? 'phone_calls_fetch,contacts_search')
  .split(',').map((s) => s.trim()).filter(Boolean);

function readJson(file, fallback) {
  if (!file) return fallback;
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return fallback;
  }
}

const send = (message) => process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', ...message })}\n`);
const text = (value) => ({ content: [{ type: 'text', text: JSON.stringify(value) }], isError: false });

function callTool(name, args = {}) {
  if (!offered.includes(name)) {
    return { content: [{ type: 'text', text: `Tool not found or service not enabled: ${name}` }], isError: true };
  }
  if (name === 'phone_calls_fetch') {
    const calls = readJson(process.env.MOCK_IMCP_CALLS, []);
    const limit = Number.isInteger(args.limit) ? args.limit : 30;
    const newestFirst = [...calls].sort((a, b) => Date.parse(b.date) - Date.parse(a.date));
    const items = newestFirst.slice(0, limit);
    return text({ '@context': 'https://schema.org', '@type': 'ItemList', name: 'Call History',
      numberOfItems: items.length, itemListElement: items });
  }
  const contacts = readJson(process.env.MOCK_IMCP_CONTACTS, {});
  return text(contacts[args.phone] ?? []);
}

readline.createInterface({ input: process.stdin }).on('line', (line) => {
  let message;
  try {
    message = JSON.parse(line);
  } catch {
    return;
  }
  const { id, method, params } = message;
  if (id === undefined) return; // notifications need no answer
  switch (method) {
    case 'initialize':
      if (process.env.MOCK_IMCP_REFUSE === '1') process.exit(0);
      send({ id, result: {
        protocolVersion: params?.protocolVersion,
        capabilities: { tools: { listChanged: true } },
        serverInfo: { name: 'iMCP (mock)', version: '0' },
      } });
      break;
    case 'tools/list':
      send({ id, result: { tools: offered.map((name) => ({ name, inputSchema: { type: 'object' } })) } });
      break;
    case 'tools/call':
      send({ id, result: callTool(params?.name, params?.arguments) });
      break;
    case 'ping':
      send({ id, result: {} });
      break;
    default:
      send({ id, error: { code: -32601, message: `Method not found: ${method}` } });
  }
});
