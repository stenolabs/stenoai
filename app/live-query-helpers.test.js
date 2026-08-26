'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const {
  MAX_LIVE_QUERY_QUESTION_CHARS,
  MAX_LIVE_TRANSCRIPT_CHARS,
  MAX_PROTOCOL_LINE_BYTES,
  MAX_DECODED_ANSWER_BYTES,
  LIVE_QUERY_TIMEOUT_MS,
  FIXED_LIVE_QUERY_ERRORS,
  formatLiveQueryTimestamp,
  isMeaningfulLiveQueryText,
  formatLiveTranscriptSegments,
  normalizeLiveQueryHistory,
  validateLiveQueryInputs,
  buildLiveTranscriptQuerySnapshot,
} = require('./live-query-helpers');

test('constants match required protocol and resource limits', () => {
  assert.strictEqual(MAX_LIVE_QUERY_QUESTION_CHARS, 2000);
  assert.strictEqual(MAX_LIVE_TRANSCRIPT_CHARS, 100000);
  assert.strictEqual(MAX_PROTOCOL_LINE_BYTES, 1024 * 1024);
  assert.strictEqual(MAX_DECODED_ANSWER_BYTES, 1024 * 1024);
  assert.strictEqual(LIVE_QUERY_TIMEOUT_MS, 300000);
  assert.strictEqual(FIXED_LIVE_QUERY_ERRORS.FAILED, 'Live query failed');
});

test('formatLiveQueryTimestamp formats seconds into MM:SS', () => {
  assert.strictEqual(formatLiveQueryTimestamp(0), '00:00');
  assert.strictEqual(formatLiveQueryTimestamp(5), '00:05');
  assert.strictEqual(formatLiveQueryTimestamp(65), '01:05');
  assert.strictEqual(formatLiveQueryTimestamp(125.8), '02:05');
  assert.strictEqual(formatLiveQueryTimestamp(3600), '60:00');
  assert.strictEqual(formatLiveQueryTimestamp('45'), '00:45');
});

test('formatLiveQueryTimestamp handles non-finite and negative inputs safely', () => {
  assert.strictEqual(formatLiveQueryTimestamp(-10), '00:00');
  assert.strictEqual(formatLiveQueryTimestamp(NaN), '??:??');
  assert.strictEqual(formatLiveQueryTimestamp(Infinity), '??:??');
  assert.strictEqual(formatLiveQueryTimestamp(null), '00:00'); // Number(null) is 0
  assert.strictEqual(formatLiveQueryTimestamp(undefined), '??:??');
  assert.strictEqual(formatLiveQueryTimestamp('invalid'), '??:??');
});

test('isMeaningfulLiveQueryText accepts linguistic and numeric content across scripts', () => {
  // Latin / English
  assert.strictEqual(isMeaningfulLiveQueryText('Hello world'), true);
  assert.strictEqual(isMeaningfulLiveQueryText('OK'), true);
  assert.strictEqual(isMeaningfulLiveQueryText('123'), true);
  assert.strictEqual(isMeaningfulLiveQueryText('Q4 roadmap'), true);

  // Traditional Chinese / CJK
  assert.strictEqual(isMeaningfulLiveQueryText('你好'), true);
  assert.strictEqual(isMeaningfulLiveQueryText('這是繁體中文即時轉錄測試'), true);
  assert.strictEqual(isMeaningfulLiveQueryText('會議紀錄'), true);
  assert.strictEqual(isMeaningfulLiveQueryText('日本語テスト'), true);
  assert.strictEqual(isMeaningfulLiveQueryText('한국어'), true);

  // Accented and unicode letters
  assert.strictEqual(isMeaningfulLiveQueryText('résumé'), true);
  assert.strictEqual(isMeaningfulLiveQueryText('Café'), true);
});

