'use strict';

// End-to-end tests of the Suggested actions service (mcp-actions.js) against
// the real mock MCP server fixture (e2e/fixtures/mock-mcp-server.js) over
// Streamable HTTP: bearer and header endpoints, the full OAuth 2.1 DCR flow
// through the loopback listener, approve / dismiss / audit, org policy,
// refresh rotation and re-prompt, and that secrets never land in config.

const { test, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { createActionsService, allowedByList } = require('./mcp-actions');
const { startMockMcpServer, followAuthorizeRedirect } = require('../e2e/fixtures/mock-mcp-server');

const fakeSafeStorage = {
  isEncryptionAvailable: () => true,
  encryptString: (s) => Buffer.from(`enc:${Buffer.from(s, 'utf8').toString('base64')}`),
  decryptString: (b) => Buffer.from(b.toString().slice(4), 'base64').toString('utf8'),
};

let dir;
let summary;
let mock;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'steno-actions-'));
  summary = path.join(dir, 'output', 'standup_summary.json');
  fs.mkdirSync(path.dirname(summary), { recursive: true });
  fs.writeFileSync(summary, '{}');
});

afterEach(async () => {
  if (mock) await mock.close();
  mock = null;
  fs.rmSync(dir, { recursive: true, force: true });
});

function service(overrides = {}) {
  return createActionsService({
    userDataDir: dir,
    safeStorage: fakeSafeStorage,
    fetch: (...a) => fetch(...a),
    openAuthorizeUrl: followAuthorizeRedirect,
    runSuggest: async () => ({ success: true, proposals: [] }),
    ...overrides,
  });
}

const allFiles = (d) => fs.readdirSync(d, { recursive: true }).map((f) => path.join(d, f)).filter((f) => fs.statSync(f).isFile());

test('bearer endpoint: connect, list tools, secret only in encrypted store', async () => {
  mock = await startMockMcpServer({ auth: 'bearer', token: 'tok-123' });
  const svc = service();
  const c = await svc.addCustom({ name: 'n8n', url: mock.url, auth: 'bearer', token: 'tok-123' });
  assert.equal(c.status, 'ok');
  assert.deepEqual(c.tools.map((t) => t.name).sort(), ['create_issue', 'search_issues', 'send_message']);
  assert.equal(c.locality, 'device');
  const config = fs.readFileSync(path.join(dir, 'mcp-connections.json'), 'utf8');
  assert.ok(!config.includes('tok-123'), 'token not in config');
  for (const f of allFiles(dir)) assert.ok(!fs.readFileSync(f, 'utf8').includes('tok-123'), `plaintext token in ${f}`);
});

test('wrong bearer token leaves the connection flagged, not crashed', async () => {
  mock = await startMockMcpServer({ auth: 'bearer', token: 'right' });
  const c = await service().addCustom({ name: 'x', url: mock.url, auth: 'bearer', token: 'wrong' });
  assert.equal(c.status, 'needs-auth');
  assert.equal(c.tools.length, 0);
});

test('custom header endpoint (Zapier/Make style)', async () => {
  mock = await startMockMcpServer({ auth: 'header', headerName: 'X-Api-Key', token: 'hdr-1' });
  const c = await service().addCustom({ name: 'Zap', url: mock.url, auth: 'header', headerName: 'X-Api-Key', token: 'hdr-1' });
  assert.equal(c.status, 'ok');
  assert.equal(c.headerName, 'X-Api-Key');
});

test('rejects unsafe URLs and reserved headers', async () => {
  const svc = service();
  await assert.rejects(svc.addCustom({ name: 'x', url: 'http://example.com/mcp', auth: 'none' }), { code: 'invalid-url' });
  await assert.rejects(svc.addCustom({ name: 'x', url: 'https://u:p@example.com/mcp', auth: 'none' }), { code: 'invalid-url' });
  await assert.rejects(svc.addCustom({ name: 'x', url: 'https://example.com/mcp', auth: 'header', headerName: 'Host', token: 't' }), { code: 'invalid-header' });
  await assert.rejects(svc.addCustom({ name: 'x', url: 'https://example.com/mcp', auth: 'bearer', token: 'a\nb' }), { code: 'invalid-token' });
});

