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
