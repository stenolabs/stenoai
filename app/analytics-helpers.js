'use strict';

/**
 * Pure, side-effect-free analytics helpers used by main.js's trackEvent call
 * sites. Extracted into their own module (mirrors shortcut-url.js /
 * setup-check-parse.js) so the bucketing/classification/sanitization logic
 * is unit-testable without requiring Electron.
 */

function textLengthBucket(text) {
  const len = (text || '').length;
  if (len === 0) return '0';
  if (len < 20) return '1-20';
  if (len < 50) return '20-50';
  if (len < 100) return '50-100';
  if (len < 250) return '100-250';
  return '250+';
}

function durationBucket(seconds) {
  if (seconds < 60) return '<1m';
  if (seconds < 300) return '1-5m';
  if (seconds < 900) return '5-15m';
  if (seconds < 1800) return '15-30m';
  if (seconds < 3600) return '30-60m';
  return '60m+';
}

// Renderer-originated analytics event names allowed through the `track` IPC
// bridge (contextIsolation means the renderer can't call trackEvent
// directly), each mapped to its own property-key allowlist. This is the
// actual privacy boundary: sanitizing by type/length alone would still let a
// short PII value (an attendee name, a meeting title) ride through under an
// unexpected key. Only listed here are events the renderer currently calls
// via ipc().analytics.track() -- e.g. chat_message_sent fires directly from
// main.js's streaming handlers and deliberately isn't reachable from here.
// Object.create(null) -- NOT a `{}` literal -- so a lookup by an
// Object.prototype key name (`__proto__`, `constructor`, `toString`, ...)
// returns real `undefined` instead of silently resolving to the inherited
// prototype method/object. A `{}` literal here would let eventName
// '__proto__' resolve to Object.prototype itself (truthy, no .has()),
// crashing sanitizeTrackProperties instead of safely falling through to "no
// allowlist for this event".
const RENDERER_TRACK_EVENT_PROPERTIES = Object.assign(Object.create(null), {
  notification_shown: new Set(['type']),
  notification_clicked: new Set(['type']),
  notification_dismissed: new Set(['type']),
  onboarding_completed: new Set(['ai_provider', 'calendar_connected']),
  ai_provider_selected: new Set(['provider']),
});

const RENDERER_TRACK_EVENTS = new Set(Object.keys(RENDERER_TRACK_EVENT_PROPERTIES));

// Value allowlist for specific event/property pairs, keyed as
// "event.property". This is on top of the key allowlist above: a key being
// approved doesn't mean any short string under it is safe -- these
// properties are meant to be small fixed enums, so a future bug that passes
// something else through an approved key (e.g. pasted text landing in
// `type`) gets dropped here rather than silently forwarded because it
// happened to be under 200 chars. Only string-valued properties need an
// entry; booleans/numbers are already fully constrained by their type.
const RENDERER_TRACK_EVENT_VALUE_ALLOWLIST = Object.assign(Object.create(null), {
  'notification_shown.type': new Set(['premeeting']),
  'notification_clicked.type': new Set(['premeeting']),
  'notification_dismissed.type': new Set(['premeeting']),
  'onboarding_completed.ai_provider': new Set(['local', 'cloud']),
  'ai_provider_selected.provider': new Set(['local', 'cloud']),
});

// Value-sanitizes a renderer-supplied properties object: only keys in that
// event's allowlist survive; of those, string values must also match the
// event/property's value allowlist (if one exists) and be <=200 chars, and
// number/boolean values pass through as-is. Objects/arrays are dropped
// entirely -- never forwarded to PostHog. This is the security boundary
// between renderer-supplied data and PostHog capture.
function sanitizeTrackProperties(eventName, properties) {
  const allowedKeys = typeof eventName === 'string' ? RENDERER_TRACK_EVENT_PROPERTIES[eventName] : undefined;
  const out = {};
  if (!allowedKeys || !properties || typeof properties !== 'object') return out;
  for (const [key, value] of Object.entries(properties)) {
    if (!allowedKeys.has(key)) continue;
    if (typeof value === 'string') {
      const valueAllowlist = RENDERER_TRACK_EVENT_VALUE_ALLOWLIST[`${eventName}.${key}`];
      if (valueAllowlist && !valueAllowlist.has(value)) continue; // not a known enum value -- drop
      if (value.length <= 200) out[key] = value;
    } else if (typeof value === 'number' || typeof value === 'boolean') {
      out[key] = value;
    }
    // keys outside the allowlist, values outside the value allowlist,
    // objects/arrays, and long strings are all dropped -- never forwarded
  }
  return out;
}

