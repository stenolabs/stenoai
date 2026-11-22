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

const NOTE = {
  title: 'Release sync',
  summary: 'Ship Friday. The launch page is PAGE-42.',
  action_items: ['Bob to prep the release notes', 'Alice to tell support'],
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
        note: NOTE,
        proposals: [
          { connection_id: id, tool: 'create_issue', arguments: { title: 'Prep release notes', priority: 'high' }, reason: 'Bob owns it', action_item: 1 },
          { connection_id: id, tool: 'send_message', arguments: { channel: '#eng', text: 'Ship Friday' }, action_item: 2 },
          { connection_id: id, tool: 'search_issues', arguments: { query: 'x' }, action_item: 1 }, // read-only: not offered
          { connection_id: 'nope', tool: 'create_issue', arguments: { title: 'x' }, action_item: 1 }, // unknown connection
          { connection_id: id, tool: 'create_issue', arguments: { title: 'Prep release notes', priority: 'urgent' }, action_item: 1 }, // invalid: kept with errors
          { connection_id: id, tool: 'create_issue', arguments: { title: 'Uncited' } }, // cites no action item: dropped
          { connection_id: id, tool: 'create_issue', arguments: { title: 'not_specified' }, action_item: 1 }, // placeholder: dropped
        ],
      };
    },
  });
  await svc.addCustom({ name: 'n8n', url: mock.url, auth: 'bearer', token: 't' });
  const { cards } = await svc.suggest(summary);
  assert.ok(!toolsSeen.tools.some((t) => t.tool === 'search_issues'), 'read-only tools are not offered');
  assert.equal(cards.length, 3);
  assert.equal(cards[0].actionItem, 'Bob to prep the release notes');
  assert.equal(cards[2].validationErrors.length, 1, 'bad enum');
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
      return { success: true, note: NOTE, proposals: [{ connection_id: id, tool: 'create_issue', arguments: { title: 'A' }, action_item: 1 }] };
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
    runSuggest: async () => ({ success: true, note: NOTE, proposals: [{ connection_id: c.id, tool: 'create_issue', arguments: { title: 'A' }, action_item: 1 }] }),
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

test('OAuth: CIMD is used when the server advertises it and offers no DCR', async () => {
  mock = await startMockMcpServer({ auth: 'oauth', cimd: true, noDcr: true });
  const cimd = `${mock.base}/client.json`;
  const c = await service({ clientMetadataUrl: cimd }).addCustom({ name: 'cimd', url: mock.url, auth: 'oauth' });
  assert.equal(c.status, 'ok');
  assert.equal(mock.registrations().length, 0);
  assert.equal(mock.authorizeRequests()[0].client_id, cimd);
});

