const { test } = require('node:test');
const assert = require('node:assert');

const { CallerId, isCallAudio } = require('./caller-id');

// A fake iMCP whose call history can change between lookups, and a recorder of
// what reaches the backend. Times are seconds from T0; data is invented.
const T0 = Date.parse('2026-03-02T14:00:00Z');
const ms = (s) => T0 + s * 1000;
const iso = (s) => new Date(ms(s)).toISOString().replace(/\.\d{3}Z$/, 'Z');

function entry({ id = '1', number = '+12025550100', type = 'incoming', start = 0, duration = 0 } = {}) {
  return { '@id': id, phoneNumber: number, callType: type, date: iso(start),
    durationSeconds: duration, serviceProvider: 'com.apple.Telephony' };
}

function setup({ history = [], contacts = { '+12025550100': 'Erika Mustermann' }, busy = () => false,
  sleep = async () => {}, apply = async () => {} } = {}) {
  const imcp = {
    status: { state: 'ready', contacts: true },
    started: 0,
    lookups: 0,
    history,
    start() { this.started += 1; },
    stop() {},
    async recentCalls() {
      this.lookups += 1;
      return typeof this.history === 'function' ? this.history(this.lookups) : this.history;
    },
    async contactName(number) { return contacts[number] ?? null; },
  };
  const applied = [];
  const callerId = new CallerId({
    imcp,
    isProcessing: busy,
    applyCallInfo: async (stem, calls, options) => {
      applied.push({ stem, calls, ...options });
      await apply(stem, calls);
    },
    sleep,
    now: () => ms(300), // a clock that matches the fake call times
    lookupAttempts: 5,
  });
  callerId.setEnabled(true);
  return { callerId, imcp, applied };
}

const mic = (event, s, app = 'com.apple.avconferenced') => ({ event, app_id: app, pid: 42, ts: ms(s) / 1000 });

test('a call answered on this Mac, recorded to the end', async () => {
  const { callerId, applied } = setup({ history: [entry({ start: 0, duration: 113 })] });
  callerId.micEvent(mic('start', 0.4));
  callerId.recordingStarted('sysaudio-1-Note', ms(1));
  callerId.micEvent(mic('stop', 56));
  callerId.recordingStopped(ms(58));
  await callerId.idle();
  assert.deepStrictEqual(applied, [{
    stem: 'sysaudio-1-Note', sidecarOnly: false,
    calls: [{ name: 'Erika Mustermann', number: '+12025550100', direction: 'incoming',
      service: 'phone', started_at: new Date(ms(0)).toISOString() }],
  }]);
});

test('a call answered on this Mac, recording stopped mid-call: found at once', async () => {
  const { callerId, applied } = setup({ history: [entry({ start: 0, duration: 0 })] });
  callerId.micEvent(mic('start', 0.4));
  callerId.recordingStarted('stem', ms(1));
  callerId.recordingStopped(ms(30));
  await callerId.idle();
  assert.strictEqual(applied.length, 1);
});

test('a call moved from the iPhone, recording stopped mid-call: found when the call ends', async () => {
  const { callerId, imcp, applied } = setup({ history: [] });
  callerId.micEvent(mic('start', 30));
  callerId.recordingStarted('stem', ms(31));
  callerId.recordingStopped(ms(40));
  await callerId.idle();
  assert.strictEqual(applied.length, 0);
  imcp.history = [entry({ type: 'outgoing', start: 0, duration: 138 })];
  callerId.micEvent(mic('stop', 69));
  await callerId.idle();
  assert.strictEqual(applied.length, 1);
  assert.strictEqual(applied[0].calls[0].direction, 'outgoing');
});

