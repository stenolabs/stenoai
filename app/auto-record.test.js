// Unit tests for app/auto-record.js: the setting read, the toast copy, and the
// start tracker that ties each "Recording started" toast to its own recording.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const {
  ANNOUNCE_WINDOW_MS,
  loadAutoRecordMeetingsEnabled,
  buildAutoRecordStartedOptions,
  createAutoStarts,
} = require('./auto-record');

const fixtureDirs = [];
test.after(() => {
  for (const dir of fixtureDirs) fs.rmSync(dir, { recursive: true, force: true });
});

function configWith(contents) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'auto-record-'));
  fixtureDirs.push(dir);
  const file = path.join(dir, 'config.json');
  if (contents !== undefined) fs.writeFileSync(file, contents);
  return file;
}

test('the setting is off unless config.json holds a real true', () => {
  assert.equal(loadAutoRecordMeetingsEnabled(configWith(undefined)), false); // no file
  assert.equal(loadAutoRecordMeetingsEnabled(configWith('{}')), false);
  assert.equal(loadAutoRecordMeetingsEnabled(configWith('{"auto_record_meetings_enabled": "true"}')), false);
  assert.equal(loadAutoRecordMeetingsEnabled(configWith('not json')), false);
  assert.equal(loadAutoRecordMeetingsEnabled(configWith('{"auto_record_meetings_enabled": true}')), true);
});

test('the toast names the calendar event, else the app, and offers Stop', () => {
  const withEvent = buildAutoRecordStartedOptions({ appName: 'Zoom', calendarTitle: 'Weekly sync' });
  assert.equal(withEvent.title, 'Recording started');
  assert.equal(withEvent.body, 'Weekly sync');
  assert.deepEqual(withEvent.actions, [{ type: 'button', text: 'Stop' }]);
  assert.equal(withEvent.tag, 'meeting-detected');
  assert.equal(buildAutoRecordStartedOptions({ appName: 'FaceTime' }).body, 'FaceTime');
  assert.equal(buildAutoRecordStartedOptions({}).body, 'A meeting');
});

test('an unattended start is announced once, for its own recording', () => {
  const starts = createAutoStarts({ now: () => 1000 });
  const id = starts.begin({ appName: 'Zoom' });
  starts.recordingStarted('auto_record');
  assert.deepEqual(starts.captureConfirmed(), { id, appName: 'Zoom' });
  assert.equal(starts.captureConfirmed(), null, 'a capture flap reporting "recording" again is not a new start');
  assert.equal(starts.isCurrent(id), true);
  starts.recordingStopped();
  assert.equal(starts.isCurrent(id), false, 'Stop on an old toast must not stop a later recording');
});

test('nothing is announced without an unattended start', () => {
  const starts = createAutoStarts();
  starts.recordingStarted('manual');
  assert.equal(starts.captureConfirmed(), null);
});

test('a second detection while one start is pending is refused', () => {
  const starts = createAutoStarts({ now: () => 1000 });
  const first = starts.begin({ appName: 'Zoom' });
  assert.equal(starts.begin({ appName: 'FaceTime' }), null);
  starts.recordingStarted('auto_record');
  assert.deepEqual(starts.captureConfirmed(), { id: first, appName: 'Zoom' });
});

test('a failed start is dropped, and a manual recording after it gets no toast', () => {
  const starts = createAutoStarts({ now: () => 1000 });
  const id = starts.begin({ appName: 'Zoom' });
  starts.startFailed();
  starts.recordingStarted('manual');
  assert.equal(starts.captureConfirmed(), null);
  assert.equal(starts.isCurrent(id), false);
  assert.notEqual(starts.begin({ appName: 'Zoom' }), null, 'the next detection can start again');
});

test('a manual start while an auto-start is pending takes its place', () => {
  const starts = createAutoStarts({ now: () => 1000 });
  starts.begin({ appName: 'Zoom' });
  starts.recordingStarted('hotkey');
  assert.equal(starts.captureConfirmed(), null);
  assert.equal(starts.isPending(), false);
});

test('a start that never reaches main expires and blocks nothing after', () => {
  let t = 0;
  const starts = createAutoStarts({ now: () => t });
  starts.begin({ appName: 'Zoom' });
  t = ANNOUNCE_WINDOW_MS + 1;
  assert.equal(starts.isPending(), false);
  starts.recordingStarted('auto_record');
  assert.equal(starts.captureConfirmed(), null);
  assert.notEqual(starts.begin({ appName: 'Zoom' }), null);
});
