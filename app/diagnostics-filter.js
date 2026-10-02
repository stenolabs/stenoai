'use strict';

// Source-side privacy filters for the shareable debug log (Settings >
// Developer > Debug console, backed by sendDebugLog). These keep meeting
// content and PII out of the buffer in the first place, mirroring the on-disk
// allowlist in main.js's logPipelineStdoutLine. See
// docs/superpowers/specs/2026-07-04-diagnostics-privacy-design.md (PR1).

// ---------------------------------------------------------------------------
// Stdout allowlist
// ---------------------------------------------------------------------------

// Prefixes for the structural, content-free protocol lines that are safe to
// forward to the debug buffer. Everything else on stdout — settings-command
// JSON replies, query answers, and the content markers CHUNK:/TITLE:/LIVE_SEG:/
// CHAT_CHUNK: — is dropped.
//
// Deliberately EXCLUDED (accepted diagnostic loss, per the design): STATUS:,
// SUCCESS:, ERROR:, WARNING: (settings replies / error strings that can quote
// content) and LIVE_READY: (a config JSON payload). PARAKEET_PULL_STAGE: /
// LIVE_READY: are consumed by dedicated handlers, never the generic choke
// points, so they never reach this filter.
const DIAGNOSTIC_STDOUT_PREFIXES = [
  'HEARTBEAT:',
  'PROGRESS:',
  'TRANSCRIPTION_COMPLETE:',
  'TRANSCRIPTION_FAILED:',
  'SAVED:',
  'STREAM_ERROR:',
  'CHAT_STREAM_ERROR:',
  'LIVE_ERROR:',
];

// STREAM_COMPLETE is an exact-match sentinel (no trailing value), so it is
// matched on its own rather than as a prefix.
function isDiagnosticStdoutLine(line) {
  const l = (line || '').trim();
  if (!l) return false;
  if (l === 'STREAM_COMPLETE') return true;
  return DIAGNOSTIC_STDOUT_PREFIXES.some((p) => l.startsWith(p));
}

// ---------------------------------------------------------------------------
// `$ stenoai ...` args-echo sanitizer
// ---------------------------------------------------------------------------

// Replace everything after the -q flag with a redaction marker (keeps the file
// and the flag, drops the question text).
function redactAfterQ(args) {
  const i = args.indexOf('-q');
  if (i === -1) return args.slice();
  return [...args.slice(0, i + 1), '<redacted>'];
}

// Collapse every value arg after the command into a single marker.
function redactRest(args) {
  return args.length > 1 ? [args[0], '<redacted>'] : args.slice();
}

// Denylist map: commands whose argv carries user content or PII. Each entry
// rewrites the argv FOR LOGGING ONLY (never the spawned args). API keys are
// safe here — they travel via env/safeStorage, never argv.
const ARGS_ECHO_REDACTORS = {
  // Question text follows -q; keep the file + flag, drop the question.
  query: redactAfterQ,
  'query-streaming': redactAfterQ,
  // The whole template JSON is the user's custom prompt.
  'save-template': () => ['save-template', '<template json>'],
  // Single sensitive value arg(s): name, storage path, folder name, or URL
  // (URLs may embed user:pass@ or an org hostname).
  'set-user-name': redactRest,
  'set-storage-path': redactRest,
  'create-folder': redactRest,
  'rename-folder': redactRest,
  'set-remote-ollama-url': redactRest,
  'test-remote-ollama': redactRest,
  'set-cloud-api-url': redactRest,
  // --api-url may embed credentials or a private org hostname (same class as
  // set-cloud-api-url). The ASR key never travels via argv - it is held in
  // safeStorage and injected through the environment.
  'set-openai-asr-config': redactRest,
  // device_id + a user-assigned device label (e.g. "Conference AirPods") -
  // same PII class as set-user-name.
  'set-microphone': redactRest,
  'confirm-speaker': redactRest,
  'create-person-profile': redactRest,
  'rename-person-profile': redactRest,
  'delete-person-profile': redactRest,
  'get-speaker-sample-audio': redactRest,
  'mark-speaker-cluster': redactRest,
  'set-cluster-review-state': redactRest,
  'speaker-naming-status': redactRest,
  'suggest-speakers': redactRest,
  'speaker-timestamps': redactRest,
  'get-person-sample-audio': redactRest,
};

// Return the argv rewritten for the `$ stenoai <...>` debug echo. Non-
// denylisted commands echo verbatim.
function sanitizeArgsForLog(args) {
  if (!Array.isArray(args) || args.length === 0) return '';
  const redactor = ARGS_ECHO_REDACTORS[args[0]];
  const out = redactor ? redactor(args) : args;
  return out.join(' ');
}

module.exports = { isDiagnosticStdoutLine, sanitizeArgsForLog };