// host === domain, or host is a real subdomain of domain (ends with
// ".domain") -- NOT a bare substring match, which would also match an
// unrelated host like "evilzoom.us.attacker.com" or "notzoom.us".
function hostMatchesDomain(host, domain) {
  return host === domain || host.endsWith(`.${domain}`);
}

// Enum-only provider inference from a calendar event's meeting_url -- the
// URL itself is discarded, never sent to PostHog.
function calendarMeetingProvider(meetingUrl) {
  if (!meetingUrl || typeof meetingUrl !== 'string') return 'none';
  try {
    const host = new URL(meetingUrl).hostname.toLowerCase();
    if (hostMatchesDomain(host, 'zoom.us') || hostMatchesDomain(host, 'zoom.com')) return 'zoom';
    if (hostMatchesDomain(host, 'meet.google.com')) return 'meet';
    if (hostMatchesDomain(host, 'teams.microsoft.com') || hostMatchesDomain(host, 'teams.live.com')) return 'teams';
    return 'other';
  } catch (_) {
    return 'other';
  }
}

// Coarse, PII-free classification of a caught error for error_occurred's
// `reason` property. Fixed enum output only -- NEVER forwards error.message
// or .stack to PostHog, since either can carry a local file path (username in
// a home directory, an imported audio file's name, etc).
function classifyErrorReason(error) {
  const msg = String((error && error.message) || error || '');
  if (/\bENOENT\b/.test(msg)) return 'not_found';
  if (/\bEACCES\b|\bEPERM\b/.test(msg)) return 'permission_denied';
  if (/\bENOSPC\b/.test(msg)) return 'disk_full';
  if (/spawn error/i.test(msg)) return 'spawn_failed';
  if (/timed out|watchdog/i.test(msg)) return 'timeout';
  if (/malloc|out of memory|\boom\b/i.test(msg)) return 'out_of_memory';
  const exitMatch = msg.match(/exited with code (-?\d+)/i);
  if (exitMatch) return `subprocess_exit_${exitMatch[1]}`;
  return 'unknown';
}

// Coarse, PII-free classification of the STREAM_ERROR:<message> line
// simple_recorder.py's process_streaming() prints on a summarization
// failure (see src/summarizer.py's raise sites). Fixed enum output only --
// NEVER forwards the raw message to PostHog. Most raise sites in
// summarizer.py are static/templated text (safe to pattern-match by name),
// but several are bare re-raises of third-party SDK/HTTP exceptions (and
// Bedrock's raw response body), whose text is unpredictable and can echo
// request content or infra details -- those simply won't match any pattern
// below and correctly fall through to 'unknown', same as classifyErrorReason.
//
// The connection-refused half of ollama_not_running and the
// insufficient_memory branch match text that ORIGINATES from the Ollama
// server / the underlying httpx client on a bare re-raise, not a literal
// authored in summarizer.py -- unlike every other branch here, those two
// are exempt from the drift-guard test in analytics-helpers.test.js (there
// is no summarizer.py string for them to grep). "Connection refused"/
// "ConnectError" mirrors the same detection already used for the
// remote-Ollama status check in simple_recorder.py.
function classifySummarizationStreamError(message) {
  const msg = String(message || '');
  if (/Failed to start Ollama service/i.test(msg)) return 'ollama_not_running';
  // A stream can die mid-generation even after the pre-flight readiness
  // check in _ensure_ollama_ready already passed (Ollama killed/crashed
  // during generation) -- functionally the same "Ollama isn't there" case.
  if (/Connection refused|ConnectError|ECONNREFUSED/i.test(msg)) return 'ollama_not_running';
  if (/Failed to ensure model .* is available|could not find model/i.test(msg)) return 'model_unavailable';
  // Ollama's own server error when a model doesn't fit in available RAM,
  // e.g. "model requires more system memory (10.5 GiB) than is available
  // (8.0 GiB)" -- distinct from model_unavailable (the model IS installed).
  if (/requires more system memory/i.test(msg)) return 'insufficient_memory';
  if (/too long to summarize even after chunking/i.test(msg)) return 'context_overflow';
  // Deliberately matches just "returned (an) empty result/response/summary/
  // report" with no trailing anchor (e.g. NOT "...after retry") -- anchoring
  // to what follows would make this brittle to a copy-edit of the rest of
  // the sentence, same drift risk the guard test below exists to catch.
  if (/returned (an )?empty result|returned empty response|returned an empty (summary|report)/i.test(msg)) return 'empty_summary';
  // Neutral name (not auth_expired): the adapter's 401/403 really is a
  // session expiry, but Bedrock's 403 is a missing IAM permission -- a
  // rejected credential either way, not necessarily an expired one.
  if (/rejected the (request|api key)/i.test(msg)) return 'auth_rejected';
  if (/is not configured/i.test(msg)) return 'not_configured';
  if (/is not installed|package is required/i.test(msg)) return 'dependency_missing';
  if (/failed after all retries|HTTP \d+/i.test(msg)) return 'api_error';
  return 'unknown';
}

