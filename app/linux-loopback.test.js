'use strict';

/**
 * Frame alignment for the Linux loopback PCM stream. pw-record's stdout splits
 * on pipe boundaries, not frame ones; the renderer floors away any partial
 * frame it receives, which shifts every later sample by a channel and swaps
 * L/R for the rest of the recording. Pure — no PipeWire, no Electron.
 */

const { test } = require('node:test');
const assert = require('node:assert');
const { createFrameAligner, createSerialQueue } = require('./linux-loopback');

const FRAME = 4; // stereo s16 = 2 channels * 2 bytes

test('passes through a chunk that is already frame-aligned', () => {
  const align = createFrameAligner(FRAME);
  const out = align(Buffer.from([1, 2, 3, 4, 5, 6, 7, 8]));
  assert.deepStrictEqual([...out], [1, 2, 3, 4, 5, 6, 7, 8]);
});

test('holds back a partial frame and completes it from the next chunk', () => {
  const align = createFrameAligner(FRAME);
  // one whole frame + half of the next
  const first = align(Buffer.from([1, 2, 3, 4, 5, 6]));
  assert.deepStrictEqual([...first], [1, 2, 3, 4], 'only the whole frame is emitted');
  const second = align(Buffer.from([7, 8, 9, 10]));
  assert.deepStrictEqual([...second], [5, 6, 7, 8], 'remainder is carried, not lost');
});

test('emits nothing until a whole frame is available', () => {
  const align = createFrameAligner(FRAME);
  assert.strictEqual(align(Buffer.from([1])), null);
  assert.strictEqual(align(Buffer.from([2])), null);
  assert.strictEqual(align(Buffer.from([3])), null);
  assert.deepStrictEqual([...align(Buffer.from([4]))], [1, 2, 3, 4]);
});

test('no byte is lost or duplicated across a ragged stream', () => {
  const align = createFrameAligner(FRAME);
  const source = Buffer.from(Array.from({ length: 64 }, (_, i) => i));
  const emitted = [];
  let offset = 0;
  for (const size of [3, 7, 1, 11, 5, 9, 2, 13, 6, 7]) {
    const slice = source.subarray(offset, offset + size);
    if (slice.length === 0) break;
    offset += slice.length;
    const out = align(slice);
    if (out) emitted.push(...out);
  }
  assert.strictEqual(emitted.length % FRAME, 0, 'only whole frames are emitted');
  assert.deepStrictEqual(emitted, [...source.subarray(0, emitted.length)], 'bytes stay in order');
  assert.ok(offset - emitted.length < FRAME, 'at most a partial frame is withheld');
});

test('a zero-length chunk is a no-op, not a spurious emission', () => {
  const align = createFrameAligner(FRAME);
  assert.strictEqual(align(Buffer.alloc(0)), null);
  assert.deepStrictEqual([...align(Buffer.from([1, 2, 3, 4]))], [1, 2, 3, 4]);
});

test('aligners are independent (a restart does not inherit a stale remainder)', () => {
  const first = createFrameAligner(FRAME);
  first(Buffer.from([1, 2, 3])); // leaves 3 bytes pending
  const second = createFrameAligner(FRAME);
  assert.deepStrictEqual(
    [...second(Buffer.from([9, 9, 9, 9]))],
    [9, 9, 9, 9],
    'a fresh capture starts with an empty buffer',
  );
});

// createSerialQueue is the real function main.js serialises loopback start/stop
// on — imported, not re-implemented, so deleting or breaking it fails here.
test('serialises overlapping operations', async () => {
  const run = createSerialQueue();
  const events = [];
  const op = (id) => async () => {
    events.push(`enter:${id}`);
    await new Promise((r) => setTimeout(r, 5)); // the await window the race needs
    events.push(`exit:${id}`);
  };

  await Promise.all([run(op('a')), run(op('b')), run(op('c'))]);

  assert.deepStrictEqual(events, [
    'enter:a', 'exit:a', 'enter:b', 'exit:b', 'enter:c', 'exit:c',
  ]);
});

test('a rejected operation does not stall the queue', async () => {
  const run = createSerialQueue();
  await assert.rejects(run(async () => { throw new Error('start failed'); }), /start failed/);
  // A later start must still run — one failure can't wedge every later recording.
  assert.strictEqual(await run(async () => 'ok'), 'ok');
});

test('queues are independent', async () => {
  const a = createSerialQueue();
  const b = createSerialQueue();
  let released;
  const blocked = a(() => new Promise((r) => { released = r; }));
  // b must not be held up by a's in-flight operation.
  assert.strictEqual(await b(async () => 'b ran'), 'b ran');
  released();
  await blocked;
});
