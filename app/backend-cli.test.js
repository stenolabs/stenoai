'use strict';

const { test, mock, afterEach } = require('node:test');
const assert = require('node:assert');
const path = require('path');

// backend-cli.js destructures child_process.spawn at load time, so stub it
// BEFORE the first require. killProcessTree reads child_process.execFileSync at
// call time, so that can be stubbed per-test.
const cp = require('child_process');
const realSpawn = cp.spawn;
let spawnCalls = [];
let stubChild = { fake: true };
cp.spawn = (...args) => { spawnCalls.push(args); return stubChild; };

const { spawn, killProcessTree, createBackendCli } = require('./backend-cli');

afterEach(() => {
  spawnCalls = [];
  stubChild = { fake: true };
  mock.restoreAll();
});

// A controllable child-process double: runPythonScript registers stdout/stderr/
// process handlers synchronously, so a test can drive them after the call.
function fakeChild() {
  const bags = { stdout: {}, stderr: {}, proc: {} };
  const sink = (bag) => ({ on: (evt, cb) => { bag[evt] = cb; } });
  return {
    stdout: sink(bags.stdout),
    stderr: sink(bags.stderr),
    on: (evt, cb) => { bags.proc[evt] = cb; },
    emit: (which, evt, arg) => { const h = bags[which][evt]; if (h) h(arg); },
  };
}

function recordingDeps(extra = {}) {
  const rec = { debug: [], forwarded: [], attached: [] };
  const deps = {
    app: { isPackaged: false },
    sendDebugLog: (m) => rec.debug.push(m),
    sanitizeArgsForLog: () => 'SANITIZED',
    attachProcessingStderr: (proc, label) => rec.attached.push({ proc, label }),
    forwardDiagnosticStdout: (line, source) => rec.forwarded.push({ line, source }),
    ...extra,
  };
  return { rec, run: createBackendCli(deps).runPythonScript };
}

// ---- spawn wrapper -------------------------------------------------------

test('spawn defaults windowsHide:true and PYTHONUNBUFFERED:1 for the (command, args[]) form', () => {
  spawn('backend', ['a', 'b']);
  assert.deepStrictEqual(spawnCalls[0][0], 'backend');
  assert.deepStrictEqual(spawnCalls[0][1], ['a', 'b']);
  assert.strictEqual(spawnCalls[0][2].windowsHide, true);
  assert.strictEqual(spawnCalls[0][2].env.PYTHONUNBUFFERED, '1');
});

test('spawn lets a caller override windowsHide, and merges (not replaces) env', () => {
  spawn('backend', ['a'], { windowsHide: false, cwd: '/x', env: { FOO: 'bar' } });
  const opts = spawnCalls[0][2];
  assert.strictEqual(opts.windowsHide, false);
  assert.strictEqual(opts.cwd, '/x');
  assert.strictEqual(opts.env.FOO, 'bar');
  assert.strictEqual(opts.env.PYTHONUNBUFFERED, '1');
});

test('spawn lets a caller override PYTHONUNBUFFERED itself', () => {
  spawn('backend', ['a'], { env: { PYTHONUNBUFFERED: '0' } });
  assert.strictEqual(spawnCalls[0][2].env.PYTHONUNBUFFERED, '0');
});

test('spawn handles the 2-arg (command, options) form', () => {
  spawn('backend', { cwd: '/y' });
  // Collapsed to the options-object overload; windowsHide defaulted in.
  const opts = spawnCalls[0][1];
  assert.strictEqual(opts.windowsHide, true);
  assert.strictEqual(opts.cwd, '/y');
  assert.strictEqual(opts.env.PYTHONUNBUFFERED, '1');
});

test('spawn defaults options when args is null/undefined', () => {
  spawn('backend');
  assert.deepStrictEqual(spawnCalls[0][1], undefined);
  assert.strictEqual(spawnCalls[0][2].windowsHide, true);
  assert.strictEqual(spawnCalls[0][2].env.PYTHONUNBUFFERED, '1');
});

// ---- killProcessTree -----------------------------------------------------

test('killProcessTree is a no-op for a falsy pid', () => {
  const killMock = mock.method(process, 'kill', () => {});
  killProcessTree(0);
  killProcessTree(null);
  killProcessTree(undefined);
  assert.strictEqual(killMock.mock.callCount(), 0);
});

test('killProcessTree escalates SIGTERM -> SIGKILL on POSIX', () => {
  if (process.platform === 'win32') return; // POSIX-only branch
  const killMock = mock.method(process, 'kill', () => {});
  mock.timers.enable({ apis: ['setTimeout'] });
  killProcessTree(4242);
  // Immediate SIGTERM.
  assert.strictEqual(killMock.mock.callCount(), 1);
  assert.deepStrictEqual(killMock.mock.calls[0].arguments, [4242, 'SIGTERM']);
  // SIGKILL only after the 1s escalation timer.
  mock.timers.tick(1000);
  assert.strictEqual(killMock.mock.callCount(), 2);
  assert.deepStrictEqual(killMock.mock.calls[1].arguments, [4242, 'SIGKILL']);
});

test('killProcessTree tree-kills via taskkill on win32', () => {
  const origPlatform = process.platform;
  try {
    // Inside the try so any throw during setup still hits the finally restore.
    Object.defineProperty(process, 'platform', { value: 'win32', configurable: true });
    const execMock = mock.method(cp, 'execFileSync', () => {});
    killProcessTree(777);
    assert.strictEqual(execMock.mock.callCount(), 1);
    const [bin, argv, opts] = execMock.mock.calls[0].arguments;
    assert.strictEqual(bin, 'taskkill');
    assert.deepStrictEqual(argv, ['/PID', '777', '/T', '/F']);
    assert.strictEqual(opts.windowsHide, true);
  } finally {
    Object.defineProperty(process, 'platform', { value: origPlatform, configurable: true });
  }
});