// This module lives in the app/ directory alongside main.js and is always
// required from there via a relative path, so __dirname here is identical to
// main.js's own -- the app's install root, whether that's an asar-packaged
// production build or a dev checkout. Used to anchor-strip the machine-local
// portion of a stack frame's path in redactLocalPaths below.
const APP_ROOT = __dirname;

// Collapses a matched absolute path down to just its filename -- not merely
// its username segment. Redacting only "/Users/<name>" would still leave
// every directory AFTER it intact (e.g. "/Users/<redacted>/acme-corp-
// confidential/steno-fork/lib/file.js" still names the client/workspace),
// which is exactly as revealing as the username itself for a frame outside
// APP_ROOT. Keeping the basename preserves "which file" for triage without
// any of the directory structure around it.
//
// prefixDepth is the number of leading path segments that are ALWAYS the
// matched pattern's own fixed text plus the username -- e.g. 2 for
// "Users/<name>" or "home/<name>", 3 for "C:/Users/<name>" (drive letter +
// "Users" + name) -- and must be stripped unconditionally, never treated as
// a candidate "filename". Without this, a match with nothing after the
// username (e.g. a stack frame reference with no real file component)
// falls back to the LAST segment being the username itself: confirmed live,
// `redactLocalPaths('at foo (/Users/bob:5:10)')` produced
// "at foo (<redacted-path>/bob:5:10)" before this fix -- the exact thing
// this function exists to prevent.
function collapseToFilename(matchedPath, prefixDepth) {
  const segments = matchedPath.split(/[\\/]/).filter(Boolean);
  const rest = segments.slice(prefixDepth);
  const filename = rest[rest.length - 1];
  return filename ? `<redacted-path>/${filename}` : '<redacted-path>';
}

// V8 stack frames end with ":<line>:<col>" and optionally a closing paren --
// e.g. "(/path/to/file.js:123:45)" or "/path/to/file.js:123:45" (no
// parens). Stripped off FIRST, before any path redaction runs, so the path
// match below can safely consume to end-of-line instead of having to guess
// where the path "ends" using `:` / `)` as delimiters -- both are valid
// characters in a real folder name ("Client (Secret)", "Project:Next"), so
// stopping at the first occurrence of either previously left everything
// after it -- the actual workspace/client name -- completely unredacted.
// Confirmed live before this fix: a frame referencing
// ".../Client (Secret)/main.js:10:2)" only got redacted up to
// "Client (Secret", leaking ")/main.js:10:2)" (i.e. the real folder name,
// intact) straight through.
const TRAILING_LOCATION_RE = /:\d+:\d+\)?\s*$/;

