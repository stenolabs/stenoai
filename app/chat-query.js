'use strict';

const MAX_BYTES = 1024 * 1024;
const ERROR = 'Unable to answer. Check your AI provider and try again.';

// Stable failure codes from src/ai_errors.py (CHAT_STREAM_ERROR:<code>,
// CHAT_AGENT_ERROR:<code>). They carry no provider text, so they may travel to
// the renderer as `errorCode` next to the fixed `error` message; anything else
// on an error line (an old backend's free text) is never forwarded.
const AI_ERROR_CODES = new Set([
  'ollama-unreachable', 'model-missing', 'auth', 'quota', 'rate-limit',
  'network', 'timeout', 'context-too-long', 'unknown',
]);

function aiErrorCode(value) {
  const code = typeof value === 'string' ? value.trim() : '';
  return AI_ERROR_CODES.has(code) ? code : 'unknown';
}

function validateRequest(request) {
  if (!request || !['live', 'meeting', 'notes', 'general'].includes(request.scope)
      || typeof request.question !== 'string' || !request.question.trim()
      || request.question.length > 2000) throw new Error('Enter a question of up to 2,000 characters.');
  const history = request.history ?? [];
  if (!Array.isArray(history) || history.length > 6 || Array.from(history).some((t) => !t
      || !['user', 'assistant'].includes(t.role) || typeof t.content !== 'string' || t.content.length > 4000)
      || history.reduce((sum, t) => sum + t.content.length, 0) > 12000) throw new Error('Invalid conversation history.');
  if (request.folder != null && (typeof request.folder !== 'string' || request.folder.length > 256)) throw new Error('Invalid folder.');
  // Pick fields explicitly: a renderer cannot attach its own live transcript or
  // arbitrary file to a general query. Main resolves trusted context separately.
  return { scope: request.scope, question: request.question, history, folder: request.scope === 'notes' ? request.folder : undefined };
}

function liveSnapshot(state, maxChars = 100000) {
  const format = (segments, prior) => (segments || [])
    .filter((s) => s?.isFinal === true && typeof s.text === 'string' && /[\p{L}\p{N}]/u.test(s.text))
    .map((s) => `${prior ? '' : `[${Math.max(0, Math.floor(Number(s.start) || 0))}s] `}${s.speaker === 'You' ? 'You' : 'Others'}: ${s.text.trim()}`)
    .join('\n');
  const current = format(state.segments, false);
  const prior = format(state.priorSegments, true);
  return [prior && `EARLIER IN THIS MEETING (before resume):\n${prior}`, current && `CURRENT RECORDING:\n${current}`]
    .filter(Boolean).join('\n\n').slice(-maxChars);
}

/** Own a query's child/timeout/protocol lifecycle, independently of recording. */
function runQuery({ spawn, backend, env, cwd, payload, send, onFinish, timeoutMs = 300000 }) {
  let proc;
  let done = false;
  let buffer = '';
  let answerBytes = 0;
  let timer;
  const finish = (success, error, errorCode) => {
    if (done) return;
    done = true;
    clearTimeout(timer);
    proc?.kill();
    send('query-done', { success, ...(error ? { error } : {}), ...(error && errorCode ? { errorCode } : {}) });
    onFinish();
  };
  const fail = (code = 'unknown') => finish(false, ERROR, code);
  try {
    const input = JSON.stringify(payload);
    if (Buffer.byteLength(input) > MAX_BYTES) throw new Error('Payload limit');
    proc = spawn(backend, ['chat-context-streaming'], { env, cwd, windowsHide: true });
    timer = setTimeout(() => finish(false, 'The answer timed out. Please try again.', 'timeout'), timeoutMs);
    proc.stdout.on('data', (data) => {
      if (done) return;
      buffer += data.toString('utf8');
      if (Buffer.byteLength(buffer) > MAX_BYTES) return fail();
      let nl;
      while (!done && (nl = buffer.indexOf('\n')) !== -1) {
        const line = buffer.slice(0, nl).replace(/\r$/, '');
        buffer = buffer.slice(nl + 1);
        if (line.startsWith('CHAT_STEP:')) {
          // What the answer read ("Read 12 notes"): counts and a title only.
          try {
            const step = JSON.parse(Buffer.from(line.slice(10), 'base64').toString('utf8'));
            if (step && step.source === 'context') send('query-tool-step', { step });
          } catch (_) {}
        } else if (line.startsWith('CHAT_CHUNK:')) {
          const chunk = Buffer.from(line.slice(11), 'base64').toString('utf8');
          answerBytes += Buffer.byteLength(chunk);
          if (answerBytes > MAX_BYTES) return fail();
          send('query-chunk', { chunk });
        } else if (line === 'CHAT_STREAM_COMPLETE') {
          if (answerBytes) finish(true);
          else fail();
        } else if (line.startsWith('CHAT_STREAM_ERROR:')) {
          fail(aiErrorCode(line.slice(18)));
        }
      }
    });
    // Drain without logging: providers may put private context on stderr.
    proc.stderr.on('data', () => {});
    proc.on('error', () => fail());
    proc.on('close', () => fail());
    proc.stdin.on('error', () => fail());
    proc.stdin.end(input);
  } catch (_) {
    fail();
  }
  return { cancel: () => finish(false, 'Answer stopped.') };
}

module.exports = { validateRequest, liveSnapshot, runQuery, aiErrorCode, AI_ERROR_CODES };
