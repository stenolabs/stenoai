'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { makeLineReader } = require('./backend-stream');
const { createSpeakerModelPreparer } = require('./speaker-model-prepare');

const READY = JSON.stringify({
  success: true,
  ready: true,
  cache_directory: '/synthetic/models/speaker-diarization',
  required_models: ['sortformer/SortformerNvidiaHigh_v2.mlmodelc'],
  missing_models: [],
});

function setup(platform = 'darwin') {
  const procs = [];
  const progress = [];
  const prepare = createSpeakerModelPreparer({
    platform,
    makeLineReader,
    getBackendPath: () => '/synthetic/backend',
    getBackendCwd: () => '/synthetic',
    spawn: (_bin, args, opts) => {
      assert.equal(args[0], 'prepare-speaker-models');
      assert.equal(opts.cwd, '/synthetic');
      const proc = new EventEmitter();
      proc.args = args;
      proc.stdout = new EventEmitter();
      proc.stderr = new EventEmitter();
      procs.push(proc);
      return proc;
    },
    onProgress: (event) => progress.push(event),
  });
  return { prepare, procs, progress };
}

test('relays split progress lines and resolves with the final status', async () => {
  const { prepare, procs, progress } = setup();
  const promise = prepare();
  for (const chunk of [
    'SPEAKER_MODELS_PRO', 'GRESS:{"percent": 12, "phase": "downloading"}\r\n',
    'SPEAKER_MODELS_PROGRESS:{"percent": 140, "phase": "downloading"}\n',
    'SPEAKER_MODELS_PROGRESS:{"percent": 60, "phase": "/etc/passwd"}\n',
    'SPEAKER_MODELS_PROGRESS:not json\n',
    'SPEAKER_MODELS_PROGRESS:{"percent": 80, "phase": "compiling", "extra": "x"}\n',
    `${READY.slice(0, 20)}`, `${READY.slice(20)}\n`,
  ]) {
    procs[0].stdout.emit('data', Buffer.from(chunk));
  }
  procs[0].emit('close', 0);
  const result = await promise;
  assert.equal(result.ready, true);
  assert.deepEqual(progress, [
    { percent: 12, phase: 'downloading' },
    { percent: 80, phase: 'compiling' },
  ]);
});

test('a failed or garbled run resolves to a structured failure', async () => {
  const { prepare, procs } = setup();
  const promise = prepare();
  procs[0].stdout.emit('data', Buffer.from('Traceback: boom\n'));
  procs[0].emit('close', 1);
  assert.deepEqual(await promise, {
    success: false, ready: false, error: 'Speaker diarization model setup failed',
  });
});

test('a structured backend failure is passed through as-is', async () => {
  const { prepare, procs } = setup();
  const promise = prepare();
  const failure = { success: false, ready: false, error: 'Speaker diarization model setup failed' };
  procs[0].stdout.emit('data', Buffer.from(`${JSON.stringify(failure)}\n`));
  procs[0].emit('close', 1);
  assert.deepEqual(await promise, failure);
});

test('a spawn error resolves to the structured failure', async () => {
  const { prepare, procs } = setup();
  const promise = prepare();
  procs[0].emit('error', new Error('ENOENT'));
  assert.deepEqual(await promise, {
    success: false, ready: false, error: 'Speaker diarization model setup failed',
  });
});

test('concurrent requests share one download; a later request starts a new one', async () => {
  const { prepare, procs } = setup();
  const first = prepare();
  const second = prepare();
  assert.equal(procs.length, 1);
  procs[0].stdout.emit('data', Buffer.from(`${READY}\n`));
  procs[0].emit('close', 0);
  assert.equal(await first, await second);
  const third = prepare();
  assert.equal(procs.length, 2);
  procs[1].emit('close', 1);
  assert.equal((await third).success, false);
});

test('the engine reaches the backend; omitted means the saved setting', async () => {
  const { prepare, procs } = setup();
  const saved = prepare();
  assert.deepEqual(procs[0].args, ['prepare-speaker-models']);
  procs[0].emit('close', 0);
  await saved;
  const nemotron = prepare('nemotron3');
  assert.deepEqual(procs[1].args, ['prepare-speaker-models', '--engine', 'nemotron3']);
  procs[1].emit('close', 0);
  await nemotron;
});

test('a different engine waits for the running download instead of racing it', async () => {
  const { prepare, procs } = setup();
  const sortformer = prepare('sortformer');
  const nemotron = prepare('nemotron3');
  const nemotronAgain = prepare('nemotron3');
  assert.equal(procs.length, 1);
  procs[0].stdout.emit('data', Buffer.from(`${READY}\n`));
  procs[0].emit('close', 0);
  assert.equal((await sortformer).ready, true);
  await new Promise(setImmediate);
  assert.equal(procs.length, 2);
  assert.deepEqual(procs[1].args, ['prepare-speaker-models', '--engine', 'nemotron3']);
  procs[1].emit('close', 1);
  assert.equal(await nemotron, await nemotronAgain);
  assert.equal((await nemotron).success, false);
});

test('non-macOS never spawns the backend', async () => {
  const { prepare, procs } = setup('win32');
  assert.equal((await prepare()).success, false);
  assert.equal(procs.length, 0);
});
