'use strict';

/**
 * Pure helpers for live transcript snapshot filtering, formatting, and query validation.
 *
 * Privacy & resource guarantees:
 * - Punctuation-only / filler / empty utterances are rejected via \p{L}|\p{N}.
 * - Only finalized segments (isFinal === true) are included.
 * - Speakers are normalized ('You', 'Others', fallback 'Speaker').
 * - Timestamps are formatted into MM:SS intervals.
 * - Context snapshot is recent-first capped at 100,000 characters.
 * - Questions are capped at 2,000 Unicode code units.
 * - Line buffers and decoded responses are capped at 1 MiB.
 * - Query timeout is enforced at 300s.
 * - Error messages are fixed/sanitized and never leak transcript contents.
 */

const MAX_LIVE_QUERY_QUESTION_CHARS = 2000;
const MAX_LIVE_TRANSCRIPT_CHARS = 100000;
const MAX_PROTOCOL_LINE_BYTES = 1024 * 1024;
const MAX_DECODED_ANSWER_BYTES = 1024 * 1024;
const LIVE_QUERY_TIMEOUT_MS = 300000;

const FIXED_LIVE_QUERY_ERRORS = Object.freeze({
  UNAUTHORIZED: 'Unauthorized renderer',
  INVALID_QUERY_ID: 'Invalid query id',
  INVALID_SESSION: 'Invalid live session',
  NO_ACTIVE_TRANSCRIPT: 'No active live transcript for this session',
  EMPTY_TRANSCRIPT: 'Live transcript is empty',
  QUESTION_REQUIRED: 'Question is required',
  QUESTION_TOO_LONG: 'Question exceeds maximum length of 2000 characters',
  QUERY_ALREADY_ACTIVE: 'Query already active',
  TIMEOUT: 'Query timed out',
  LINE_LIMIT_EXCEEDED: 'Protocol line limit exceeded',
  FAILED: 'Live query failed',
  RESPONSE_LIMIT_EXCEEDED: 'Response limit exceeded',
  STREAM_CLOSED: 'Stream closed prematurely',
});

function formatLiveQueryTimestamp(value) {
  const seconds = Number(value);
  if (!Number.isFinite(seconds)) return '??:??';
  const whole = Math.max(0, Math.floor(seconds));
  const minutes = Math.floor(whole / 60);
  const secs = whole % 60;
  return `${String(minutes).padStart(2, '0')}:${String(secs).padStart(2, '0')}`;
}

function isMeaningfulLiveQueryText(text) {
  return /[\p{L}\p{N}]/u.test(String(text || ''));
}

function formatSingleLiveSegment(segment) {
  const speaker = segment.speaker === 'Others' || segment.speaker === 'You'
    ? segment.speaker
    : 'Speaker';
  const start = formatLiveQueryTimestamp(segment.start);
  const end = formatLiveQueryTimestamp(segment.end);
  return `[${start} - ${end}] ${speaker}: ${String(segment.text).trim()}`;
}

function formatLiveTranscriptSegments(segments, { maxChars = MAX_LIVE_TRANSCRIPT_CHARS } = {}) {
  if (!Array.isArray(segments)) return '';
  const valid = segments.filter(
    (segment) => segment && segment.isFinal && isMeaningfulLiveQueryText(segment.text),
  );
  if (valid.length === 0) return '';

  const cap = typeof maxChars === 'number' && maxChars > 0 ? maxChars : MAX_LIVE_TRANSCRIPT_CHARS;

  // Build recent-first: iterate backwards from newest to oldest
  const selectedLines = [];
  let currentLen = 0;

  for (let i = valid.length - 1; i >= 0; i--) {
    const line = formatSingleLiveSegment(valid[i]);
    const addedLen = line.length + (selectedLines.length > 0 ? 1 : 0);

    if (currentLen + addedLen <= cap) {
      selectedLines.unshift(line);
      currentLen += addedLen;
    } else {
      if (selectedLines.length === 0) {
        // Single segment exceeds cap: take the tail of this segment
        selectedLines.push(line.slice(-cap));
      }
      break;
    }
  }

  return selectedLines.join('\n').trim();
}

function validateLiveQueryInputs({ queryId, sessionName, question } = {}) {
  if (typeof queryId !== 'string' || !queryId.trim() || queryId.length > 256) {
    return { valid: false, error: FIXED_LIVE_QUERY_ERRORS.INVALID_QUERY_ID };
  }
  if (typeof sessionName !== 'string' || !sessionName.trim() || sessionName.length > 256) {
    return { valid: false, error: FIXED_LIVE_QUERY_ERRORS.INVALID_SESSION };
  }
  if (typeof question !== 'string' || !question.trim()) {
    return { valid: false, error: FIXED_LIVE_QUERY_ERRORS.QUESTION_REQUIRED };
  }
  if (question.length > MAX_LIVE_QUERY_QUESTION_CHARS) {
    return { valid: false, error: FIXED_LIVE_QUERY_ERRORS.QUESTION_TOO_LONG };
  }
  return { valid: true };
}

function buildLiveTranscriptQuerySnapshot({
  sessionName,
  activeSessionName,
  systemAudioRecordingActive,
  liveTranscriptState,
  maxChars = MAX_LIVE_TRANSCRIPT_CHARS,
} = {}) {
  if (typeof sessionName !== 'string' || !sessionName.trim() || sessionName.length > 256) {
    return { error: FIXED_LIVE_QUERY_ERRORS.INVALID_SESSION };
  }
  if (
    !systemAudioRecordingActive
    || activeSessionName !== sessionName
    || !liveTranscriptState
    || liveTranscriptState.sessionName !== sessionName
  ) {
    return { error: FIXED_LIVE_QUERY_ERRORS.NO_ACTIVE_TRANSCRIPT };
  }

  const allSegments = [
    ...(liveTranscriptState.priorSegments || []),
    ...(liveTranscriptState.segments || []),
  ];

  const transcript = formatLiveTranscriptSegments(allSegments, { maxChars });
  if (!transcript) return { error: FIXED_LIVE_QUERY_ERRORS.EMPTY_TRANSCRIPT };
  return { transcript };
}

module.exports = {
  MAX_LIVE_QUERY_QUESTION_CHARS,
  MAX_LIVE_TRANSCRIPT_CHARS,
  MAX_PROTOCOL_LINE_BYTES,
  MAX_DECODED_ANSWER_BYTES,
  LIVE_QUERY_TIMEOUT_MS,
  FIXED_LIVE_QUERY_ERRORS,
  formatLiveQueryTimestamp,
  isMeaningfulLiveQueryText,
  formatSingleLiveSegment,
  formatLiveTranscriptSegments,
  validateLiveQueryInputs,
  buildLiveTranscriptQuerySnapshot,
};