// This function is only ever called on ONE stack-frame line at a time (see
// sanitizeErrorForCrashReport's `lines.slice(1).map(redactLocalPaths)`), so
// anchoring path matches to `$` (end of that line) is safe -- a real V8
// frame never has more than one path per line.
function redactLocalPaths(text) {
  let redacted = text.split(APP_ROOT).join('<app>');

  const locationMatch = redacted.match(TRAILING_LOCATION_RE);
  const suffix = locationMatch ? locationMatch[0] : '';
  const body = suffix ? redacted.slice(0, redacted.length - suffix.length) : redacted;

  // prefixDepth per pattern: "Users"/<name> and "home"/<name> are each 2
  // fixed segments before any real path content; "C:"/"Users"/<name> is 3
  // (drive letter + "Users" + name); "root" alone is 1 (no separate
  // username segment).
  let redactedBody = body;
  redactedBody = redactedBody.replace(/\/Users\/[^\n]+$/, (m) => collapseToFilename(m, 2));
  redactedBody = redactedBody.replace(/\/home\/[^\n]+$/, (m) => collapseToFilename(m, 2));
  redactedBody = redactedBody.replace(/[A-Za-z]:\\Users\\[^\n]+$/, (m) => collapseToFilename(m, 3));
  // /root/ is not personally identifying on its own (there's only one
  // root), but a workspace/project folder immediately under it could still
  // be -- e.g. "/root/acme-corp-project/...". Not an officially shipped
  // platform today, but src/config.py already has a Linux data-dir
  // fallback, so this is cheap defense-in-depth rather than a live,
  // exercised path.
  redactedBody = redactedBody.replace(/\/root\/[^\n]+$/, (m) => collapseToFilename(m, 1));

  return redactedBody + suffix;
}

// Coarse, PII-free error for crash reporting ($exception capture). An
// uncaught fs/child_process error's raw .message can embed a local path, a
// session/note name, or -- for a calendar-titled recording -- a meeting
// title or attendee name, so it must never ride along verbatim like
// posthogClient.captureException(err, ...) would send it by default.
// Reuses classifyErrorReason so the message is always one of that function's
// fixed enum values. Stack FRAMES are kept (they're the actual triage value
// of a crash report -- which function, which line) but path-redacted via
// redactLocalPaths, since an unpacked/dev install's frames are NOT
// guaranteed to be the same for every user the way a signed build's are.
// The first line, which normally repeats "name: message" and would carry
// the risky raw text, is replaced with the sanitized reason outright.
function sanitizeErrorForCrashReport(err) {
  const reason = classifyErrorReason(err);
  const name = (err && err.name) || 'Error';
  // `new Error(reason)` auto-captures its OWN stack at this exact line, which
  // points into this file -- itself under APP_ROOT, so a dev checkout's real
  // local path. That's fine when we immediately overwrite it with the
  // redacted original stack below, but if the original error has no real
  // stack (a non-Error `throw`, which uncaughtException receives directly
  // and unwrapped -- unlike unhandledRejection, which we always wrap in a
  // real Error first), this auto-captured stack would otherwise survive
  // untouched and leak that path in full. Confirmed live: `throw "x"` /
  // `sanitizeErrorForCrashReport("x")` produced this file's real dev
  // checkout path verbatim before this branch existed.
  const safe = new Error(reason);
  safe.name = name;
  if (err && typeof err.stack === 'string') {
    const lines = err.stack.split('\n');
    const frames = lines.slice(1).map(redactLocalPaths);
    safe.stack = [`${name}: ${reason}`, ...frames].join('\n');
  } else {
    // No real stack to redact -- a message-only "stack" is the honest
    // answer (there's no frame data to report), not V8's auto-captured one.
    safe.stack = `${name}: ${reason}`;
  }
  return safe;
}

function captureSanitizedException(posthogClient, err, distinctId) {
  if (!posthogClient || !distinctId) return;
  posthogClient.captureException(sanitizeErrorForCrashReport(err), distinctId);
}

