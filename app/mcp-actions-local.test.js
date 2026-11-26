'use strict';

// The actions service (mcp-actions.js) with its two on-device kinds of
// action: the built-in Email drafts (mailto:, mcp-email.js) and local command
// servers over stdio (mcp-stdio-client.js, against the fixture
// e2e/fixtures/mock-stdio-mcp-server.js). Org policy, the native
// confirmation, grounding of suggested recipients, and secrets at rest.

const { test, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { createActionsService } = require('./mcp-actions');
const { EMAIL_CONNECTION_ID } = require('./mcp-email');

const FIXTURE = path.join(__dirname, '..', 'e2e', 'fixtures', 'mock-stdio-mcp-server.js');
const fakeSafeStorage = {
  isEncryptionAvailable: () => true,
  encryptString: (s) => Buffer.from(`enc:${Buffer.from(s, 'utf8').toString('base64')}`),
  decryptString: (b) => Buffer.from(b.toString().slice(4), 'base64').toString('utf8'),
};
const NOTE = {
  title: 'Acme renewal',
  summary: 'Agreed the renewal. Dana (dana@acme.co) wants the pricing sheet.',
  action_items: ['Send Dana the pricing sheet and a recap'],
};

let dir;
let summary;
let services;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'steno-actions-local-'));
  summary = path.join(dir, 'output', 'acme_summary.json');
  fs.mkdirSync(path.dirname(summary), { recursive: true });
  fs.writeFileSync(summary, '{}');
  services = [];
});

afterEach(() => {
  for (const s of services) s.shutdown();
  fs.rmSync(dir, { recursive: true, force: true });
});

function service(overrides = {}) {
  const opened = [];
  const clipboard = [];
  const svc = createActionsService({
    userDataDir: dir,
    safeStorage: fakeSafeStorage,
    fetch: (...a) => fetch(...a),
    openAuthorizeUrl: async () => {},
    runSuggest: async () => ({ success: true, proposals: [] }),
    openMailto: async (url) => { opened.push(url); },
    writeClipboard: async (text) => { clipboard.push(text); },
    confirmLocalCommand: async () => true,
    ...overrides,
  });
  services.push(svc);
  return Object.assign(svc, { opened, clipboard });
}

const allFiles = (d) => fs.readdirSync(d, { recursive: true }).map((f) => path.join(d, f)).filter((f) => fs.statSync(f).isFile());

test('Email drafts: built in, on by default, can be turned off but not removed', async () => {
  const svc = service();
  const listed = (await svc.list()).connections.find((c) => c.id === EMAIL_CONNECTION_ID);
  assert.equal(listed.kind, 'email');
  assert.equal(listed.builtin, true);
  assert.equal(listed.enabled, true);
  assert.equal(listed.locality, 'device');
  assert.equal(listed.origin, null);
  assert.deepEqual(listed.tools.map((t) => t.name), ['draft_email']);
  assert.ok((await svc.chatToolset()).some((t) => t.tool === 'draft_email' && !t.readOnly));
  assert.equal(await svc.hasUsableConnections(), true);

  await svc.setEnabled(EMAIL_CONNECTION_ID, false);
  assert.equal((await svc.list()).connections.find((c) => c.id === EMAIL_CONNECTION_ID).enabled, false);
  assert.deepEqual(await svc.chatToolset(), []);
  assert.throws(() => svc.remove(EMAIL_CONNECTION_ID), { code: 'invalid-state' });
  // The setting persists.
  assert.equal((await service().list()).connections.find((c) => c.id === EMAIL_CONNECTION_ID).enabled, false);
});

test('Email drafts: a suggested draft keeps only recipients written in the note', async () => {
  let catalogue;
  const svc = service({
    runSuggest: async (_s, toolsFile) => {
      catalogue = JSON.parse(fs.readFileSync(toolsFile, 'utf8')).tools;
      return {
        success: true,
        note: NOTE,
        proposals: [
          {
            connection_id: EMAIL_CONNECTION_ID, tool: 'draft_email', action_item: 1,
            arguments: { to: ['Dana@acme.co', 'ceo@acme.co', 'someone@example.com'], subject: 'Pricing sheet', body: 'Hi Dana, attached.' },
          },
          // An address the model made up in the body: the whole proposal goes.
          {
            connection_id: EMAIL_CONNECTION_ID, tool: 'draft_email', action_item: 1,
            arguments: { subject: 'Recap', body: 'Reply to sales@acme.co with questions.' },
          },
        ],
      };
    },
  });
  const { cards } = await svc.suggest(summary);
  const entry = catalogue.find((t) => t.tool === 'draft_email');
  assert.equal(entry.kind, 'email');
  assert.equal(entry.simple, true);
  assert.equal(cards.length, 1);
  assert.deepEqual(cards[0].arguments.to, ['Dana@acme.co']);
  assert.equal(cards[0].connectionKind, 'email');
  assert.equal(cards[0].locality, 'device');
});

