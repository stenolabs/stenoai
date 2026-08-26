const assert = require('node:assert/strict');
const test = require('node:test');

const {
  SUPPORTED_VERSIONS,
  MODERN_VERSION,
  decodeHeaderValue,
  handleRpc,
} = require('./mcp-protocol.js');

function modernHeaders(extra = {}) {
  return {
    'mcp-protocol-version': MODERN_VERSION,
    'mcp-method': 'ping',
    ...extra,
  };
}

function assertNoError(body) {
  assert.ok(body);
  assert.strictEqual(body.jsonrpc, '2.0');
  assert.strictEqual(body.error, undefined);
}

function makeBody(method, overrides = {}) {
  return {
    jsonrpc: '2.0',
    method,
    id: 1,
    ...overrides,
  };
}

test('decodeHeaderValue handles base64-sentinels and rejects invalid values', async () => {
  assert.strictEqual(decodeHeaderValue('foo'), 'foo');
  assert.strictEqual(decodeHeaderValue('= ?'), '= ?');
  assert.strictEqual(decodeHeaderValue('=?base64?aGVsbG8=?='), 'hello');
  assert.throws(
    () => decodeHeaderValue('=?base64?a?='),
    (err) => err instanceof Error && /Invalid MCP base64 header value/.test(err.message)
  );
});