// ---- createBackendCli: packaging-aware paths -----------------------------

test('getBackendPath/getBackendCwd resolve the dev build via injected app', () => {
  const { getBackendPath, getBackendCwd } = createBackendCli({ app: { isPackaged: false } });
  const exe = process.platform === 'win32' ? 'stenoai.exe' : 'stenoai';
  // __dirname is app/, so dev paths point at <repo>/dist/stenoai/*.
  assert.strictEqual(getBackendPath(), path.join(__dirname, '..', 'dist', 'stenoai', exe));
  assert.strictEqual(getBackendCwd(), path.join(__dirname, '..', 'dist', 'stenoai'));
});

test('getBackendPath/getBackendCwd resolve the packaged resources dir', () => {
  const origRes = process.resourcesPath;
  try {
    // Inside the try so any throw during setup still hits the finally restore.
    Object.defineProperty(process, 'resourcesPath', { value: '/Apps/Steno.app/Contents/Resources', configurable: true });
    const exe = process.platform === 'win32' ? 'stenoai.exe' : 'stenoai';
    const { getBackendPath, getBackendCwd } = createBackendCli({ app: { isPackaged: true } });
    assert.strictEqual(getBackendPath(), path.join('/Apps/Steno.app/Contents/Resources', 'stenoai', exe));
    assert.strictEqual(getBackendCwd(), path.join('/Apps/Steno.app/Contents/Resources', 'stenoai'));
  } finally {
    Object.defineProperty(process, 'resourcesPath', { value: origRes, configurable: true });
  }
});

// ---- createBackendCli: runPythonScript behavior -------------------------

test('runPythonScript (non-silent) sanitizes the echoed argv and streams output', async () => {
  stubChild = fakeChild();
  const { rec, run } = recordingDeps();
  const p = run('simple_recorder.py', ['create-folder', 'secret'], false);
  // The spawned argv is untouched; only the LOGGED echo is sanitized.
  assert.deepStrictEqual(spawnCalls[0][1], ['create-folder', 'secret']);
  assert.ok(rec.debug.includes('$ stenoai SANITIZED'));
  // No extraEnv -> spawn()'s own PYTHONUNBUFFERED default is all that's set.
  assert.strictEqual(spawnCalls[0][2].env.PYTHONUNBUFFERED, '1');

  stubChild.emit('stdout', 'data', Buffer.from('one\ntwo'));
  assert.deepStrictEqual(rec.forwarded, [
    { line: 'one', source: 'backend' },
    { line: 'two', source: 'backend' },
  ]);
  stubChild.emit('stderr', 'data', Buffer.from('bad\n'));
  assert.ok(rec.debug.includes('STDERR: bad'));

  stubChild.emit('proc', 'close', 0);
  assert.ok(rec.debug.includes('Command completed with exit code: 0'));
  assert.strictEqual(await p, 'one\ntwo');
});

test('runPythonScript (silent) suppresses all debug-panel logging', async () => {
  stubChild = fakeChild();
  const { rec, run } = recordingDeps();
  const p = run('simple_recorder.py', ['status'], true);
  stubChild.emit('stdout', 'data', Buffer.from('quiet'));
  stubChild.emit('stderr', 'data', Buffer.from('noise\n'));
  stubChild.emit('proc', 'close', 0);
  assert.deepStrictEqual(rec.debug, []);
  assert.deepStrictEqual(rec.forwarded, []);
  assert.strictEqual(await p, 'quiet');
});

test('runPythonScript merges extraEnv over the parent environment', async () => {
  stubChild = fakeChild();
  const { run } = recordingDeps();
  const p = run('simple_recorder.py', ['x'], true, { STENO_TEST_FLAG: 'on' });
  const env = spawnCalls[0][2].env;
  assert.strictEqual(env.STENO_TEST_FLAG, 'on');
  assert.strictEqual(env.PATH, process.env.PATH); // parent env preserved
  stubChild.emit('proc', 'close', 0);
  await p;
});

test('runPythonScript attaches persistent stderr capture only when a logLabel is given', async () => {
  stubChild = fakeChild();
  const withLabel = recordingDeps();
  const p1 = withLabel.run('simple_recorder.py', ['x'], true, {}, 'process-streaming');
  assert.strictEqual(withLabel.rec.attached.length, 1);
  assert.strictEqual(withLabel.rec.attached[0].label, 'process-streaming');
  stubChild.emit('proc', 'close', 0);
  await p1;

  stubChild = fakeChild();
  const noLabel = recordingDeps();
  const p2 = noLabel.run('simple_recorder.py', ['x'], true);
  assert.strictEqual(noLabel.rec.attached.length, 0);
  stubChild.emit('proc', 'close', 0);
  await p2;
});

test('runPythonScript rejects with the stderr text on a non-zero exit', async () => {
  stubChild = fakeChild();
  const { run } = recordingDeps();
  const p = run('simple_recorder.py', ['x'], true);
  stubChild.emit('stderr', 'data', Buffer.from('boom happened'));
  stubChild.emit('proc', 'close', 3);
  await assert.rejects(p, /code 3: boom happened/);
});

test('runPythonScript rejects and logs on a spawn error event', async () => {
  stubChild = fakeChild();
  const { rec, run } = recordingDeps();
  const p = run('simple_recorder.py', ['x'], false);
  stubChild.emit('proc', 'error', new Error('ENOENT'));
  await assert.rejects(p, /ENOENT/);
  assert.ok(rec.debug.includes('Command error: ENOENT'));
});

// Restore the real child_process.spawn once this file's tests are done.
test('teardown: restore child_process.spawn', () => {
  cp.spawn = realSpawn;
});
