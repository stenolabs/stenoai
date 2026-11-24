const { test } = require('node:test');
const assert = require('node:assert');

const {
  LIVE_SNAPSHOT_FORMAT,
  formatTimestamp,
  finalLiveSegments,
  formatLiveTranscript,
  buildLiveSnapshot,
} = require('./live-transcript-format');

// liveTranscriptState.segments as main.js's LIVE_SEG handler stores them.
const STATE_SEGMENTS = [
  { text: "Let's review the budget.", start: 1.2, end: 3, isFinal: true, speaker: 'You' },
  { text: 'Starting with Q3.', start: 3.5, end: 5, isFinal: true, speaker: 'You' },
  { text: 'Q3 came in under plan.', start: 6, end: 9.4, isFinal: true, speaker: 'Others' },
  { text: 'Ship it tomorrow.', start: 3725, end: 3730, isFinal: true, speaker: 'You' },
  // A trailing partial: a preview a final will cover, never saved.
  { text: 'Ship it tomor', start: 3725, end: 3728, isFinal: false, speaker: 'You' },
];

test('formatTimestamp matches the batch MM:SS / H:MM:SS shape', () => {
  assert.strictEqual(formatTimestamp(0), '00:00');
  assert.strictEqual(formatTimestamp(65.9), '01:05');
  assert.strictEqual(formatTimestamp(3725), '1:02:05');
  assert.strictEqual(formatTimestamp(NaN), '00:00');
  assert.strictEqual(formatTimestamp(-4), '00:00');
});

test('finalLiveSegments keeps finals only, with speaker and timestamps', () => {
  const finals = finalLiveSegments([...STATE_SEGMENTS, null, { text: '  ', isFinal: true }]);
  assert.strictEqual(finals.length, 4);
  assert.deepStrictEqual(finals[2], { start: 6, end: 9.4, speaker: 'Others', text: 'Q3 came in under plan.' });
});

test('an unknown speaker lands in the mic lane', () => {
  const [seg] = finalLiveSegments([{ text: 'hi', start: 'x', end: 1, isFinal: true, speaker: undefined }]);
  assert.deepStrictEqual(seg, { start: 0, end: 1, speaker: 'You', text: 'hi' });
});

test('two speakers render like the saved diarised transcript', () => {
  const { plainText, diarisedText, isDiarised } = formatLiveTranscript(finalLiveSegments(STATE_SEGMENTS));
  assert.strictEqual(isDiarised, true);
  assert.strictEqual(
    diarisedText,
    "[00:01] [You] Let's review the budget. Starting with Q3.\n\n" +
      '[00:06] [Others] Q3 came in under plan.\n\n' +
      '[1:02:05] [You] Ship it tomorrow.',
  );
  assert.strictEqual(
    plainText,
    "Let's review the budget. Starting with Q3.\n\nQ3 came in under plan.\n\nShip it tomorrow.",
  );
});

test('the renderer parses the placeholder into labelled segments', async () => {
  // The placeholder is read back by the detail view's transcript parser; pin
  // that the two agree on the shape (timestamp, speaker, text).
  const { diarisedText } = formatLiveTranscript(finalLiveSegments(STATE_SEGMENTS));
  const re =
    /(?:\[(\d{1,3}:\d{2}(?::\d{2})?(?:\.\d+)?)\]\s*)?\[([^\]]+)\]\s*([\s\S]*?)(?=(?:\[\d{1,3}:\d{2}(?::\d{2})?(?:\.\d+)?\]\s*)?\[[^\]]+\]|$)/g;
  const parsed = [...diarisedText.matchAll(re)].map((m) => [m[1], m[2], m[3].trim()]);
  assert.deepStrictEqual(parsed[1], ['00:06', 'Others', 'Q3 came in under plan.']);
  assert.deepStrictEqual(parsed[2], ['1:02:05', 'You', 'Ship it tomorrow.']);
});

test('one speaker is saved plain, as the batch path does', () => {
  const { plainText, diarisedText, isDiarised } = formatLiveTranscript(finalLiveSegments(STATE_SEGMENTS.slice(0, 2)));
  assert.strictEqual(isDiarised, false);
  assert.strictEqual(diarisedText, null);
  assert.strictEqual(plainText, "Let's review the budget. Starting with Q3.");
});

test('no segments → empty plain text', () => {
  assert.deepStrictEqual(formatLiveTranscript([]), { plainText: '', diarisedText: null, isDiarised: false });
});

test('the snapshot is versioned JSON carrying the structured segments', () => {
  const finals = finalLiveSegments(STATE_SEGMENTS);
  const parsed = JSON.parse(buildLiveSnapshot(finals));
  assert.strictEqual(parsed.format, LIVE_SNAPSHOT_FORMAT);
  assert.strictEqual(LIVE_SNAPSHOT_FORMAT, 'stenoai-live-transcript/v1');
  assert.deepStrictEqual(parsed.segments, finals);
});