test('mcp handleRpc modern+legacy protocol semantics', async (t) => {
  const tools = [{ name: 'list_meetings' }, { name: 'get_meeting' }];

  await t.test('modern tools/list round-trip', async () => {
    const result = await handleRpc({
      headers: modernHeaders({
        'mcp-method': 'tools/list',
      }),
      body: makeBody('tools/list'),
      tools,
      callTool: async () => ({ content: [{ type: 'text', text: 'unused' }] }),
      serverInfo: { name: 'steno-mcp', version: '0.1.0' },
    });

    assert.strictEqual(result.status, 200);
    assertNoError(result.body);
    assert.strictEqual(result.body.result.resultType, 'complete');
    assert.deepStrictEqual(result.body.result.tools, tools);
  });

  await t.test('modern tools/call accepts Base64-sentinel Mcp-Name with non-ASCII name', async () => {
    const toolName = '會議清單';
    const encoded = `=?base64?${Buffer.from(toolName, 'utf8').toString('base64')}?=`;
    const captured = {};

    const result = await handleRpc({
      headers: modernHeaders({
        'mcp-method': 'tools/call',
        'mcp-name': encoded,
      }),
      body: {
        jsonrpc: '2.0',
        id: 11,
        method: 'tools/call',
        params: {
          name: toolName,
          arguments: { query: 'notes' },
        },
      },
      tools: [{ name: toolName }],
      callTool: async (name, args) => {
        captured.name = name;
        captured.args = args;
        return {
          content: [{ type: 'text', text: 'ok' }],
          structuredContent: { query: args.query },
        };
      },
      serverInfo: { name: 'steno-mcp', version: '0.1.0' },
    });

    assert.strictEqual(result.status, 200);
    assertNoError(result.body);
    assert.strictEqual(result.body.result.content[0].text, 'ok');
    assert.deepStrictEqual(result.body.result.structuredContent, { query: 'notes' });
    assert.strictEqual(captured.name, toolName);
    assert.deepStrictEqual(captured.args, { query: 'notes' });
  });

  await t.test('modern missing Mcp-Method -> 400 HeaderMismatch', async () => {
    const result = await handleRpc({
      headers: {
        'mcp-protocol-version': MODERN_VERSION,
      },
      body: makeBody('ping'),
      tools,
      callTool: async () => ({ content: [] }),
    });

    assert.strictEqual(result.status, 400);
    assert.strictEqual(result.body.error.code, -32020);
    assert.match(result.body.error.message, /Mcp-Method/);
  });

  await t.test('modern mismatched Mcp-Method -> 400 HeaderMismatch', async () => {
    const result = await handleRpc({
      headers: modernHeaders({
        'mcp-method': 'ping/other',
      }),
      body: makeBody('ping'),
      tools,
      callTool: async () => ({ content: [] }),
    });

    assert.strictEqual(result.status, 400);
    assert.strictEqual(result.body.error.code, -32020);
    assert.match(result.body.error.message, /Mcp-Method/);
  });

  await t.test('modern mismatched Mcp-Name -> 400 HeaderMismatch', async () => {
    const toolName = 'list_meetings';
    const result = await handleRpc({
      headers: modernHeaders({
        'mcp-method': 'tools/call',
        'mcp-name': 'other',
      }),
      body: makeBody('tools/call', { params: { name: toolName, arguments: {} } }),
      tools: [{ name: toolName }],
      callTool: async () => ({ content: [] }),
    });

    assert.strictEqual(result.status, 400);
    assert.strictEqual(result.body.error.code, -32020);
    assert.match(result.body.error.message, /Mcp-Name/);
  });

  await t.test('modern _meta / header version disagreement -> 400 HeaderMismatch', async () => {
    const result = await handleRpc({
      headers: modernHeaders({
        'mcp-method': 'ping',
      }),
      body: {
        ...makeBody('ping'),
        params: {
          _meta: {
            'io.modelcontextprotocol/protocolVersion': '2025-03-26',
          },
        },
      },
      tools,
      callTool: async () => ({ content: [] }),
    });

    assert.strictEqual(result.status, 400);
    assert.strictEqual(result.body.error.code, -32020);
  });

  await t.test('modern unsupported protocol version -> 400 with supported versions', async () => {
    const result = await handleRpc({
      headers: {
        'mcp-protocol-version': '2000-01-01',
        'mcp-method': 'ping',
      },
      body: makeBody('ping'),
      tools,
      callTool: async () => ({ content: [] }),
    });

    assert.strictEqual(result.status, 400);
    assert.strictEqual(result.body.error.code, -32022);
    assert.deepStrictEqual(result.body.error.data.supported, SUPPORTED_VERSIONS);
    assert.strictEqual(result.body.error.data.requested, '2000-01-01');
  });

  await t.test('modern unknown method -> 404 with -32601', async () => {
    const result = await handleRpc({
      headers: modernHeaders({
        'mcp-method': 'does-not-exist',
      }),
      body: makeBody('does-not-exist'),
      tools,
      callTool: async () => ({ content: [] }),
    });

    assert.strictEqual(result.status, 404);
    assert.strictEqual(result.body.error.code, -32601);
  });

  await t.test('modern notification -> 202 with null body', async () => {
    const result = await handleRpc({
      headers: modernHeaders({
        'mcp-method': 'notifications/initialized',
      }),
      body: {
        jsonrpc: '2.0',
        method: 'notifications/initialized',
      },
      tools,
      callTool: async () => ({ content: [] }),
    });

    assert.strictEqual(result.status, 202);
    assert.strictEqual(result.body, null);
  });
  await t.test('server/discover returns supportedVersions + serverInfo', async () => {
    const serverInfo = { name: 'steno-mcp', version: '9.9.9' };
    const result = await handleRpc({
      headers: modernHeaders({
        'mcp-method': 'server/discover',
      }),
      body: makeBody('server/discover'),
      tools,
      callTool: async () => ({ content: [] }),
      serverInfo,
    });
    assert.strictEqual(result.status, 200);
    assert.deepStrictEqual(result.body.result.supportedVersions, SUPPORTED_VERSIONS);
    assert.deepStrictEqual(result.body.result._meta['io.modelcontextprotocol/serverInfo'], serverInfo);
    assert.deepStrictEqual(result.body.result.capabilities, { tools: {} });
    assert.strictEqual(result.body.result.resultType, 'complete');
  });

  await t.test('legacy initialize handshake uses no protocol headers', async () => {
    const result = await handleRpc({
      headers: {},
      body: {
        jsonrpc: '2.0',
        id: 55,
        method: 'initialize',
        params: { protocolVersion: '2025-03-26' },
      },
      serverInfo: { name: 'steno-mcp', version: 'legacy' },
      tools,
      callTool: async () => ({ content: [] }),
    });

    assert.strictEqual(result.status, 200);
    assert.strictEqual(result.body.result.protocolVersion, '2025-03-26');
    assert.deepStrictEqual(result.body.result.capabilities, { tools: {} });
    assert.deepStrictEqual(result.body.result.serverInfo, { name: 'steno-mcp', version: 'legacy' });
    assert.strictEqual(result.body.result.resultType, undefined);
    assert.strictEqual(Object.prototype.hasOwnProperty.call(result.body.result, 'sessionId'), false);
  });

  await t.test('modern resultType appears for modern era and is absent for legacy', async () => {
    const modernResult = await handleRpc({
      headers: modernHeaders({
        'mcp-method': 'ping',
      }),
      body: makeBody('ping'),
      callTool: async () => ({ content: [] }),
      tools,
    });

    const legacyResult = await handleRpc({
      headers: {},
      body: {
        jsonrpc: '2.0',
        id: 3,
        method: 'initialize',
        params: { protocolVersion: MODERN_VERSION },
      },
      callTool: async () => ({ content: [] }),
      tools,
    });

    assert.strictEqual(modernResult.body.result.resultType, 'complete');
    assert.strictEqual('resultType' in legacyResult.body.result, false);
  });

  await t.test('tools/call with throwing handler returns isError in result', async () => {
    const result = await handleRpc({
      headers: modernHeaders({
        'mcp-method': 'tools/call',
        'mcp-name': 'list_meetings',
      }),
      body: makeBody('tools/call', {
        params: {
          name: 'list_meetings',
          arguments: {},
        },
      }),
      tools: [{ name: 'list_meetings' }],
      callTool: async () => {
        throw new Error('secret token: abc');
      },
    });

    assert.strictEqual(result.status, 200);
    assertNoError(result.body);
    assert.strictEqual(result.body.result.isError, true);
    assert.ok(!result.body.result.content[0].text.includes('secret token'));
  });

  await t.test('tools/call unknown tool returns result.isError (not JSON-RPC error)', async () => {
    const result = await handleRpc({
      headers: modernHeaders({
        'mcp-method': 'tools/call',
        'mcp-name': 'nope',
      }),
      body: makeBody('tools/call', {
        params: {
          name: 'nope',
          arguments: {},
        },
      }),
      tools: [{ name: 'list_meetings' }],
      callTool: async () => ({ content: [] }),
    });

    assert.strictEqual(result.status, 200);
    assertNoError(result.body);
    assert.strictEqual(result.body.result.isError, true);
  });

  await t.test('non-object body ([], 42, null) -> 400 with -32600 Invalid Request', async () => {
    const testBodies = [[], 42, null, 'string', true];
    for (const testBody of testBodies) {
      // Without MCP-Protocol-Version header (legacy)
      const legacyRes = await handleRpc({
        headers: {},
        body: testBody,
        tools,
        callTool: async () => ({ content: [] }),
      });
      assert.strictEqual(legacyRes.status, 400);
      assert.strictEqual(legacyRes.body.error.code, -32600);
      assert.strictEqual(legacyRes.body.error.message, 'Invalid Request');
      assert.strictEqual(legacyRes.body.id, null);

      // With MCP-Protocol-Version header (modern)
      const modernRes = await handleRpc({
        headers: modernHeaders({ 'mcp-method': 'ping' }),
        body: testBody,
        tools,
        callTool: async () => ({ content: [] }),
      });
      assert.strictEqual(modernRes.status, 400);
      assert.strictEqual(modernRes.body.error.code, -32600);
      assert.strictEqual(modernRes.body.error.message, 'Invalid Request');
      assert.strictEqual(modernRes.body.id, null);
    }
  });
});
