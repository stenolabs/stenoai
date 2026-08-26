'use strict';

/**
 * IPC contract conformance — catches channel-name drift across the four files
 * that hand-maintain the renderer<->main wire, so a rename/removal in one place
 * fails CI instead of silently breaking at runtime.
 *
 * The channel name is a bare string threaded through four files with nothing
 * else tying them together:
 *   - app/main.js           — the registrations: ipcMain.handle/on/once('<ch>')
 *   - app/preload.js        — the contextBridge surface: invoke/send('<ch>') for
 *                             renderer->main calls, subscribe('<ch>') for the
 *                             main->renderer (M->R) event stream
 *   - app/renderer/src/lib/ipc.ts — the typed bridge the renderer actually calls
 *   - app/e2e-mock-ipc.js   — the T1 mock that shims ipcMain.handle
 *
 * These are JS/TS source files; we scan them as text (regex), matching the
 * codebase's pragmatism. That is deliberately good enough: the goal is drift
 * detection, not a full parse.
 *
 * The real relationships (NOT a naive "all four must be identical"):
 *
 *   1. preload invoke/send channels  ==  main.js registrations (+ a small
 *      allowlist of channels registered by a third-party package, not by our
 *      source). A renderer channel with no handler rejects invoke() at runtime
 *      ("no handler registered"); an orphan handler is dead code. Both directions
 *      are checked.
 *   2. e2e-mock stub keys  is-subset-of  renderer-callable channels. The mock
 *      only needs entries for channels whose *shape* matters on first paint; it
 *      resolves everything else permissively (see e2e-mock-ipc.js). So the drift
 *      risk is the reverse of "every channel must be stubbed": a *stale* stub
 *      that names a channel which no longer exists would silently do nothing.
 *   3. preload subscribe (M->R) channels  are each emitted somewhere in main.js
 *      (webContents.send). These are NOT ipcMain registrations.
 *   4. ipc.ts is a *typed structural mirror* of the preload bridge object — it
 *      carries no channel-name string literals, so its channels can't be
 *      string-scanned. We instead assert the top-level bridge namespaces in
 *      ipc.ts match preload's, catching a whole namespace added/removed out of
 *      sync (the per-method shape is covered by tsc + the T1 e2e suite).
 *
 * Cross-platform: pure text scanning, no platform assumptions — runs the same on
 * macOS and Windows.
 */

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const read = (rel) => fs.readFileSync(path.join(__dirname, rel), 'utf8');

const MAIN = read('main.js');
const PRELOAD = read('preload.js');
const MOCK = read('e2e-mock-ipc.js');
const IPC_TS = read('renderer/src/lib/ipc.ts');

// Extracted sibling IPC modules (RFC #327): main.js delegates whole handler
// groups to `*-ipc.js` modules, so the registration + M->R emission scans union
// them with main.js — a handler or send() that MOVED out of main.js must still
// count as present. e2e-mock-ipc.js also matches `*-ipc.js` but is the T1 test
// double, not a real registrar, so it is excluded. debug-log.js is not a handler
// module but owns `.send('debug-log')` after the Phase 0 extraction, so it joins
// the EMISSION sources only.
const SIBLING_IPC_MODULES = fs
  .readdirSync(__dirname)
  .filter((f) => /-ipc\.js$/.test(f) && f !== 'e2e-mock-ipc.js' && !/\.test\.js$/.test(f))
  .map((f) => read(f));
const EMIT_ONLY_SOURCES = ['debug-log.js'].map((f) => read(f));

// Where ipcMain.handle/on/once registrations may live: main.js + handler modules.
const REGISTRATION_SOURCES = [MAIN, ...SIBLING_IPC_MODULES];
// Where main->renderer `.send()` emissions may live: the above + emit-only modules.
const EMISSION_SOURCES = [MAIN, ...SIBLING_IPC_MODULES, ...EMIT_ONLY_SOURCES];

// Channels registered outside our own source: electron-audio-loopback's
// initMain() (app/main.js) installs these ipcMain handlers itself, so they are
// renderer-callable without a literal ipcMain.handle in main.js.
const EXTERNALLY_REGISTERED = new Set(['enable-loopback-audio', 'disable-loopback-audio']);

function matchAll(src, re) {
  const out = [];
  for (const m of src.matchAll(re)) out.push(m[1]);
  return out;
}

