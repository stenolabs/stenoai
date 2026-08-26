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
    { valid: true },
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

test('buildLiveTranscriptQuerySnapshot concatenates priorSegments and current segments into clean transcript', () => {
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
  assert.strictEqual(
    result.transcript,
    '[00:00 - 00:05] You: 我們現在開始會議\n[00:05 - 00:12] Others: 好的，確認收到',
  );
});
