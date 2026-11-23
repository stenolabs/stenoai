#!/usr/bin/env node
'use strict';

/**
 * A tiny MCP server over stdio (newline-delimited JSON-RPC), for the local
 * command servers of Suggested actions (app/mcp-stdio-client.js,
 * mcp-stdio-client.test.js). No SDK: it speaks the wire format directly, so
 * the client is tested against the spec rather than against itself.
 *
 * Tools: create_note (write), whoami (read-only; echoes MOCK_SECRET's length
 * and whether STENO_PARENT_ONLY leaked in), fail (a tool error), slow (never
 * answers). Behaviour switches, from the environment:
 *   MOCK_STDIO_MODE=silent     never answers initialize (handshake timeout)
 *   MOCK_STDIO_MODE=banner     prints a non-JSON banner line on stdout first
 *   MOCK_STDIO_MODE=exit-on-call  exits when a tool is called
 *   MOCK_STDIO_GRANDCHILD=<file>  starts a long-lived grandchild and writes
 *                                 "<self pid> <grandchild pid>" to <file>
 *   MOCK_STDIO_CALLS=<file>    appends each tools/call as a JSON line
 */

const fs = require('node:fs');
const { spawn } = require('node:child_process');

const mode = process.env.MOCK_STDIO_MODE || '';

if (process.env.MOCK_STDIO_GRANDCHILD) {
  const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
  fs.writeFileSync(process.env.MOCK_STDIO_GRANDCHILD, `${process.pid} ${child.pid}`);
}
if (mode === 'banner') process.stdout.write('Starting mock server v1...\n');
process.stderr.write(`mock stderr secret=${process.env.MOCK_SECRET || ''}\n`);

const TOOLS = [
  {
    name: 'create_note',
    title: 'Create note',
    description: 'Create a note in the local notebook.',
    inputSchema: {
      type: 'object',
      properties: { title: { type: 'string' }, body: { type: 'string' } },
      required: ['title'],
    },
  },
  {
    name: 'whoami',
    description: 'Report what the server can see.',
    inputSchema: { type: 'object', properties: {} },
    annotations: { readOnlyHint: true },
  },
  { name: 'fail', description: 'Always fails.', inputSchema: { type: 'object', properties: {} } },
  { name: 'slow', description: 'Never answers.', inputSchema: { type: 'object', properties: {} } },
];

const send = (msg) => process.stdout.write(`${JSON.stringify(msg)}\n`);
const reply = (id, result) => send({ jsonrpc: '2.0', id, result });

function handle(msg) {
  if (!msg || typeof msg !== 'object' || msg.id === undefined) return; // notifications
  switch (msg.method) {
    case 'initialize':
      if (mode === 'silent') return;
      reply(msg.id, {
        protocolVersion: msg.params?.protocolVersion || '2025-06-18',
        capabilities: { tools: {} },
        serverInfo: { name: 'mock-stdio', version: '1.0.0' },
      });
      return;
    case 'ping':
      reply(msg.id, {});
      return;
    case 'tools/list':
      reply(msg.id, { tools: TOOLS });
      return;
    case 'tools/call': {
      const { name, arguments: args = {} } = msg.params || {};
      if (process.env.MOCK_STDIO_CALLS) fs.appendFileSync(process.env.MOCK_STDIO_CALLS, `${JSON.stringify({ name, args })}\n`);
      if (mode === 'exit-on-call') process.exit(3);
      if (name === 'create_note') {
        reply(msg.id, { content: [{ type: 'text', text: `Created "${args.title}" at https://notes.example.test/n/1` }] });
      } else if (name === 'whoami') {
        reply(msg.id, {
          content: [{
            type: 'text',
            text: JSON.stringify({ secretLength: (process.env.MOCK_SECRET || '').length, parentLeak: Boolean(process.env.STENO_PARENT_ONLY) }),
          }],
        });
      } else if (name === 'fail') {
        reply(msg.id, { isError: true, content: [{ type: 'text', text: 'Notebook is locked' }] });
      } else if (name === 'slow') {
        // never answers
      } else {
        send({ jsonrpc: '2.0', id: msg.id, error: { code: -32602, message: `Unknown tool ${name}` } });
      }
      return;
    }
    default:
      send({ jsonrpc: '2.0', id: msg.id, error: { code: -32601, message: 'Method not found' } });
  }
}

let buffer = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  buffer += chunk;
  let nl = buffer.indexOf('\n');
  while (nl !== -1) {
    const line = buffer.slice(0, nl).trim();
    buffer = buffer.slice(nl + 1);
    if (line) {
      try { handle(JSON.parse(line)); } catch (_) { /* ignore */ }
    }
    nl = buffer.indexOf('\n');
  }
});
process.stdin.on('end', () => process.exit(0));
