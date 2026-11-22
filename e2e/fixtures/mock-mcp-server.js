// Mock remote MCP server (Streamable HTTP) for Suggested actions, in the
// spirit of mock-adapter.js. One instance serves:
//   POST /mcp                         the MCP endpoint (real @modelcontextprotocol/server
//                                     handler, so the wire format is the SDK's own)
// and, with auth: 'oauth', a complete OAuth 2.1 authorization server:
//   GET  /.well-known/oauth-protected-resource/mcp   RFC 9728
//   GET  /.well-known/oauth-authorization-server     RFC 8414
//   POST /register                                   RFC 7591 DCR
//   GET  /authorize                                  302 straight back to redirect_uri
//                                                    (no login page: the consent step)
//   POST /token                                      code (PKCE S256 checked) + refresh
//                                                    (rotating; a reused refresh token
//                                                    is invalid_grant)
// Every /authorize and /token request must carry resource=<base>/mcp (RFC 8707).
//
// Auth modes: 'none', 'bearer' (Authorization: Bearer <token>), 'header'
// (<headerName>: <token>) and 'oauth'. Tool calls are recorded so a spec can
// assert exactly what was sent (approve) and that nothing was (dismiss).
//
// Used by e2e/specs/mcp-actions.t2.spec.ts and app/mcp-actions.test.js. The SDK
// is resolved from app/node_modules so the fixture also loads outside the
// Playwright NODE_PATH.
const http = require('node:http');
const crypto = require('node:crypto');
const path = require('node:path');

const appDir = path.join(__dirname, '..', '..', 'app');
const sdk = require(require.resolve('@modelcontextprotocol/server', { paths: [appDir] }));
const { McpServer, fromJsonSchema, createMcpHandler } = sdk;

const DEFAULT_TOOLS = [
  {
    name: 'create_issue',
    title: 'Create issue',
    description: 'Create an issue in the tracker.',
    inputSchema: {
      type: 'object',
      properties: {
        title: { type: 'string', minLength: 1, maxLength: 200, description: 'Issue title' },
        description: { type: 'string', description: 'Details' },
        priority: { type: 'string', enum: ['low', 'medium', 'high'] },
      },
      required: ['title'],
      additionalProperties: false,
    },
  },
  {
    name: 'send_message',
    title: 'Send message',
    description: 'Post a message to a channel.',
    inputSchema: {
      type: 'object',
      properties: { channel: { type: 'string' }, text: { type: 'string' } },
      required: ['channel', 'text'],
    },
  },
  {
    name: 'search_issues',
    title: 'Search issues',
    description: 'Find issues.',
    readOnly: true,
    inputSchema: { type: 'object', properties: { query: { type: 'string' } } },
  },
];

// A Notion-like endpoint for simple actions (app/mcp-simple-actions.js): the
// vendor's nested create-pages tool plus tools a small model should never be
// offered. A connection of kind 'notion' pointed here gets create_page.
const NOTION_LIKE_TOOLS = [
  {
    name: 'notion-create-pages',
    title: 'Create Notion pages',
    description: 'Creates one or more Notion pages with the specified properties and content.',
    inputSchema: {
      type: 'object',
      properties: {
        pages: {
          type: 'array',
          minItems: 1,
          items: {
            type: 'object',
            properties: {
              properties: { type: 'object', additionalProperties: { type: 'string' } },
              content: { type: 'string' },
            },
            required: ['properties'],
          },
        },
        parent: { type: 'object', properties: { page_id: { type: 'string' } } },
      },
      required: ['pages'],
    },
  },
  {
    name: 'notion-search',
    title: 'Search Notion',
    description: 'Search pages.',
    readOnly: true,
    inputSchema: { type: 'object', properties: { query: { type: 'string' } } },
  },
  {
    name: 'notion-delete-pages',
    title: 'Delete pages',
    description: 'Move pages to Trash.',
    destructive: true,
    inputSchema: { type: 'object', properties: { page_ids: { type: 'array', items: { type: 'string' } } } },
  },
];

const sha256url = (s) => crypto.createHash('sha256').update(s).digest('base64url');
const rand = () => crypto.randomBytes(12).toString('base64url');

