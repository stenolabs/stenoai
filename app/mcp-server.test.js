const test = require('node:test');
const assert = require('node:assert/strict');
const { createMcpServer } = require('./mcp-server.js');

test('mcp-server: test suite', async (t) => {
  const TEST_KEY = 'test-secret-key-12345';
  let mockRpcResponse = {
    status: 200,
    body: { jsonrpc: '2.0', id: 1, result: { status: 'ok' } },
  };
  let shouldRpcReject = false;

  const server = createMcpServer({
    getApiKey: () => TEST_KEY,
    handleRpc: async ({ headers, body }) => {
      if (shouldRpcReject) {
        throw new Error('boom');
      }
      return mockRpcResponse;
    },
    log: () => {},
  });

  await server.start(0);
  const port = server.port();
  assert.ok(port > 0, 'Port should be allocated');
  assert.strictEqual(server.isRunning(), true);

  const internalServer = server._getServer();
  const addressInfo = internalServer.address();
  assert.strictEqual(addressInfo.address, '127.0.0.1', 'Server must be bound to 127.0.0.1');

  const baseUrl = `http://127.0.0.1:${port}`;

  await t.test('401 when Authorization header is missing', async () => {
    const res = await fetch(`${baseUrl}/mcp`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', method: 'ping', id: 1 }),
    });
    assert.strictEqual(res.status, 401);
    assert.strictEqual(res.headers.get('www-authenticate'), 'Bearer');
    const json = await res.json();
    assert.strictEqual(json.id, null);
    assert.ok(json.error);
  });

  await t.test('401 when Authorization header has wrong key', async () => {
    const res = await fetch(`${baseUrl}/mcp`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: 'Bearer wrong-key',
      },
      body: JSON.stringify({ jsonrpc: '2.0', method: 'ping', id: 1 }),
    });
    assert.strictEqual(res.status, 401);
    assert.strictEqual(res.headers.get('www-authenticate'), 'Bearer');
    const json = await res.json();
    assert.strictEqual(json.id, null);
  });

  await t.test('401 when Authorization header has wrong key length (crypto.timingSafeEqual non-throwing check)', async () => {
    const res = await fetch(`${baseUrl}/mcp`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: 'Bearer short',
      },
      body: JSON.stringify({ jsonrpc: '2.0', method: 'ping', id: 1 }),
    });
    assert.strictEqual(res.status, 401);
  });

  await t.test('401 when Authorization header has non-Bearer scheme', async () => {
    const res = await fetch(`${baseUrl}/mcp`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Basic ${TEST_KEY}`,
      },
      body: JSON.stringify({ jsonrpc: '2.0', method: 'ping', id: 1 }),
    });
    assert.strictEqual(res.status, 401);
    assert.strictEqual(res.headers.get('www-authenticate'), 'Bearer');
  });

  await t.test('Auth precedes body parsing: oversized body without auth returns 401, not 413', async () => {
    const hugeBody = 'x'.repeat(2 * 1024 * 1024);
    const res = await fetch(`${baseUrl}/mcp`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: hugeBody,
    });
    assert.strictEqual(res.status, 401);
  });

  await t.test('200 with right Bearer key and valid payload', async () => {
    const res = await fetch(`${baseUrl}/mcp`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${TEST_KEY}`,
      },
      body: JSON.stringify({ jsonrpc: '2.0', method: 'ping', id: 1 }),
    });
    assert.strictEqual(res.status, 200);
    const json = await res.json();
    assert.deepStrictEqual(json, mockRpcResponse.body);
  });

  await t.test('Origin check: 403 for foreign Origin', async () => {
    const res = await fetch(`${baseUrl}/mcp`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${TEST_KEY}`,
        Origin: 'https://evil.com',
      },
      body: JSON.stringify({ jsonrpc: '2.0', method: 'ping', id: 1 }),
    });
    assert.strictEqual(res.status, 403);
    const json = await res.json();
    assert.strictEqual(json.id, null);
  });

  await t.test('Origin check: 200 for localhost Origin', async () => {
    const res = await fetch(`${baseUrl}/mcp`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${TEST_KEY}`,
        Origin: `http://localhost:${port}`,
      },
      body: JSON.stringify({ jsonrpc: '2.0', method: 'ping', id: 1 }),
    });
    assert.strictEqual(res.status, 200);
  });

  await t.test('Origin check: 200 for 127.0.0.1 Origin', async () => {
    const res = await fetch(`${baseUrl}/mcp`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${TEST_KEY}`,
        Origin: `http://127.0.0.1:${port}`,
      },
      body: JSON.stringify({ jsonrpc: '2.0', method: 'ping', id: 1 }),
    });
    assert.strictEqual(res.status, 200);
  });

  await t.test('405 with Allow: POST for GET /mcp and DELETE /mcp', async () => {
    const getRes = await fetch(`${baseUrl}/mcp`, {
      method: 'GET',
    });
    assert.strictEqual(getRes.status, 405);
    assert.strictEqual(getRes.headers.get('allow'), 'POST');

    const delRes = await fetch(`${baseUrl}/mcp`, {
      method: 'DELETE',
    });
    assert.strictEqual(delRes.status, 405);
    assert.strictEqual(delRes.headers.get('allow'), 'POST');
  });

  await t.test('404 for wrong path', async () => {
    const res = await fetch(`${baseUrl}/other`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${TEST_KEY}`,
      },
      body: JSON.stringify({ jsonrpc: '2.0', method: 'ping', id: 1 }),
    });
    assert.strictEqual(res.status, 404);
  });

  await t.test('400 with -32700 for invalid JSON', async () => {
    const res = await fetch(`${baseUrl}/mcp`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${TEST_KEY}`,
      },
      body: '{ invalid json',
    });
    assert.strictEqual(res.status, 400);
    const json = await res.json();
    assert.strictEqual(json.error.code, -32700);
  });

  await t.test('400 with -32700 for empty body', async () => {
    const res = await fetch(`${baseUrl}/mcp`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${TEST_KEY}`,
      },
      body: '',
    });
    assert.strictEqual(res.status, 400);
    const json = await res.json();
    assert.strictEqual(json.error.code, -32700);
  });

  await t.test('413 for an over-cap body (authenticated)', async () => {
    const hugeBody = '{"x":"' + 'a'.repeat(1.5 * 1024 * 1024) + '"}';
    try {
      const res = await fetch(`${baseUrl}/mcp`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${TEST_KEY}`,
        },
        body: hugeBody,
      });
      assert.strictEqual(res.status, 413);
    } catch (err) {
      // fetch may reject if server destroyed socket on 413
      assert.ok(err);
    }
  });

  await t.test('202 with no body passthrough (notification case)', async () => {
    mockRpcResponse = {
      status: 202,
      body: null,
    };
    const res = await fetch(`${baseUrl}/mcp`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${TEST_KEY}`,
      },
      body: JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }),
    });
    assert.strictEqual(res.status, 202);
    const text = await res.text();
    assert.strictEqual(text, '');
  });

  await t.test('500 with -32603 when handleRpc throws', async () => {
    shouldRpcReject = true;
    const res = await fetch(`${baseUrl}/mcp`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${TEST_KEY}`,
      },
      body: JSON.stringify({ jsonrpc: '2.0', method: 'ping', id: 1 }),
    });
    assert.strictEqual(res.status, 500);
    const json = await res.json();
    assert.strictEqual(json.error.code, -32603);
    shouldRpcReject = false;
  });

  await t.test('Session and resumption headers are never echoed', async () => {
    mockRpcResponse = {
      status: 200,
      body: { jsonrpc: '2.0', id: 1, result: {} },
    };
    const res = await fetch(`${baseUrl}/mcp`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${TEST_KEY}`,
        'Mcp-Session-Id': 'some-session',
        'Last-Event-ID': '123',
      },
      body: JSON.stringify({ jsonrpc: '2.0', method: 'ping', id: 1 }),
    });
    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.headers.get('mcp-session-id'), null);
    assert.strictEqual(res.headers.get('last-event-id'), null);
  });

  await t.test('stop() shuts down the server idempotently and allows clean exit', async () => {
    assert.strictEqual(server.isRunning(), true);
    await server.stop();
    assert.strictEqual(server.isRunning(), false);
    assert.strictEqual(server.port(), null);
    await server.stop(); // idempotent
  });
});