// --- main.js: every ipcMain.handle / .on / .once registration ---
function mainRegistrations() {
  return REGISTRATION_SOURCES.flatMap((src) =>
    matchAll(src, /ipcMain\.(?:handle|on|once)\(\s*["']([^"']+)["']/g),
  );
}

// --- preload.js: renderer->main channels (invoke = request, send = fire) ---
function preloadInvokeChannels() {
  return new Set(matchAll(PRELOAD, /\b(?:invoke|send)\(\s*["']([^"']+)["']/g));
}

// --- preload.js: main->renderer event channels (subscribe wrapper) ---
function preloadSubscribeChannels() {
  return new Set(matchAll(PRELOAD, /\bsubscribe\(\s*["']([^"']+)["']/g));
}

// --- e2e-mock-ipc.js: the MOCKS + DEFAULTS stub keys. Anchored to the
// top-level object-literal indent (4 spaces, both MOCKS and DEFAULTS keys
// sit directly under `const MOCKS = {`/`const DEFAULTS = {`) rather than any
// quoted kebab-case string anywhere in the file — a mock's *response value*
// can itself contain kebab-case keys (e.g. a model id nested inside a
// catalog), which would otherwise be misread as a second, stale channel
// stub. ---
function mockStubKeys() {
  return new Set(matchAll(MOCK, /^ {4}["']([a-z0-9]+(?:-[a-z0-9]+)+)["']\s*:/gm));
}

test('main.js has no duplicate ipcMain registrations (Electron throws on the 2nd)', () => {
  const regs = mainRegistrations();
  const seen = new Set();
  const dups = [];
  for (const ch of regs) {
    if (seen.has(ch)) dups.push(ch);
    else seen.add(ch);
  }
  assert.deepStrictEqual(dups, [], `duplicate ipcMain registration(s): ${dups.join(', ')}`);
});

test('custom loopback handler avoids screen capture and catches callback failures', () => {
  const initMainAt = MAIN.indexOf("initMain({ forceCoreAudioTap: process.platform === 'darwin' });");
  const removePackageHandlerAt = MAIN.indexOf("ipcMain.removeHandler('enable-loopback-audio');");
  const windowsSetupAt = MAIN.indexOf('// Windows taskbar identity.');
  assert.ok(initMainAt >= 0, 'expected electron-audio-loopback initMain call');
  assert.ok(
    removePackageHandlerAt > initMainAt && removePackageHandlerAt < windowsSetupAt,
    'custom enable-loopback-audio handler must replace the package handler immediately after initMain',
  );

  const handler = MAIN.slice(removePackageHandlerAt, windowsSetupAt);
  assert.match(handler, /ipcMain\.handle\('enable-loopback-audio',\s*\(\)\s*=>\s*{/);
  assert.match(handler, /setDisplayMediaRequestHandler\(\(request,\s*callback\)\s*=>\s*{/);
  assert.match(handler, /try\s*{\s*callback\(\{\s*video:\s*request\.frame,\s*audio:\s*'loopback'\s*}\);/s);
  assert.match(handler, /catch\s*\(err\)\s*{\s*console\.error\(/s);
  assert.doesNotMatch(handler, /desktopCapturer|getSources/);
});

test('every renderer-callable channel (preload invoke/send) is registered in main.js', () => {
  const registered = new Set(mainRegistrations());
  const missing = [...preloadInvokeChannels()].filter(
    (ch) => !registered.has(ch) && !EXTERNALLY_REGISTERED.has(ch),
  );
  assert.deepStrictEqual(
    missing.sort(),
    [],
    `preload invokes channel(s) with no ipcMain handler (invoke() would reject): ${missing.join(', ')}`,
  );
});

test('every main.js registration is reachable from the preload bridge (no orphan handlers)', () => {
  const invocable = preloadInvokeChannels();
  const orphans = [...new Set(mainRegistrations())].filter((ch) => !invocable.has(ch));
  assert.deepStrictEqual(
    orphans.sort(),
    [],
    `main.js registers channel(s) the renderer bridge never calls (dead handler?): ${orphans.join(', ')}`,
  );
});

test('every e2e-mock stub names a real renderer-callable channel (no stale stub)', () => {
  const invocable = preloadInvokeChannels();
  const stale = [...mockStubKeys()].filter((ch) => !invocable.has(ch));
  assert.deepStrictEqual(
    stale.sort(),
    [],
    `e2e-mock-ipc.js stubs channel(s) that are not renderer-callable (renamed/removed?): ${stale.join(', ')}`,
  );
});

// The channel name in main.js's M->R events is always the FIRST argument of a
// send call — `mainWindow.webContents.send('<ch>', payload)`, `event.sender.send`,
// or `sender.send` — and is sometimes a ternary of literals
// (`send(cond ? 'a' : 'b')`). Extract just that first argument (up to the first
// top-level comma / the closing paren, honoring quotes so a ')' or ',' inside a
// string never ends it early) and collect the channel literals from it. Scoping
// to the first argument keeps channel-shaped strings in a *payload* object from
// counting as a send site, and matching a real `.send(` call — not a bare
// substring anywhere — means a channel named only in a comment can't satisfy it.
function firstSendArg(src, i) {
  let depth = 1;
  let quote = null;
  let out = '';
  for (; i < src.length; i++) {
    const c = src[i];
    if (quote) {
      out += c;
      if (c === quote && src[i - 1] !== '\\') quote = null;
      continue;
    }
    if (c === "'" || c === '"' || c === '`') {
      quote = c;
      out += c;
      continue;
    }
    if (c === '(') depth++;
    else if (c === ')') {
      depth--;
      if (depth === 0) break;
    } else if (c === ',' && depth === 1) break;
    out += c;
  }
  return out;
}

function channelsEmittedViaSend() {
  const emitted = new Set();
  for (const src of EMISSION_SOURCES) {
    const re = /\.send\(/g;
    let m;
    while ((m = re.exec(src))) {
      const arg = firstSendArg(src, re.lastIndex);
      for (const lit of arg.matchAll(/["']([^"']+)["']/g)) emitted.add(lit[1]);
    }
  }
  return emitted;
}

test('every M->R subscribe channel is emitted at a real send() site in main.js', () => {
  const emitted = channelsEmittedViaSend();
  const missing = [...preloadSubscribeChannels()].filter((ch) => !emitted.has(ch));
  assert.deepStrictEqual(
    missing.sort(),
    [],
    `preload subscribes to M->R channel(s) main.js never send()s: ${missing.join(', ')}`,
  );
});

test('ipc.ts bridge namespaces match the preload bridge (type mirror in sync)', () => {
  // preload: top-level keys of `const stenoai = { ... }` (2-space indent),
  // including shorthand properties like `subscribeQueryStream,`.
  const stenoaiBody = PRELOAD.slice(PRELOAD.indexOf('const stenoai = {'));
  const preloadKeys = new Set(matchAll(stenoaiBody, /^ {2}([a-zA-Z]+)[,:]/gm));

  // ipc.ts: members of `interface StenoaiBridge { ... }` (2-space indent).
  const bridgeBody = IPC_TS.slice(IPC_TS.indexOf('interface StenoaiBridge {'));
  const tsKeys = new Set(matchAll(bridgeBody, /^ {2}([a-zA-Z]+)[?:]/gm));

  const onlyPreload = [...preloadKeys].filter((k) => !tsKeys.has(k)).sort();
  const onlyTs = [...tsKeys].filter((k) => !preloadKeys.has(k)).sort();
  assert.deepStrictEqual(
    { onlyPreload, onlyTs },
    { onlyPreload: [], onlyTs: [] },
    `preload bridge and StenoaiBridge namespaces drifted — only in preload: [${onlyPreload}], only in ipc.ts: [${onlyTs}]`,
  );
});

// The registration + emission scans read the sibling modules straight off disk,
// so a module whose require()/register call was deleted from main.js would still
// look "wired" to the union (its channels register/emit to the scanner even though
// nothing invokes it at runtime). Assert the wiring explicitly: main.js must both
// require each extracted module AND call its entry point.
test('every extracted seam module is required AND invoked in main.js (reachability)', () => {
  const modules = [
    // handler modules: entry points are their register* exports
    ...fs
      .readdirSync(__dirname)
      .filter((f) => /-ipc\.js$/.test(f) && f !== 'e2e-mock-ipc.js' && !/\.test\.js$/.test(f))
      .map((f) => ({ file: f, entryPoints: matchAll(read(f), /function\s+(register\w+)\s*\(/g) })),
    // emit-only module: entry point is the createDebugLog factory
    { file: 'debug-log.js', entryPoints: ['createDebugLog'] },
  ];
  // Scan main.js with comments stripped, so a stale pointer comment that
  // mentions a require()/factory call (e.g. "// sendDebugLog now comes from
  // ./debug-log via createDebugLog(...)") can't satisfy the check — a de-wired
  // module must actually fail. Line-comment strip guards against `://` in URLs.
  const code = MAIN
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/.*$/gm, '$1');
  const unwired = [];
  for (const { file, entryPoints } of modules) {
    const base = file.replace(/\.js$/, '');
    const required =
      code.includes(`require('./${base}')`) || code.includes(`require("./${base}")`);
    const invoked =
      entryPoints.length > 0 &&
      entryPoints.every((fn) => new RegExp(`\\b${fn}\\s*\\(`).test(code));
    if (!required || !invoked) unwired.push(`${file} (required:${required} invoked:${invoked})`);
  }
  assert.deepStrictEqual(
    unwired,
    [],
    `extracted module(s) not wired into main.js (dead registration?): ${unwired.join('; ')}`,
  );
});

// The T1 speaker spec asserts the play button toggles to "Stop sample" while
// a clip is playing. PlaySampleButton flips that label back on the media
// element's `ended` event, so the assertion is only stable while the fixture
// clip is still running. The original fixture was a 44-byte header with zero
// sample data: measured in the real renderer, it reported duration 0 and
// fired `ended` ~300ms after play(). That is why the spec was green on a Mac
// and red on CI - the runner's first assertion poll landed after the clip had
// already finished.
//
// Pinned here rather than left to the spec, because shrinking the fixture
// again would not fail loudly: it would just make that one test flaky, on
// someone else's machine, weeks later.
test('the mock sample clip is long enough for a playing state to be observable', () => {
  const mock = require('./e2e-mock-ipc.js');
  void mock; // required only so a syntax error in the fixture fails here too

  const match = MOCK.match(/const SILENT_WAV_SECONDS = (\d+)/);
  assert.ok(match, 'e2e-mock-ipc.js no longer declares SILENT_WAV_SECONDS');
  assert.ok(
    Number(match[1]) >= 2,
    `the fixture clip is ${match[1]}s; under ~2s the "toggling to stop" assertion races the ended event`,
  );
});

test('live transcript reads and queries are limited to the trusted app renderer', () => {
  const getStateIndex = MAIN.indexOf("ipcMain.handle('get-live-transcript-state',");
  assert.ok(getStateIndex >= 0, 'expected get-live-transcript-state handler in main.js');
  const getStateBlock = MAIN.slice(getStateIndex, getStateIndex + 500);
  assert.match(
    getStateBlock,
    /event\.sender\s*!==\s*mainWindow\.webContents/,
    'get-live-transcript-state must verify event.sender === mainWindow.webContents',
  );

  const queryLiveIndex = MAIN.indexOf("ipcMain.on('query-live-transcript-stream',");
  assert.ok(queryLiveIndex >= 0, 'expected query-live-transcript-stream handler in main.js');
  const queryLiveBlock = MAIN.slice(queryLiveIndex, queryLiveIndex + 500);
  assert.match(
    queryLiveBlock,
    /sender\s*!==\s*mainWindow\.webContents/,
    'query-live-transcript-stream must verify event.sender === mainWindow.webContents',
  );
});

test('live queries use the configured provider without putting content or overrides in argv', () => {
  const queryLiveIndex = MAIN.indexOf("ipcMain.on('query-live-transcript-stream',");
  const queryLiveBlock = MAIN.slice(queryLiveIndex, queryLiveIndex + 2200);
  assert.match(
    queryLiveBlock,
    /\['query-live-streaming'\]/,
    'query-live-streaming must use a content-free command argv',
  );
  assert.match(
    queryLiveBlock,
    /env:\s*\{\s*\.\.\.process\.env,\s*\.\.\.getAiEnv\(\)\s*\}/,
    'query-live-streaming must inherit the configured provider environment',
  );
  assert.doesNotMatch(
    queryLiveBlock,
    /--host|--model|-q/,
    'live query argv must not override provider/model or contain the user question',
  );
});

test('live query failures and diagnostics never forward backend or prompt text', () => {
  const protocolIndex = MAIN.indexOf('function handleLiveQueryProtocolLine(');
  const cancelIndex = MAIN.indexOf('const pendingQueryCancels = new Map();');
  assert.ok(protocolIndex >= 0 && cancelIndex > protocolIndex);
  const liveQueryBlock = MAIN.slice(protocolIndex, cancelIndex);
  assert.match(liveQueryBlock, /FIXED_LIVE_QUERY_ERRORS\.FAILED/);
  assert.doesNotMatch(
    liveQueryBlock,
    /error:\s*err\.message|error:\s*line\.slice|Process exited with code/,
    'live query errors must be fixed strings, never raw child-process text',
  );
  assert.doesNotMatch(
    liveQueryBlock,
    /sendDebugLog|console\.(?:log|warn|error)/,
    'live query handling must not log transcript, question, or provider output',
  );
});

test('live query cancellation is bound to the renderer that started it', () => {
  const cancelIndex = MAIN.indexOf("ipcMain.on('query-cancel',");
  assert.ok(cancelIndex >= 0, 'expected query-cancel handler in main.js');
  const cancelBlock = MAIN.slice(cancelIndex, cancelIndex + 1000);
  assert.match(
    cancelBlock,
    /activeLiveQuery\.sender\s*===\s*sender/,
    'query-cancel must verify activeLiveQuery.sender === sender',
  );
});
