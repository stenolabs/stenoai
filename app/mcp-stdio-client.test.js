'use strict';

// Local (stdio) MCP servers (mcp-stdio-client.js) against a real child
// process: the wire-level fixture e2e/fixtures/mock-stdio-mcp-server.js.
// Connect, list, call, tool and protocol errors, handshake and call
// timeouts, crash and lazy restart, process-tree kill, the child's
// environment, and finding a command like a shell would.

const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  createStdioPool, resolveCommand, searchDirs, childEnv, LocalServerError,
} = require('./mcp-stdio-client');

const FIXTURE = path.join(__dirname, '..', 'e2e', 'fixtures', 'mock-stdio-mcp-server.js');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'steno-stdio-'));
const pools = [];
after(() => {
  for (const p of pools) p.stopAll({ sync: true });
  fs.rmSync(tmp, { recursive: true, force: true });
});

let seq = 0;
function pool(opts = {}) {
  const p = createStdioPool({ getLoginPath: async () => null, ...opts });
  pools.push(p);
  return p;
}
const spec = (env = {}, extra = {}) => ({ id: `s${++seq}`, command: process.execPath, args: [FIXTURE], env, ...extra });
const alive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (_) {
    return false;
  }
};
const waitFor = async (fn, ms = 3000) => {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await fn()) return true;
    await new Promise((r) => setTimeout(r, 50));
  }
  return false;
};

test('connects, lists tools and calls one', async () => {
  const p = pool();
  const s = spec();
  const tools = await p.listTools(s);
  assert.deepEqual(tools.map((t) => t.name), ['create_note', 'whoami', 'fail', 'slow']);
  assert.equal(tools.find((t) => t.name === 'whoami').readOnly, true);
  assert.equal(tools.find((t) => t.name === 'create_note').readOnly, false);
  const res = await p.callTool(s, 'create_note', { title: 'Plan' });
  assert.equal(res.isError, false);
  assert.match(res.text, /Created "Plan"/);
  assert.equal(res.link, 'https://notes.example.test/n/1');
  // One process serves both requests.
  assert.deepEqual(p.running(), [s.id]);
});

test('the child gets the user env, not Steno\'s own environment', async () => {
  process.env.STENO_PARENT_ONLY = 'provider-key';
  try {
    const p = pool();
    const res = await p.callTool(spec({ MOCK_SECRET: 'abc123' }), 'whoami', {});
    assert.deepEqual(JSON.parse(res.text), { secretLength: 6, parentLeak: false });
  } finally {
    delete process.env.STENO_PARENT_ONLY;
  }
});

test('a tool error comes back as isError; a protocol error is thrown as is', async () => {
  const p = pool();
  const s = spec();
  const res = await p.callTool(s, 'fail', {});
  assert.equal(res.isError, true);
  assert.equal(res.text, 'Notebook is locked');
  await assert.rejects(p.callTool(s, 'nope', {}), (e) => !(e instanceof LocalServerError));
  // The server is still usable after both.
  assert.equal((await p.callTool(s, 'create_note', { title: 'x' })).isError, false);
});

test('a non-JSON banner on stdout is skipped', async () => {
  const tools = await pool().listTools(spec({ MOCK_STDIO_MODE: 'banner' }));
  assert.equal(tools.length, 4);
});

test('a silent server times out the handshake and is killed', async () => {
  const pidFile = path.join(tmp, 'silent.pid');
  const p = pool({ handshakeTimeoutMs: 300 });
  await assert.rejects(p.listTools(spec({ MOCK_STDIO_MODE: 'silent', MOCK_STDIO_GRANDCHILD: pidFile })), { code: 'local-timeout' });
  const [pid] = fs.readFileSync(pidFile, 'utf8').split(' ').map(Number);
  assert.ok(await waitFor(() => !alive(pid)), 'server process killed');
  assert.deepEqual(p.running(), []);
});

test('a call that never answers times out; the next use starts a fresh process', async () => {
  const pidFile = path.join(tmp, 'slow.pid');
  const p = pool({ callTimeoutMs: 300 });
  const s = spec({ MOCK_STDIO_GRANDCHILD: pidFile });
  await assert.rejects(p.callTool(s, 'slow', {}), { code: 'local-timeout' });
  const [first] = fs.readFileSync(pidFile, 'utf8').split(' ').map(Number);
  assert.ok(await waitFor(() => !alive(first)), 'timed-out server killed');
  assert.equal((await p.callTool(s, 'create_note', { title: 'again' })).isError, false);
  const [second] = fs.readFileSync(pidFile, 'utf8').split(' ').map(Number);
  assert.notEqual(second, first);
});

test('a server that exits mid-call fails with local-exited and restarts lazily', async () => {
  const p = pool();
  const s = spec({ MOCK_STDIO_MODE: 'exit-on-call' });
  await p.listTools(s);
  await assert.rejects(p.callTool(s, 'create_note', { title: 'x' }), { code: 'local-exited' });
  assert.equal((await p.listTools(s)).length, 4);
});