test('Email drafts: no auto-suggest run when Email is the only action', async () => {
  let ran = false;
  const svc = service({ runSuggest: async () => { ran = true; return { success: true, proposals: [] }; } });
  assert.deepEqual(await svc.suggest(summary, { auto: true }), { skipped: true, cards: [] });
  assert.equal(ran, false);
});

test('Email drafts: Approve opens a mailto draft; a long body goes to the clipboard', async () => {
  const svc = service({
    runSuggest: async () => ({
      success: true,
      note: NOTE,
      proposals: [{ connection_id: EMAIL_CONNECTION_ID, tool: 'draft_email', action_item: 1, arguments: { subject: 'Pricing', body: 'Hi' } }],
    }),
  });
  const [card] = (await svc.suggest(summary)).cards;
  // A header injection attempt in an address is refused before anything opens.
  await assert.rejects(svc.approve(summary, card.id, { to: ['dana@acme.co\r\nBcc: x@evil.co'], subject: 'S', body: 'B' }), { code: 'invalid-arguments' });
  assert.deepEqual(svc.opened, []);

  const done = await svc.approve(summary, card.id, { to: ['dana@acme.co'], subject: 'Pricing\r\nBcc: x@evil.co', body: 'Line 1\nLine & 2' });
  assert.equal(done.status, 'done');
  assert.equal(done.result.text, 'Draft opened in your mail app.');
  assert.equal(svc.opened[0], 'mailto:dana@acme.co?subject=Pricing%20Bcc%3A%20x%40evil.co&body=Line%201%0D%0ALine%20%26%202');
  const [entry] = svc.recent();
  assert.equal(entry.tool, 'draft_email');
  assert.equal(entry.origin, 'email');
  assert.ok(!JSON.stringify(entry).includes('dana@acme.co'), 'audit keeps a hash, not the addresses');

  // A long body: the draft carries the start, the clipboard the whole text.
  const [card2] = (await svc.suggest(summary)).cards.filter((c) => c.status === 'proposed');
  const body = 'Long recap line. '.repeat(400);
  const long = await svc.approve(summary, card2.id, { subject: 'Recap', body });
  assert.equal(long.result.clipboard, true);
  assert.match(long.result.text, /clipboard/);
  assert.ok(svc.opened[1].length <= 1800);
  assert.match(decodeURIComponent(svc.opened[1]), /continued in Steno/);
  assert.equal(svc.clipboard[0], body);
});

test('Email drafts: the org can turn them off', async () => {
  const svc = service({ getPolicy: async () => ({ actionsEnabled: true, managed: true, emailDraftsAllowed: false }) });
  const listed = (await svc.list()).connections.find((c) => c.id === EMAIL_CONNECTION_ID);
  assert.equal(listed.blockedByPolicy, true);
  assert.deepEqual(await svc.chatToolset(), []);
  await assert.rejects(svc.proposeChatAction('chat-x', { connectionId: EMAIL_CONNECTION_ID, tool: 'draft_email', arguments: { subject: 'a', body: 'b' } }), { code: 'email-not-allowed' });
});

test('Email drafts in chat: example addresses are dropped, typed ones kept', async () => {
  const svc = service();
  const { card } = await svc.proposeChatAction('chat-k', {
    connectionId: EMAIL_CONNECTION_ID, tool: 'draft_email',
    arguments: { to: ['bob@corp.io', 'you@example.com'], subject: 'Follow-up', body: 'Thanks' },
  });
  assert.deepEqual(card.arguments.to, ['bob@corp.io']);
  await svc.approve('chat-k', card.id, card.arguments);
  assert.equal(svc.opened[0], 'mailto:bob@corp.io?subject=Follow-up&body=Thanks');
});

