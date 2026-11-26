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
  assert.equal((await svc.list()).connections.filter((x) => !x.builtin).length, 0);
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
  assert.deepEqual(toolset.filter((t) => t.connectionId === c.id).map((t) => [t.tool, t.readOnly]), [['search_issues', true], ['create_issue', false]]);
  // A custom endpoint is not one Steno ships: chat shows what its reads ask for.
  assert.ok(toolset.filter((t) => t.connectionId === c.id).every((t) => t.curated === false));

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

test('simple actions: a Notion connection is offered create_page, and Approve sends the translated vendor call', async () => {
  const { NOTION_LIKE_TOOLS } = require('../e2e/fixtures/mock-mcp-server');
  mock = await startMockMcpServer({ auth: 'none', tools: NOTION_LIKE_TOOLS });
  let catalogue = null;
  const svc = service({
    runSuggest: async (_summary, toolsFile) => {
      catalogue = JSON.parse(fs.readFileSync(toolsFile, 'utf8')).tools;
      return {
        success: true,
        note: { title: 'Website review', summary: '', action_items: ["Create a Notion page called 'Website content cleanup'"] },
        proposals: [{ connection_id: catalogue[0].connection_id, tool: 'create_page', action_item: 1,
          arguments: { title: 'Website content cleanup', content: ['Defence', 'Law enforcement'] } }],
      };
    },
  });
  // A connection of the Notion kind pointed at the mock (connectConnector would use Notion's own URL).
  const c = svc._stores.connections.add({ name: 'Notion', url: mock.url, kind: 'notion', auth: 'none' });
  await svc.refreshTools(c.id);

  const { cards } = await svc.suggest(summary);
  assert.deepEqual(catalogue.filter((t) => t.connection_id === c.id).map((t) => [t.tool, t.simple]), [['create_page', true]], 'only the simple action, never the raw tools');
  assert.equal(JSON.stringify(catalogue).includes('notion-delete-pages'), false);
  const [card] = cards;
  assert.equal(card.tool, 'notion-create-pages');
  assert.equal(card.toolTitle, 'Create page');
  assert.deepEqual(card.inputSchema.required, ['title']);
  assert.deepEqual(card.arguments, { title: 'Website content cleanup', content: '- Defence\n- Law enforcement' });
  assert.deepEqual(card.validationErrors, []);
  assert.ok(card.sendTemplate, 'the renderer previews the vendor payload from this');
  assert.deepEqual(mock.calls(), [], 'suggesting runs nothing');

  const done = await svc.approve(summary, card.id, { title: 'Website cleanup', content: '' });
  assert.equal(done.status, 'done');
  assert.deepEqual(mock.calls(), [{ name: 'notion-create-pages', args: { pages: [{ properties: { title: 'Website cleanup' } }] } }]);
  assert.equal(svc.recent()[0].tool, 'notion-create-pages');

  // Chat: a small local model gets create_page only; a cloud model also the raw tools.
  const small = await svc.chatToolset({ simpleOnly: true });
  assert.deepEqual(small.map((t) => t.tool), ['create_page', 'draft_email']);
  const big = await svc.chatToolset();
  assert.deepEqual(big.map((t) => t.tool), ['create_page', 'notion-create-pages', 'notion-search', 'draft_email']);
  const { card: chatCard } = await svc.proposeChatAction('chat-x', { connectionId: c.id, tool: 'create_page', simple: 'create_page', arguments: { title: 'From chat' } });
  assert.equal(chatCard.tool, 'notion-create-pages');
  const ran = await svc.approve('chat-x', chatCard.id, { title: 'From chat' });
  assert.equal(ran.status, 'done');
  assert.deepEqual(mock.calls().at(-1).args, { pages: [{ properties: { title: 'From chat' } }] });
  assert.deepEqual(await svc.proposeChatAction('chat-x', { connectionId: c.id, tool: 'create_page', simple: 'create_page', arguments: { title: 'TBD' } }),
    { rejected: 'placeholder', missing: ['title'] });
  await assert.rejects(svc.proposeChatAction('chat-x', { connectionId: c.id, tool: 'x', simple: 'drop_all', arguments: {} }), /does not offer/);
});

