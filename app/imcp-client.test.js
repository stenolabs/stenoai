const { test, afterEach } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { ImcpClient, STATUS, findImcpServer, personName, toolJson } = require('./imcp-client');

// Most tests run the real MCP SDK against the mock bridge the e2e tier uses, so
// the handshake and tool calls are the ones Steno makes against iMCP. Data is
// invented: numbers from the fictional 555-01xx range.
const MOCK = path.join(__dirname, '..', 'e2e', 'fixtures', 'mock-imcp-server.js');
const MOCK_ENV = ['STENOAI_IMCP_SERVER', 'MOCK_IMCP_TOOLS', 'MOCK_IMCP_CALLS', 'MOCK_IMCP_CONTACTS', 'MOCK_IMCP_REFUSE'];

const clients = [];
const tempDirs = [];
afterEach(async () => {
  await Promise.all(clients.splice(0).map((c) => c.stop()));
  for (const key of MOCK_ENV) delete process.env[key];
  for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function writeJson(value) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'imcp-test-'));
  tempDirs.push(dir);
  const file = path.join(dir, 'data.json');
  fs.writeFileSync(file, JSON.stringify(value));
  return file;
}

function mockClient(env = {}, options = {}) {
  Object.assign(process.env, { STENOAI_IMCP_SERVER: MOCK }, env);
  const client = new ImcpClient({ platform: 'darwin', retryDelaysMs: [20], pendingPollMs: 20, ...options });
  clients.push(client);
  return client;
}

async function waitFor(client, state, ms = 5000) {
  const deadline = Date.now() + ms;
  while (client.status.state !== state) {
    if (Date.now() > deadline) assert.fail(`status stayed ${client.status.state}, expected ${state}`);
    await new Promise((r) => setTimeout(r, 10));
  }
}

const CALLS = [
  { '@id': '1', phoneNumber: '+12025550101', callType: 'incoming', date: '2026-03-02T09:00:00Z', durationSeconds: 120, serviceProvider: 'com.apple.Telephony' },
  { '@id': '2', phoneNumber: '+12025550102', callType: 'outgoing', date: '2026-03-02T14:00:00Z', durationSeconds: 138, serviceProvider: 'com.apple.Telephony' },
];

test('connects to iMCP and reports ready with Contacts', async () => {
  const client = mockClient();
  client.start();
  await waitFor(client, STATUS.READY);
  assert.deepStrictEqual(client.status, { state: STATUS.READY, contacts: true });
});

test('recentCalls returns iMCP call entries, newest first', async () => {
  const client = mockClient({ MOCK_IMCP_CALLS: writeJson(CALLS) });
  client.start();
  await waitFor(client, STATUS.READY);
  const calls = await client.recentCalls(10);
  assert.deepStrictEqual(calls.map((c) => c['@id']), ['2', '1']);
  assert.deepStrictEqual((await client.recentCalls(1)).map((c) => c['@id']), ['2']);
});

test('contactName returns the name Contacts has for a number', async () => {
  const client = mockClient({ MOCK_IMCP_CONTACTS: writeJson({
    '+12025550102': [{ '@type': 'Person', name: 'Erika Mustermann' }],
    '+12025550103': [{ '@type': 'Person', givenName: 'Max', familyName: 'Mustermann' }],
  }) });
  client.start();
  await waitFor(client, STATUS.READY);
  assert.strictEqual(await client.contactName('+12025550102'), 'Erika Mustermann');
  assert.strictEqual(await client.contactName('+12025550103'), 'Max Mustermann');
  assert.strictEqual(await client.contactName('+12025550199'), null);
});

test('Phone switched off in iMCP reads as phone-off, and calls are refused', async () => {
  const client = mockClient({ MOCK_IMCP_TOOLS: 'contacts_search' });
  client.start();
  await waitFor(client, STATUS.PHONE_OFF);
  await assert.rejects(client.recentCalls(), /not ready/);
});

test('Contacts switched off in iMCP means numbers without names', async () => {
  const client = mockClient({ MOCK_IMCP_TOOLS: 'phone_calls_fetch' });
  client.start();
  await waitFor(client, STATUS.READY);
  assert.strictEqual(client.status.contacts, false);
  assert.strictEqual(await client.contactName('+12025550102'), null);
});

test('a refused connection stops being retried after the second refusal', async () => {
  const client = mockClient({ MOCK_IMCP_REFUSE: '1' }, { isAppRunning: async () => true });
  client.start();
  await waitFor(client, STATUS.DECLINED);
});