// Only fixed, public model identifiers are safe to send as analytics values.
// User-entered model names, fine-tuned ids, local paths, and self-pulled tags
// can carry customer/project names, so they collapse to the fixed "custom".
const ANALYTICS_MODEL_ALLOWLIST = new Set([
  // Curated local registry (SUPPORTED_MODELS in src/config.py) + Apple + MLX tags
  'apple:system',
  'gemma4:e2b-it-qat',
  'gemma4:e4b-it-qat',
  'gemma4:12b-it-qat',
  'gemma4:e2b-nvfp4',
  'gemma4:e4b-nvfp4',
  'gemma4:12b-nvfp4',
  'llama3.2:3b',
  'qwen3.5:9b',
  'gpt-oss:20b',
  // Transcription engines (SUPPORTED_WHISPER_MODELS + the parakeet path)
  'parakeet',
  'large-v3-turbo',
  // Common public cloud ids (cloud model fields are free-form per provider)
  'gpt-4o-mini',
  'gpt-4o',
  'gpt-4.1-mini',
  'claude-3-5-haiku-latest',
  'claude-3-5-sonnet-latest',
  'claude-3-7-sonnet-latest',
  'claude-haiku-4-5-20251001',
  // Bedrock dropdown (SUPPORTED_BEDROCK_MODELS in src/config.py)
  'anthropic.claude-sonnet-4-5-20250929-v2:0',
  'anthropic.claude-haiku-4-5-20251001-v1:0',
  'anthropic.claude-opus-4-1-20250805-v1:0',
  'anthropic.claude-3-5-sonnet-20241022-v2:0',
  'anthropic.claude-3-5-haiku-20241022-v1:0',
]);

function sanitizeModelForAnalytics(model) {
  if (typeof model !== 'string' || model.trim() === '') return 'unknown';
  const trimmed = model.trim();
  return ANALYTICS_MODEL_ALLOWLIST.has(trimmed) ? trimmed : 'custom';
}

// Content-free per-window summary for calendar_snapshot: counts + a
// provider breakdown, never titles/attendees/URLs.
function summarizeCalendarWindow(windowEvents) {
  const providerBreakdown = {};
  let videoMeetingCount = 0;
  for (const e of windowEvents) {
    const provider = calendarMeetingProvider(e.meeting_url);
    if (provider !== 'none') {
      videoMeetingCount++;
      providerBreakdown[provider] = (providerBreakdown[provider] || 0) + 1;
    }
  }
  return {
    meeting_count: windowEvents.length,
    video_meeting_count: videoMeetingCount,
    provider_breakdown: providerBreakdown,
  };
}

// Splits a fetched event list into "today" and "week" calendar_snapshot
// payloads. Pure given `now` -- callers own throttling/trackEvent side effects.
function summarizeCalendarSnapshot(events, now) {
  const startOfDayMs = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 0, 0, 0, 0).getTime();
  const endOfDayMs = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 23, 59, 59, 999).getTime();
  const timedNonDeclined = events.filter(
    (e) => e && typeof e.start === 'string' && e.start.includes('T') && e.is_all_day !== true && e.response_status !== 'declined'
  );
  const todayEvents = timedNonDeclined.filter((e) => {
    const startMs = new Date(e.start).getTime();
    return isFinite(startMs) && startMs >= startOfDayMs && startMs <= endOfDayMs;
  });
  return {
    today: summarizeCalendarWindow(todayEvents),
    week: summarizeCalendarWindow(timedNonDeclined),
  };
}

// Resolves with `fallback` if `promise` hasn't settled within `ms`, or if it
// rejects -- this function itself never rejects. Needed because
// getCalendarEventForNow's own AbortController only bounds the calendar
// event fetch; a stuck OAuth token-refresh request (no timeout of its own)
// upstream of that fetch can hang the whole chain indefinitely. Without an
// outer bound here, that hang would silently swallow recording_started for
// the recording that triggered the lookup.
function withTimeout(promise, ms, fallback = null) {
  return new Promise((resolve) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      resolve(fallback);
    }, ms);
    promise.then(
      (value) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(value);
      },
      () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(fallback);
      }
    );
  });
}

module.exports = {
  textLengthBucket,
  durationBucket,
  RENDERER_TRACK_EVENTS,
  RENDERER_TRACK_EVENT_PROPERTIES,
  RENDERER_TRACK_EVENT_VALUE_ALLOWLIST,
  sanitizeTrackProperties,
  calendarMeetingProvider,
  classifyErrorReason,
  classifySummarizationStreamError,
  captureSanitizedException,
  redactLocalPaths,
  sanitizeModelForAnalytics,
  sanitizeErrorForCrashReport,
  summarizeCalendarWindow,
  summarizeCalendarSnapshot,
  withTimeout,
};