test('isMeaningfulLiveQueryText rejects punctuation-only and whitespace-only utterances', () => {
  // Punctuation-only snapshots that must be rejected
  assert.strictEqual(isMeaningfulLiveQueryText('...'), false);
  assert.strictEqual(isMeaningfulLiveQueryText('???'), false);
  assert.strictEqual(isMeaningfulLiveQueryText('!'), false);
  assert.strictEqual(isMeaningfulLiveQueryText('... ??? !'), false);
  assert.strictEqual(isMeaningfulLiveQueryText('——'), false);
  assert.strictEqual(isMeaningfulLiveQueryText('……'), false);
  assert.strictEqual(isMeaningfulLiveQueryText('，。、；：'), false);
  assert.strictEqual(isMeaningfulLiveQueryText('【】（）'), false);

  // Whitespace and empty
  assert.strictEqual(isMeaningfulLiveQueryText(''), false);
  assert.strictEqual(isMeaningfulLiveQueryText('   '), false);
  assert.strictEqual(isMeaningfulLiveQueryText('\t\n  '), false);
  assert.strictEqual(isMeaningfulLiveQueryText(null), false);
  assert.strictEqual(isMeaningfulLiveQueryText(undefined), false);
});

test('formatLiveTranscriptSegments filters non-final, empty, and punctuation-only segments', () => {
  const segments = [
    { start: 0, end: 3, speaker: 'You', text: 'Hello everyone', isFinal: true },
    { start: 3, end: 5, speaker: 'Others', text: '...', isFinal: true }, // punctuation-only -> rejected
    { start: 5, end: 8, speaker: 'Others', text: 'Good morning!', isFinal: true },
    { start: 8, end: 10, speaker: 'You', text: 'interim unfinalized chunk', isFinal: false }, // not final -> rejected
    null,
    undefined,
    { start: 10, end: 14, speaker: 'CustomSpeaker', text: '會議開始進行討論', isFinal: true }, // unknown speaker -> normalized to Speaker
  ];

  const formatted = formatLiveTranscriptSegments(segments);
  const lines = formatted.split('\n');

  assert.strictEqual(lines.length, 3);
  assert.strictEqual(lines[0], '[00:00 - 00:03] You: Hello everyone');
  assert.strictEqual(lines[1], '[00:05 - 00:08] Others: Good morning!');
  assert.strictEqual(lines[2], '[00:10 - 00:14] Speaker: 會議開始進行討論');
});

test('formatLiveTranscriptSegments returns empty string for non-array or empty inputs', () => {
  assert.strictEqual(formatLiveTranscriptSegments([]), '');
  assert.strictEqual(formatLiveTranscriptSegments(null), '');
  assert.strictEqual(formatLiveTranscriptSegments(undefined), '');
  assert.strictEqual(formatLiveTranscriptSegments('not an array'), '');
});

test('formatLiveTranscriptSegments caps transcript to maxChars favoring most recent segments', () => {
  const segments = [
    { start: 0, end: 10, speaker: 'You', text: 'First segment early in meeting', isFinal: true },
    { start: 10, end: 20, speaker: 'Others', text: 'Second segment middle of meeting', isFinal: true },
    { start: 20, end: 30, speaker: 'You', text: 'Third segment latest discussion topic', isFinal: true },
  ];

  // When cap fits all segments
  const full = formatLiveTranscriptSegments(segments, { maxChars: 1000 });
  assert.ok(full.includes('First segment'));
  assert.ok(full.includes('Second segment'));
  assert.ok(full.includes('Third segment'));

  // When cap only fits the most recent segments (e.g. last 2 segments)
  const line3 = '[00:20 - 00:30] You: Third segment latest discussion topic';
  const line2 = '[00:10 - 00:20] Others: Second segment middle of meeting';
  const capTwo = line3.length + 1 + line2.length;
  const recentTwo = formatLiveTranscriptSegments(segments, { maxChars: capTwo });
  assert.strictEqual(recentTwo, `${line2}\n${line3}`);
  assert.strictEqual(recentTwo.includes('First segment'), false);

  // When cap only fits the last segment
  const capOne = line3.length;
  const recentOne = formatLiveTranscriptSegments(segments, { maxChars: capOne });
  assert.strictEqual(recentOne, line3);
  assert.strictEqual(recentOne.includes('Second segment'), false);

  // When a single segment exceeds maxChars, take the tail slice bounded to maxChars
  const truncated = formatLiveTranscriptSegments(segments, { maxChars: 20 });
  assert.strictEqual(truncated.length, 20);
  assert.strictEqual(truncated, line3.slice(-20));
});

