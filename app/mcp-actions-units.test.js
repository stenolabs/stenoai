'use strict';

// Small-unit coverage for the Suggested actions building blocks: schema
// validation, endpoint URL rules, the secret store, the audit hash, tool
// result links and credential redaction in diagnostics.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { validateArguments, compactSchema } = require('./mcp-schema');
const { normalizeEndpointUrl, normalizeHeaderName } = require('./mcp-connections');
const { createSecretStore } = require('./mcp-secret-store');
const { argumentsHash, canonicalJson } = require('./mcp-audit-log');
const { resultLink } = require('./mcp-remote-client');
const { redactCredentials, sanitizeArgsForLog } = require('./diagnostics-filter');
const { connectorById, publicCatalogue } = require('./mcp-connectors');

const schema = {
  type: 'object',
  properties: {
    title: { type: 'string', minLength: 1, maxLength: 5 },
    count: { type: 'integer', minimum: 1 },
    tags: { type: 'array', items: { type: 'string' }, maxItems: 2 },
    kind: { enum: ['a', 'b'] },
    who: { anyOf: [{ type: 'string' }, { type: 'null' }] },
  },
  required: ['title'],
  additionalProperties: false,
};

test('schema validation', () => {
  assert.deepEqual(validateArguments(schema, { title: 'ok' }), []);
  const errs = validateArguments(schema, { title: '', count: 1.5, tags: ['a', 'b', 3], kind: 'c', who: 3, extra: 1 });
  const paths = errs.map((e) => e.path).sort();
  assert.deepEqual(paths, ['$.count', '$.extra', '$.kind', '$.tags', '$.tags[2]', '$.title', '$.who']);
  assert.deepEqual(validateArguments(schema, {}).map((e) => e.path), ['$.title']);
  assert.equal(validateArguments(schema, []).length, 1, 'root must be an object');
  assert.deepEqual(validateArguments(undefined, { anything: 1 }), [], 'no schema accepts objects');
});

test('compactSchema clips descriptions and keeps structure', () => {
  const c = compactSchema({ type: 'object', description: 'x'.repeat(500), properties: { a: { type: 'string', description: 'y', examples: ['z'] } } });
  assert.equal(c.description.length, 200);
  assert.deepEqual(c.properties.a, { type: 'string', description: 'y' });
});

test('endpoint URLs: https anywhere, http only on device or local network', () => {
  assert.equal(normalizeEndpointUrl('https://hooks.zapier.com/mcp').locality, 'internet');
  assert.equal(normalizeEndpointUrl('http://localhost:5678/mcp/abc').locality, 'device');
  assert.equal(normalizeEndpointUrl('http://192.168.1.20:5678/mcp').locality, 'network');
  assert.equal(normalizeEndpointUrl('http://n8n.local/mcp').locality, 'network');
  assert.equal(normalizeEndpointUrl('http://example.com/mcp'), null);
  assert.equal(normalizeEndpointUrl('https://user:pw@example.com/mcp'), null);
  assert.equal(normalizeEndpointUrl('https://example.com/mcp#frag'), null);
  assert.equal(normalizeEndpointUrl('ftp://example.com'), null);
  assert.equal(normalizeEndpointUrl('https://exa mple.com'), null);
  assert.equal(normalizeHeaderName('X-Api-Key'), 'X-Api-Key');
  assert.equal(normalizeHeaderName('Host'), null);
  assert.equal(normalizeHeaderName('Bad Header'), null);
});

