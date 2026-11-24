'use strict';

/**
 * Streamable HTTP MCP client for remote action endpoints (n8n, Zapier, Make,
 * Linear, Notion, Atlassian, any MCP URL). The remote sibling of
 * imcp-client.js, on the same @modelcontextprotocol/client SDK.
 *
 * Connections are short-lived: one per tools/list refresh or approved tool
 * call, then closed. There is no long-running session to keep alive or leak,
 * and every call re-reads the current credential, so a disconnect or a token
 * rotation takes effect immediately.
 *
 * Auth is supplied by the caller as an SDK AuthProvider:
 *   { token(): Promise<string|undefined>, onUnauthorized?(): Promise<void> }
 * plus optional static headers (a custom header token). The transport
 * retries once after onUnauthorized and then throws UnauthorizedError.
 */

const TOOLS_PAGE_LIMIT = 10;
const MAX_TOOLS = 200;
const CONNECT_TIMEOUT_MS = 20 * 1000;
const CALL_TIMEOUT_MS = 60 * 1000;

function defaultCreateClient(clientInfo) {
  const { Client } = require('@modelcontextprotocol/client');
  return new Client(clientInfo, { capabilities: {} });
}

function defaultCreateTransport(url, options) {
  const { StreamableHTTPClientTransport } = require('@modelcontextprotocol/client');
  return new StreamableHTTPClientTransport(new URL(url), options);
}

/** The useful part of a tools/list entry, bounded. */
function toolSummary(tool) {
  return {
    name: String(tool.name),
    title: typeof tool.title === 'string' ? tool.title.slice(0, 200) : (typeof tool.annotations?.title === 'string' ? tool.annotations.title.slice(0, 200) : null),
    description: typeof tool.description === 'string' ? tool.description.slice(0, 2000) : '',
    inputSchema: tool.inputSchema && typeof tool.inputSchema === 'object' ? tool.inputSchema : { type: 'object' },
    readOnly: tool.annotations?.readOnlyHint === true,
    destructive: tool.annotations?.destructiveHint === true,
  };
}

/** First https link in a tool result: a structured `url`, a resource_link, or text. */
function resultLink(result) {
  const sc = result?.structuredContent;
  for (const key of ['url', 'link', 'href', 'webUrl', 'permalink']) {
    if (sc && typeof sc[key] === 'string' && /^https:\/\//i.test(sc[key])) return sc[key];
  }
  for (const c of result?.content || []) {
    if (c?.type === 'resource_link' && typeof c.uri === 'string' && /^https:\/\//i.test(c.uri)) return c.uri;
    if (c?.type === 'text' && typeof c.text === 'string') {
      const m = /https:\/\/[^\s"'<>)\]]+/i.exec(c.text);
      if (m) return m[0];
    }
  }
  return null;
}

function resultText(result) {
  return (result?.content || [])
    .filter((c) => c?.type === 'text' && typeof c.text === 'string')
    .map((c) => c.text)
    .join('\n')
    .slice(0, 2000);
}

async function withClient({ url, authProvider, headers = {}, fetch: fetchImpl, clientInfo, createClient = defaultCreateClient, createTransport = defaultCreateTransport }, fn) {
  const client = createClient(clientInfo || { name: 'Steno', version: '0' });
  const transport = createTransport(url, {
    authProvider,
    requestInit: { headers },
    ...(fetchImpl ? { fetch: fetchImpl } : {}),
  });
  try {
    await client.connect(transport, { timeout: CONNECT_TIMEOUT_MS });
    return await fn(client);
  } finally {
    await client.close().catch(() => {});
  }
}

async function listTools(opts) {
  return withClient(opts, async (client) => {
    const tools = [];
    let cursor;
    for (let page = 0; page < TOOLS_PAGE_LIMIT; page += 1) {
      const res = await client.listTools(cursor ? { cursor } : undefined, { timeout: CONNECT_TIMEOUT_MS });
      for (const t of res?.tools || []) {
        if (t && typeof t.name === 'string') tools.push(toolSummary(t));
        if (tools.length >= MAX_TOOLS) return tools;
      }
      cursor = res?.nextCursor;
      if (!cursor) break;
    }
    return tools;
  });
}

async function callTool(opts, name, args) {
  return withClient(opts, async (client) => {
    const result = await client.callTool({ name, arguments: args }, { timeout: CALL_TIMEOUT_MS });
    return {
      isError: result?.isError === true,
      link: resultLink(result),
      text: resultText(result),
    };
  });
}

module.exports = { listTools, callTool, resultLink, resultText, toolSummary };