test('validateLiveQueryInputs validates queryId, sessionName, and question length', () => {
  // Valid input
  assert.deepStrictEqual(
    validateLiveQueryInputs({
      queryId: 'q-12345',
      sessionName: 'session-20260824',
      question: 'What was decided about the budget?',
    }),
    { valid: true, history: [] },
  );

  // Invalid queryId
  assert.deepStrictEqual(
    validateLiveQueryInputs({ queryId: '', sessionName: 's1', question: 'Q' }),
    { valid: false, error: FIXED_LIVE_QUERY_ERRORS.INVALID_QUERY_ID },
  );
  assert.deepStrictEqual(
    validateLiveQueryInputs({ queryId: null, sessionName: 's1', question: 'Q' }),
    { valid: false, error: FIXED_LIVE_QUERY_ERRORS.INVALID_QUERY_ID },
  );
  assert.deepStrictEqual(
    validateLiveQueryInputs({ queryId: 'a'.repeat(300), sessionName: 's1', question: 'Q' }),
    { valid: false, error: FIXED_LIVE_QUERY_ERRORS.INVALID_QUERY_ID },
  );

  // Invalid sessionName
  assert.deepStrictEqual(
    validateLiveQueryInputs({ queryId: 'q1', sessionName: '', question: 'Q' }),
    { valid: false, error: FIXED_LIVE_QUERY_ERRORS.INVALID_SESSION },
  );
  assert.deepStrictEqual(
    validateLiveQueryInputs({ queryId: 'q1', sessionName: '   ', question: 'Q' }),
    { valid: false, error: FIXED_LIVE_QUERY_ERRORS.INVALID_SESSION },
  );
  assert.deepStrictEqual(
    validateLiveQueryInputs({ queryId: 'q1', sessionName: 'b'.repeat(300), question: 'Q' }),
    { valid: false, error: FIXED_LIVE_QUERY_ERRORS.INVALID_SESSION },
  );

  // Invalid question
  assert.deepStrictEqual(
    validateLiveQueryInputs({ queryId: 'q1', sessionName: 's1', question: '' }),
    { valid: false, error: FIXED_LIVE_QUERY_ERRORS.QUESTION_REQUIRED },
  );
  assert.deepStrictEqual(
    validateLiveQueryInputs({ queryId: 'q1', sessionName: 's1', question: '   ' }),
    { valid: false, error: FIXED_LIVE_QUERY_ERRORS.QUESTION_REQUIRED },
  );
  assert.deepStrictEqual(
    validateLiveQueryInputs({ queryId: 'q1', sessionName: 's1', question: null }),
    { valid: false, error: FIXED_LIVE_QUERY_ERRORS.QUESTION_REQUIRED },
  );
  assert.deepStrictEqual(
    validateLiveQueryInputs({ queryId: 'q1', sessionName: 's1', question: 'x'.repeat(2001) }),
    { valid: false, error: FIXED_LIVE_QUERY_ERRORS.QUESTION_TOO_LONG },
  );
});

test('buildLiveTranscriptQuerySnapshot validates session match and active recording state', () => {
  const validState = {
    sessionName: 'session-20260824-1',
    priorSegments: [],
    segments: [
      { start: 0, end: 4, speaker: 'You', text: 'Discussing the release plan', isFinal: true },
    ],
  };

  // Missing or invalid sessionName
  assert.deepStrictEqual(
    buildLiveTranscriptQuerySnapshot({ sessionName: '' }),
    { error: FIXED_LIVE_QUERY_ERRORS.INVALID_SESSION },
  );
  assert.deepStrictEqual(
    buildLiveTranscriptQuerySnapshot({ sessionName: null }),
    { error: FIXED_LIVE_QUERY_ERRORS.INVALID_SESSION },
  );

  // Recording inactive
  assert.deepStrictEqual(
    buildLiveTranscriptQuerySnapshot({
      sessionName: 'session-20260824-1',
      activeSessionName: 'session-20260824-1',
      systemAudioRecordingActive: false,
      liveTranscriptState: validState,
    }),
    { error: FIXED_LIVE_QUERY_ERRORS.NO_ACTIVE_TRANSCRIPT },
  );

  // Session mismatch with active recording session
  assert.deepStrictEqual(
    buildLiveTranscriptQuerySnapshot({
      sessionName: 'session-20260824-1',
      activeSessionName: 'session-other',
      systemAudioRecordingActive: true,
      liveTranscriptState: validState,
    }),
    { error: FIXED_LIVE_QUERY_ERRORS.NO_ACTIVE_TRANSCRIPT },
  );

  // Session mismatch with live transcript state
  assert.deepStrictEqual(
    buildLiveTranscriptQuerySnapshot({
      sessionName: 'session-20260824-1',
      activeSessionName: 'session-20260824-1',
      systemAudioRecordingActive: true,
      liveTranscriptState: { ...validState, sessionName: 'session-other' },
    }),
    { error: FIXED_LIVE_QUERY_ERRORS.NO_ACTIVE_TRANSCRIPT },
  );
});