test('suggest → approve sends exactly the edited args; dismiss sends nothing; audit written', async () => {
  mock = await startMockMcpServer({ auth: 'bearer', token: 't' });
  let toolsSeen = null;
  const svc = service({
    runSuggest: async (summaryPath, toolsFile) => {
      assert.equal(summaryPath, summary);
      toolsSeen = JSON.parse(fs.readFileSync(toolsFile, 'utf8'));
      const id = toolsSeen.tools[0].connection_id;
      return {
        success: true,
        proposals: [
          { connection_id: id, tool: 'create_issue', arguments: { title: 'Prep release notes', priority: 'high' }, reason: 'Bob owns it' },
          { connection_id: id, tool: 'send_message', arguments: { channel: '#eng', text: 'Ship Friday' } },
          { connection_id: id, tool: 'search_issues', arguments: { query: 'x' } }, // read-only: not offered
          { connection_id: 'nope', tool: 'create_issue', arguments: { title: 'x' } }, // unknown connection
          { connection_id: id, tool: 'create_issue', arguments: { priority: 'urgent' } }, // invalid: kept with errors
        ],
      };
    },
  });
  await svc.addCustom({ name: 'n8n', url: mock.url, auth: 'bearer', token: 't' });
  const { cards } = await svc.suggest(summary);
  assert.ok(!toolsSeen.tools.some((t) => t.tool === 'search_issues'), 'read-only tools are not offered');
  assert.equal(cards.length, 3);
  assert.equal(cards[2].validationErrors.length, 2, 'missing title + bad enum');
  assert.ok(!fs.existsSync(path.join(dir, 'tmp')) || fs.readdirSync(path.join(dir, 'tmp')).length === 0, 'tools file removed');

  // Invalid edits are refused before anything is sent.
  await assert.rejects(svc.approve(summary, cards[0].id, { title: '' }), { code: 'invalid-arguments' });
  assert.equal(mock.calls().length, 0);

  const edited = { title: 'Prep release notes v2', priority: 'medium' };
  const done = await svc.approve(summary, cards[0].id, edited);
  assert.equal(done.status, 'done');
  assert.equal(done.result.link, 'https://mock.example/items/1');
  assert.deepEqual(mock.calls(), [{ name: 'create_issue', args: edited }]);
  await assert.rejects(svc.approve(summary, cards[0].id, edited), { code: 'invalid-state' }, 'no double run');

  await svc.dismiss(summary, cards[1].id);
  assert.equal(mock.calls().length, 1, 'dismiss sends nothing');

  const log = svc.recent();
  assert.equal(log.length, 1);
  assert.equal(log[0].tool, 'create_issue');
  assert.equal(log[0].status, 'ok');
  assert.match(log[0].argumentsSha256, /^[0-9a-f]{64}$/);
  const raw = fs.readFileSync(path.join(dir, 'mcp-actions-audit.jsonl'), 'utf8');
  assert.ok(!raw.includes('Prep release notes'), 'arguments are hashed, not logged');

  // Cards persist per note; a fresh suggest keeps history, replaces open ones.
  const again = await service().getCards(summary);
  assert.deepEqual(again.map((c) => c.status), ['done', 'dismissed', 'proposed']);
});

test('auto-suggest respects the setting and never replaces existing cards', async () => {
  mock = await startMockMcpServer({ auth: 'none' });
  let runs = 0;
  const svc = service({
    runSuggest: async (_s, toolsFile) => {
      runs += 1;
      const id = JSON.parse(fs.readFileSync(toolsFile, 'utf8')).tools[0].connection_id;
      return { success: true, proposals: [{ connection_id: id, tool: 'create_issue', arguments: { title: 'A' } }] };
    },
  });
  await svc.addCustom({ name: 'local', url: mock.url, auth: 'none' });
  svc.setAutoSuggest(false);
  assert.equal((await svc.suggest(summary, { auto: true })).skipped, true);
  svc.setAutoSuggest(true);
  assert.equal((await svc.suggest(summary, { auto: true })).cards.length, 1);
  assert.equal((await svc.suggest(summary, { auto: true })).skipped, true);
  assert.equal(runs, 1);
});

test('org policy: disabled blocks everything; allowlist blocks other endpoints', async () => {
  mock = await startMockMcpServer({ auth: 'none' });
  let policy = { actionsEnabled: false, endpointAllowlist: null, managed: true };
  const svc = service({ getPolicy: async () => policy });
  await assert.rejects(svc.addCustom({ name: 'x', url: mock.url, auth: 'none' }), { code: 'disabled-by-org' });
  policy = { actionsEnabled: true, endpointAllowlist: ['https://n8n.corp.example'], managed: true };
  await assert.rejects(svc.addCustom({ name: 'x', url: mock.url, auth: 'none' }), { code: 'endpoint-not-allowed' });
  policy = { actionsEnabled: true, endpointAllowlist: [mock.base], managed: true };
  const c = await svc.addCustom({ name: 'x', url: mock.url, auth: 'none' });
  assert.equal(c.status, 'ok');
  // Policy is re-checked at approve time, not only when connecting.
  const svc2 = service({
    getPolicy: async () => policy,
    runSuggest: async () => ({ success: true, proposals: [{ connection_id: c.id, tool: 'create_issue', arguments: { title: 'A' } }] }),
  });
  const { cards } = await svc2.suggest(summary);
  policy = { actionsEnabled: true, endpointAllowlist: ['https://elsewhere.example'], managed: true };
  await assert.rejects(svc2.approve(summary, cards[0].id, { title: 'A' }), { code: 'endpoint-not-allowed' });
  assert.equal(mock.calls().length, 0);
});

