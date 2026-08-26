'use strict';

/**
 * Pure helpers for live transcript snapshot filtering, formatting, and query validation.
 *
 * Privacy & resource guarantees:
 * - Punctuation-only / filler / empty utterances are rejected via \p{L}|\p{N}.
 * - Only finalized segments (isFinal === true) are included.
 * - Speakers are normalized ('You', 'Others', fallback 'Speaker').
 * - Timestamps are formatted into MM:SS intervals for current recording segments.
 * - Resumed recording prior segments are rendered in a separate leading block without timestamps.
 * - Context snapshot is recent-first capped at 100,000 characters.
 * - Questions are capped at 2,000 Unicode code units.
 * - Multi-turn history is bounded (max 6 items, 4k chars/item, 12k chars total).
 * - Line buffers and decoded responses are capped at 1 MiB.
 * - Query timeout is enforced at 300s.
 * - Error messages are fixed/sanitized and never leak transcript contents.
 */

const MAX_LIVE_QUERY_QUESTION_CHARS = 2000;
const MAX_LIVE_TRANSCRIPT_CHARS = 100000;
const MAX_PROTOCOL_LINE_BYTES = 1024 * 1024;
const MAX_DECODED_ANSWER_BYTES = 1024 * 1024;
const LIVE_QUERY_TIMEOUT_MS = 300000;
const MAX_LIVE_QUERY_HISTORY_ENTRIES = 6;
const MAX_LIVE_QUERY_HISTORY_ITEM_CHARS = 4000;
const MAX_LIVE_QUERY_TOTAL_HISTORY_CHARS = 12000;