test('buildLiveTranscriptQuerySnapshot returns error when live transcript has only punctuation or non-final segments', () => {
  const punctuationOnlyState = {
    sessionName: 'session-zh',
    priorSegments: [
      { start: 0, end: 2, speaker: 'You', text: '...', isFinal: true },
    ],
    segments: [
      { start: 2, end: 4, speaker: 'Others', text: '??? !!!', isFinal: true },
      { start: 4, end: 6, speaker: 'You', text: 'unfinalized text', isFinal: false },
    ],
  };

  const result = buildLiveTranscriptQuerySnapshot({
    sessionName: 'session-zh',
    activeSessionName: 'session-zh',
    systemAudioRecordingActive: true,
    liveTranscriptState: punctuationOnlyState,
  });

  assert.deepStrictEqual(result, { error: FIXED_LIVE_QUERY_ERRORS.EMPTY_TRANSCRIPT });
});

test('buildLiveTranscriptQuerySnapshot two-block format for resumed recordings', () => {
  const fullState = {
    sessionName: 'session-zh',
    priorSegments: [
      { start: 0, end: 5, speaker: 'You', text: '我們現在開始會議', isFinal: true },
    ],
    segments: [
      { start: 5, end: 12, speaker: 'Others', text: '好的，確認收到', isFinal: true },
    ],
  };

  const result = buildLiveTranscriptQuerySnapshot({
    sessionName: 'session-zh',
    activeSessionName: 'session-zh',
    systemAudioRecordingActive: true,
    liveTranscriptState: fullState,
  });

  assert.strictEqual(result.error, undefined);
  const lines = result.transcript.split('\n');
  assert.strictEqual(lines[0], 'EARLIER IN THIS MEETING (before resume):');
  // Prior segment has no timestamp
  assert.match(lines[1], /You: 我們現在開始會議/);
  assert.doesNotMatch(lines[1], /\d\d:\d\d/);
  // Separator blank line then CURRENT RECORDING: header
  assert.strictEqual(lines[2], '');
  assert.strictEqual(lines[3], 'CURRENT RECORDING:');
  // Current segment has timestamp
  assert.match(lines[4], /\[00:05 - 00:12\] Others: 好的，確認收到/);
});

test('buildLiveTranscriptQuerySnapshot no-prior-segments is unchanged (identity case)', () => {
  const state = {
    sessionName: 's1',
    priorSegments: [],
    segments: [
      { start: 0, end: 3, speaker: 'You', text: 'Hello world', isFinal: true },
    ],
  };

  const result = buildLiveTranscriptQuerySnapshot({
    sessionName: 's1',
    activeSessionName: 's1',
    systemAudioRecordingActive: true,
    liveTranscriptState: state,
  });

  assert.strictEqual(result.error, undefined);
  // No headers in a normal never-resumed recording
  assert.doesNotMatch(result.transcript, /EARLIER IN THIS MEETING/);
  assert.doesNotMatch(result.transcript, /CURRENT RECORDING/);
  assert.strictEqual(result.transcript, '[00:00 - 00:03] You: Hello world');
});

