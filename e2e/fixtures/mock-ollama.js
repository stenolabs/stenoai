// Mock Ollama for the T2 tier, bound to the hardcoded 11434 the app probes.
// src/ollama_manager.py checks http://127.0.0.1:11434/api/tags first and skips
// starting its own `ollama serve` on a 200 (ollama_manager.py ~148), so
// prebinding here keeps the real/ bundled Ollama out of the test. Answers
// /api/tags, /api/pull, /api/delete, and a streaming NDJSON /api/chat.
//
// Bind is hard by design (listen throws on EADDRINUSE): if a real Ollama is
// already answering on 11434 the test would silently hit the live LLM instead
// of this stub, so T2 setup must `pkill -f ollama` first (the bind then proves
// the port is ours). Used by the summary/transcription specs from PR2 on; the
// PR1 org-lock spec doesn't exercise Ollama and so doesn't start it.
//
// Contract testing (Phase 4): pass { chatReply } to return a fixed assistant
// message instead of the default 'ok', and read lastChatPrompt() to assert what
// prompt the summarizer built (e.g. that it embedded the transcript). Default
// behaviour is unchanged, so the existing @pipeline specs are unaffected.
const http = require('http');

const OLLAMA_PORT = 11434;

/**
 * Start the mock Ollama on 11434 (or a custom/ephemeral port).
 * @param {object} [opts]
 * @param {number} [opts.port=0] port to bind (0 for ephemeral port).
 * @param {string} [opts.chatReply='ok'] assistant content returned by /api/chat.
 * @param {string[]} [opts.chatReplyQueue=[]] queue of replies to dequeue per call; falls back to chatReply when exhausted.
 * @param {{status:number, message:string}} [opts.chatError] when set, /api/chat responds with this HTTP
 *   status and JSON body `{"error": message}` (the real Ollama 404 shape) instead of a reply. Off by
 *   default so existing specs are unaffected. chatCalls still increments so callers can assert it was hit.
 * @param {string[]} [opts.installedModels=['gemma4:e2b-it-qat','gemma4:e2b-nvfp4','llama3.2:3b']] models /api/tags reports as installed.
 * @param {number} [opts.pullDelayMs=0] hold the /api/pull response open this long before completing it -- gives a
 *   cancel-mid-download test a real window to call cancel-pull before the mock would otherwise finish first.
 * @returns {Promise<{ port: number, close: () => Promise<void>, lastChatPrompt: () => string|null, chatCalls: () => number, pullCalls: () => number, remainingQueueLength: () => number, lastPulledModel: () => string|null, deleteCalls: () => number, lastDeletedModel: () => string|null }>}
 */