const FIXED_LIVE_QUERY_ERRORS = Object.freeze({
  UNAUTHORIZED: 'Unauthorized renderer',
  INVALID_QUERY_ID: 'Invalid query id',
  INVALID_SESSION: 'Invalid live session',
  NO_ACTIVE_TRANSCRIPT: 'No active live transcript for this session',
  EMPTY_TRANSCRIPT: 'Live transcript is empty',
  QUESTION_REQUIRED: 'Question is required',
  QUESTION_TOO_LONG: 'Question exceeds maximum length of 2000 characters',
  INVALID_HISTORY: 'Invalid chat history',
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

function formatSinglePriorSegment(segment) {
  const speaker = segment.speaker === 'Others' || segment.speaker === 'You'
    ? segment.speaker
    : 'Speaker';
  return `${speaker}: ${String(segment.text || '').trim()}`;
}

function formatSingleLiveSegment(segment) {
  const speaker = segment.speaker === 'Others' || segment.speaker === 'You'
    ? segment.speaker
    : 'Speaker';
  const start = formatLiveQueryTimestamp(segment.start);
  const end = formatLiveQueryTimestamp(segment.end);
  return `[${start} - ${end}] ${speaker}: ${String(segment.text || '').trim()}`;
}

function formatLiveTranscriptSegments(segments, options = {}) {
  let curSegments = segments;
  let priorSegments = options.priorSegments || [];
  let maxChars = typeof options.maxChars === 'number' && options.maxChars > 0
    ? options.maxChars
    : MAX_LIVE_TRANSCRIPT_CHARS;

  if (segments && typeof segments === 'object' && !Array.isArray(segments)) {
    curSegments = segments.segments || [];
    priorSegments = segments.priorSegments || options.priorSegments || [];
    if (typeof segments.maxChars === 'number' && segments.maxChars > 0) {
      maxChars = segments.maxChars;
    }
  }

  const validCurrent = Array.isArray(curSegments)
    ? curSegments.filter((s) => s && s.isFinal && isMeaningfulLiveQueryText(s.text))
    : [];
  const validPrior = Array.isArray(priorSegments)
    ? priorSegments.filter((s) => s && s.isFinal && isMeaningfulLiveQueryText(s.text))
    : [];

  if (validCurrent.length === 0 && validPrior.length === 0) return '';

  const cap = maxChars;

  // Case 1: No prior segments exist -> standard format without headers
  if (validPrior.length === 0) {
    const selectedLines = [];
    let currentLen = 0;
    for (let i = validCurrent.length - 1; i >= 0; i--) {
      const line = formatSingleLiveSegment(validCurrent[i]);
      const addedLen = line.length + (selectedLines.length > 0 ? 1 : 0);
      if (currentLen + addedLen <= cap) {
        selectedLines.unshift(line);
        currentLen += addedLen;
      } else {
        if (selectedLines.length === 0) {
          selectedLines.push(line.slice(-cap));
        }
        break;
      }
    }
    return selectedLines.join('\n').trim();
  }

  // Case 2: Prior segments exist (with or without current segments)
  const priorLines = validPrior.map(formatSinglePriorSegment);
  const currentLines = validCurrent.map(formatSingleLiveSegment);

  const priorHeader = 'EARLIER IN THIS MEETING (before resume):';
  const currentHeader = 'CURRENT RECORDING:';

  // If there are no current segments, format only the prior block
  if (currentLines.length === 0) {
    const selectedPrior = [];
    let currentLen = priorHeader.length;
    for (let i = priorLines.length - 1; i >= 0; i--) {
      const line = priorLines[i];
      const addedLen = line.length + 1; // newline before line
      if (currentLen + addedLen <= cap) {
        selectedPrior.unshift(line);
        currentLen += addedLen;
      } else {
        break;
      }
    }
    if (selectedPrior.length === 0) {
      const firstLine = priorLines[priorLines.length - 1];
      const full = `${priorHeader}\n${firstLine}`;
      return full.length <= cap ? full : full.slice(-cap).trim();
    }
    return `${priorHeader}\n${selectedPrior.join('\n')}`.trim();
  }

  // Both prior segments and current segments exist.
  // Rule: drop prior-block lines before current-block lines.
  let currentLinesLen = 0;
  for (let i = 0; i < currentLines.length; i++) {
    currentLinesLen += currentLines[i].length + (i > 0 ? 1 : 0);
  }

  if (currentLinesLen >= cap) {
    // Current lines alone take the entire budget (or exceed it).
    // Drop prior block completely, return trimmed current lines without headers.
    const selectedLines = [];
    let currentLen = 0;
    for (let i = currentLines.length - 1; i >= 0; i--) {
      const line = currentLines[i];
      const addedLen = line.length + (selectedLines.length > 0 ? 1 : 0);
      if (currentLen + addedLen <= cap) {
        selectedLines.unshift(line);
        currentLen += addedLen;
      } else {
        if (selectedLines.length === 0) {
          selectedLines.push(line.slice(-cap));
        }
        break;
      }
    }
    return selectedLines.join('\n').trim();
  }

  // All current lines fit. Check if we can fit headers and any prior lines.
  const currentSection = `${currentHeader}\n${currentLines.join('\n')}`;
  // Delimiter between prior block and current block is '\n\n'
  const fixedOverhead = priorHeader.length + 1 + 2 + currentSection.length;
  const remainingBudget = cap - fixedOverhead;

  if (remainingBudget <= 0) {
    // Cannot fit headers + prior block -> return current lines without header
    return currentLines.join('\n').trim();
  }

  const selectedPrior = [];
  let priorLen = 0;
  for (let i = priorLines.length - 1; i >= 0; i--) {
    const line = priorLines[i];
    const addedLen = line.length + (selectedPrior.length > 0 ? 1 : 0);
    if (priorLen + addedLen <= remainingBudget) {
      selectedPrior.unshift(line);
      priorLen += addedLen;
    } else {
      break;
    }
  }

  if (selectedPrior.length === 0) {
    return currentLines.join('\n').trim();
  }

  return `${priorHeader}\n${selectedPrior.join('\n')}\n\n${currentSection}`.trim();
}

function normalizeLiveQueryHistory(history) {
  if (history === undefined || history === null) {
    return { valid: true, history: [] };
  }
  if (!Array.isArray(history)) {
    return { valid: false, error: FIXED_LIVE_QUERY_ERRORS.INVALID_HISTORY };
  }

  for (const entry of history) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
      return { valid: false, error: FIXED_LIVE_QUERY_ERRORS.INVALID_HISTORY };
    }
    if (entry.role !== 'user' && entry.role !== 'assistant') {
      return { valid: false, error: FIXED_LIVE_QUERY_ERRORS.INVALID_HISTORY };
    }
    if (typeof entry.content !== 'string') {
      return { valid: false, error: FIXED_LIVE_QUERY_ERRORS.INVALID_HISTORY };
    }
    if (entry.content.length > MAX_LIVE_QUERY_HISTORY_ITEM_CHARS) {
      return { valid: false, error: FIXED_LIVE_QUERY_ERRORS.INVALID_HISTORY };
    }
  }

  // Keep at most newest 6 entries
  const newestEntries = history.slice(-MAX_LIVE_QUERY_HISTORY_ENTRIES).map((e) => ({
    role: e.role,
    content: e.content,
  }));

  // Cap total history characters at 12000, dropping oldest entries first
  let totalChars = newestEntries.reduce((sum, e) => sum + e.content.length, 0);
  while (newestEntries.length > 0 && totalChars > MAX_LIVE_QUERY_TOTAL_HISTORY_CHARS) {
    const dropped = newestEntries.shift();
    totalChars -= dropped.content.length;
  }

  return { valid: true, history: newestEntries };
}