test('formatLiveTranscriptSegments two-block format drops prior lines before current under cap', () => {
  // Create segments where prior block must be dropped to respect the cap
  const currentLines = [
    { start: 0, end: 5, speaker: 'You', text: 'First current', isFinal: true },
    { start: 5, end: 10, speaker: 'Others', text: 'Second current', isFinal: true },
  ];
  const priorLines = [
    { start: 0, end: 5, speaker: 'You', text: 'Prior content that should be dropped', isFinal: true },
  ];

  // Calculate rough size of current lines with timestamps only
  const currentOnlyResult = formatLiveTranscriptSegments(currentLines, { priorSegments: [] });
  const capJustForCurrent = currentOnlyResult.length;

  // With such a small cap, prior block should be dropped
  const resultSmallCap = formatLiveTranscriptSegments(currentLines, {
    priorSegments: priorLines,
    maxChars: capJustForCurrent,
  });

  assert.doesNotMatch(resultSmallCap, /EARLIER IN THIS MEETING/);
  assert.doesNotMatch(resultSmallCap, /Prior content/);
  // Current lines are preserved
  assert.match(resultSmallCap, /First current/);
  assert.match(resultSmallCap, /Second current/);

  // With a generous cap, prior block appears before current
  const resultLargeCap = formatLiveTranscriptSegments(currentLines, {
    priorSegments: priorLines,
    maxChars: 2000,
  });
  assert.match(resultLargeCap, /EARLIER IN THIS MEETING/);
  assert.match(resultLargeCap, /Prior content/);
  assert.match(resultLargeCap, /CURRENT RECORDING/);
  assert.ok(resultLargeCap.indexOf('EARLIER IN THIS MEETING') < resultLargeCap.indexOf('CURRENT RECORDING'));
});

test('buildLiveTranscriptQuerySnapshot recordingActive true via currentRecordingProcess only', () => {
  const state = {
    sessionName: 'session-rec',
    priorSegments: [],
    segments: [
      { start: 0, end: 3, speaker: 'You', text: 'Active via process', isFinal: true },
    ],
  };

  // recordingActive=true but systemAudioRecordingActive=false (capture blip scenario)
  const result = buildLiveTranscriptQuerySnapshot({
    sessionName: 'session-rec',
    activeSessionName: 'session-rec',
    recordingActive: true,
    systemAudioRecordingActive: false,
    liveTranscriptState: state,
  });

  assert.strictEqual(result.error, undefined);
  assert.match(result.transcript, /Active via process/);
});

test('INVALID_HISTORY is in the frozen FIXED_LIVE_QUERY_ERRORS map', () => {
  assert.ok(
    Object.prototype.hasOwnProperty.call(FIXED_LIVE_QUERY_ERRORS, 'INVALID_HISTORY'),
    'FIXED_LIVE_QUERY_ERRORS must have INVALID_HISTORY key',
  );
  assert.strictEqual(typeof FIXED_LIVE_QUERY_ERRORS.INVALID_HISTORY, 'string');
  assert.ok(FIXED_LIVE_QUERY_ERRORS.INVALID_HISTORY.length > 0);
  // Must be frozen
  assert.throws(() => { FIXED_LIVE_QUERY_ERRORS.INVALID_HISTORY = 'hacked'; }, TypeError);
});

test('normalizeLiveQueryHistory accepts absent, null, and empty history', () => {
  assert.deepStrictEqual(normalizeLiveQueryHistory(undefined), { valid: true, history: [] });
  assert.deepStrictEqual(normalizeLiveQueryHistory(null), { valid: true, history: [] });
  assert.deepStrictEqual(normalizeLiveQueryHistory([]), { valid: true, history: [] });
});

