import { test, expect } from '../fixtures/electron';
import { readUserConfig, writeMeetingSummary } from '../fixtures/user-config';
import { realUserDataDir, fileSig } from '../fixtures/real-user-data';

type MCPStatus = {
  success: boolean;
  enabled: boolean;
  port: number;
  running: boolean;
  keySet: boolean;
  endpoint: string;
};

type MCPKey = {
  success: boolean;
  key?: string;
};

type StenoWindow = Window & {
  stenoai: {
    mcp: {
      getStatus: () => Promise<MCPStatus>;
      getKey: () => Promise<MCPKey>;
      setEnabled: (enabled: boolean) => Promise<{ success: boolean; error?: string }>;
    };
  };
};

type McpHttpResponse = {
  status: number;
  text: string;
  json: Record<string, unknown> | null;
};

type RpcError = {
  code: number;
  message?: string;
  data?: unknown;
};

const MODERN_VERSION = '2026-07-28';
const ALL_TOOL_NAMES = [
  'ask_meetings',
  'get_meeting',
  'get_meeting_transcript',
  'list_folders',
  'list_meetings',
  'search_meetings',
];

function rpcMeta(version: string): Record<string, unknown> {
  return {
    _meta: {
      'io.modelcontextprotocol/protocolVersion': version,
    },
  };
}

function stripJson(bodyText: string): Record<string, unknown> | null {
  const text = bodyText.trim();
  if (!text) return null;
  return JSON.parse(text) as Record<string, unknown>;
}

function rpcErrorCode(body: Record<string, unknown> | null): number | undefined {
  const err = body?.error as RpcError | undefined;
  return err?.code;
}

function rpcErrorData(body: Record<string, unknown> | null): unknown {
  const err = body?.error as RpcError | undefined;
  return err?.data;
}

function extractText(result: Record<string, unknown> | null | undefined): string {
  const content = (result as { content?: unknown })?.content;
  if (!Array.isArray(content)) return '';

  return content
    .map((entry) =>
      typeof entry === 'object' && entry !== null && 'text' in entry
        ? String((entry as { text?: unknown }).text ?? '')
        : '',
    )
    .join('\n');
}

async function postMcpRequest(
  endpoint: string,
  init: {
    key?: string;
    protocolVersion: string;
    mcpMethod: string;
    bodyMethod: string;
    params?: Record<string, unknown>;
    name?: string;
    includeId?: boolean;
    origin?: string;
  },
): Promise<McpHttpResponse> {
  const requestBody = {
    jsonrpc: '2.0',
    method: init.bodyMethod,
    ...(init.includeId === false ? {} : { id: 1 }),
    params: {
      ...(init.params ?? {}),
      ...rpcMeta(init.protocolVersion),
    },
  };

  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    'MCP-Protocol-Version': init.protocolVersion,
    'Mcp-Method': init.mcpMethod,
  };
  if (init.key) {
    headers.Authorization = `Bearer ${init.key}`;
  }
  if (init.name) {
    headers['Mcp-Name'] = init.name;
  }
  if (init.origin) {
    headers.Origin = init.origin;
  }

  const response = await fetch(endpoint, {
    method: 'POST',
    headers,
    body: JSON.stringify(requestBody),
  });

  const responseText = await response.text();
  const responseBody = stripJson(responseText);

  return {
    status: response.status,
    text: responseText,
    json: responseBody,
  };
}