function validateLiveQueryInputs({ queryId, sessionName, question, history } = {}) {
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
  const historyValidation = normalizeLiveQueryHistory(history);
  if (!historyValidation.valid) {
    return { valid: false, error: historyValidation.error };
  }
  return { valid: true, history: historyValidation.history };
}

function buildLiveTranscriptQuerySnapshot({
  sessionName,
  activeSessionName,
  recordingActive,
  systemAudioRecordingActive,
  liveTranscriptState,
  maxChars = MAX_LIVE_TRANSCRIPT_CHARS,
} = {}) {
  if (typeof sessionName !== 'string' || !sessionName.trim() || sessionName.length > 256) {
    return { error: FIXED_LIVE_QUERY_ERRORS.INVALID_SESSION };
  }
  const isRecording = typeof recordingActive === 'boolean'
    ? recordingActive
    : Boolean(systemAudioRecordingActive);

  if (
    !isRecording
    || activeSessionName !== sessionName
    || !liveTranscriptState
    || liveTranscriptState.sessionName !== sessionName
  ) {
    return { error: FIXED_LIVE_QUERY_ERRORS.NO_ACTIVE_TRANSCRIPT };
  }

  const transcript = formatLiveTranscriptSegments(liveTranscriptState.segments || [], {
    maxChars,
    priorSegments: liveTranscriptState.priorSegments || [],
  });
  if (!transcript) return { error: FIXED_LIVE_QUERY_ERRORS.EMPTY_TRANSCRIPT };
  return { transcript };
}

module.exports = {
  MAX_LIVE_QUERY_QUESTION_CHARS,
  MAX_LIVE_TRANSCRIPT_CHARS,
  MAX_PROTOCOL_LINE_BYTES,
  MAX_DECODED_ANSWER_BYTES,
  LIVE_QUERY_TIMEOUT_MS,
  MAX_LIVE_QUERY_HISTORY_ENTRIES,
  MAX_LIVE_QUERY_HISTORY_ITEM_CHARS,
  MAX_LIVE_QUERY_TOTAL_HISTORY_CHARS,
  FIXED_LIVE_QUERY_ERRORS,
  formatLiveQueryTimestamp,
  isMeaningfulLiveQueryText,
  formatSinglePriorSegment,
  formatSingleLiveSegment,
  formatLiveTranscriptSegments,
  normalizeLiveQueryHistory,
  validateLiveQueryInputs,
  buildLiveTranscriptQuerySnapshot,
};
