'use strict';

// Unit tests for the MCP OAuth 2.1 client (mcp-oauth.js) against a scripted
// fetch: discovery order and validation, registration order (CIMD → DCR →
// static, Atlassian not cached), PKCE + RFC 8707 resource on every request,
// and serialized refresh with rotation and invalid_grant.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const oauth = require('./mcp-oauth');

/** fetch over a route table: { 'GET https://x/y': (url, init) => ({ status, body, headers }) }. */
function scriptedFetch(routes) {
  const seen = [];
  const fn = async (url, init = {}) => {
    const method = (init.method || 'GET').toUpperCase();
    const key = `${method} ${String(url).split('?')[0]}`;
    seen.push({ key, url: String(url), init });
    const route = routes[key];
    const r = route ? await route(String(url), init) : { status: 404, body: { error: 'nf' } };
    const text = r.body === undefined ? '' : JSON.stringify(r.body);
    return {
      status: r.status,
      ok: r.status >= 200 && r.status < 300,
      headers: new Headers(r.headers || {}),
      text: async () => text,
    };
  };
  fn.seen = seen;
  return fn;
}

const AS = 'https://auth.example.com';
const MCP = 'https://mcp.example.com/mcp';
const asMeta = (extra = {}) => ({
  issuer: AS,
  authorization_endpoint: `${AS}/authorize`,
  token_endpoint: `${AS}/token`,
  registration_endpoint: `${AS}/register`,
  code_challenge_methods_supported: ['S256'],
  ...extra,
});

test('parseWwwAuthenticate reads quoted and bare params', () => {
  const p = oauth.parseWwwAuthenticate('Bearer realm="mcp", resource_metadata="https://x/.well-known/oauth-protected-resource", scope=read error="invalid_token"');
  assert.equal(p.scheme, 'bearer');
  assert.equal(p.params.resource_metadata, 'https://x/.well-known/oauth-protected-resource');
  assert.equal(p.params.scope, 'read');
  assert.equal(p.params.error, 'invalid_token');
  assert.equal(oauth.parseWwwAuthenticate(''), null);
});

test('well-known URLs follow RFC 9728 and RFC 8414 path insertion', () => {
  assert.deepEqual(oauth.protectedResourceMetadataUrls('https://h.example/v2/mcp'), [
    'https://h.example/.well-known/oauth-protected-resource/v2/mcp',
    'https://h.example/.well-known/oauth-protected-resource',
  ]);
  assert.deepEqual(oauth.authServerMetadataUrls('https://h.example'), [
    'https://h.example/.well-known/oauth-authorization-server',
    'https://h.example/.well-known/openid-configuration',
  ]);
  assert.equal(oauth.authServerMetadataUrls('https://h.example/tenant1')[0], 'https://h.example/.well-known/oauth-authorization-server/tenant1');
});

test('discovery prefers the resource_metadata hint and validates the resource', async () => {
  const fetch = scriptedFetch({
    'GET https://mcp.example.com/custom-prm': () => ({ status: 200, body: { resource: MCP, authorization_servers: [AS], scopes_supported: ['a', 'b'] } }),
  });
  const pr = await oauth.discoverProtectedResource({
    serverUrl: MCP, fetch,
    challenge: oauth.parseWwwAuthenticate('Bearer resource_metadata="https://mcp.example.com/custom-prm", scope="a"'),
  });
  assert.equal(pr.issuer, AS);
  assert.equal(pr.resource, MCP);
  assert.equal(pr.scope, 'a', 'challenge scope wins over scopes_supported');
  assert.equal(fetch.seen.length, 1);
});

test('discovery rejects metadata for another resource', async () => {
  const fetch = scriptedFetch({
    'GET https://mcp.example.com/.well-known/oauth-protected-resource/mcp': () => ({ status: 200, body: { resource: 'https://evil.example/mcp', authorization_servers: [AS] } }),
  });
  await assert.rejects(oauth.discoverProtectedResource({ serverUrl: MCP, fetch }), { code: 'resource-mismatch' });
});

test('discovery refuses an http authorization server', async () => {
  const fetch = scriptedFetch({
    'GET https://mcp.example.com/.well-known/oauth-protected-resource/mcp': () => ({ status: 200, body: { resource: MCP, authorization_servers: ['http://auth.example.com'] } }),
  });
  await assert.rejects(oauth.discoverProtectedResource({ serverUrl: MCP, fetch }), { code: 'insecure-endpoint' });
});

test('discovery falls back to the server origin for pre-RFC 9728 servers', async () => {
  const pr = await oauth.discoverProtectedResource({ serverUrl: MCP, fetch: scriptedFetch({}) });
  assert.equal(pr.issuer, 'https://mcp.example.com');
  assert.equal(pr.legacy, true);
});