test('iMCP not installed', async () => {
  const client = new ImcpClient({ platform: 'darwin', findServer: () => null, retryDelaysMs: [60000] });
  clients.push(client);
  client.start();
  assert.strictEqual(client.status.state, STATUS.NOT_INSTALLED);
});

test('not macOS', () => {
  const client = new ImcpClient({ platform: 'win32' });
  client.start();
  assert.strictEqual(client.status.state, STATUS.UNSUPPORTED);
});

// A fake SDK client, for the states the mock bridge cannot hold still. Closing
// it calls onclose, as the SDK's does.
function fakeSdkClient({ connect, listTools }) {
  return {
    connect,
    async close() { this.onclose?.(); },
    setNotificationHandler: () => {},
    listTools: listTools
      || (async () => ({ tools: [{ name: 'phone_calls_fetch' }, { name: 'contacts_search' }] })),
  };
}

test('while the handshake waits, iMCP not running and awaiting approval are told apart', async () => {
  let running = false;
  const client = new ImcpClient({
    platform: 'darwin', findServer: () => '/bin/true', pendingPollMs: 20,
    isAppRunning: async () => running,
    createClient: () => fakeSdkClient({ connect: () => new Promise(() => {}) }),
    createTransport: () => ({}),
  });
  clients.push(client);
  client.start();
  await waitFor(client, STATUS.NOT_RUNNING);
  running = true;
  await waitFor(client, STATUS.AWAITING_APPROVAL);
});

test('a dropped connection is re-established', async () => {
  const made = [];
  const client = new ImcpClient({
    platform: 'darwin', findServer: () => '/bin/true', retryDelaysMs: [20],
    isAppRunning: async () => false,
    createClient: () => {
      const sdk = fakeSdkClient({ connect: async () => {} });
      made.push(sdk);
      return sdk;
    },
    createTransport: () => ({}),
  });
  clients.push(client);
  client.start();
  await waitFor(client, STATUS.READY);
  made[0].onclose(); // iMCP quit: the bridge exited
  assert.notStrictEqual(client.status.state, STATUS.READY);
  await waitFor(client, STATUS.READY);
  assert.strictEqual(made.length, 2);
});

test('a process probe that answers after the handshake does not undo ready', async () => {
  let answer;
  const client = new ImcpClient({
    platform: 'darwin', findServer: () => '/bin/true', pendingPollMs: 60000,
    isAppRunning: () => new Promise((resolve) => { answer = resolve; }),
    createClient: () => fakeSdkClient({ connect: async () => {} }),
    createTransport: () => ({}),
  });
  clients.push(client);
  client.start();
  await waitFor(client, STATUS.READY);
  answer(true); // pgrep, started before the handshake finished, answers now
  await new Promise((r) => setTimeout(r, 10));
  assert.strictEqual(client.status.state, STATUS.READY);
});

test('a failed tool list starts the connection over', async () => {
  const made = [];
  const client = new ImcpClient({
    platform: 'darwin', findServer: () => '/bin/true', retryDelaysMs: [20],
    isAppRunning: async () => true,
    createClient: () => {
      const first = made.length === 0;
      const sdk = fakeSdkClient({
        connect: async () => {},
        listTools: first ? async () => { throw new Error('transient'); } : undefined,
      });
      made.push(sdk);
      return sdk;
    },
    createTransport: () => ({}),
  });
  clients.push(client);
  client.start();
  await waitFor(client, STATUS.READY);
  assert.strictEqual(made.length, 2);
});

test('findImcpServer: the override, then the Applications folders', () => {
  assert.strictEqual(findImcpServer({ env: { STENOAI_IMCP_SERVER: '/x' }, exists: () => true }), '/x');
  assert.strictEqual(findImcpServer({ env: { STENOAI_IMCP_SERVER: '/x' }, exists: () => false }), null);
  assert.strictEqual(
    findImcpServer({ env: {}, exists: (p) => p.startsWith('/Users/u/'), home: '/Users/u' }),
    '/Users/u/Applications/iMCP.app/Contents/MacOS/imcp-server');
  assert.strictEqual(findImcpServer({ env: {}, exists: () => false, home: '/Users/u' }), null);
});

test('personName and toolJson', () => {
  assert.strictEqual(personName({ name: ' Erika Mustermann ' }), 'Erika Mustermann');
  assert.strictEqual(personName({ givenName: 'Erika' }), 'Erika');
  assert.strictEqual(personName({}), null);
  assert.deepStrictEqual(toolJson({ content: [{ type: 'text', text: '[1]' }] }), [1]);
  assert.throws(() => toolJson({ isError: true, content: [{ type: 'text', text: 'Tool not found' }] }), /Tool not found/);
});
