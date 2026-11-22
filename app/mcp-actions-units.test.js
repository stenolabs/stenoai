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

const { authorizeFailureCode, redactProviderText } = require('./mcp-actions');

test('authorize failures: an Atlassian account with no site gets its own code', () => {
  const noSite = { code: 'authorize-failed', providerError: 'invalid_request', providerDescription: "Your account isn't associated with a supported site." };
  assert.equal(authorizeFailureCode('atlassian', noSite), 'atlassian-no-site');
  assert.equal(authorizeFailureCode('atlassian', { ...noSite, code: 'denied', providerError: 'access_denied' }), 'atlassian-no-site');
  assert.equal(authorizeFailureCode('atlassian', { code: 'no-code' }), 'atlassian-no-site');
  // Clicking Cancel stays a plain denial; other vendors and errors are untouched.
  assert.equal(authorizeFailureCode('atlassian', { code: 'denied', providerError: 'access_denied', providerDescription: 'User denied access' }), null);
  assert.equal(authorizeFailureCode('atlassian', { code: 'timeout' }), null);
  assert.equal(authorizeFailureCode('linear', noSite), null);
  assert.equal(authorizeFailureCode('atlassian', null), null);
});

test('provider error text is redacted before it is logged', () => {
  const out = redactProviderText('No site for ada@example.com\nBearer abc.def.ghi');
  assert.doesNotMatch(out, /ada@example\.com/);
  assert.doesNotMatch(out, /\n/);
  assert.ok(out.length <= 200);
});

const proposals = require('./mcp-proposals');

test('placeholders: stand-in values are caught, real values are not', () => {
  for (const v of ['not_specified', 'Unspecified', 'unknown', 'TBD', 'n/a', 'None', 'null', '', '  ', '<page id>', '{page_id}', 'your_page_id', 'example_id', 'xxx', '00000000-0000-0000-0000-000000000000', null]) {
    assert.equal(proposals.isPlaceholder(v), true, String(v));
  }
  for (const v of ['Prep release notes', 'Your weekly recap', 'Test the release', '#eng', 'PAGE-42', 0, false]) {
    assert.equal(proposals.isPlaceholder(v), false, String(v));
  }
  const schema = { type: 'object', properties: { page_id: { type: 'string' }, priority: { enum: ['none', 'high'] }, items: { type: 'array' } }, required: ['page_id', 'priority', 'items'] };
  assert.deepEqual(proposals.placeholderArguments(schema, { page_id: 'not_specified', priority: 'none', items: [{ old_str: 'TBD' }] }), ['page_id', 'items']);
  assert.deepEqual(proposals.placeholderArguments(schema, { page_id: 'abc', priority: 'high', items: ['a'] }), []);
  assert.deepEqual(proposals.placeholderArguments(schema, { priority: 'high', items: ['a'] }), ['page_id'], 'missing counts');
});

test('identifiers: only ids written in the note are allowed', () => {
  for (const name of ['id', 'page_id', 'issueId', 'parent', 'parentId', 'parent_page']) assert.equal(proposals.isIdentifierParam(name), true, name);
  for (const name of ['title', 'content', 'idea', 'valid']) assert.equal(proposals.isIdentifierParam(name), false, name);
  const schema = { type: 'object', properties: {}, required: ['page_id', 'content'] };
  const note = 'The launch page is PAGE-42.';
  assert.deepEqual(proposals.ungroundedIdentifiers(schema, { page_id: 'PAGE-42', content: 'x' }, note), []);
  assert.deepEqual(proposals.ungroundedIdentifiers(schema, { page_id: 'PAGE-7', content: 'x' }, note), ['page_id']);
  // An optional id the model leaves to the user is not checked.
  assert.deepEqual(proposals.ungroundedIdentifiers({ required: ['content'] }, { page_id: 'PAGE-7', content: 'x' }, note), []);
  assert.deepEqual(proposals.ungroundedIdentifiers(schema, { page_id: 'Website content cleanup', content: 'x' }, 'Create Website content cleanup'), ['page_id'], 'a title is not an id');
});

test('citations: a proposal must name one of the note action items', () => {
  const items = ['Bob to prep the release notes', 'Alice to tell support'];
  assert.equal(proposals.citedActionItem({ action_item: 2 }, items), 'Alice to tell support');
  assert.equal(proposals.citedActionItem({ action_item: '1' }, items), 'Bob to prep the release notes');
  assert.equal(proposals.citedActionItem({ action_item: 'Alice to tell support' }, items), 'Alice to tell support');
  for (const ref of [0, 3, 'Someone else', undefined, null, 1.5]) assert.equal(proposals.citedActionItem({ action_item: ref }, items), null, String(ref));
  const note = { title: 'Sync', summary: 'Page PAGE-42', action_items: items };
  const schema = { required: ['page_id', 'content'] };
  assert.deepEqual(proposals.checkProposal({ action_item: 1, arguments: { page_id: 'PAGE-42', content: 'x' } }, schema, note), { ok: true, actionItem: items[0] });
  assert.equal(proposals.checkProposal({ arguments: { page_id: 'PAGE-42', content: 'x' } }, schema, note).reason, 'uncited');
  assert.equal(proposals.checkProposal({ action_item: 1, arguments: { page_id: 'not_specified', content: 'x' } }, schema, note).reason, 'placeholder');
  assert.equal(proposals.checkProposal({ action_item: 1, arguments: { page_id: 'PAGE-1', content: 'x' } }, schema, note).reason, 'ungrounded-id');
});
