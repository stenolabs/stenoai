'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { EventEmitter } = require('node:events');
const { findAudioSource, runAudioConverter } = require('./meeting-transfer-audio');

test('audio discovery rejects symlinked recordings even with a matching outside filename', async t => {
  const scratch = await fs.mkdtemp(path.join(os.tmpdir(), 'steno-audio-path-'));
  t.after(() => fs.rm(scratch, { recursive: true, force: true }));
  const root = await fs.realpath(scratch);
  const base = path.join(root, 'library');
  const outside = path.join(root, 'outside');
  await fs.mkdir(path.join(base, 'output'), { recursive: true });
  await fs.mkdir(outside);
  await fs.writeFile(path.join(outside, 'meeting.wav'), 'synthetic');
  const summary = path.join(base, 'output', 'meeting_summary.json');
  await fs.symlink(outside, path.join(base, 'recordings'), process.platform === 'win32' ? 'junction' : 'dir');
  await assert.rejects(findAudioSource(summary, [base], ['wav']), { code: 'unsafe_storage' });
  await fs.unlink(path.join(base, 'recordings'));
  await fs.mkdir(path.join(base, 'recordings'));
  const wav = path.join(base, 'recordings', 'meeting.wav');
  await fs.writeFile(wav, 'synthetic');
  assert.equal(await findAudioSource(summary, [base], ['wav']), wav);
});

test('converter timeout escalates and waits for close before allowing cleanup', async () => {
  const child = new EventEmitter();
  const signals = [];
  let notifyKill;
  const killed = new Promise(resolve => { notifyKill = resolve; });
  child.kill = signal => { signals.push(signal); if (signal === 'SIGKILL') notifyKill(); };
  let settled = false;
  const conversion = runAudioConverter('synthetic', [], { spawnProcess: () => child, timeoutMs: 5, graceMs: 5 });
  conversion.then(() => { settled = true; }, () => { settled = true; });
  await killed;
  assert.deepEqual(signals, ['SIGTERM', 'SIGKILL']);
  assert.equal(settled, false);
  child.emit('close', null);
  await assert.rejects(conversion, { code: 'transfer_failed' });
});

test('converter spawn error waits for close and successful close clears timers', async () => {
  for (const fail of [false, true]) {
    const child = new EventEmitter();
    child.kill = () => assert.fail('unexpected timeout');
    const conversion = runAudioConverter('synthetic', [], { spawnProcess: () => child });
    if (fail) child.emit('error', new Error('synthetic spawn failure'));
    child.emit('close', fail ? -1 : 0);
    if (fail) await assert.rejects(conversion, { code: 'transfer_failed' });
    else await conversion;
  }
});