test('the record appearing a moment after the call ends is waited for', async () => {
  const { callerId, imcp, applied } = setup({
    history: (attempt) => (attempt < 3 ? [] : [entry({ start: 0, duration: 102 })]),
  });
  callerId.micEvent(mic('start', 29));
  callerId.recordingStarted('stem', ms(29.5));
  callerId.micEvent(mic('stop', 51));
  callerId.recordingStopped(ms(52));
  await callerId.idle();
  assert.strictEqual(applied.length, 1);
  assert.strictEqual(imcp.lookups, 3);
});

// A clock that only the lookup's own waiting moves, for history that changes
// over time: `history(seconds)` is what iMCP has that long after the audio stop.
function waitingClock(history) {
  let waited = 0;
  return {
    sleep: async (msToWait) => { waited += msToWait; },
    history: () => history(waited / 1000),
  };
}

test('back to back: the call before does not stand in for the next one', async () => {
  // Call A 10:00 to 10:10, stored as about 20 minutes. Call B placed on the
  // iPhone and moved to the Mac, audio 10:12 to 10:15; its record is written a
  // second after it ends. Times from 10:00.
  const a = entry({ id: '1', number: '+12025550101', start: 0, duration: 1205 });
  const b = entry({ id: '2', number: '+12025550102', type: 'outgoing', start: 680, duration: 440 });
  const clock = waitingClock((s) => (s < 1 ? [a] : [b, a]));
  const { callerId, applied } = setup({ history: clock.history, sleep: clock.sleep });
  callerId.micEvent(mic('start', 0.4));
  callerId.micEvent(mic('stop', 600));
  callerId.micEvent(mic('start', 720));
  callerId.recordingStarted('note-b', ms(721));
  callerId.micEvent(mic('stop', 900));
  callerId.recordingStopped(ms(901));
  await callerId.idle();
  assert.deepStrictEqual(applied.map((x) => x.calls.map((c) => c.number)), [['+12025550102']]);
});

test('redialled at once, the next call is waited for before looking', async () => {
  // A ended at 10:10:00 and B's audio began five seconds later, too soon for
  // the call history alone to tell them apart: only waiting for B's record does.
  const a = entry({ id: '1', number: '+12025550101', start: 0, duration: 1205 });
  const b = entry({ id: '2', number: '+12025550102', type: 'outgoing', start: 603, duration: 360 });
  const clock = waitingClock((s) => (s < 1 ? [a] : [b, a]));
  const { callerId, applied, imcp } = setup({ history: clock.history, sleep: clock.sleep });
  callerId.micEvent(mic('start', 605));
  callerId.recordingStarted('note-b', ms(606));
  callerId.micEvent(mic('stop', 783));
  callerId.recordingStopped(ms(784));
  await callerId.idle();
  assert.strictEqual(imcp.lookups, 1);
  assert.strictEqual(applied[0].calls[0].number, '+12025550102');
});

test('a continued note gets one write at a time', async () => {
  // Two recordings into the same note, each with its own call, found together.
  const order = [];
  let release;
  const first = new Promise((resolve) => { release = resolve; });
  const { callerId, applied } = setup({
    history: [entry({ id: '1', number: '+12025550101', start: 0, duration: 120 }),
      entry({ id: '2', number: '+12025550102', start: 100, duration: 120 })],
    apply: async (stem, calls) => {
      order.push(`start ${calls[0].number}`);
      if (calls[0].number === '+12025550101') await first;
      order.push(`end ${calls[0].number}`);
    },
  });
  callerId.micEvent(mic('start', 0.4, 'com.apple.avconferenced'));
  callerId.recordingStarted('note', ms(1));
  callerId.micEvent(mic('stop', 60, 'com.apple.avconferenced'));
  callerId.recordingStopped(ms(61));
  callerId.micEvent({ ...mic('start', 100.4), pid: 43 });
  callerId.recordingStarted('note', ms(101));
  callerId.micEvent({ ...mic('stop', 160), pid: 43 });
  callerId.recordingStopped(ms(161));
  await new Promise((resolve) => setImmediate(resolve));
  release();
  await callerId.idle();
  assert.deepStrictEqual(order,
    ['start +12025550101', 'end +12025550101', 'start +12025550102', 'end +12025550102']);
  assert.deepStrictEqual(applied.map((x) => x.stem), ['note', 'note']);
});

