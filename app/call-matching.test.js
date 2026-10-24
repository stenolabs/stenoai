const { test } = require('node:test');
const assert = require('node:assert');

const { matchCall, normaliseCall } = require('./call-matching');

// Invented data. Numbers are from the fictional 555-01xx range; the shapes are
// the four Continuity calls measured on macOS 26 (see call-matching.js).

const T0 = Date.parse('2026-03-02T14:00:00Z');
const at = (seconds) => new Date(T0 + seconds * 1000);

// One entry as iMCP's phone_calls_fetch returns it.
function entry({ id = '1', number = '+12025550100', type = 'incoming', start = 0,
  duration = 0, service = 'com.apple.Telephony' } = {}) {
  return {
    '@id': id,
    phoneNumber: number,
    callType: type,
    date: at(start).toISOString().replace(/\.\d{3}Z$/, 'Z'),
    durationSeconds: duration,
    serviceProvider: service,
  };
}

test('a call answered on this Mac matches once it has ended', () => {
  // Connected at 0, audio on the Mac at once, 56 s long, stored as 113 s.
  const calls = [entry({ start: 0, duration: 113 })];
  const call = matchCall(calls, { startedAt: at(0.4), endedAt: at(56) });
  assert.strictEqual(call.number, '+12025550100');
  assert.strictEqual(call.direction, 'incoming');
  assert.strictEqual(call.service, 'phone');
});

test('a call answered on this Mac matches while it is still running', () => {
  // The recording stopped mid-call: the record exists, still at 0 s.
  const calls = [entry({ start: 0, duration: 0 })];
  const call = matchCall(calls, { startedAt: at(0.4), endedAt: null });
  assert.strictEqual(call.number, '+12025550100');
});

test('a call answered on the iPhone and moved to the Mac matches once it has ended', () => {
  // Answered on the iPhone at 0 (the Mac rang, so a 0 s record appeared then),
  // moved to the Mac at 29 s, ended at 51 s, stored as 102 s.
  const calls = [entry({ start: 0, duration: 102 })];
  const call = matchCall(calls, { startedAt: at(29), endedAt: at(51) });
  assert.strictEqual(call.number, '+12025550100');
});

test('a call answered on the iPhone and moved does not match while it runs', () => {
  // Its record looks like any call answered on the iPhone: 0 s, started well
  // before the audio. Only the call's end settles it, so the answer is "not yet".
  const calls = [entry({ start: 0, duration: 0 })];
  assert.strictEqual(matchCall(calls, { startedAt: at(29), endedAt: null }), null);
});

test('a call placed on the iPhone and moved to the Mac matches once it has ended', () => {
  // No record until it ended; then one with the iPhone's start, 69 s stored as 138 s.
  const calls = [entry({ type: 'outgoing', start: 0, duration: 138 })];
  const call = matchCall(calls, { startedAt: at(30.8), endedAt: at(69) });
  assert.strictEqual(call.direction, 'outgoing');
  assert.strictEqual(call.startedAt.getTime(), T0);
});

test('a call placed on the iPhone and still running has nothing to match yet', () => {
  const earlier = entry({ id: '7', number: '+12025550107', start: -3600, duration: 400 });
  assert.strictEqual(matchCall([earlier], { startedAt: at(30.8), endedAt: null }), null);
});

test('the current call wins over earlier calls', () => {
  const calls = [
    entry({ id: '3', number: '+12025550103', start: 0, duration: 138, type: 'outgoing' }),
    // Answered on the iPhone an hour ago and never on the Mac: 0 s for good.
    entry({ id: '2', number: '+12025550102', start: -3600, duration: 0 }),
    // An earlier call on the Mac, stored long enough to reach into this one.
    entry({ id: '1', number: '+12025550101', start: -600, duration: 1200 }),
  ];
  const call = matchCall(calls, { startedAt: at(30.8), endedAt: at(69) });
  assert.strictEqual(call.number, '+12025550103');
});

test('an earlier call that ended before this one began is not taken in its place', () => {
  // The current call's record is missing; the earlier call ended long before.
  const calls = [entry({ number: '+12025550101', start: -3600, duration: 1200 })];
  assert.strictEqual(matchCall(calls, { startedAt: at(30), endedAt: at(600) }), null);
});

test('back to back: the call before is not taken for the next one', () => {
  // Call A 10:00 to 10:10, stored as about 20 minutes. Call B placed on the
  // iPhone at 10:11:20 and moved to the Mac: audio 10:12 to 10:15. At face
  // value A reaches past B's audio; read as doubled it ended two minutes before.
  const a = entry({ id: '1', number: '+12025550101', start: -720, duration: 1205 });
  const b = entry({ id: '2', number: '+12025550102', type: 'outgoing', start: -40, duration: 440 });
  const audio = { startedAt: at(0), endedAt: at(180) };
  // B's record is written only once B has ended, so a lookup can see A alone.
  assert.strictEqual(matchCall([a], audio), null);
  assert.strictEqual(matchCall([b, a], audio).number, '+12025550102');
});

test('a missed call never matches', () => {
  const calls = [entry({ type: 'missed', start: 0, duration: 0 })];
  assert.strictEqual(matchCall(calls, { startedAt: at(0.4), endedAt: null }), null);
  assert.strictEqual(matchCall(calls, { startedAt: at(0.4), endedAt: at(60) }), null);
});

test('a call that started after the audio does not match', () => {
  // Rang during the call (call waiting) and was answered on the iPhone.
  const calls = [entry({ number: '+12025550104', start: 20, duration: 0 })];
  assert.strictEqual(matchCall(calls, { startedAt: at(0.4), endedAt: at(60) }), null);
});

test('normaliseCall reads iMCP entries', () => {
  const facetime = normaliseCall(entry({ service: 'com.apple.FaceTime' }));
  assert.strictEqual(facetime.service, 'facetime');
  assert.strictEqual(normaliseCall(entry({ number: 'Unknown' })).number, null);
  assert.strictEqual(normaliseCall({ ...entry(), date: 'not a date' }), null);
  assert.strictEqual(normaliseCall(null), null);
});

test('matchCall tolerates missing input', () => {
  assert.strictEqual(matchCall([entry()], null), null);
  assert.strictEqual(matchCall(null, { startedAt: at(0), endedAt: null }), null);
  assert.strictEqual(matchCall([entry()], { startedAt: 'not a date', endedAt: null }), null);
});
