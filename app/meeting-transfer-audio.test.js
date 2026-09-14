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
  assert.equal((await findAudioSource(summary, [base], ['wav'])).sourcePath, wav);
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

test('a source disappearing between discovery and stat reports source_changed', async t => {
  const scratch = await fs.mkdtemp(path.join(os.tmpdir(), 'steno-disappearing-audio-'));
  t.after(() => fs.rm(scratch, { recursive: true, force: true }));
  const base = await fs.realpath(scratch);
  const dir = path.join(base, 'recordings');
  await fs.mkdir(dir);
  const source = path.join(dir, 'meeting.wav');
  await fs.writeFile(source, 'synthetic');
  const lstat = fs.lstat;
  fs.lstat = async (file, ...args) => {
    if (file === source) await fs.unlink(source);
    return lstat(file, ...args);
  };
  try {
    await assert.rejects(findAudioSource(path.join(base, 'output', 'meeting_summary.json'), [base], ['wav']), { code: 'source_changed' });
  } finally { fs.lstat = lstat; }
});

test('a source replaced by a directory between discovery and stat reports source_changed', async t => {
  const scratch = await fs.mkdtemp(path.join(os.tmpdir(), 'steno-replaced-audio-'));
  t.after(() => fs.rm(scratch, { recursive: true, force: true }));
  const base = await fs.realpath(scratch);
  const dir = path.join(base, 'recordings');
  await fs.mkdir(dir);
  const source = path.join(dir, 'meeting.wav');
  await fs.writeFile(source, 'synthetic');
  const lstat = fs.lstat;
  fs.lstat = async (file, ...args) => {
    if (file === source) {
      await fs.unlink(source);
      await fs.mkdir(source);
    }
    return lstat(file, ...args);
  };
  try {
    await assert.rejects(findAudioSource(path.join(base, 'output', 'meeting_summary.json'), [base], ['wav']), { code: 'source_changed' });
  } finally { fs.lstat = lstat; }
});

const { PassThrough } = require('node:stream');
const { runNativeAudioConverter, encodeNativeAudio, convertTransferAudio } = require('./meeting-transfer-audio');
const { inspectCAF } = require('./meeting-transfer-codec');
const { makeWav } = require('../e2e/fixtures/make-wav');
const { makeWebMOpus } = require('../e2e/fixtures/make-webm-opus');
const helper = path.resolve(__dirname, '../bin/steno-audio-encode');
const nativeOnly = { skip: process.platform !== 'darwin' || process.arch !== 'arm64' };

function nativeChild() {
  const child = new EventEmitter();
  child.stdout = new PassThrough(); child.stderr = new PassThrough();
  child.kill = () => {};
  return child;
}

test('native converter passes only inherited FDs and parses success after close', async () => {
  const child = nativeChild();
  const promise = runNativeAudioConverter('helper', 12, 13, { spawnProcess: (binary, args, options) => {
    assert.equal(binary, 'helper');
    assert.deepEqual(args, ['--input-fd', '3', '--output-fd', '4']);
    assert.deepEqual(options, { shell: false, stdio: ['ignore', 'pipe', 'pipe', 12, 13] });
    return child;
  } });
  child.stdout.write('{"codec":"aac"}\n');
  child.emit('close', 0);
  assert.deepEqual(await promise, { codec: 'aac' });
});

test('native converter output flood terminates then waits for close before cleanup', async () => {
  const child = nativeChild(); const signals = [];
  let killed;
  const escalated = new Promise(resolve => { killed = resolve; });
  child.kill = signal => { signals.push(signal); if (signal === 'SIGKILL') killed(); };
  let settled = false;
  const promise = runNativeAudioConverter('helper', 3, 4, { spawnProcess: () => child, outputLimit: 8, graceMs: 2 });
  promise.catch(() => { settled = true; });
  child.stderr.write('too much output');
  await escalated;
  assert.equal(settled, false); assert.deepEqual(signals, ['SIGTERM', 'SIGKILL']);
  child.emit('close', null);
  await assert.rejects(promise, { code: 'transfer_failed' });
});

test('native converter rejects malformed JSON and failed exit', async () => {
  for (const code of [0, 1]) {
    const child = nativeChild();
    const promise = runNativeAudioConverter('helper', 3, 4, { spawnProcess: () => child });
    child.stdout.write('not JSON'); child.emit('close', code);
    await assert.rejects(promise, { code: code ? 'unsupported_audio' : 'transfer_failed' });
  }
});

async function nativeScratch(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'native-transfer-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.access(helper); // A native CI run must build the helper, never silently skip it.
  return root;
}

test('native WAV export compresses both channels, preserves originals and retains AAC bytes', nativeOnly, async t => {
  const root = await nativeScratch(t);
  for (const channels of [1, 2]) {
    const input = path.join(root, `tone-${channels}.wav`), target = path.join(root, `tone-${channels}.caf`);
    makeWav(input, { seconds: 2.0001, sampleRate: 48000, channels });
    const original = await fs.readFile(input);
    const result = await convertTransferAudio(input, target, { nativeHelper: helper });
    assert.equal(result.channelCount, channels);
    assert.equal(Math.round(result.duration * 48000), Math.floor(2.0001 * 48000));
    assert.ok(result.byteCount < original.length);
    assert.deepEqual(await fs.readFile(input), original);
    assert.equal((await inspectCAF(target, { includeFormat: true })).format, 'aac ');
    const copy = path.join(root, `copy-${channels}.caf`);
    await convertTransferAudio(target, copy, {}); // AAC passthrough needs no helper.
    assert.deepEqual(await fs.readFile(copy), await fs.readFile(target));
  }
});