function startMockOllama(opts = {}) {
  const port = opts.port ?? 0;
  const chatReply = opts.chatReply ?? 'ok';
  const chatReplyQueue = Array.isArray(opts.chatReplyQueue) ? [...opts.chatReplyQueue] : [];
  const chatError = opts.chatError ?? null;
  const installedModels = Array.isArray(opts.installedModels)
    ? opts.installedModels
    : ['gemma4:e2b-it-qat', 'gemma4:e2b-nvfp4', 'llama3.2:3b'];
  const pullDelayMs = opts.pullDelayMs ?? 0;
  let lastChatPrompt = null;
  let chatCalls = 0;
  let pullCalls = 0;
  let lastPulledModel = null;
  let deleteCalls = 0;
  let lastDeletedModel = null;

  return new Promise((resolve, reject) => {
    const server = http.createServer((req, res) => {
      // /api/tags — the summarizer's _ensure_model_available() reads each
      // entry's `model` field (ollama-python maps it there, not `name`); if the
      // configured model isn't found it tries to PULL it, so we must list it
      // under `model` or the pull path 404s and crashes summarisation.
      if (req.method === 'GET' && req.url === '/api/tags') {
        // gemma4:e2b-it-qat is the config default (Config.DEFAULT_MODEL); listed
        // by default so the summarizer finds the configured model installed
        // instead of taking the pull path. llama3.2:3b kept for tests that pin
        // the older model explicitly. Callers can override via opts.installedModels
        // (e.g. [] to force the pull path).
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(
          JSON.stringify({
            models: installedModels.map((name) => ({
              name,
              model: name,
              modified_at: '2024-01-01T00:00:00Z',
              size: 4301000000,
              digest: 'mock',
            })),
          }),
        );
        return;
      }
      // /api/pull — defensive: if the model is ever considered missing, answer
      // a success stream rather than 404 so summarisation doesn't crash.
      if (req.method === 'POST' && req.url === '/api/pull') {
        const chunks = [];
        req.on('data', (c) => chunks.push(c));
        req.on('end', () => {
          pullCalls++;
          let body = {};
          try {
            body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
          } catch { /* ignore */ }
          lastPulledModel = body.name || body.model || null;
          res.writeHead(200, { 'content-type': 'application/x-ndjson' });
          const finish = () => {
            if (res.writableEnded || res.destroyed) return;
            res.end(JSON.stringify({ status: 'success' }) + '\n');
          };
          if (pullDelayMs > 0) {
            const timer = setTimeout(finish, pullDelayMs);
            // If the client (our pull-model subprocess) disconnects early --
            // e.g. it was killed by a cancel-pull -- don't fire the delayed
            // write against an already-closed socket.
            res.on('close', () => clearTimeout(timer));
          } else {
            finish();
          }
        });
        return;
      }
      if (req.method === 'POST' && req.url === '/api/chat') {
        // Capture the prompt so a contract test can assert what was sent (the
        // summarizer sends messages:[{role:'user', content:<prompt+transcript>}]).
        const chunks = [];
        req.on('data', (c) => chunks.push(c));
        req.on('end', () => {
          chatCalls++;
          let body = {};
          try {
            body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
          } catch { /* ignore */ }
          const msgs = Array.isArray(body.messages) ? body.messages : [];
          lastChatPrompt = msgs.length ? String(msgs[msgs.length - 1].content || '') : '';

          // Opt-in failure mode: reply with the configured HTTP error (the real
          // Ollama 404 "model not found" shape) so the summarizer's stream fails
          // and must surface it rather than saving an empty summary.
          if (chatError) {
            res.writeHead(chatError.status, { 'content-type': 'application/json' });
            res.end(JSON.stringify({ error: chatError.message }));
            return;
          }

          // Dequeue reply or fall back to default
          const reply = chatReplyQueue.length > 0 ? chatReplyQueue.shift() : chatReply;

          if (body.stream === false) {
            // Non-streaming (map call): return a single JSON object
            res.writeHead(200, { 'content-type': 'application/json' });
            res.end(JSON.stringify({ message: { role: 'assistant', content: reply }, done: true }));
          } else {
            // Streaming (reduce call / legacy): return NDJSON
            res.writeHead(200, { 'content-type': 'application/x-ndjson' });
            res.write(
              JSON.stringify({ message: { role: 'assistant', content: reply }, done: false }) +
                '\n',
            );
            res.end(
              JSON.stringify({ message: { role: 'assistant', content: '' }, done: true }) + '\n',
            );
          }
        });
        return;
      }
      if (req.method === 'DELETE' && req.url === '/api/delete') {
        const chunks = [];
        req.on('data', (c) => chunks.push(c));
        req.on('end', () => {
          deleteCalls++;
          let body = {};
          try {
            body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
          } catch { /* ignore */ }
          lastDeletedModel = body.model || body.name || null;
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ status: 'success' }));
        });
        return;
      }
      res.writeHead(404, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: 'mock: not found' }));
    });
    // No EADDRINUSE swallow — a bind failure is a real signal (live Ollama up).
    server.on('error', reject);
    server.listen(port, '127.0.0.1', () => {
      const addr = server.address();
      const boundPort = addr && typeof addr === 'object' ? addr.port : port;
      resolve({
        port: boundPort,
        close: () => new Promise((r) => server.close(() => r())),
        lastChatPrompt: () => lastChatPrompt,
        chatCalls: () => chatCalls,
        pullCalls: () => pullCalls,
        remainingQueueLength: () => chatReplyQueue.length,
        lastPulledModel: () => lastPulledModel,
        deleteCalls: () => deleteCalls,
        lastDeletedModel: () => lastDeletedModel,
      });
    });
  });
}

module.exports = { startMockOllama, OLLAMA_PORT };