test('normalizeLiveQueryHistory rejects non-array and malformed entries', () => {
  assert.deepStrictEqual(
    normalizeLiveQueryHistory('bad'),
    { valid: false, error: FIXED_LIVE_QUERY_ERRORS.INVALID_HISTORY },
  );
  assert.deepStrictEqual(
    normalizeLiveQueryHistory(42),
    { valid: false, error: FIXED_LIVE_QUERY_ERRORS.INVALID_HISTORY },
  );
  // Bad role
  assert.deepStrictEqual(
    normalizeLiveQueryHistory([{ role: 'system', content: 'x' }]),
    { valid: false, error: FIXED_LIVE_QUERY_ERRORS.INVALID_HISTORY },
  );
  // Non-string content
  assert.deepStrictEqual(
    normalizeLiveQueryHistory([{ role: 'user', content: 42 }]),
    { valid: false, error: FIXED_LIVE_QUERY_ERRORS.INVALID_HISTORY },
  );
  // Content too long (>4000 chars)
  assert.deepStrictEqual(
    normalizeLiveQueryHistory([{ role: 'user', content: 'x'.repeat(4001) }]),
    { valid: false, error: FIXED_LIVE_QUERY_ERRORS.INVALID_HISTORY },
  );
  // Null entry in array
  assert.deepStrictEqual(
    normalizeLiveQueryHistory([null]),
    { valid: false, error: FIXED_LIVE_QUERY_ERRORS.INVALID_HISTORY },
  );
});

test('normalizeLiveQueryHistory enforces max 6 entries (keeps newest)', () => {
  const entries = Array.from({ length: 8 }, (_, i) => ({
    role: i % 2 === 0 ? 'user' : 'assistant',
    content: `message ${i}`,
  }));
  const result = normalizeLiveQueryHistory(entries);
  assert.strictEqual(result.valid, true);
  assert.strictEqual(result.history.length, 6);
  // Should be the 6 newest (entries[2] through entries[7])
  assert.strictEqual(result.history[0].content, 'message 2');
  assert.strictEqual(result.history[5].content, 'message 7');
});

test('normalizeLiveQueryHistory enforces 4000 char per-entry limit', () => {
  const valid = normalizeLiveQueryHistory([{ role: 'user', content: 'x'.repeat(4000) }]);
  assert.strictEqual(valid.valid, true);
  const invalid = normalizeLiveQueryHistory([{ role: 'user', content: 'x'.repeat(4001) }]);
  assert.strictEqual(invalid.valid, false);
  assert.strictEqual(invalid.error, FIXED_LIVE_QUERY_ERRORS.INVALID_HISTORY);
});

test('normalizeLiveQueryHistory enforces 12000 total char limit by dropping oldest entries', () => {
  // 6 entries each with 2001 chars = 12006 total > 12000: oldest should be dropped
  const entries = Array.from({ length: 6 }, (_, i) => ({
    role: i % 2 === 0 ? 'user' : 'assistant',
    content: 'x'.repeat(2001),
  }));
  const result = normalizeLiveQueryHistory(entries);
  assert.strictEqual(result.valid, true);
  // Total must be <= 12000
  const total = result.history.reduce((sum, e) => sum + e.content.length, 0);
  assert.ok(total <= 12000, `total history chars ${total} exceeds 12000`);
  // Some entries were dropped
  assert.ok(result.history.length < 6);
});

test('validateLiveQueryInputs accepts valid history and rejects INVALID_HISTORY', () => {
  // Valid empty history
  const r1 = validateLiveQueryInputs({ queryId: 'q1', sessionName: 's1', question: 'Q', history: [] });
  assert.deepStrictEqual(r1, { valid: true, history: [] });

  // Valid history with proper entries
  const r2 = validateLiveQueryInputs({
    queryId: 'q1',
    sessionName: 's1',
    question: 'Q',
    history: [{ role: 'user', content: 'Hi' }, { role: 'assistant', content: 'Hello' }],
  });
  assert.strictEqual(r2.valid, true);
  assert.strictEqual(r2.history.length, 2);

  // Invalid history: bad role
  const r3 = validateLiveQueryInputs({
    queryId: 'q1',
    sessionName: 's1',
    question: 'Q',
    history: [{ role: 'system', content: 'x' }],
  });
  assert.deepStrictEqual(r3, { valid: false, error: FIXED_LIVE_QUERY_ERRORS.INVALID_HISTORY });

  // Invalid history: not an array
  const r4 = validateLiveQueryInputs({
    queryId: 'q1',
    sessionName: 's1',
    question: 'Q',
    history: { role: 'user', content: 'x' },
  });
  assert.deepStrictEqual(r4, { valid: false, error: FIXED_LIVE_QUERY_ERRORS.INVALID_HISTORY });
});
