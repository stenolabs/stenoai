'use strict';
const { after, test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {
  hasLegacySpeakerModelCache,
  reprepareSpeakerModelsAfterUpgrade,
} = require('./speaker-model-upgrade');

const fixtures = [];
after(() => {
  for (const dir of fixtures) fs.rmSync(dir, { recursive: true, force: true });
});

function userData({ legacy }) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'steno-upgrade-'));
  fixtures.push(dir);
  if (legacy) {
    fs.mkdirSync(
      path.join(dir, 'models', 'speaker-diarization', 'sortformer', 'SortformerNvidiaHigh_v2.mlmodelc'),
      { recursive: true },
    );
  }
  return dir;
}

const MISSING = { success: true, ready: false, missing_models: ['sortformer/v3/fp16/x'] };

function run(overrides) {
  const calls = { status: 0, prepare: 0 };
  const promise = reprepareSpeakerModelsAfterUpgrade({
    platform: 'darwin',
    userDataDir: overrides.userDataDir ?? userData({ legacy: true }),
    env: {},
    checkStatus: async () => { calls.status++; return MISSING; },
    prepare: async () => { calls.prepare++; return { success: true, ready: true }; },
    ...overrides,
  });
  return { promise, calls };
}

test('a pre-upgrade cache whose models no longer load is downloaded again', async () => {
  const { promise, calls } = run({});
  assert.equal(await promise, true);
  assert.deepEqual(calls, { status: 1, prepare: 1 });
});

test('installs without the old cache never start the backend', async () => {
  const { promise, calls } = run({ userDataDir: userData({ legacy: false }) });
  assert.equal(await promise, false);
  assert.deepEqual(calls, { status: 0, prepare: 0 });
});

test('ready models, a failed check, or a failed status call download nothing', async () => {
  for (const checkStatus of [
    async () => ({ success: true, ready: true, missing_models: [] }),
    async () => ({ success: false, ready: false, error: 'unavailable' }),
    async () => { throw new Error('spawn failed'); },
  ]) {
    const { promise, calls } = run({ checkStatus });
    assert.equal(await promise, false);
    assert.equal(calls.prepare, 0);
  }
});

test('a failed or throwing download reports false so the next launch retries', async () => {
  for (const prepare of [
    async () => ({ success: false, ready: false, error: 'offline' }),
    // Startup discards the promise and main.js exits on unhandled rejections.
    async () => { throw new Error('spawn EACCES'); },
  ]) {
    const { promise } = run({ prepare });
    assert.equal(await promise, false);
  }
});

test('off macOS, or under a model-dir override, nothing runs', async () => {
  for (const overrides of [{ platform: 'win32' }, { env: { STENOAI_DIARIZE_MODEL_DIR: '/shared/cache' } }]) {
    const { promise, calls } = run(overrides);
    assert.equal(await promise, false);
    assert.deepEqual(calls, { status: 0, prepare: 0 });
  }
  assert.equal(hasLegacySpeakerModelCache(userData({ legacy: true }), { STENOAI_DIARIZE_MODEL_DIR: ' ' }), true);
});