test('a recording without call audio is never looked up', async () => {
  const { callerId, imcp, applied } = setup({ history: [entry({ start: 0, duration: 60 })] });
  callerId.micEvent(mic('start', 0, 'us.zoom.xos'));
  callerId.recordingStarted('stem', ms(1));
  callerId.micEvent(mic('stop', 60, 'us.zoom.xos'));
  callerId.recordingStopped(ms(61));
  await callerId.idle();
  assert.strictEqual(imcp.lookups, 0);
  assert.strictEqual(applied.length, 0);
});

test('a call that ended before the recording began is not attached', async () => {
  const { callerId, imcp } = setup({ history: [entry({ start: 0, duration: 60 })] });
  callerId.micEvent(mic('start', 0));
  callerId.micEvent(mic('stop', 30));
  callerId.recordingStarted('stem', ms(100));
  callerId.recordingStopped(ms(200));
  await callerId.idle();
  assert.strictEqual(imcp.lookups, 0);
});

test('while the note is still processing, the call is stored, then applied when it finishes', async () => {
  let busy = true;
  const { callerId, applied } = setup({ history: [entry({ start: 0, duration: 113 })], busy: () => busy });
  callerId.micEvent(mic('start', 0.4));
  callerId.recordingStarted('stem', ms(1));
  callerId.micEvent(mic('stop', 56));
  callerId.recordingStopped(ms(58));
  await callerId.idle();
  assert.deepStrictEqual(applied.map((a) => a.sidecarOnly), [true]);
  busy = false;
  callerId.processingFinished(['other-stem']);
  callerId.processingFinished(['stem']);
  await callerId.idle();
  assert.deepStrictEqual(applied.map((a) => a.sidecarOnly), [true, false]);
});

test('a number not in Contacts is kept without a name', async () => {
  const { callerId, applied } = setup({
    history: [entry({ number: '+12025550101', start: 0, duration: 113 })], contacts: {},
  });
  callerId.micEvent(mic('start', 0.4));
  callerId.recordingStarted('stem', ms(1));
  callerId.micEvent(mic('stop', 56));
  callerId.recordingStopped(ms(58));
  await callerId.idle();
  assert.strictEqual(applied[0].calls[0].name, null);
  assert.strictEqual(applied[0].calls[0].number, '+12025550101');
});

test('switched off, nothing is looked up', async () => {
  const { callerId, imcp } = setup({ history: [entry({ start: 0, duration: 113 })] });
  callerId.setEnabled(false);
  callerId.micEvent(mic('start', 0.4));
  callerId.recordingStarted('stem', ms(1));
  callerId.micEvent(mic('stop', 56));
  callerId.recordingStopped(ms(58));
  await callerId.idle();
  assert.strictEqual(imcp.lookups, 0);
});

test('iMCP not ready: the lookup gives up without an error', async () => {
  const { callerId, imcp, applied } = setup({ history: [entry({ start: 0, duration: 113 })] });
  imcp.status = { state: 'not-running', contacts: false };
  callerId.micEvent(mic('start', 0.4));
  callerId.recordingStarted('stem', ms(1));
  callerId.micEvent(mic('stop', 56));
  callerId.recordingStopped(ms(58));
  await callerId.idle();
  assert.strictEqual(imcp.lookups, 0);
  assert.strictEqual(applied.length, 0);
});

test('isCallAudio recognises call audio only', () => {
  assert.strictEqual(isCallAudio({ app_id: 'com.apple.avconferenced' }), true);
  assert.strictEqual(isCallAudio({ app_id: 'com.apple.FaceTime' }), true);
  assert.strictEqual(isCallAudio({ app_id: 'us.zoom.xos' }), false);
  assert.strictEqual(isCallAudio({}), false);
});