test('auth server metadata must echo the issuer and support S256', async () => {
  const ok = scriptedFetch({ [`GET ${AS}/.well-known/oauth-authorization-server`]: () => ({ status: 200, body: asMeta() }) });
  assert.equal((await oauth.discoverAuthServer({ issuer: AS, fetch: ok })).token_endpoint, `${AS}/token`);

  const wrongIssuer = scriptedFetch({ [`GET ${AS}/.well-known/oauth-authorization-server`]: () => ({ status: 200, body: asMeta({ issuer: 'https://other.example' }) }) });
  await assert.rejects(oauth.discoverAuthServer({ issuer: AS, fetch: wrongIssuer }), { code: 'issuer-mismatch' });

  const noPkce = scriptedFetch({ [`GET ${AS}/.well-known/oauth-authorization-server`]: () => ({ status: 200, body: asMeta({ code_challenge_methods_supported: ['plain'] }) }) });
  await assert.rejects(oauth.discoverAuthServer({ issuer: AS, fetch: noPkce }), { code: 'pkce-unsupported' });

  const oidc = scriptedFetch({ [`GET ${AS}/.well-known/openid-configuration`]: () => ({ status: 200, body: asMeta() }) });
  assert.equal((await oauth.discoverAuthServer({ issuer: AS, fetch: oidc })).issuer, AS, 'falls back to OIDC discovery');
});

function memoryRegistrations() {
  const map = new Map();
  return { map, get: async (k) => map.get(k) || null, save: async (k, v) => { map.set(k, v); } };
}

test('registration: CIMD only when advertised', async () => {
  const fetch = scriptedFetch({});
  const c = await oauth.chooseClient({ asMeta: asMeta({ client_id_metadata_document_supported: true }), issuer: AS, redirectUri: 'http://127.0.0.1:5555/callback', fetch, registrations: memoryRegistrations() });
  assert.equal(c.method, 'cimd');
  assert.equal(c.client_id, 'https://stenoai.co/oauth/client.json');
  assert.equal(fetch.seen.length, 0, 'no DCR call');
});

test('registration: DCR is cached per issuer and reused for the same redirect', async () => {
  let n = 0;
  const fetch = scriptedFetch({
    [`POST ${AS}/register`]: (_u, init) => {
      n += 1;
      const body = JSON.parse(init.body);
      assert.equal(body.token_endpoint_auth_method, 'none');
      assert.equal(body.redirect_uris.length, 1);
      return { status: 201, body: { client_id: `c${n}` } };
    },
  });
  const regs = memoryRegistrations();
  const args = { asMeta: asMeta(), issuer: AS, redirectUri: 'http://127.0.0.1:5555/callback', fetch, registrations: regs };
  assert.equal((await oauth.chooseClient(args)).client_id, 'c1');
  assert.equal((await oauth.chooseClient(args)).client_id, 'c1', 'cached');
  assert.equal((await oauth.chooseClient({ ...args, redirectUri: 'http://127.0.0.1:6666/callback' })).client_id, 'c2', 'new redirect re-registers');
  assert.equal(n, 2);
});

test('registration: Atlassian (noDcrCache) registers every time and caches nothing', async () => {
  let n = 0;
  const fetch = scriptedFetch({ [`POST ${AS}/register`]: () => ({ status: 201, body: { client_id: `c${++n}` } }) });
  const regs = memoryRegistrations();
  const args = { asMeta: asMeta(), issuer: AS, redirectUri: 'http://127.0.0.1:5555/callback', fetch, registrations: regs, vendor: { noDcrCache: true } };
  await oauth.chooseClient(args);
  await oauth.chooseClient(args);
  assert.equal(n, 2);
  assert.equal(regs.map.size, 0);
});

test('registration: static client, then needs-registration', async () => {
  const meta = asMeta({ registration_endpoint: undefined });
  const fetch = scriptedFetch({});
  const s = await oauth.chooseClient({ asMeta: meta, issuer: AS, redirectUri: 'x', fetch, vendor: { staticClient: { clientId: 'static-1' } } });
  assert.equal(s.method, 'static');
  await assert.rejects(oauth.chooseClient({ asMeta: meta, issuer: AS, redirectUri: 'x', fetch, vendor: { staticClient: null } }), { code: 'needs-registration' });
});