test('secret store encrypts, binds to origin and writes 0600', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'steno-secrets-'));
  try {
    const safeStorage = {
      isEncryptionAvailable: () => true,
      encryptString: (s) => Buffer.from(s).reverse(),
      decryptString: (b) => Buffer.from(b).reverse().toString(),
    };
    const store = createSecretStore({ dir, safeStorage });
    store.save('conn:1', 'https://a.example', { token: 'sekret' });
    assert.deepEqual(store.load('conn:1', 'https://a.example'), { token: 'sekret' });
    assert.equal(store.load('conn:1', 'https://b.example'), null);
    const file = store.fileFor('conn:1');
    assert.ok(!fs.readFileSync(file).toString().includes('sekret'));
    if (process.platform !== 'win32') assert.equal(fs.statSync(file).mode & 0o777, 0o600);
    assert.ok(!path.basename(file).includes('conn'), 'file name is a hash');
    store.remove('conn:1');
    assert.equal(store.load('conn:1', 'https://a.example'), null);
    const unavailable = createSecretStore({ dir, safeStorage: { ...safeStorage, isEncryptionAvailable: () => false } });
    assert.throws(() => unavailable.save('k', 'https://a.example', 'x'), /Secure storage/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('argument hash is canonical', () => {
  assert.equal(canonicalJson({ b: 1, a: [{ d: 1, c: 2 }] }), '{"a":[{"c":2,"d":1}],"b":1}');
  assert.equal(argumentsHash({ a: 1, b: 2 }), argumentsHash({ b: 2, a: 1 }));
  assert.notEqual(argumentsHash({ a: 1 }), argumentsHash({ a: 2 }));
});

test('result link: structured url, resource link, then text; https only', () => {
  assert.equal(resultLink({ structuredContent: { url: 'https://x.example/1' } }), 'https://x.example/1');
  assert.equal(resultLink({ content: [{ type: 'resource_link', uri: 'https://x.example/2' }] }), 'https://x.example/2');
  assert.equal(resultLink({ content: [{ type: 'text', text: 'Created (https://x.example/3).' }] }), 'https://x.example/3');
  assert.equal(resultLink({ content: [{ type: 'text', text: 'javascript:alert(1) http://x.example' }] }), null);
});

test('diagnostics redact credentials and the suggest-actions note path', () => {
  assert.equal(redactCredentials('Authorization: Bearer abcdefghijkl123'), 'Authorization: Bearer <redacted>');
  assert.equal(redactCredentials('POST /token?code=abc123&state=s'), 'POST /token?code=<redacted>&state=s');
  assert.equal(redactCredentials('{"access_token":"at-1","expires_in":3600}'), '{"access_token":"<redacted>","expires_in":3600}');
  assert.equal(redactCredentials('Command completed with exit code: 0'), 'Command completed with exit code: 0');
  assert.equal(sanitizeArgsForLog(['suggest-actions', '/x/Board review_summary.md', '--tools-file', '/t']), 'suggest-actions <redacted>');
});

test('connector catalogue: HubSpot and Asana need registration, Atlassian is not DCR-cached', () => {
  const byId = Object.fromEntries(publicCatalogue().map((c) => [c.id, c]));
  assert.equal(byId.linear.url, 'https://mcp.linear.app/mcp');
  assert.equal(byId.notion.url, 'https://mcp.notion.com/mcp');
  assert.equal(byId.atlassian.url, 'https://mcp.atlassian.com/v2/mcp');
  assert.equal(byId.hubspot.status, 'needs-registration');
  assert.equal(byId.asana.status, 'needs-registration');
  assert.equal(connectorById('atlassian').noDcrCache, true);
  assert.equal(connectorById('hubspot').staticClient, null);
});

test('IPC: note paths are validated, ids type-checked, errors carry a code and no internals', async () => {
  const { registerMcpActionsIpc } = require('./mcp-actions-ipc');
  const { ActionError } = require('./mcp-actions');
  const handlers = {};
  const calls = [];
  const service = {
    approve: async (...a) => { calls.push(a); return { id: 'c1', status: 'done' }; },
    list: async () => { throw new Error('boom with secret at-abc'); },
    remove: () => { throw new ActionError('not-found', 'Connection not found'); },
  };
  registerMcpActionsIpc({
    ipcMain: { handle: (ch, fn) => { handlers[ch] = fn; } },
    getService: () => service,
    validateMeetingFilePath: async (f) => (f === 'ok.json' ? { realPath: '/real/ok.json' } : { error: 'outside' }),
  });
  assert.deepEqual(await handlers['actions-approve']({}, 'evil.json', 'c1', { a: 1 }), { success: false, error_code: 'invalid-note', error: 'Note not found' });
  assert.equal((await handlers['actions-approve']({}, 'ok.json', '../x', { a: 1 })).error_code, 'invalid-id');
  assert.equal((await handlers['actions-approve']({}, 'ok.json', 'c1', [1])).error_code, 'invalid-arguments');
  const ok = await handlers['actions-approve']({}, 'ok.json', 'c1', { a: 1 });
  assert.equal(ok.success, true);
  assert.deepEqual(calls, [['/real/ok.json', 'c1', { a: 1 }]]);
  assert.deepEqual(await handlers['actions-list']({}), { success: false, error_code: 'error', error: 'Something went wrong' });
  assert.deepEqual(await handlers['actions-remove']({}, 'x'), { success: false, error_code: 'not-found', error: 'Connection not found' });
});