test('simple actions: invalid simple fields are refused before anything is sent', async () => {
  const { NOTION_LIKE_TOOLS } = require('../e2e/fixtures/mock-mcp-server');
  mock = await startMockMcpServer({ auth: 'none', tools: NOTION_LIKE_TOOLS });
  const svc = service({
    runSuggest: async (_s, toolsFile) => ({
      success: true,
      note: { title: 'n', summary: '', action_items: ['Make a page'] },
      proposals: [{ connection_id: JSON.parse(fs.readFileSync(toolsFile, 'utf8')).tools[0].connection_id, tool: 'Create-Page', arguments: { title: 'A page' }, action_item: 1 }],
    }),
  });
  const c = svc._stores.connections.add({ name: 'Notion', url: mock.url, kind: 'notion', auth: 'none' });
  await svc.refreshTools(c.id);
  const { cards } = await svc.suggest(summary);
  assert.equal(cards.length, 1, 'tool name repaired');
  await assert.rejects(svc.approve(summary, cards[0].id, { title: '', extra: 1 }), (e) => e.code === 'invalid-arguments' && e.validationErrors.length >= 1);
  assert.deepEqual(mock.calls(), []);
});

test('always allow: approve with alwaysAllow trusts the app; later suggestions and chat writes run at once, marked in the audit log; policy, validation and the switch still gate it', async () => {
  mock = await startMockMcpServer({ auth: 'bearer', token: 't' });
  let proposals = () => [];
  let policyOverride = {};
  const svc = service({
    runSuggest: async (_s, toolsFile) => {
      const id = JSON.parse(fs.readFileSync(toolsFile, 'utf8')).tools[0].connection_id;
      return { success: true, note: NOTE, proposals: proposals(id) };
    },
    getPolicy: async () => ({ actionsEnabled: true, endpointAllowlist: null, managed: false, ...policyOverride }),
  });
  const added = await svc.addCustom({ name: 'n8n', url: mock.url, auth: 'bearer', token: 't' });
  assert.equal(added.autoApprove, false, 'nothing is trusted by default');

  // Not trusted yet: a card, offering "Always allow"; nothing runs.
  proposals = (id) => [{ connection_id: id, tool: 'create_issue', arguments: { title: 'Prep release notes' }, action_item: 1 }];
  const first = (await svc.suggest(summary)).cards;
  assert.equal(first.length, 1);
  assert.equal(first[0].status, 'proposed');
  assert.equal(first[0].autoApproveOffered, true);
  assert.equal(mock.calls().length, 0);

  // Invalid arguments with "Always allow": refused, and the app stays untrusted.
  await assert.rejects(svc.approve(summary, first[0].id, { title: '' }, { alwaysAllow: true }), { code: 'invalid-arguments' });
  assert.equal((await svc.list()).connections.find((c) => c.id === added.id).autoApprove, false);
  assert.equal(mock.calls().length, 0);

  // "Always allow for n8n": this action runs, and the flag is persisted with the connection.
  const done = await svc.approve(summary, first[0].id, { title: 'Prep release notes' }, { alwaysAllow: true });
  assert.equal(done.status, 'done');
  assert.equal(done.autoApproved, false, 'the user approved this one');
  assert.equal(done.autoApproveOffered, false);
  assert.equal((await svc.list()).connections.find((c) => c.id === added.id).autoApprove, true);
  const stored = JSON.parse(fs.readFileSync(path.join(dir, 'mcp-connections.json'), 'utf8'));
  assert.equal(stored.connections[0].autoApprove, true);
  assert.equal(svc.recent()[0].autoApproved, undefined, 'a user approval is not marked automatic');

  // Next suggestions: a valid one runs at once; one with a validation problem still asks.
  proposals = (id) => [
    { connection_id: id, tool: 'create_issue', arguments: { title: 'Second' }, action_item: 1 },
    { connection_id: id, tool: 'create_issue', arguments: { title: 'Bad', priority: 'urgent' }, action_item: 1 },
  ];
  const second = (await svc.suggest(summary)).cards;
  assert.deepEqual(second.map((c) => [c.arguments.title, c.status, c.autoApproved]), [
    ['Prep release notes', 'done', false],
    ['Second', 'done', true],
    ['Bad', 'proposed', false],
  ]);
  assert.equal(second[1].result.link, 'https://mock.example/items/2');
  assert.equal(second[2].autoApproveOffered, false, 'already trusted: nothing more to offer');
  assert.deepEqual(mock.calls().map((c) => c.args.title), ['Prep release notes', 'Second']);
  const log = svc.recent();
  assert.equal(log.length, 2);
  assert.equal(log[0].autoApproved, true, 'the automatic run is marked in the audit log');
  assert.equal(log[0].tool, 'create_issue');
  assert.ok(!fs.readFileSync(path.join(dir, 'mcp-actions-audit.jsonl'), 'utf8').includes('Second'), 'arguments still hashed');

  // Chat: a write on the trusted app runs without a card, and says so.
  const chat = await svc.proposeChatAction('chat-auto', { connectionId: added.id, tool: 'create_issue', arguments: { title: 'From chat' } });
  assert.equal(chat.auto, true);
  assert.equal(chat.card.status, 'done');
  assert.equal(chat.card.autoApproved, true);
  assert.equal(mock.calls().at(-1).args.title, 'From chat');
  // ...but a chat write with a validation problem still becomes a card.
  const chatBad = await svc.proposeChatAction('chat-auto', { connectionId: added.id, tool: 'create_issue', arguments: { title: 'x', priority: 'urgent' } });
  assert.equal(chatBad.auto, undefined);
  assert.equal(chatBad.card.status, 'proposed');
  assert.equal(mock.calls().length, 3);

  // A managed org that forbids it: suggestions ask again, and it cannot be turned on.
  policyOverride = { managed: true, autoApproveAllowed: false };
  proposals = (id) => [{ connection_id: id, tool: 'create_issue', arguments: { title: 'Third' }, action_item: 1 }];
  const third = (await svc.suggest(summary)).cards.find((c) => c.arguments.title === 'Third');
  assert.equal(third.status, 'proposed');
  assert.equal(third.autoApproveOffered, false);
  assert.equal(mock.calls().length, 3);
  await assert.rejects(svc.setAutoApprove(added.id, true), { code: 'auto-approve-not-allowed' });
  await assert.rejects(svc.approve(summary, third.id, { title: 'Third' }, { alwaysAllow: true }), { code: 'auto-approve-not-allowed' });
  assert.equal(mock.calls().length, 3, 'a refused "always allow" sends nothing');
  policyOverride = {};

  // A disabled connection is not offered, so nothing of it can auto-run.
  await svc.setEnabled(added.id, false);
  proposals = (id) => [{ connection_id: id, tool: 'create_issue', arguments: { title: 'While off' }, action_item: 1 }];
  assert.equal((await svc.suggest(summary)).cards.some((c) => c.arguments.title === 'While off'), false);
  assert.equal(mock.calls().length, 3);
  await svc.setEnabled(added.id, true);

  // The switch turns it off: the next suggestion asks again.
  const off = await svc.setAutoApprove(added.id, false);
  assert.equal(off.autoApprove, false);
  proposals = (id) => [{ connection_id: id, tool: 'create_issue', arguments: { title: 'Fourth' }, action_item: 1 }];
  const fourth = (await svc.suggest(summary)).cards.find((c) => c.arguments.title === 'Fourth');
  assert.equal(fourth.status, 'proposed');
  assert.equal(fourth.autoApproveOffered, true);
  assert.equal(mock.calls().length, 3);
  // And it survives a restart either way.
  assert.equal((await service().list()).connections.find((c) => c.id === added.id).autoApprove, false);
});