test('PKCE pair is S256 and authorize URL carries resource + state', () => {
  const { verifier, challenge, method } = oauth.pkcePair();
  assert.equal(method, 'S256');
  assert.equal(challenge, crypto.createHash('sha256').update(verifier).digest('base64url'));
  assert.ok(verifier.length >= 43);
  const url = new URL(oauth.buildAuthorizeUrl({
    asMeta: asMeta(), client: { client_id: 'c1' }, redirectUri: 'http://127.0.0.1:1/callback', state: 's1', challenge, scope: 'a b', resource: MCP,
  }));
  assert.equal(url.searchParams.get('code_challenge_method'), 'S256');
  assert.equal(url.searchParams.get('resource'), MCP);
  assert.equal(url.searchParams.get('state'), 's1');
  assert.equal(url.searchParams.get('scope'), 'a b');
});

test('code exchange sends verifier + resource; refresh keeps the old refresh token when not rotated', async () => {
  const bodies = [];
  const fetch = scriptedFetch({
    [`POST ${AS}/token`]: (_u, init) => {
      const p = Object.fromEntries(new URLSearchParams(init.body));
      bodies.push(p);
      if (p.grant_type === 'authorization_code') return { status: 200, body: { access_token: 'a1', refresh_token: 'r1', expires_in: 60, token_type: 'bearer' } };
      return { status: 200, body: { access_token: 'a2', expires_in: 60 } };
    },
  });
  const t = await oauth.exchangeCode({ fetch, asMeta: asMeta(), client: { client_id: 'c1' }, code: 'x', verifier: 'v', redirectUri: 'r', resource: MCP, now: 1000 });
  assert.deepEqual(t, { access_token: 'a1', refresh_token: 'r1', expires_at: 61000, scope: null });
  assert.equal(bodies[0].resource, MCP);
  assert.equal(bodies[0].code_verifier, 'v');
  const t2 = await oauth.refreshTokens({ fetch, asMeta: asMeta(), client: { client_id: 'c1' }, tokens: t, resource: MCP });
  assert.equal(t2.refresh_token, 'r1');
  assert.equal(bodies[1].resource, MCP);
});

test('invalid_grant on refresh means sign in again', async () => {
  const fetch = scriptedFetch({ [`POST ${AS}/token`]: () => ({ status: 400, body: { error: 'invalid_grant' } }) });
  await assert.rejects(
    oauth.refreshTokens({ fetch, asMeta: asMeta(), client: { client_id: 'c1' }, tokens: { refresh_token: 'r' }, resource: MCP }),
    oauth.ReauthRequiredError,
  );
});

test('TokenManager refreshes proactively, once for concurrent callers, and persists rotation first', async () => {
  let clock = 0;
  let refreshCalls = 0;
  const events = [];
  const fetch = scriptedFetch({
    [`POST ${AS}/token`]: async (_u, init) => {
      refreshCalls += 1;
      const p = Object.fromEntries(new URLSearchParams(init.body));
      assert.equal(p.refresh_token, 'r1');
      await new Promise((r) => setTimeout(r, 10));
      return { status: 200, body: { access_token: 'a2', refresh_token: 'r2', expires_in: 3600 } };
    },
  });
  let record = { tokens: { access_token: 'a1', refresh_token: 'r1', expires_at: 100_000 }, client: { client_id: 'c1' }, asMeta: asMeta(), resource: MCP };
  const tm = new oauth.TokenManager({
    load: async () => record,
    save: async (r) => { events.push('save'); record = r; },
    fetch,
    now: () => clock,
  });
  assert.equal(await tm.accessToken(), 'a1', 'fresh token used as is');
  clock = 50_000; // within the 60 s skew of expiry
  const tokens = await Promise.all([tm.accessToken(), tm.accessToken(), tm.accessToken()]);
  assert.deepEqual(tokens, ['a2', 'a2', 'a2']);
  assert.equal(refreshCalls, 1, 'serialized');
  assert.equal(record.tokens.refresh_token, 'r2', 'rotated refresh token persisted');
  assert.deepEqual(events, ['save']);
  // A caller whose token already got replaced does not refresh again.
  assert.equal((await tm.refresh('a1')).access_token, 'a2');
  assert.equal(refreshCalls, 1);
});

test('TokenManager without tokens asks for sign-in', async () => {
  const tm = new oauth.TokenManager({ load: async () => null, save: async () => {}, fetch: scriptedFetch({}) });
  await assert.rejects(tm.accessToken(), oauth.ReauthRequiredError);
});

test('token errors never echo the token', async () => {
  const fetch = scriptedFetch({ [`POST ${AS}/token`]: () => ({ status: 500, body: { error: 'server_error' } }) });
  await assert.rejects(
    oauth.refreshTokens({ fetch, asMeta: asMeta(), client: { client_id: 'c1' }, tokens: { refresh_token: 'super-secret-rt' }, resource: MCP }),
    (e) => !String(e.message).includes('super-secret-rt'),
  );
});