test('stop() kills the whole process tree (npx-style grandchild included)', async () => {
  const pidFile = path.join(tmp, 'tree.pid');
  const p = pool();
  const s = spec({ MOCK_STDIO_GRANDCHILD: pidFile });
  await p.listTools(s);
  const [server, grandchild] = fs.readFileSync(pidFile, 'utf8').split(' ').map(Number);
  assert.ok(alive(server) && alive(grandchild));
  assert.equal(p.stop(s.id), true);
  assert.ok(await waitFor(() => !alive(server) && !alive(grandchild)), 'server and grandchild gone');
});

test('stopAll({ sync }) for app quit kills immediately', async () => {
  const pidFile = path.join(tmp, 'quit.pid');
  const p = pool();
  await p.listTools(spec({ MOCK_STDIO_GRANDCHILD: pidFile }));
  const [server, grandchild] = fs.readFileSync(pidFile, 'utf8').split(' ').map(Number);
  p.stopAll({ sync: true });
  assert.ok(await waitFor(() => !alive(server) && !alive(grandchild)));
  assert.deepEqual(p.running(), []);
});

test('an idle server is stopped and started again on next use', async () => {
  const p = pool({ idleMs: 200 });
  const s = spec();
  await p.listTools(s);
  assert.ok(await waitFor(() => p.running().length === 0, 2000), 'stopped when idle');
  assert.equal((await p.listTools(s)).length, 4);
});

test('an unknown command fails with command-not-found', async () => {
  await assert.rejects(pool().listTools(spec({}, { command: 'steno-no-such-command-xyz' })), { code: 'command-not-found' });
});

test('resolveCommand searches the PATH like a shell (POSIX)', { skip: process.platform === 'win32' }, () => {
  const bin = path.join(tmp, 'bin');
  fs.mkdirSync(bin, { recursive: true });
  const tool = path.join(bin, 'my-mcp');
  fs.writeFileSync(tool, '#!/bin/sh\n', { mode: 0o755 });
  fs.writeFileSync(path.join(bin, 'not-exec'), 'x', { mode: 0o644 });
  assert.equal(resolveCommand('my-mcp', { dirs: ['/nonexistent', bin], platform: process.platform }), tool);
  assert.equal(resolveCommand('not-exec', { dirs: [bin], platform: process.platform }), null);
  assert.equal(resolveCommand(tool, { dirs: [], platform: process.platform }), tool);
  assert.equal(resolveCommand('~/x', { dirs: [], platform: process.platform, home: tmp }), null);
});

test('resolveCommand applies PATHEXT on Windows (npx -> npx.cmd)', () => {
  const files = new Set(['C:\\nodejs\\npx.cmd', 'C:\\tools\\uvx.exe']);
  const fakeFs = {
    statSync: (f) => {
      if (!files.has(f)) throw new Error('ENOENT');
      return { isFile: () => true };
    },
    accessSync: () => {},
    constants: { X_OK: 1 },
  };
  const opts = { dirs: ['C:\\Windows', 'C:\\nodejs', 'C:\\tools'], platform: 'win32', env: { PATHEXT: '.COM;.EXE;.BAT;.CMD' }, fs: fakeFs, home: 'C:\\Users\\me' };
  assert.equal(resolveCommand('npx', opts), 'C:\\nodejs\\npx.cmd');
  assert.equal(resolveCommand('uvx', opts), 'C:\\tools\\uvx.exe');
  assert.equal(resolveCommand('C:\\nodejs\\npx', opts), 'C:\\nodejs\\npx.cmd');
  assert.equal(resolveCommand('missing', opts), null);
});

test('searchDirs: login shell PATH first, then PATH, then install locations', () => {
  const dirs = searchDirs({ platform: 'darwin', env: { PATH: '/usr/bin:/bin' }, home: '/Users/me', loginPath: '/Users/me/.nvm/versions/node/v22/bin:/usr/bin' });
  assert.equal(dirs[0], '/Users/me/.nvm/versions/node/v22/bin');
  assert.ok(dirs.includes('/opt/homebrew/bin'));
  assert.equal(dirs.filter((d) => d === '/usr/bin').length, 1);
  const win = searchDirs({ platform: 'win32', env: { Path: 'C:\\nodejs;relative' }, home: 'C:\\Users\\me' });
  assert.deepEqual(win, ['C:\\nodejs']);
});

test('childEnv is minimal plus the user variables', () => {
  const env = childEnv({
    userEnv: { API_KEY: 'k', PATH: '/custom' },
    dirs: ['/usr/bin'],
    platform: 'linux',
    env: { HOME: '/home/me', OPENAI_API_KEY: 'parent-secret', PATH: '/usr/bin' },
  });
  assert.deepEqual(env, { HOME: '/home/me', PATH: '/custom:/usr/bin', API_KEY: 'k' });
});