function startMockMcpServer(opts = {}) {
  const auth = opts.auth || 'bearer';
  const token = opts.token || 'e2e-mcp-token';
  const headerName = (opts.headerName || 'X-Api-Key').toLowerCase();
  const tools = opts.tools || DEFAULT_TOOLS;
  const accessTtl = opts.accessTtlSeconds ?? 3600;
  const calls = [];
  const registrations = [];
  const tokenRequests = [];
  const authorizeRequests = [];
  const codes = new Map(); // code -> { clientId, challenge, redirectUri, resource }
  const accessTokens = new Set();
  const refreshTokens = new Set();
  let issueSeq = 0;
  let base = '';

  const handler = createMcpHandler(() => {
    const server = new McpServer({ name: 'mock-actions', version: '1.0.0' }, { capabilities: { tools: {} } });
    for (const tool of tools) {
      server.registerTool(
        tool.name,
        {
          title: tool.title,
          description: tool.description,
          inputSchema: fromJsonSchema(tool.inputSchema),
          annotations: { title: tool.title, readOnlyHint: tool.readOnly === true, destructiveHint: tool.destructive === true },
        },
        async (args) => {
          calls.push({ name: tool.name, args });
          // A tool with `failText` answers as the endpoint rejecting the call.
          if (tool.failText) return { isError: true, content: [{ type: 'text', text: tool.failText }] };
          // A tool with `resultText` answers with it (a read tool's JSON, say).
          if (tool.resultText) return { content: [{ type: 'text', text: tool.resultText }] };
          issueSeq += 1;
          return { content: [{ type: 'text', text: `Created MOCK-${issueSeq} https://mock.example/items/${issueSeq}` }] };
        },
      );
    }
    return server;
  });

  const json = (res, status, body, headers = {}) => {
    res.writeHead(status, { 'content-type': 'application/json', ...headers });
    res.end(JSON.stringify(body));
  };

  const issueTokens = () => {
    const access = `at-${rand()}`;
    const refresh = `rt-${rand()}`;
    accessTokens.add(access);
    refreshTokens.add(refresh);
    return { access_token: access, refresh_token: refresh, token_type: 'Bearer', expires_in: accessTtl, scope: 'actions' };
  };

  function authorized(req) {
    if (auth === 'none') return true;
    if (auth === 'header') return req.headers[headerName] === token;
    const m = /^Bearer (.+)$/.exec(req.headers.authorization || '');
    if (!m) return false;
    return auth === 'bearer' ? m[1] === token : accessTokens.has(m[1]);
  }

  async function serveMcp(req, res, body) {
    if (!authorized(req)) {
      const headers = auth === 'oauth'
        ? { 'www-authenticate': `Bearer resource_metadata="${base}/.well-known/oauth-protected-resource/mcp", scope="actions"` }
        : { 'www-authenticate': 'Bearer' };
      return json(res, 401, { error: 'unauthorized' }, headers);
    }
    const request = new Request(`${base}${req.url}`, {
      method: req.method,
      headers: Object.fromEntries(Object.entries(req.headers).filter(([, v]) => typeof v === 'string')),
      body: ['GET', 'HEAD'].includes(req.method) ? undefined : body,
    });
    const response = await handler.fetch(request);
    res.writeHead(response.status, Object.fromEntries(response.headers));
    if (response.body) for await (const chunk of response.body) res.write(chunk);
    res.end();
  }

  return new Promise((resolve, reject) => {
    const server = http.createServer(async (req, res) => {
      try {
        const chunks = [];
        for await (const c of req) chunks.push(c);
        const body = Buffer.concat(chunks);
        const url = new URL(req.url, base);

        if (url.pathname === '/mcp') return await serveMcp(req, res, body);
        if (auth !== 'oauth') return json(res, 404, { error: 'not found' });

        if (req.method === 'GET' && url.pathname === '/.well-known/oauth-protected-resource/mcp') {
          return json(res, 200, { resource: `${base}/mcp`, authorization_servers: [base], scopes_supported: ['actions'] });
        }
        if (req.method === 'GET' && url.pathname === '/.well-known/oauth-authorization-server') {
          return json(res, 200, {
            issuer: base,
            authorization_endpoint: `${base}/authorize`,
            token_endpoint: `${base}/token`,
            ...(opts.noDcr ? {} : { registration_endpoint: `${base}/register` }),
            response_types_supported: ['code'],
            grant_types_supported: ['authorization_code', 'refresh_token'],
            token_endpoint_auth_methods_supported: ['none'],
            code_challenge_methods_supported: ['S256'],
            ...(opts.cimd ? { client_id_metadata_document_supported: true } : {}),
          });
        }
        if (req.method === 'GET' && url.pathname === '/client.json' && opts.cimd) {
          return json(res, 200, { client_id: `${base}/client.json`, redirect_uris: ['http://127.0.0.1/callback'] });
        }
        if (req.method === 'POST' && url.pathname === '/register') {
          if (opts.noDcr) return json(res, 404, { error: 'not found' });
          const meta = JSON.parse(body.toString('utf8') || '{}');
          const client = { client_id: `client-${registrations.length + 1}`, redirect_uris: meta.redirect_uris || [], token_endpoint_auth_method: 'none' };
          registrations.push({ ...client, metadata: meta });
          return json(res, 201, client);
        }
        if (req.method === 'GET' && url.pathname === '/authorize') {
          const q = Object.fromEntries(url.searchParams);
          authorizeRequests.push(q);
          const client = registrations.find((r) => r.client_id === q.client_id);
          const cimdOk = opts.cimd && q.client_id === `${base}/client.json`;
          if ((!client && !cimdOk) || (client && !client.redirect_uris.includes(q.redirect_uri))) {
            return json(res, 400, { error: 'invalid_client' });
          }
          if (q.code_challenge_method !== 'S256' || !q.code_challenge || q.resource !== `${base}/mcp` || q.response_type !== 'code') {
            return json(res, 400, { error: 'invalid_request' });
          }
          const code = `code-${rand()}`;
          codes.set(code, { clientId: q.client_id, challenge: q.code_challenge, redirectUri: q.redirect_uri, resource: q.resource });
          const target = new URL(q.redirect_uri);
          target.searchParams.set('code', code);
          target.searchParams.set('state', q.state);
          res.writeHead(302, { location: target.href });
          return res.end();
        }
        if (req.method === 'POST' && url.pathname === '/token') {
          const p = Object.fromEntries(new URLSearchParams(body.toString('utf8')));
          tokenRequests.push({ ...p, code_verifier: p.code_verifier ? '<set>' : undefined, refresh_token: p.refresh_token ? '<set>' : undefined });
          if (p.resource !== `${base}/mcp`) return json(res, 400, { error: 'invalid_target' });
          if (p.grant_type === 'authorization_code') {
            const entry = codes.get(p.code);
            codes.delete(p.code);
            if (!entry || entry.clientId !== p.client_id || entry.redirectUri !== p.redirect_uri
              || sha256url(p.code_verifier || '') !== entry.challenge) {
              return json(res, 400, { error: 'invalid_grant' });
            }
            return json(res, 200, issueTokens());
          }
          if (p.grant_type === 'refresh_token') {
            if (!refreshTokens.has(p.refresh_token)) return json(res, 400, { error: 'invalid_grant' });
            refreshTokens.delete(p.refresh_token); // rotation
            return json(res, 200, issueTokens());
          }
          return json(res, 400, { error: 'unsupported_grant_type' });
        }
        return json(res, 404, { error: 'not found' });
      } catch (e) {
        if (!res.headersSent) json(res, 500, { error: String(e && e.message) });
        else res.end();
      }
    });
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      base = `http://127.0.0.1:${server.address().port}`;
      resolve({
        url: `${base}/mcp`,
        base,
        calls: () => calls.slice(),
        registrations: () => registrations.slice(),
        tokenRequests: () => tokenRequests.slice(),
        authorizeRequests: () => authorizeRequests.slice(),
        revokeAllAccessTokens: () => accessTokens.clear(),
        revokeAllRefreshTokens: () => refreshTokens.clear(),
        close: () => new Promise((r) => { server.closeAllConnections?.(); server.close(() => r()); }),
      });
    });
  });
}

/**
 * Stand-in for the browser during an OAuth sign-in: follow /authorize's 302 to
 * the loopback redirect, as a browser would after the user consents.
 */
async function followAuthorizeRedirect(authorizeUrl) {
  const res = await fetch(authorizeUrl, { redirect: 'manual' });
  const location = res.headers.get('location');
  if (!location) throw new Error(`authorize did not redirect (HTTP ${res.status})`);
  await fetch(location);
}

module.exports = { startMockMcpServer, followAuthorizeRedirect, DEFAULT_TOOLS, NOTION_LIKE_TOOLS };