test('local command: confirmed natively, tools listed, env encrypted, approve runs the tool', async () => {
  const confirmations = [];
  const svc = service({ confirmLocalCommand: async (what) => { confirmations.push(what); return true; } });
  const c = await svc.addLocal({ name: 'Notebook', command: process.execPath, args: [FIXTURE], env: { MOCK_SECRET: 'sekrit-value' } });
  assert.equal(confirmations.length, 1);
  // The dialog gets the values too, so it can show KEY=value, not just names.
  assert.deepEqual(confirmations[0], { name: 'Notebook', command: process.execPath, args: [FIXTURE], envKeys: ['MOCK_SECRET'], env: { MOCK_SECRET: 'sekrit-value' } });
  assert.equal(c.transport, 'stdio');
  assert.equal(c.locality, 'device');
  assert.equal(c.status, 'ok');
  assert.deepEqual(c.envKeys, ['MOCK_SECRET']);
  assert.deepEqual(c.tools.map((t) => t.name), ['create_note', 'whoami', 'fail', 'slow']);
  for (const f of allFiles(dir)) assert.ok(!fs.readFileSync(f, 'utf8').includes('sekrit-value'), `plaintext env value in ${f}`);

  // Chat: a read-only tool runs; it sees the saved variable.
  const read = await svc.callReadTool(c.id, 'whoami', {});
  assert.equal(JSON.parse(read.text).secretLength, 'sekrit-value'.length);

  // A note card through approve().
  const svc2 = service({
    runSuggest: async () => ({
      success: true,
      note: { title: 'Plan', summary: '', action_items: ['Write the plan down'] },
      proposals: [{ connection_id: c.id, tool: 'create_note', action_item: 1, arguments: { title: 'Plan' } }],
    }),
  });
  const [card] = (await svc2.suggest(summary)).cards;
  assert.equal(card.locality, 'device');
  assert.equal(card.origin, null);
  const done = await svc2.approve(summary, card.id, { title: 'The plan' });
  assert.equal(done.status, 'done');
  assert.equal(done.result.link, 'https://notes.example.test/n/1');
  assert.equal(svc2.recent()[0].origin, 'local server');

  // Remove: process stopped, secret gone.
  assert.ok(svc2._stores.local.running().includes(c.id));
  svc2.remove(c.id);
  assert.deepEqual(svc2._stores.local.running(), []);
  assert.equal(svc2._stores.secrets.load(`conn:${c.id}`, `local:${c.id}`), null);
});

test('local command: loader variables are refused in main before any dialog, and the name is cleaned', async () => {
  const confirmations = [];
  const svc = service({ confirmLocalCommand: async (what) => { confirmations.push(what); return true; } });
  for (const variable of ['NODE_OPTIONS', 'PYTHONPATH', 'ld_preload', 'npm_config_registry', 'GIT_SSH_COMMAND', 'DYLD_INSERT_LIBRARIES']) {
    await assert.rejects(
      svc.addLocal({ command: process.execPath, args: [FIXTURE], env: { [variable]: 'x' } }),
      (e) => e.code === 'env-not-allowed' && e.variable === variable,
      variable,
    );
  }
  assert.equal(confirmations.length, 0, 'nothing reached the dialog');
  assert.equal((await svc.list()).connections.filter((c) => !c.builtin).length, 0);

  const c = await svc.addLocal({ name: ' Note\u0000book\n ', command: process.execPath, args: [FIXTURE] });
  assert.equal(confirmations[0].name, 'Notebook');
  assert.equal(c.name, 'Notebook');
});

test('local command: declined or unavailable confirmation adds nothing', async () => {
  const declined = service({ confirmLocalCommand: async () => false });
  await assert.rejects(declined.addLocal({ command: process.execPath, args: [FIXTURE] }), { code: 'not-confirmed' });
  const none = service({ confirmLocalCommand: null });
  await assert.rejects(none.addLocal({ command: process.execPath, args: [FIXTURE] }), { code: 'local-not-allowed' });
  assert.equal((await declined.list()).connections.filter((c) => !c.builtin).length, 0);
});

