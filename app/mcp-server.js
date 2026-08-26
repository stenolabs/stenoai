const http = require('node:http');
const crypto = require('node:crypto');

const MAX_BODY_BYTES = 1024 * 1024; // 1 MiB

function isValidOrigin(originHeader) {
  if (!originHeader) return true;
  try {
    const parsed = new URL(originHeader);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      return false;
    }
    const hostname = parsed.hostname;
    return hostname === '127.0.0.1' || hostname === 'localhost';
  } catch {
    return false;
  }
}

function safeCompareStrings(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') {
    return false;
  }
  const hashA = crypto.createHash('sha256').update(a, 'utf8').digest();
  const hashB = crypto.createHash('sha256').update(b, 'utf8').digest();
  return crypto.timingSafeEqual(hashA, hashB);
}

function sendJson(res, statusCode, bodyObj, headers = {}) {
  const payload = bodyObj !== null && bodyObj !== undefined ? JSON.stringify(bodyObj) : null;
  const responseHeaders = {
    ...headers,
  };
  if (payload !== null) {
    responseHeaders['Content-Type'] = 'application/json';
    responseHeaders['Content-Length'] = Buffer.byteLength(payload);
  } else {
    responseHeaders['Content-Length'] = '0';
  }
  res.writeHead(statusCode, responseHeaders);
  if (payload !== null) {
    res.end(payload);
  } else {
    res.end();
  }
}

function createMcpServer({ handleRpc, getApiKey, log } = {}) {
  let server = null;
  let activeSockets = new Set();
  let currentPort = null;
  let running = false;

  const logger = typeof log === 'function' ? log : () => {};

  async function requestListener(req, res) {
    // 1. Route check: path must be /mcp (ignoring query string)
    let pathname = '';
    try {
      const parsedUrl = new URL(req.url, `http://${req.headers.host || '127.0.0.1'}`);
      pathname = parsedUrl.pathname;
    } catch {
      pathname = (req.url || '').split('?')[0];
    }

    if (pathname !== '/mcp') {
      return sendJson(res, 404, {
        jsonrpc: '2.0',
        id: null,
        error: {
          code: -32601,
          message: 'Not Found',
        },
      });
    }

    // 2. Method check
    const method = (req.method || '').toUpperCase();
    if (method === 'GET' || method === 'DELETE') {
      return sendJson(
        res,
        405,
        {
          jsonrpc: '2.0',
          id: null,
          error: {
            code: -32601,
            message: 'Method Not Allowed',
          },
        },
        { Allow: 'POST' }
      );
    }

    if (method !== 'POST') {
      return sendJson(
        res,
        405,
        {
          jsonrpc: '2.0',
          id: null,
          error: {
            code: -32601,
            message: 'Method Not Allowed',
          },
        },
        { Allow: 'POST' }
      );
    }

    // 3. Origin check
    const origin = req.headers['origin'];
    if (origin && !isValidOrigin(origin)) {
      return sendJson(res, 403, {
        jsonrpc: '2.0',
        id: null,
        error: {
          code: -32000,
          message: 'Forbidden: Invalid Origin',
        },
      });
    }

    // 4. Auth check (checked BEFORE reading/parsing the body)
    const expectedKey = typeof getApiKey === 'function' ? getApiKey() : null;
    const authHeader = req.headers['authorization'];
    let authenticated = false;

    if (expectedKey && typeof expectedKey === 'string' && authHeader && typeof authHeader === 'string') {
      const match = authHeader.match(/^Bearer\s+(.+)$/i);
      if (match) {
        const providedKey = match[1];
        if (safeCompareStrings(providedKey, expectedKey)) {
          authenticated = true;
        }
      }
    }

    if (!authenticated) {
      return sendJson(
        res,
        401,
        {
          jsonrpc: '2.0',
          id: null,
          error: {
            code: -32000,
            message: 'Unauthorized',
          },
        },
        { 'WWW-Authenticate': 'Bearer' }
      );
    }

    // 5. Body read with 1 MiB limit
    let rawBody = '';
    let totalBytes = 0;
    let destroyed = false;

    try {
      await new Promise((resolve, reject) => {
        req.on('data', (chunk) => {
          if (destroyed) return;
          totalBytes += chunk.length;
          if (totalBytes > MAX_BODY_BYTES) {
            destroyed = true;
            sendJson(res, 413, {
              jsonrpc: '2.0',
              id: null,
              error: {
                code: -32000,
                message: 'Payload Too Large',
              },
            });
            req.destroy();
            return reject(new Error('PAYLOAD_TOO_LARGE'));
          }
          rawBody += chunk.toString('utf8');
        });

        req.on('end', () => {
          if (!destroyed) {
            resolve();
          }
        });

        req.on('error', (err) => {
          if (!destroyed) {
            reject(err);
          }
        });
      });
    } catch (err) {
      if (err.message === 'PAYLOAD_TOO_LARGE') {
        return; // Handled above
      }
      return sendJson(res, 400, {
        jsonrpc: '2.0',
        id: null,
        error: {
          code: -32700,
          message: 'Parse error',
        },
      });
    }

    // Parse JSON
    if (!rawBody || rawBody.trim().length === 0) {
      return sendJson(res, 400, {
        jsonrpc: '2.0',
        id: null,
        error: {
          code: -32700,
          message: 'Parse error: empty body',
        },
      });
    }

    let parsedBody;
    try {
      parsedBody = JSON.parse(rawBody);
    } catch {
      return sendJson(res, 400, {
        jsonrpc: '2.0',
        id: null,
        error: {
          code: -32700,
          message: 'Parse error',
        },
      });
    }

    // 6. Dispatch to handleRpc
    // Build lower-cased header object
    const headers = {};
    for (const [k, v] of Object.entries(req.headers)) {
      headers[k.toLowerCase()] = v;
    }

    try {
      const rpcResult = await handleRpc({ headers, body: parsedBody });
      const status = rpcResult && typeof rpcResult.status === 'number' ? rpcResult.status : 200;
      const responseBody = rpcResult ? rpcResult.body : null;

      if (responseBody === null || responseBody === undefined) {
        return sendJson(res, status, null);
      } else {
        return sendJson(res, status, responseBody);
      }
    } catch (err) {
      logger({ event: 'handle_rpc_error' });
      return sendJson(res, 500, {
        jsonrpc: '2.0',
        id: null,
        error: {
          code: -32603,
          message: 'Internal error',
        },
      });
    }
  }

  async function start(port) {
    if (running && server) {
      return;
    }

    return new Promise((resolve, reject) => {
      const s = http.createServer(requestListener);

      s.on('connection', (socket) => {
        activeSockets.add(socket);
        socket.on('close', () => {
          activeSockets.delete(socket);
        });
      });

      s.on('error', (err) => {
        reject(err);
      });

      s.listen(port, '127.0.0.1', () => {
        server = s;
        running = true;
        const addr = server.address();
        currentPort = typeof addr === 'object' && addr !== null ? addr.port : port;
        resolve();
      });
    });
  }

  async function stop() {
    if (!server) {
      running = false;
      return;
    }

    for (const socket of activeSockets) {
      try {
        socket.destroy();
      } catch {
        // ignore
      }
    }
    activeSockets.clear();

    return new Promise((resolve) => {
      const s = server;
      server = null;
      running = false;
      currentPort = null;
      s.close(() => {
        resolve();
      });
    });
  }

  function port() {
    return currentPort;
  }

  function isRunning() {
    return running;
  }

  return {
    start,
    stop,
    port,
    isRunning,
    _getServer: () => server,
  };
}

module.exports = {
  createMcpServer,
};