test('allowlist matching is by origin and path prefix', () => {
  assert.equal(allowedByList('https://a.example/mcp', null), true);
  assert.equal(allowedByList('https://a.example/mcp', ['https://a.example']), true);
  assert.equal(allowedByList('https://a.example/mcp/x', ['https://a.example/mcp']), true);
  assert.equal(allowedByList('https://a.example/mcpx', ['https://a.example/mcp']), false);
  assert.equal(allowedByList('https://a.example.evil.com/mcp', ['https://a.example']), false);
  assert.equal(allowedByList('https://a.example/mcp', []), false);
});

test('OAuth: discovery, DCR, PKCE + resource, loopback, tools; refresh rotates; invalid_grant re-prompts', async () => {
  mock = await startMockMcpServer({ auth: 'oauth', accessTtlSeconds: 3600 });
  let clock = Date.now();
  const svc = service({ now: () => clock });
  const c = await svc.addCustom({ name: 'Linear-like', url: mock.url, auth: 'oauth' });
  assert.equal(c.status, 'ok');
  assert.equal(c.tools.length, 3);
  assert.equal(mock.registrations().length, 1, 'registered once');
  const reg = mock.registrations()[0];
  assert.match(reg.redirect_uris[0], /^http:\/\/127\.0\.0\.1:\d+\/callback$/);
  assert.equal(reg.metadata.token_endpoint_auth_method, 'none');
  const authz = mock.authorizeRequests()[0];
  assert.equal(authz.code_challenge_method, 'S256');
  assert.equal(authz.resource, mock.url);
  assert.equal(authz.scope, 'actions');
  assert.ok(mock.tokenRequests().every((r) => r.resource === mock.url), 'resource on every token request');

  // Sign in again: the DCR registration is reused for the same issuer.
  await svc.authorize(c.id);
  assert.equal(mock.registrations().length, 1, 'DCR cached per issuer');

  // Expiry → proactive refresh with rotation, persisted.
  clock += 3600 * 1000;
  await svc.refreshTools(c.id);
  const grants = mock.tokenRequests().map((r) => r.grant_type);
  assert.equal(grants.filter((g) => g === 'refresh_token').length, 1);

  // Refresh token revoked server-side → needs sign-in, no crash.
  mock.revokeAllRefreshTokens();
  mock.revokeAllAccessTokens();
  await assert.rejects(svc.refreshTools(c.id), { code: 'needs-auth' });
  const listed = (await svc.list()).connections.find((x) => x.id === c.id);
  assert.equal(listed.status, 'needs-auth');

  for (const f of allFiles(dir)) {
    const text = fs.readFileSync(f, 'utf8');
    assert.ok(!/\b(at|rt)-[A-Za-z0-9_-]{10,}/.test(text), `plaintext OAuth token in ${f}`);
  }
});

test('OAuth: CIMD is used when the server advertises it (no DCR)', async () => {
  const cimd = 'https://stenoai.co/oauth/client.json';
  mock = await startMockMcpServer({ auth: 'oauth', cimd });
  const c = await service().addCustom({ name: 'cimd', url: mock.url, auth: 'oauth' });
  assert.equal(c.status, 'ok');
  assert.equal(mock.registrations().length, 0);
  assert.equal(mock.authorizeRequests()[0].client_id, cimd);
});

test('OAuth: cancelled sign-in leaves the connection asking to sign in', async () => {
  mock = await startMockMcpServer({ auth: 'oauth' });
  let svc;
  svc = service({ openAuthorizeUrl: async () => { setTimeout(() => svc.cancelAuthorize(), 10); } });
  await assert.rejects(svc.addCustom({ name: 'x', url: mock.url, auth: 'oauth' }), { code: 'cancelled' });
  assert.equal((await svc.list()).connections[0].status, 'needs-auth');
});

test('a secret is bound to its origin', async () => {
  mock = await startMockMcpServer({ auth: 'bearer', token: 't' });
  const svc = service();
  const c = await svc.addCustom({ name: 'x', url: mock.url, auth: 'bearer', token: 't' });
  const { secrets } = svc._stores;
  assert.deepEqual(secrets.load(`conn:${c.id}`, mock.base), { type: 'bearer', token: 't' });
  assert.equal(secrets.load(`conn:${c.id}`, 'https://evil.example'), null);
});

test('remove deletes the connection and its secret', async () => {
  mock = await startMockMcpServer({ auth: 'bearer', token: 't' });
  const svc = service();
  const c = await svc.addCustom({ name: 'x', url: mock.url, auth: 'bearer', token: 't' });
  assert.equal(svc.remove(c.id), true);
  assert.equal((await svc.list()).connections.length, 0);
  assert.equal(svc._stores.secrets.load(`conn:${c.id}`, mock.base), null);
});
