// Unit tests for app/tray-indicator.js: the menu bar recording title.
const test = require('node:test');
const assert = require('node:assert/strict');

const {
  formatTrayElapsed,
  buildTrayRecordingTitle,
  buildTrayTooltip,
} = require('./tray-indicator');

test('formatTrayElapsed uses m:ss under an hour and h:mm:ss after', () => {
  assert.equal(formatTrayElapsed(0), '0:00');
  assert.equal(formatTrayElapsed(7), '0:07');
  assert.equal(formatTrayElapsed(754), '12:34');
  assert.equal(formatTrayElapsed(3599), '59:59');
  assert.equal(formatTrayElapsed(3600), '1:00:00');
  assert.equal(formatTrayElapsed(3600 * 2 + 65), '2:01:05');
});

test('formatTrayElapsed clamps bad input to zero', () => {
  assert.equal(formatTrayElapsed(-5), '0:00');
  assert.equal(formatTrayElapsed(undefined), '0:00');
  assert.equal(formatTrayElapsed(NaN), '0:00');
  assert.equal(formatTrayElapsed(12.9), '0:12');
});

test('no title while idle', () => {
  assert.equal(buildTrayRecordingTitle({ recording: false, paused: false, elapsedSeconds: 30 }), '');
});

test('recording shows a small red dot, then the time', () => {
  assert.equal(
    buildTrayRecordingTitle({ recording: true, paused: false, elapsedSeconds: 754 }),
    '\x1b[31m•\x1b[0m 12:34'
  );
});

test('paused prefixes a pause mark to the frozen time', () => {
  const title = buildTrayRecordingTitle({ recording: true, paused: true, elapsedSeconds: 754 });
  assert.equal(title, '❚❚ 12:34');
  assert.doesNotMatch(title, /\x1b/);
});

test('tooltip reflects the state', () => {
  assert.equal(buildTrayTooltip({ recording: false, paused: false }), 'Steno');
  assert.equal(buildTrayTooltip({ recording: true, paused: false }), 'Steno - Recording');
  assert.equal(buildTrayTooltip({ recording: true, paused: true }), 'Steno - Recording paused');
});