test('local command: invalid input is refused', async () => {
  const svc = service();
  await assert.rejects(svc.addLocal({ command: '' }), { code: 'invalid-command' });
  await assert.rejects(svc.addLocal({ command: 'npx\nrm' }), { code: 'invalid-command' });
  await assert.rejects(svc.addLocal({ command: 'npx', args: ['a\nb'] }), { code: 'invalid-args' });
  await assert.rejects(svc.addLocal({ command: 'npx', env: { 'BAD-NAME': 'x' } }), { code: 'invalid-env' });
});

test('local command: a command that cannot be found is kept, flagged', async () => {
  const svc = service();
  const c = await svc.addLocal({ name: 'Missing', command: 'steno-no-such-binary-xyz' });
  assert.equal(c.status, 'error');
  await assert.rejects(svc.refreshTools(c.id), { code: 'command-not-found' });
});

test('local command: org policy gates it (allowlist implies off unless allowed)', async () => {
  const restricted = service({ getPolicy: async () => ({ actionsEnabled: true, managed: true, endpointAllowlist: ['https://mcp.linear.app'] }) });
  await assert.rejects(restricted.addLocal({ command: process.execPath, args: [FIXTURE] }), { code: 'local-not-allowed' });
  const allowed = service({ getPolicy: async () => ({ actionsEnabled: true, managed: true, endpointAllowlist: ['https://mcp.linear.app'], localCommandsAllowed: true }) });
  const c = await allowed.addLocal({ command: process.execPath, args: [FIXTURE] });
  assert.equal(c.blockedByPolicy, false);
  // Turned off later: listed as blocked, and nothing runs.
  const off = service({ getPolicy: async () => ({ actionsEnabled: true, managed: true, localCommandsAllowed: false }) });
  assert.equal((await off.list()).connections.find((x) => x.id === c.id).blockedByPolicy, true);
  await assert.rejects(off.refreshTools(c.id), { code: 'local-not-allowed' });
  await assert.rejects(off.callReadTool(c.id, 'whoami', {}), { code: 'local-not-allowed' });
  assert.ok(!(await off.chatToolset()).some((t) => t.connectionId === c.id));
});

test('Email drafts: "Always allow" opens later suggested drafts without a card and survives the on/off switch', async () => {
  let proposals = [];
  const svc = service({ runSuggest: async () => ({ success: true, note: NOTE, proposals }) });
  proposals = [{
    connection_id: EMAIL_CONNECTION_ID, tool: 'draft_email', action_item: 1,
    arguments: { to: ['dana@acme.co'], subject: 'Pricing sheet', body: 'Hi Dana, attached.' },
  }];
  const first = (await svc.suggest(summary)).cards[0];
  assert.equal(first.status, 'proposed');
  assert.equal(svc.opened.length, 0);
  const done = await svc.approve(summary, first.id, first.arguments, { alwaysAllow: true });
  assert.equal(done.status, 'done');
  assert.equal(svc.opened.length, 1);
  const listed = () => svc.list().then((l) => l.connections.find((c) => c.id === EMAIL_CONNECTION_ID));
  assert.equal((await listed()).autoApprove, true);

  // Turning Email off and on again keeps the choice; it only applies while on.
  await svc.setEnabled(EMAIL_CONNECTION_ID, false);
  assert.equal((await listed()).autoApprove, true);
  await svc.setEnabled(EMAIL_CONNECTION_ID, true);

  proposals = [{
    connection_id: EMAIL_CONNECTION_ID, tool: 'draft_email', action_item: 1,
    arguments: { to: ['dana@acme.co'], subject: 'Recap', body: 'Thanks for today.' },
  }];
  const second = (await svc.suggest(summary)).cards.find((c) => c.arguments.subject === 'Recap');
  assert.equal(second.status, 'done');
  assert.equal(second.autoApproved, true);
  assert.equal(svc.opened.length, 2);
  assert.match(svc.opened[1], /^mailto:dana@acme\.co\?subject=Recap/);
  assert.equal(svc.recent()[0].autoApproved, true);

  // Off again: the next draft waits for Approve.
  await svc.setAutoApprove(EMAIL_CONNECTION_ID, false);
  assert.equal((await listed()).autoApprove, false);
  proposals = [{
    connection_id: EMAIL_CONNECTION_ID, tool: 'draft_email', action_item: 1,
    arguments: { subject: 'Later', body: 'x' },
  }];
  assert.equal((await svc.suggest(summary)).cards.find((c) => c.arguments.subject === 'Later').status, 'proposed');
  assert.equal(svc.opened.length, 2);
});
