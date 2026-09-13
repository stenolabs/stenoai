'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { EventEmitter } = require('node:events');
const ts = require('typescript');
const { makeLineReader } = require('./backend-stream');
const { classifyReprocessError } = require('./reprocess-error');

const cases = [
  ['Connection error.', 'generation_connection_failed'],
  ['[Errno 65] No route to host', 'generation_connection_failed'],
  ['Failed to connect to Ollama', 'generation_connection_failed'],
  ['ConnectError: Connection refused', 'generation_connection_failed'],
  ['model "synthetic-model" not found, try pulling it first (status code: 404)', 'generation_model_unavailable'],
  ['Failed to ensure model synthetic is available', 'generation_model_unavailable'],
  ['API rejected the request (401)', 'generation_auth_failed'],
  ['ReadTimeout: timed out', 'generation_timeout'],
  ['model requires more system memory than is available', 'generation_out_of_memory'],
  ['Remote Ollama URL is not configured.', 'generation_not_configured'],
  ['unrecognized failure with synthetic private content', 'generation_failed'],
];
for (const [input, code] of cases) {
  test(`classifies ${code}: ${input}`, () => assert.equal(classifyReprocessError(input), code));
}

// Exercise the actual registration, including protocol parsing and all emitted
// payloads. Parsing statement boundaries avoids coupling to brace indentation.
const source = fs.readFileSync(path.join(__dirname, 'main.js'), 'utf8');
const file = ts.createSourceFile('main.js', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
const registration = file.statements.find(statement => {
  if (!ts.isExpressionStatement(statement) || !ts.isCallExpression(statement.expression)) return false;
  const call = statement.expression;
  return ts.isPropertyAccessExpression(call.expression)
    && call.expression.expression.getText(file) === 'ipcMain'
    && call.expression.name.text === 'handle'
    && ts.isStringLiteral(call.arguments[0]) && call.arguments[0].text === 'reprocess-meeting';
});
assert.ok(registration, 'reprocess IPC registration must exist');
const watchdogDeclaration = file.statements.find(statement =>
  ts.isFunctionDeclaration(statement) && statement.name?.text === 'makeInactivityWatchdog');
assert.ok(watchdogDeclaration, 'real inactivity watchdog must exist');

async function start(validationError) {
  let handler;
  const events = [];
  const jobs = new Map();
  const proc = new EventEmitter();
  proc.stdout = new EventEmitter();
  proc.stderr = new EventEmitter();
  let syncs = 0;
  let nextTimer = 0;
  const timers = new Map();
  proc.kill = () => { proc.emit('close', null, 'SIGTERM'); return true; };
  vm.runInNewContext(watchdogDeclaration.getText(file) + '\n' + registration.getText(file), {
    ipcMain: { handle: (_channel, fn) => { handler = fn; } },
    classifyReprocessError, makeLineReader, Buffer,
    validateMeetingFilePath: async () => validationError ? { error: validationError } : { realPath: '/synthetic/meeting.md' },
    activeReprocessJobs: jobs, getAiEnv: () => ({}),
    getBackendEnv: () => ({}), getTranscriptionEnv: async () => ({}),
    spawn: () => proc, getBackendPath: () => '/synthetic/backend', getBackendCwd: () => '/synthetic',
    TRANSCRIBE_INACTIVITY_MS: 1000,
    activeInactivityWatchdogs: new Set(), systemSuspendedForWatchdogs: false,
    setTimeout: callback => { const id = ++nextTimer; timers.set(id, callback); return id; },
    clearTimeout: id => timers.delete(id),
    sendDebugLog() {}, forwardDiagnosticStdout() {}, console: { log() {}, error() {} },
    mainWindow: { isDestroyed: () => false, webContents: { send: (name, data) => events.push({ name, ...data }) } },
    obsidianSync: { syncNoteBySummaryPath: () => { syncs++; } },
    runPythonScript: async () => '[]',
  });
  const promise = handler({}, '/synthetic/meeting.md', false, 'Synthetic meeting');
  // validateMeetingFilePath is async; let it register the process listeners.
  await new Promise(resolve => setImmediate(resolve));
  return { proc, events, jobs, promise, syncs: () => syncs, expireWatchdog: () => {
    assert.equal(timers.size, 1);
    const callback = timers.values().next().value;
    timers.clear();
    callback();
  } };
}

test('split stream failure survives generic exit and no raw diagnostics reach the renderer', async () => {
  const { proc, events, jobs, promise, syncs } = await start();
  proc.stdout.emit('data', Buffer.from('STREAM_ER'));
  proc.stdout.emit('data', Buffer.from('ROR:[Errno 65] No route to host https://synthetic.invalid/private\r\n'));
  proc.stderr.emit('data', Buffer.from('synthetic private diagnostic tail'));
  proc.emit('close', 1);
  const result = await promise;
  assert.equal(result.success, false);
  assert.equal(result.error_code, 'generation_connection_failed');
  assert.deepEqual(events.map(e => [e.name, e.error_code]), [
    ['summary-complete', 'generation_connection_failed'],
    ['processing-complete', 'generation_connection_failed'],
  ]);
  assert.doesNotMatch(JSON.stringify({ result, events }), /private|synthetic\.invalid/);
  assert.equal(jobs.size, 0);
  assert.equal(syncs(), 0);
});

for (const channel of ['stdout', 'stderr']) {
  test(`failure before streaming is classified from ${channel}`, async () => {
    const { proc, promise, events } = await start();
    proc[channel].emit('data', Buffer.from('ERROR: Failed to reprocess summary: model "synthetic" not found\n'));
    proc.emit('close', 1);
    assert.equal((await promise).error_code, 'generation_model_unavailable');
    assert.equal(events[0].error_code, 'generation_model_unavailable');
  });
}

test('OpenAI and Anthropic connection diagnostics survive the stream protocol', async () => {
  const { proc, promise, events } = await start();
  proc.stdout.emit('data', Buffer.from('STREAM_ERROR:Connection error.\n'));
  proc.emit('close', 1);
  assert.equal((await promise).error_code, 'generation_connection_failed');
  assert.ok(events.every(e => e.error_code === 'generation_connection_failed'));
});

test('spawn failure returns safe generic error and removes the active job', async () => {
  const { proc, promise, jobs } = await start();
  proc.emit('error', new Error('spawn /synthetic/private/backend ENOENT'));
  const result = await promise;
  assert.equal(result.success, false);
  assert.equal(result.error_code, 'generation_failed');
  assert.doesNotMatch(JSON.stringify(result), /private/);
  assert.equal(jobs.size, 0);
});

test('path validation failure does not expose local paths', async () => {
  const { promise } = await start('File not found: /synthetic/private/meeting.md');
  const result = await promise;
  assert.equal(result.success, false);
  assert.doesNotMatch(JSON.stringify(result), /private/);
});

test('STREAM_ERROR is a failure even when the process exits zero', async () => {
  const { proc, promise, events, syncs } = await start();
  proc.stdout.emit('data', Buffer.from('STREAM_ERROR:unknown synthetic failure\n'));
  proc.emit('close', 0);
  assert.equal((await promise).success, false);
  assert.ok(events.every(e => !e.success));
  assert.equal(syncs(), 0);
});

test('successful generation still completes and syncs the saved note', async () => {
  const { proc, promise, events, jobs, syncs } = await start();
  proc.stdout.emit('data', Buffer.from('STREAM_COMPLETE\n'));
  proc.emit('close', 0);
  assert.equal((await promise).success, true);
  assert.ok(events.every(e => e.success));
  assert.equal(events[1].notesGenerated, true);
  assert.equal(jobs.size, 0);
  assert.equal(syncs(), 1);
});

for (const partial of [false, true]) {
  test(`real watchdog reports timeout after ${partial ? 'partial stream' : 'silent startup'}`, async () => {
    const { proc, events, jobs, promise, syncs, expireWatchdog } = await start();
    if (partial) proc.stdout.emit('data', Buffer.from('CHUNK:cGFydGlhbA==\n'));
    expireWatchdog();
    const result = await promise;
    assert.equal(result.success, false);
    assert.equal(result.error_code, 'generation_timeout');
    const completion = events.find(e => e.name === 'processing-complete');
    assert.equal(completion.success, false);
    assert.equal(completion.error_code, 'generation_timeout');
    assert.equal(jobs.size, 0);
    assert.equal(syncs(), 0);
  });
}

test('watchdog termination preserves a specific preceding stream failure', async () => {
  const { proc, promise, expireWatchdog } = await start();
  proc.stdout.emit('data', Buffer.from('STREAM_ERROR:model "synthetic" not found\n'));
  expireWatchdog();
  assert.equal((await promise).error_code, 'generation_model_unavailable');
});
