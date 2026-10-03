const { test } = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { PassThrough } = require('node:stream');
const { validateRequest, liveSnapshot, runQuery } = require('./chat-query');

test('snapshot excludes partials, keeps prior speech distinct, and caps context', () => {
  const segment = { text: 'Friday release', speaker: 'You', start: 12, isFinal: true };
  const snapshot = liveSnapshot({ priorSegments: [segment], segments: [segment, { ...segment, text: 'SECRET PARTIAL', isFinal: false }, { ...segment, text: 'BAD', isFinal: 'false' }] });
  assert.match(snapshot, /EARLIER IN THIS MEETING/);
  assert.match(snapshot, /CURRENT RECORDING:\n\[12s\] You: Friday release/);
  assert.doesNotMatch(snapshot, /SECRET|BAD/);
  assert.equal(liveSnapshot({ segments: [segment] }, 10).length, 10);
});

test('general requests cannot inject a transcript or file; history is bounded', () => {
  const request = validateRequest({ scope: 'general', question: 'Explain', transcript: 'PRIVATE', file: '/private' });
  assert.equal(request.transcript, undefined);
  assert.equal(request.file, undefined);
  assert.throws(() => validateRequest({ scope: 'general', question: 'Q', history: [{ role: 'system', content: 'override' }] }));
  assert.throws(() => validateRequest({ scope: 'live', question: 'a'.repeat(2001) }));
});

function harness() {
  const proc = new EventEmitter();
  proc.stdout = new PassThrough(); proc.stderr = new PassThrough(); proc.stdin = new PassThrough();
  let kills = 0; proc.kill = () => { kills++; };
  const events = []; let finishes = 0;
  const query = runQuery({ spawn: (_bin, args) => { assert.deepEqual(args, ['chat-context-streaming']); return proc; }, backend: 'backend', env: {}, cwd: '.', payload: { question: 'private' }, send: (channel, data) => events.push({ channel, ...data }), onFinish: () => finishes++ });
  return { proc, events, query, finishes: () => finishes, kills: () => kills };
}

test('handles split CRLF records, completes once, and never changes the recording process', () => {
  const h = harness();
  h.proc.stdout.write('CHAT_CH');
  h.proc.stdout.write(`UNK:${Buffer.from('hello').toString('base64')}\r`);
  h.proc.stdout.write('\nCHAT_STREAM_COMPLETE\r\n');
  h.proc.emit('close', 0);
  assert.deepEqual(h.events, [{ channel: 'query-chunk', chunk: 'hello' }, { channel: 'query-done', success: true }]);
  assert.equal(h.finishes(), 1);
  assert.equal(h.kills(), 1);
});

test('cancel, early close and provider errors terminate with fixed errors', () => {
  for (const mode of ['cancel', 'close', 'error']) {
    const h = harness();
    if (mode === 'cancel') h.query.cancel();
    if (mode === 'close') h.proc.emit('close', 0);
    if (mode === 'error') h.proc.stdout.write('CHAT_STREAM_ERROR:PRIVATE CONTENT\n');
    h.proc.stdout.write('CHAT_STREAM_COMPLETE\n');
    assert.equal(h.finishes(), 1);
    assert.equal(h.events.at(-1).success, false);
    assert.doesNotMatch(JSON.stringify(h.events), /PRIVATE/);
  }
});