test('native WebM export preserves Opus valid timing and fails closed on gaps', nativeOnly, async t => {
  const root = await nativeScratch(t);
  const input = path.join(root, 'silence.webm'), output = path.join(root, 'silence.caf');
  const bytes = makeWebMOpus(); await fs.writeFile(input, bytes);
  const result = await convertTransferAudio(input, output, { nativeHelper: helper });
  assert.equal(Math.round(result.duration * 48000), 95208);
  assert.equal(result.channelCount, 2);
  assert.equal((await inspectCAF(output, { includeFormat: true })).format, 'opus');
  assert.deepEqual(await fs.readFile(input), bytes);
  const copy = path.join(root, 'copy.caf');
  await convertTransferAudio(output, copy, {});
  assert.deepEqual(await fs.readFile(copy), await fs.readFile(output));
  await fs.writeFile(input, makeWebMOpus({ gap: 1000 }));
  await assert.rejects(convertTransferAudio(input, path.join(root, 'failed.caf'), { nativeHelper: helper, ffmpeg: 'must-not-run' }), { code: 'unsupported_audio' });
});

test('helper output claims and concurrent source mutation are rejected', nativeOnly, async t => {
  const root = await nativeScratch(t), input = path.join(root, 'tone.wav');
  makeWav(input);
  await assert.rejects(encodeNativeAudio(input, path.join(root, 'false.caf'), helper, { run: async (...args) => {
    const result = await runNativeAudioConverter(...args); result.sourceSHA256 = '0'.repeat(64); return result;
  } }), { code: 'transfer_failed' });
  await assert.rejects(encodeNativeAudio(input, path.join(root, 'changed.caf'), helper, { run: async (...args) => {
    const result = await runNativeAudioConverter(...args);
    const bytes = await fs.readFile(input); bytes[bytes.length - 1] ^= 1; await fs.writeFile(input, bytes);
    return result;
  } }), { code: 'source_changed' });
});

test('Opus CAF rejects contradictory cookies, packet timing and truncated tables', nativeOnly, async t => {
  const root = await nativeScratch(t), source = path.join(root, 'input.webm'), target = path.join(root, 'output.caf');
  await fs.writeFile(source, makeWebMOpus());
  await convertTransferAudio(source, target, { nativeHelper: helper });
  const original = await fs.readFile(target);
  const chunks = {};
  for (let position = 8; position < original.length;) {
    const type = original.toString('ascii', position, position + 4);
    const size = Number(original.readBigInt64BE(position + 4));
    chunks[type] = { start: position + 12, size, header: position };
    position += 12 + size;
  }
  const cases = [
    b => { b[chunks.kuki.start + 9] = 1; },
    b => { b[chunks.kuki.start + 10] ^= 1; },
    b => { b[chunks.kuki.start + 16] = 1; },
    b => { b.writeBigInt64BE(1000001n, chunks.pakt.start); },
    b => { b[chunks.pakt.start + 15] ^= 1; },
    b => { b[chunks.pakt.start + 26] ^= 1; },
    b => { b[chunks.data.start + 4] = 0; },
    b => { b.writeBigInt64BE(BigInt(chunks.pakt.size - 1), chunks.pakt.header + 4); },
  ];
  for (const [index, change] of cases.entries()) {
    const bytes = Buffer.from(original); change(bytes);
    const file = path.join(root, `invalid-${index}.caf`); await fs.writeFile(file, bytes);
    await assert.rejects(inspectCAF(file), { code: 'unsupported_audio' });
  }
});

test('native converter timeout waits for termination and does not accept late success', async () => {
  const child = nativeChild();
  let killed;
  const escalated = new Promise(resolve => { killed = resolve; });
  child.kill = signal => { if (signal === 'SIGKILL') killed(); };
  const promise = runNativeAudioConverter('helper', 3, 4, { spawnProcess: () => child, timeoutMs: 2, graceMs: 2 });
  await escalated;
  child.stdout.write('{}'); child.emit('close', 0);
  await assert.rejects(promise, { code: 'transfer_failed' });
});

test('multichannel WAV retains the existing PCM export path', nativeOnly, async t => {
  const root = await nativeScratch(t), input = path.join(root, 'surround.wav'), target = path.join(root, 'surround.caf');
  const ffmpeg = path.resolve(__dirname, '../dist/stenoai/_internal/ffmpeg');
  await fs.access(ffmpeg);
  makeWav(input, { seconds: 0.1, sampleRate: 48000, channels: 4 });
  const original = await fs.readFile(input);
  await convertTransferAudio(input, target, { nativeHelper: 'must-not-run', ffmpeg });
  const metadata = await inspectCAF(target, { includeFormat: true });
  assert.equal(metadata.format, 'lpcm'); assert.equal(metadata.channelCount, 4);
  assert.equal(Math.round(metadata.duration * 48000), 4800);
  assert.deepEqual(await fs.readFile(input), original);
});