test('OAuth: DCR wins when the server offers both, so an unpublished CIMD never breaks sign-in', async () => {
  mock = await startMockMcpServer({ auth: 'oauth', cimd: true });
  const c = await service({ clientMetadataUrl: 'https://stenoai.invalid/oauth/client.json' }).addCustom({ name: 'both', url: mock.url, auth: 'oauth' });
  assert.equal(c.status, 'ok');
  assert.equal(mock.registrations().length, 1);
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

test('suggest drops placeholder, uncited and invented-id proposals and never offers destructive tools', async () => {
  const tools = [
    ...require('../e2e/fixtures/mock-mcp-server').DEFAULT_TOOLS,
    {
      name: 'update_page',
      title: 'Update page',
      description: 'Change an existing page.',
      inputSchema: { type: 'object', properties: { page_id: { type: 'string' }, content: { type: 'string' } }, required: ['page_id', 'content'] },
    },
    {
      name: 'delete_page',
      title: 'Delete page',
      description: 'Delete a page.',
      destructive: true,
      inputSchema: { type: 'object', properties: { page_id: { type: 'string' } }, required: ['page_id'] },
    },
  ];
  mock = await startMockMcpServer({ auth: 'none', tools });
  let offered = null;
  const svc = service({
    runSuggest: async (_s, toolsFile) => {
      offered = JSON.parse(fs.readFileSync(toolsFile, 'utf8')).tools;
      const id = offered[0].connection_id;
      return {
        success: true,
        note: NOTE,
        proposals: [
          { connection_id: id, tool: 'update_page', arguments: { page_id: 'not_specified', content: 'less text' }, action_item: 1 },
          { connection_id: id, tool: 'update_page', arguments: { page_id: 'PAGE-99', content: 'less text' }, action_item: 1 },
          { connection_id: id, tool: 'update_page', arguments: { page_id: 'PAGE-42', content: 'less text' }, action_item: 1 },
          { connection_id: id, tool: 'send_message', arguments: { channel: 'TBD', text: 'hi' }, action_item: 2 },
          { connection_id: id, tool: 'send_message', arguments: { channel: '#support', text: 'Ship Friday' }, action_item: 'Alice to tell support' },
          { connection_id: id, tool: 'send_message', arguments: { channel: '#support', text: 'x' }, action_item: 7 },
        ],
      };
    },
  });
  await svc.addCustom({ name: 'Docs', url: mock.url, auth: 'none' });
  const { cards } = await svc.suggest(summary);
  assert.ok(!offered.some((t) => t.tool === 'delete_page'), 'destructive tools are never offered');
  assert.deepEqual(cards.map((c) => [c.tool, c.arguments.page_id || c.arguments.channel, c.actionItem]), [
    ['update_page', 'PAGE-42', 'Bob to prep the release notes'],
    ['send_message', '#support', 'Alice to tell support'],
  ]);
});

test('a failed action keeps the endpoint message, trimmed and redacted, for the card', async () => {
  const tools = [{
    name: 'create_page',
    title: 'Create page',
    description: 'Create a page.',
    failText: `Validation failed: parent not found (token=abc123secret). ${'x'.repeat(400)}`,
    inputSchema: { type: 'object', properties: { title: { type: 'string' } }, required: ['title'] },
  }];
  mock = await startMockMcpServer({ auth: 'none', tools });
  const svc = service({
    runSuggest: async (_s, toolsFile) => {
      const id = JSON.parse(fs.readFileSync(toolsFile, 'utf8')).tools[0].connection_id;
      return { success: true, note: NOTE, proposals: [{ connection_id: id, tool: 'create_page', arguments: { title: 'Notes' }, action_item: 1 }] };
    },
  });
  await svc.addCustom({ name: 'Docs', url: mock.url, auth: 'none' });
  const { cards } = await svc.suggest(summary);
  const failed = await svc.approve(summary, cards[0].id, { title: 'Notes' });
  assert.equal(failed.status, 'failed');
  assert.match(failed.result.detail, /^Validation failed: parent not found/);
  assert.doesNotMatch(failed.result.detail, /abc123secret/);
  assert.ok(failed.result.detail.length <= 300);
});

test('chat agent: read tools run, writes become cards approved through the same path, destructive tools never offered', async () => {
  mock = await startMockMcpServer({
    auth: 'none',
    tools: [
      { name: 'search_issues', title: 'Search issues', description: 'Find issues.', readOnly: true, inputSchema: { type: 'object', properties: { query: { type: 'string' } } } },
      { name: 'create_issue', title: 'Create issue', description: 'Create.', inputSchema: { type: 'object', properties: { title: { type: 'string' } }, required: ['title'] } },
      { name: 'delete_issue', title: 'Delete issue', description: 'Delete.', destructive: true, inputSchema: { type: 'object', properties: { id: { type: 'string' } } } },
    ],
  });
  const svc = service();
  const c = await svc.addCustom({ name: 'Tracker', url: mock.url, auth: 'none' });
  const toolset = await svc.chatToolset();
  assert.deepEqual(toolset.map((t) => [t.tool, t.readOnly]), [['search_issues', true], ['create_issue', false]]);

  const read = await svc.callReadTool(c.id, 'search_issues', { query: 'x' });
  assert.equal(read.isError, false);
  await assert.rejects(svc.callReadTool(c.id, 'create_issue', { title: 'x' }), /needs approval/);
  assert.deepEqual(mock.calls().map((x) => x.name), ['search_issues']);

  const key = 'chat-abc';
  assert.deepEqual(await svc.proposeChatAction(key, { connectionId: c.id, tool: 'create_issue', arguments: { title: 'TBD' } }), { rejected: 'placeholder', missing: ['title'] });
  await assert.rejects(svc.proposeChatAction(key, { connectionId: c.id, tool: 'delete_issue', arguments: { id: '1' } }), /does not offer/);
  const { card } = await svc.proposeChatAction(key, { connectionId: c.id, tool: 'create_issue', arguments: { title: 'Ship it' } });
  assert.equal(card.status, 'proposed');
  assert.deepEqual(mock.calls().map((x) => x.name), ['search_issues']); // proposing runs nothing

  const done = await svc.approve(key, card.id, { title: 'Ship it today' });
  assert.equal(done.status, 'done');
  assert.deepEqual(mock.calls().at(-1), { name: 'create_issue', args: { title: 'Ship it today' } });
  assert.equal(svc.recent().length, 1);

  // Org policy off: no tools for chat, and no proposals.
  const off = service({ getPolicy: async () => ({ actionsEnabled: false }) });
  assert.deepEqual(await off.chatToolset(), []);
  await assert.rejects(off.proposeChatAction(key, { connectionId: c.id, tool: 'create_issue', arguments: { title: 'x' } }), /turned off/);
});
