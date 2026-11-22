'use strict';

/**
 * The OAuth redirect listener for MCP connections: an HTTP server on
 * 127.0.0.1 (never 0.0.0.0, never "localhost", which can resolve elsewhere)
 * that waits for /callback?code=...&state=..., the same pattern as the Google
 * Calendar and Outlook sign-ins in main.js.
 *
 * It listens on `preferredPort` when given (so a cached Dynamic Client
 * Registration, which recorded an exact redirect URI, stays valid) and falls
 * back to an ephemeral port. A wrong `state` is answered and ignored, not
 * treated as the end of the flow, so a stray or forged request cannot cancel
 * a real sign-in.
 */

const http = require('node:http');

const DEFAULT_TIMEOUT_MS = 5 * 60 * 1000;

const page = (title, body) =>
  `<!doctype html><html><head><meta charset="utf-8"><title>${title}</title></head>` +
  `<body style="font-family:-apple-system,system-ui,sans-serif;background:#FAF9F5;color:#1B1B19;text-align:center;padding:60px">` +
  `<h2>${title}</h2><p>${body}</p></body></html>`;

function listen(server, port) {
  return new Promise((resolve, reject) => {
    const onError = (e) => {
      server.removeListener('listening', onListening);
      reject(e);
    };
    const onListening = () => {
      server.removeListener('error', onError);
      resolve(server.address().port);
    };
    server.once('error', onError);
    server.once('listening', onListening);
    server.listen(port, '127.0.0.1');
  });
}

/**
 * Start the listener. Resolves { redirectUri, port, result, close } where
 * `result` resolves { code } or rejects (denied, timeout, closed).
 */
async function startLoopback({ state, preferredPort = 0, timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
  if (!state) throw new Error('state is required');
  let settle;
  const result = new Promise((resolve, reject) => {
    settle = { resolve, reject };
  });
  result.catch(() => {});
  let done = false;
  const finish = (fn, value) => {
    if (done) return;
    done = true;
    clearTimeout(timer);
    try { server.close(); } catch (_) {}
    // A browser (or fetch) keeps the connection alive; drop it so a later
    // sign-in on the same port cannot be answered by this finished listener.
    setImmediate(() => { try { server.closeAllConnections(); } catch (_) {} });
    fn(value);
  };

  const server = http.createServer((req, res) => {
    res.setHeader('connection', 'close');
    res.setHeader('cache-control', 'no-store');
    let url;
    try {
      url = new URL(req.url, 'http://127.0.0.1');
    } catch {
      res.writeHead(400);
      res.end();
      return;
    }
    if (url.pathname !== '/callback') {
      res.writeHead(404);
      res.end();
      return;
    }
    if (url.searchParams.get('state') !== state) {
      res.writeHead(400, { 'content-type': 'text/html; charset=utf-8' });
      res.end(page('Invalid sign-in link', 'Return to Steno and try connecting again.'));
      return;
    }
    const error = url.searchParams.get('error');
    if (error) {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end(page('Not connected', 'You can close this tab and return to Steno.'));
      const err = new Error('Authorization was denied');
      err.code = error === 'access_denied' ? 'denied' : 'authorize-failed';
      // The provider's own error and description stay in the main process
      // (mcp-actions maps them to a code and logs them redacted); the
      // renderer never sees raw provider text.
      err.providerError = error.slice(0, 64);
      err.providerDescription = (url.searchParams.get('error_description') || '').slice(0, 500);
      finish(settle.reject, err);
      return;
    }
    const code = url.searchParams.get('code');
    if (!code) {
      res.writeHead(400, { 'content-type': 'text/html; charset=utf-8' });
      res.end(page('Missing authorization code', 'Return to Steno and try again.'));
      // A callback with the right state but neither a code nor an error is
      // a finished flow that produced nothing; fail now, not at the timeout.
      const err = new Error('Sign-in ended without an authorization code');
      err.code = 'no-code';
      finish(settle.reject, err);
      return;
    }
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(page('Connected', 'You can close this tab and return to Steno.'));
    finish(settle.resolve, { code });
  });

  let port;
  try {
    port = await listen(server, preferredPort);
  } catch (e) {
    if (!preferredPort) throw e;
    port = await listen(server, 0);
  }
  const timer = setTimeout(() => {
    const err = new Error('Timed out waiting for sign-in');
    err.code = 'timeout';
    finish(settle.reject, err);
  }, timeoutMs);
  timer.unref?.();

  return {
    port,
    redirectUri: `http://127.0.0.1:${port}/callback`,
    result,
    close: () => {
      const err = new Error('Cancelled');
      err.code = 'cancelled';
      finish(settle.reject, err);
    },
  };
}

module.exports = { startLoopback };
