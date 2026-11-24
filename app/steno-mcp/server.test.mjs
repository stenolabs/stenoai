// Drives the Steno MCP server over real stdio with the MCP client SDK: once
// from source, once from the packaged bundle, and checks the .mcpb archive.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { buildStenoMcp } from '../scripts/build-steno-mcp.mjs';
import { readZip } from '../scripts/zip-store.mjs';
import { makeTempDir, seedStore, writeConfig } from './test-fixtures.mjs';
import { createDiagnostics, LOG_MAX_BYTES, redact } from './diagnostics.mjs';
import { callTool } from './server.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
let built;

before(async () => {
  built = await buildStenoMcp({ outDir: makeTempDir('steno-mcp-build-'), quiet: true });
});
after(() => fs.rmSync(built.outDir, { recursive: true, force: true }));

async function connect(entry, dataDir) {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [entry],
    env: { ...process.env, STENOAI_USER_DATA_DIR: dataDir },
    stderr: 'pipe',
  });
  const client = new Client({ name: 'steno-mcp-test', version: '1.0.0' }, { capabilities: {} });
  await client.connect(transport);
  return client;
}

const text = (result) => result.content.map((c) => c.text).join('');

for (const [label, entry] of [
  ['source', () => path.join(HERE, 'index.mjs')],
  ['bundle', () => built.bundlePath],
]) {
  test(`${label}: lists read-only tools and serves seeded meetings`, async () => {
    const dir = makeTempDir();
    seedStore(dir);
    writeConfig(dir, { mcp_folder_allowlist: ['f-sales'] });
    const client = await connect(entry(), dir);
    try {
      const { tools } = await client.listTools();
      assert.deepEqual(
        tools.map((t) => t.name).sort(),
        ['get_note', 'get_transcript', 'list_action_items', 'list_folders', 'search_meetings'],
      );
      for (const t of tools) {
        assert.equal(t.annotations?.readOnlyHint, true, t.name);
        assert.equal(t.annotations?.destructiveHint, false, t.name);
      }
      const search = JSON.parse(text(await client.callTool({ name: 'search_meetings', arguments: { query: 'pricing' } })));
      assert.deepEqual(search.results.map((r) => r.id), ['acme-kickoff']);
      const note = await client.callTool({ name: 'get_note', arguments: { id: 'acme-kickoff' } });
      assert.match(text(note), /# Acme kickoff/);
      // Outside the allowlist: not found, same as a nonexistent id.
      const hidden = await client.callTool({ name: 'get_note', arguments: { id: 'eng-standup' } });
      assert.equal(hidden.isError, true);
      const escape = await client.callTool({ name: 'get_note', arguments: { id: '../../config' } });
      assert.equal(escape.isError, true);
      if (label === 'bundle') {
        assert.equal(client.getServerVersion()?.version, built.version);
      }
      // Each tool call stamps last-used under the client's own name.
      const stamp = JSON.parse(fs.readFileSync(path.join(dir, 'steno-mcp-last-used.json'), 'utf8'));
      assert.ok(Number.isFinite(Date.parse(stamp.clients['steno-mcp-test'])));
      assert.equal(stamp.last_used_at, stamp.clients['steno-mcp-test']);
      // The hidden/escape lookups were logged as a class only: no ids, no content.
      const log = fs.readFileSync(path.join(dir, 'logs', 'steno-mcp.log'), 'utf8');
      assert.match(log, /ERROR tool=get_note tool: ToolError\n/);
      assert.doesNotMatch(log, /eng-standup|config|Acme|pricing/);
    } finally {
      await client.close();
    }
  });
}

test('the .mcpb holds a valid manifest and the runnable bundle', () => {
  const files = readZip(fs.readFileSync(built.mcpbPath));
  assert.deepEqual(Object.keys(files).sort(), ['icon.png', 'manifest.json', 'server/index.mjs']);
  const manifest = JSON.parse(files['manifest.json'].toString('utf8'));
  assert.equal(manifest.manifest_version, '0.3');
  assert.equal(manifest.version, built.version);
  assert.equal(manifest.server.type, 'node');
  assert.equal(manifest.server.entry_point, 'server/index.mjs');
  assert.deepEqual(manifest.server.mcp_config.args, ['${__dirname}/server/index.mjs']);
  assert.deepEqual(files['server/index.mjs'], fs.readFileSync(built.bundlePath));
  assert.ok(!files['server/index.mjs'].toString('utf8').includes('__STENO_VERSION__'));
});

test('diagnostics redact content, cap the log, and keep stderr prefixed', () => {
  assert.equal(
    redact('Unexpected token, "Pricing agreed" is not valid JSON in /Users/a/Library/Application Support/stenoai/output/x.md'),
    'Unexpected token, "…" is not valid JSON in <path>',
  );
  assert.equal(redact('EACCES: open C:\\Users\\Ada Lovelace\\notes.md'), 'EACCES: open <path>');
  const dir = makeTempDir();
  const lines = [];
  const d = createDiagnostics({ dataDir: dir, stderr: { write: (l) => lines.push(l) } });
  d.logError('tool', new TypeError("Cannot read 'x' of /secret/path"), { tool: 'search_meetings' });
  assert.match(lines[0], /^\[steno-mcp\] error: tool=search_meetings tool: TypeError: Cannot read "…" of <path>\n$/);
  const big = 'x'.repeat(200);
  for (let i = 0; i < (LOG_MAX_BYTES / 200) * 2; i += 1) d.log('error', big);
  assert.ok(fs.statSync(d.logPath).size <= LOG_MAX_BYTES);
  assert.ok(fs.existsSync(`${d.logPath}.1`));
  assert.deepEqual(fs.readdirSync(path.join(dir, 'logs')).sort(), ['steno-mcp.log', 'steno-mcp.log.1']);
});

test('last-used is throttled per client and merges clients', () => {
  const dir = makeTempDir();
  let t = Date.parse('2026-11-22T10:00:00.000Z');
  const d = createDiagnostics({ dataDir: dir, now: () => new Date(t), stderr: { write() {} } });
  const read = () => JSON.parse(fs.readFileSync(d.lastUsedPath, 'utf8'));
  d.markUsed('claude-code');
  t += 1000;
  d.markUsed('claude-code');
  assert.equal(read().clients['claude-code'], '2026-11-22T10:00:00.000Z');
  d.markUsed('codex-mcp-client');
  t += 60_000;
  d.markUsed('claude-code');
  assert.deepEqual(read(), {
    last_used_at: '2026-11-22T10:01:01.000Z',
    clients: { 'claude-code': '2026-11-22T10:01:01.000Z', 'codex-mcp-client': '2026-11-22T10:00:01.000Z' },
  });
  d.markUsed(undefined);
  assert.ok(read().clients.unknown);
});

test('an unexpected tool failure is logged without leaking internals to the assistant', () => {
  const dir = makeTempDir();
  fs.writeFileSync(path.join(dir, 'config.json'), '{ not json');
  const lines = [];
  const diagnostics = createDiagnostics({ dataDir: dir, stderr: { write: (l) => lines.push(l) } });
  const result = callTool('list_folders', {}, { env: { STENOAI_USER_DATA_DIR: dir } }, { diagnostics, clientName: 'x' });
  assert.equal(result.isError, true);
  assert.match(lines.join(''), /\[steno-mcp\] error: tool=list_folders tool: /);
  assert.ok(fs.existsSync(diagnostics.logPath));
});