test('local MCP HTTP server works from external client context and enforces security gates', async ({
  launchApp,
  userDataDir,
}) => {
  const realDirBefore = fileSig(realUserDataDir());

  const firstMeeting = 'MCP Seed Alpha';
  const secondMeeting = 'MCP Seed Beta';

  // Seed two notes before launch so the MCP tools have deterministic fixtures.
  writeMeetingSummary(userDataDir, 'mcp-alpha', {
    name: firstMeeting,
    transcript: 'First seeded transcript for MCP endpoint assertions.',
  });
  writeMeetingSummary(userDataDir, 'mcp-beta', {
    name: secondMeeting,
    transcript: 'Second seeded transcript for MCP endpoint assertions.',
  });

  const { page } = await launchApp();

  const enableResult = await page.evaluate(
    () => (window as unknown as StenoWindow).stenoai.mcp.setEnabled(true),
  );
  if (!enableResult.success) {
    // eslint-disable-next-line no-console
    console.warn(
      '[t2] SKIPPED mcp-server: MCP could not be enabled (likely safeStorage-related).',
    );
    test.info().annotations.push({
      type: 'skip-reason',
      description: 'safeStorage unavailable; MCP cannot be enabled on this runner',
    });
    test.skip(true, 'safeStorage unavailable on this runner');
  }

  const statusAfterEnable = await page.evaluate(
    () => (window as unknown as StenoWindow).stenoai.mcp.getStatus(),
  );
  expect(statusAfterEnable.success).toBe(true);
  expect(statusAfterEnable.enabled).toBe(true);
  expect(statusAfterEnable.running).toBe(true);
  expect(statusAfterEnable.keySet).toBe(true);
  expect(typeof statusAfterEnable.port).toBe('number');

  await expect.poll(() => readUserConfig(userDataDir).mcp_enabled).toBe(true);

  const keyResult = await page.evaluate(() => (window as unknown as StenoWindow).stenoai.mcp.getKey());
  if (!keyResult.success || !keyResult.key) {
    // eslint-disable-next-line no-console
    console.warn(
      '[t2] SKIPPED mcp-server: safeStorage unavailable; MCP key cannot be returned.',
    );
    test.info().annotations.push({
      type: 'skip-reason',
      description: 'safeStorage unavailable; getKey cannot return MCP key',
    });
    test.skip(true, 'safeStorage unavailable on this runner');
  }

  const apiKey = keyResult.key!;
  const endpoint = `http://127.0.0.1:${statusAfterEnable.port}/mcp`;

  // 1) No Authorization header -> 401.
  const noAuth = await postMcpRequest(endpoint, {
    protocolVersion: MODERN_VERSION,
    mcpMethod: 'ping',
    bodyMethod: 'ping',
    params: {},
  });
  expect(noAuth.status).toBe(401);

  // 2) Wrong bearer key -> 401.
  const wrongAuth = await postMcpRequest(endpoint, {
    key: 'wrong-key',
    protocolVersion: MODERN_VERSION,
    mcpMethod: 'ping',
    bodyMethod: 'ping',
    params: {},
  });
  expect(wrongAuth.status).toBe(401);

  // 3) GET /mcp and DELETE /mcp -> 405.
  const getRes = await fetch(endpoint, { method: 'GET' });
  expect(getRes.status).toBe(405);
  const deleteRes = await fetch(endpoint, { method: 'DELETE' });
  expect(deleteRes.status).toBe(405);

  // 4) Foreign Origin with valid key -> 403.
  const foreignOrigin = await postMcpRequest(endpoint, {
    key: apiKey,
    protocolVersion: MODERN_VERSION,
    mcpMethod: 'tools/list',
    bodyMethod: 'tools/list',
    params: {},
    origin: 'https://evil.example',
  });
  expect(foreignOrigin.status).toBe(403);

  // 5) Modern discover call.
  const discover = await postMcpRequest(endpoint, {
    key: apiKey,
    protocolVersion: MODERN_VERSION,
    mcpMethod: 'server/discover',
    bodyMethod: 'server/discover',
    params: {},
  });
  expect(discover.status).toBe(200);
  expect(discover.json).not.toBeNull();
  expect((discover.json as { result?: { resultType?: string } }).result?.resultType).toBe('complete');
  expect((discover.json as { result?: { supportedVersions?: unknown[] } }).result?.supportedVersions).toContain(
    MODERN_VERSION,
  );
  expect(
    (discover.json as {
      result?: {
        _meta?: { 'io.modelcontextprotocol/serverInfo'?: { name?: string } };
      };
    }).result?._meta?.['io.modelcontextprotocol/serverInfo']?.name,
  ).toBeTruthy();

  // 6) tools/list exposes all six defined tool names.
  const listTools = await postMcpRequest(endpoint, {
    key: apiKey,
    protocolVersion: MODERN_VERSION,
    mcpMethod: 'tools/list',
    bodyMethod: 'tools/list',
    params: {},
  });
  expect(listTools.status).toBe(200);
  const listed = listTools.json?.result?.tools as Array<{ name?: string }> | undefined;
  const names = Array.isArray(listed) ? listed.map((tool) => tool?.name).filter(Boolean) : [];
  expect(names.sort()).toEqual([...ALL_TOOL_NAMES].sort());

  // 7) tools/call list_meetings includes the seeded meeting names.
  const listMeetings = await postMcpRequest(endpoint, {
    key: apiKey,
    protocolVersion: MODERN_VERSION,
    mcpMethod: 'tools/call',
    bodyMethod: 'tools/call',
    name: 'list_meetings',
    params: {
      name: 'list_meetings',
      arguments: {},
    },
  });
  expect(listMeetings.status).toBe(200);
  expect(listMeetings.json).not.toBeNull();
  expect(listMeetings.json?.result?.isError).toBeFalsy();
  const listedText = extractText(listMeetings.json?.result as Record<string, unknown> | undefined);
  const structured = JSON.stringify(listMeetings.json?.result?.structuredContent ?? {});
  expect(listedText.includes(firstMeeting) || structured.includes(firstMeeting)).toBe(true);
  expect(listedText.includes(secondMeeting) || structured.includes(secondMeeting)).toBe(true);

  // 8) Header/body mismatch.
  const mismatch = await postMcpRequest(endpoint, {
    key: apiKey,
    protocolVersion: MODERN_VERSION,
    mcpMethod: 'tools/list',
    bodyMethod: 'tools/call',
    name: 'list_meetings',
    params: {
      name: 'list_meetings',
      arguments: {},
    },
  });
  expect(mismatch.status).toBe(400);
  expect(rpcErrorCode(mismatch.json)).toBe(-32020);

  // 9) Unsupported protocol version.
  const unsupported = await postMcpRequest(endpoint, {
    key: apiKey,
    protocolVersion: '2023-01-01',
    mcpMethod: 'tools/list',
    bodyMethod: 'tools/list',
    params: {},
  });
  expect(unsupported.status).toBe(400);
  expect(rpcErrorCode(unsupported.json)).toBe(-32022);
  const unsupportedData = rpcErrorData(unsupported.json);
  expect(Array.isArray((unsupportedData as { supported?: unknown })?.supported)).toBe(true);

  // 10) Unknown method.
  const unknownMethod = await postMcpRequest(endpoint, {
    key: apiKey,
    protocolVersion: MODERN_VERSION,
    mcpMethod: 'does/not-exist',
    bodyMethod: 'does/not-exist',
    params: {},
  });
  expect(unknownMethod.status).toBe(404);
  expect(rpcErrorCode(unknownMethod.json)).toBe(-32601);

  // 11) Notification body -> 202 with empty body.
  const notification = await postMcpRequest(endpoint, {
    key: apiKey,
    protocolVersion: MODERN_VERSION,
    mcpMethod: 'tools/call',
    bodyMethod: 'tools/call',
    includeId: false,
    name: 'list_meetings',
    params: {
      name: 'list_meetings',
      arguments: {},
    },
  });
  expect(notification.status).toBe(202);
  expect(notification.text).toBe('');
  expect(notification.json).toBeNull();

  // 12) Stop path closes the listener.
  const disableResult = await page.evaluate(() =>
    (window as unknown as StenoWindow).stenoai.mcp.setEnabled(false),
  );
  expect(disableResult.success).toBe(true);

  const statusAfterDisable = await page.evaluate(() =>
    (window as unknown as StenoWindow).stenoai.mcp.getStatus(),
  );
  expect(statusAfterDisable.running).toBe(false);
  await expect.poll(() => readUserConfig(userDataDir).mcp_enabled).toBe(false);

  // After disable the listener must be GONE: a connect attempt has to fail at
  // the transport, not answer with any status. Asserting on rejection only —
  // a reachable port means the stop path regressed, whatever it replies.
  let stopAttemptRejected = false;
  let stopAttemptStatus: number | null = null;
  try {
    const response = await fetch(endpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'MCP-Protocol-Version': MODERN_VERSION,
        'Mcp-Method': 'tools/list',
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        method: 'tools/list',
        params: rpcMeta(MODERN_VERSION),
        id: 1,
      }),
    });
    stopAttemptStatus = response.status;
    await response.text();
  } catch {
    stopAttemptRejected = true;
  }
  expect(
    stopAttemptRejected,
    `port ${statusAfterEnable.port} still answered with ${stopAttemptStatus} after disable`,
  ).toBe(true);

  // 13) Keystone proof: config in TEMP dir shows true then false; real dir untouched.
  expect(fileSig(realUserDataDir())).toBe(realDirBefore);
  const configAtShutdown = readUserConfig(userDataDir);
  expect(configAtShutdown.mcp_enabled).toBe(false);
  expect(statusAfterDisable.enabled).toBe(false);
});