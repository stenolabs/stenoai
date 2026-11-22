'use strict';

/**
 * OAuth 2.1 client for remote MCP servers (Suggested actions, Connect page).
 *
 * Pure logic over an injected `fetch`, so every step is unit-testable without
 * Electron or a network (mcp-oauth.test.js). The order follows the MCP
 * authorization spec and the 2026-11-22 connector research:
 *
 *   1. Discovery. The MCP server answers 401 with `WWW-Authenticate: Bearer
 *      resource_metadata="..."`; that URL, or the RFC 9728 well-known paths,
 *      gives the protected-resource metadata, which names the authorization
 *      server(s). RFC 8414 (then OpenID Connect discovery) gives that server's
 *      endpoints. Nothing is hardcoded per vendor.
 *   2. Registration. A Client ID Metadata Document (CIMD) when the server
 *      advertises support; otherwise Dynamic Client Registration (RFC 7591),
 *      kept per issuer except for vendors that ask us not to cache
 *      (Atlassian); otherwise a static per-vendor client from
 *      mcp-connectors.js.
 *   3. Authorization code + PKCE S256, with the RFC 8707 `resource` parameter
 *      on every authorize, token and refresh request.
 *   4. Refresh is proactive (shortly before expiry) and serialized per
 *      connection, so two tool calls never spend the same rotating refresh
 *      token twice. A rotated refresh token is persisted before the new access
 *      token is used. `invalid_grant` means sign in again.
 *
 * Security notes:
 *   - Every authorization-server URL must be https. Plain http is accepted
 *     only on loopback, and only when the caller allows it (the MCP server is
 *     itself on loopback, or the e2e suite is running).
 *   - The protected-resource metadata must describe the server we asked about
 *     (same origin, and its path a prefix of ours), and the issuer in RFC 8414
 *     metadata must echo the issuer we looked up, so a server cannot steer us
 *     to someone else's authorization server.
 *   - Tokens never appear in thrown error messages.
 */

const crypto = require('node:crypto');

const CLIENT_METADATA_URL = 'https://stenoai.co/oauth/client.json';
const CLIENT_NAME = 'Steno';
const CLIENT_URI = 'https://stenoai.co';
// Refresh this long before the access token's stated expiry.
const REFRESH_SKEW_MS = 60 * 1000;
const FETCH_TIMEOUT_MS = 20 * 1000;
const MAX_METADATA_BYTES = 256 * 1024;

class OAuthFlowError extends Error {
  constructor(code, message, extra = {}) {
    super(message);
    this.name = 'OAuthFlowError';
    this.code = code;
    Object.assign(this, extra);
  }
}

/** Sign-in is needed again: no refresh token, `invalid_grant`, or a 401 after refresh. */
class ReauthRequiredError extends OAuthFlowError {
  constructor(message = 'Sign in again to continue') {
    super('reauth-required', message);
    this.name = 'ReauthRequiredError';
  }
}

function isLoopbackHost(hostname) {
  const h = String(hostname || '').toLowerCase().replace(/^\[|\]$/g, '');
  return h === 'localhost' || h === '::1' || /^127(\.\d{1,3}){3}$/.test(h);
}

/**
 * Parse a URL an authorization flow may contact. https always; http only on
 * loopback when allowed. No credentials in the authority, no fragment.
 */
function assertSafeUrl(value, { allowLoopbackHttp = false, what = 'URL' } = {}) {
  let url;
  try {
    url = new URL(String(value));
  } catch {
    throw new OAuthFlowError('invalid-metadata', `${what} is not a valid URL`);
  }
  const loopbackHttp = url.protocol === 'http:' && allowLoopbackHttp && isLoopbackHost(url.hostname);
  if (url.protocol !== 'https:' && !loopbackHttp) {
    throw new OAuthFlowError('insecure-endpoint', `${what} must use https`);
  }
  if (url.username || url.password || url.hash) {
    throw new OAuthFlowError('invalid-metadata', `${what} has credentials or a fragment`);
  }
  return url;
}

/** `Bearer realm="x", resource_metadata="https://...", scope="a b"` → { scheme, params }. */
function parseWwwAuthenticate(header) {
  if (typeof header !== 'string' || !header.trim()) return null;
  const match = /^\s*([A-Za-z][\w.-]*)\s*(.*)$/s.exec(header);
  if (!match) return null;
  const params = {};
  const re = /([A-Za-z][\w.-]*)\s*=\s*(?:"((?:[^"\\]|\\.)*)"|([^\s,]+))/g;
  let m;
  while ((m = re.exec(match[2])) !== null) {
    params[m[1].toLowerCase()] = m[2] !== undefined ? m[2].replace(/\\(.)/g, '$1') : m[3];
  }
  return { scheme: match[1].toLowerCase(), params };
}

async function fetchJson(fetchImpl, url, init = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetchImpl(url, {
      ...init,
      headers: { accept: 'application/json', ...(init.headers || {}) },
      redirect: 'error',
      signal: controller.signal,
    });
    const text = await res.text();
    if (text.length > MAX_METADATA_BYTES) {
      throw new OAuthFlowError('invalid-metadata', 'Response is too large');
    }
    let body = null;
    try {
      body = text ? JSON.parse(text) : null;
    } catch {
      body = null;
    }
    return { status: res.status, ok: res.ok, body };
  } finally {
    clearTimeout(timer);
  }
}

/** RFC 9728 §3.1: path-inserted well-known first, then the origin root. */
function protectedResourceMetadataUrls(serverUrl) {
  const url = new URL(serverUrl);
  const path = url.pathname.replace(/\/+$/, '');
  const urls = [];
  if (path && path !== '/') urls.push(`${url.origin}/.well-known/oauth-protected-resource${path}`);
  urls.push(`${url.origin}/.well-known/oauth-protected-resource`);
  return urls;
}

/** RFC 8414 §3.1 (path-inserted), then OpenID Connect discovery (both forms). */
function authServerMetadataUrls(issuer) {
  const url = new URL(issuer);
  const path = url.pathname.replace(/\/+$/, '');
  if (!path || path === '/') {
    return [
      `${url.origin}/.well-known/oauth-authorization-server`,
      `${url.origin}/.well-known/openid-configuration`,
    ];
  }
  return [
    `${url.origin}/.well-known/oauth-authorization-server${path}`,
    `${url.origin}/.well-known/openid-configuration${path}`,
    `${url.origin}${path}/.well-known/openid-configuration`,
  ];
}

/**
 * The canonical resource identifier for an MCP server URL (RFC 8707): no
 * fragment, no query, no trailing slash. This is what goes in `resource=`.
 */
function canonicalResource(serverUrl) {
  const url = new URL(serverUrl);
  return `${url.origin}${url.pathname.replace(/\/+$/, '')}`;
}

function resourceMatches(declared, serverUrl) {
  try {
    const d = new URL(declared);
    const s = new URL(serverUrl);
    if (d.origin !== s.origin) return false;
    const dp = d.pathname.replace(/\/+$/, '');
    const sp = s.pathname.replace(/\/+$/, '');
    return sp === dp || sp.startsWith(`${dp}/`) || dp === '';
  } catch {
    return false;
  }
}

/**
 * Find the authorization server for an MCP server. `challenge` is the parsed
 * WWW-Authenticate from its 401, if any. Returns { resource, issuer,
 * resourceMetadata, scopes } where scopes are the challenge's or the
 * metadata's `scopes_supported`.
 */
async function discoverProtectedResource({ serverUrl, fetch: fetchImpl, challenge = null, allowLoopbackHttp = false }) {
  const candidates = [];
  const hinted = challenge?.params?.resource_metadata;
  if (hinted) candidates.push(assertSafeUrl(hinted, { allowLoopbackHttp, what: 'Resource metadata URL' }).href);
  for (const u of protectedResourceMetadataUrls(serverUrl)) if (!candidates.includes(u)) candidates.push(u);

  for (const candidate of candidates) {
    let res;
    try {
      res = await fetchJson(fetchImpl, candidate);
    } catch (e) {
      if (e instanceof OAuthFlowError) throw e;
      continue;
    }
    if (!res.ok || !res.body || typeof res.body !== 'object') continue;
    const meta = res.body;
    if (typeof meta.resource !== 'string' || !resourceMatches(meta.resource, serverUrl)) {
      throw new OAuthFlowError('resource-mismatch', 'Protected-resource metadata is for a different server');
    }
    const servers = Array.isArray(meta.authorization_servers) ? meta.authorization_servers : [];
    if (!servers.length || typeof servers[0] !== 'string') {
      throw new OAuthFlowError('invalid-metadata', 'Protected-resource metadata names no authorization server');
    }
    const issuer = assertSafeUrl(servers[0], { allowLoopbackHttp, what: 'Authorization server' }).href.replace(/\/$/, '');
    const scope = challenge?.params?.scope
      || (Array.isArray(meta.scopes_supported) ? meta.scopes_supported.join(' ') : '');
    return { resource: canonicalResource(meta.resource), issuer, resourceMetadata: meta, scope };
  }
  // Pre-RFC 9728 servers (MCP 2025-03): the server's origin is the issuer.
  const origin = new URL(serverUrl).origin;
  return { resource: canonicalResource(serverUrl), issuer: origin, resourceMetadata: null, scope: challenge?.params?.scope || '', legacy: true };
}

/** RFC 8414 metadata for `issuer`, validated. */
async function discoverAuthServer({ issuer, fetch: fetchImpl, allowLoopbackHttp = false }) {
  assertSafeUrl(issuer, { allowLoopbackHttp, what: 'Authorization server' });
  for (const candidate of authServerMetadataUrls(issuer)) {
    let res;
    try {
      res = await fetchJson(fetchImpl, candidate);
    } catch {
      continue;
    }
    if (!res.ok || !res.body || typeof res.body !== 'object') continue;
    const meta = res.body;
    const echoed = typeof meta.issuer === 'string' ? meta.issuer.replace(/\/$/, '') : '';
    if (echoed !== issuer.replace(/\/$/, '')) {
      throw new OAuthFlowError('issuer-mismatch', 'Authorization server metadata names a different issuer');
    }
    for (const key of ['authorization_endpoint', 'token_endpoint']) {
      if (typeof meta[key] !== 'string') throw new OAuthFlowError('invalid-metadata', `Metadata has no ${key}`);
      assertSafeUrl(meta[key], { allowLoopbackHttp, what: key });
    }
    if (meta.registration_endpoint) assertSafeUrl(meta.registration_endpoint, { allowLoopbackHttp, what: 'registration_endpoint' });
    const methods = meta.code_challenge_methods_supported;
    // The MCP spec requires S256 and requires clients to refuse a server that
    // does not advertise it.
    if (!Array.isArray(methods) || !methods.includes('S256')) {
      throw new OAuthFlowError('pkce-unsupported', 'Authorization server does not support PKCE S256');
    }
    return meta;
  }
  throw new OAuthFlowError('discovery-failed', 'Could not find the authorization server metadata');
}

function pkcePair() {
  const verifier = crypto.randomBytes(32).toString('base64url');
  const challenge = crypto.createHash('sha256').update(verifier).digest('base64url');
  return { verifier, challenge, method: 'S256' };
}

function randomState() {
  return crypto.randomBytes(16).toString('base64url');
}

/** Client metadata Steno sends for DCR; the CIMD at CLIENT_METADATA_URL matches it. */
function clientMetadata(redirectUri, scope) {
  const meta = {
    client_name: CLIENT_NAME,
    client_uri: CLIENT_URI,
    redirect_uris: [redirectUri],
    grant_types: ['authorization_code', 'refresh_token'],
    response_types: ['code'],
    token_endpoint_auth_method: 'none',
    application_type: 'native',
  };
  if (scope) meta.scope = scope;
  return meta;
}

/**
 * Pick the client to authorize as:
 *   CIMD (only if advertised) → DCR (cached per issuer unless noCache) → static.
 * `registrations` is { get(issuer), save(issuer, record), remove(issuer) }.
 * Returns { client_id, client_secret?, token_endpoint_auth_method, method, redirect_uri? }.
 */
async function chooseClient({
  asMeta, issuer, redirectUri, scope, fetch: fetchImpl, registrations, vendor = null,
  clientMetadataUrl = CLIENT_METADATA_URL,
}) {
  if (asMeta.client_id_metadata_document_supported === true && clientMetadataUrl) {
    return { client_id: clientMetadataUrl, token_endpoint_auth_method: 'none', method: 'cimd' };
  }
  if (asMeta.registration_endpoint) {
    const cacheable = !(vendor && vendor.noDcrCache);
    if (cacheable && registrations) {
      const cached = await registrations.get(issuer);
      if (cached && cached.client_id && cached.redirect_uri === redirectUri) {
        return { ...cached, method: 'dcr' };
      }
    }
    const res = await fetchJson(fetchImpl, asMeta.registration_endpoint, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(clientMetadata(redirectUri, scope)),
    });
    if (!res.ok || !res.body || typeof res.body.client_id !== 'string') {
      throw new OAuthFlowError('registration-failed', `Client registration failed (HTTP ${res.status})`);
    }
    const record = {
      client_id: res.body.client_id,
      ...(typeof res.body.client_secret === 'string' ? { client_secret: res.body.client_secret } : {}),
      token_endpoint_auth_method: res.body.token_endpoint_auth_method
        || (res.body.client_secret ? 'client_secret_basic' : 'none'),
      redirect_uri: redirectUri,
      registered_at: Date.now(),
    };
    if (cacheable && registrations) await registrations.save(issuer, record);
    return { ...record, method: 'dcr' };
  }
  const entry = vendor?.staticClient;
  if (entry && entry.clientId) {
    return {
      client_id: entry.clientId,
      ...(entry.clientSecret ? { client_secret: entry.clientSecret } : {}),
      token_endpoint_auth_method: entry.clientSecret ? 'client_secret_post' : 'none',
      method: 'static',
    };
  }
  throw new OAuthFlowError('needs-registration', 'This service needs Steno to be registered with it first');
}

function buildAuthorizeUrl({ asMeta, client, redirectUri, state, challenge, scope, resource }) {
  const url = new URL(asMeta.authorization_endpoint);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('client_id', client.client_id);
  url.searchParams.set('redirect_uri', redirectUri);
  url.searchParams.set('state', state);
  url.searchParams.set('code_challenge', challenge);
  url.searchParams.set('code_challenge_method', 'S256');
  url.searchParams.set('resource', resource);
  if (scope) url.searchParams.set('scope', scope);
  return url.href;
}

function clientAuth(client, params, headers) {
  if (client.client_secret && client.token_endpoint_auth_method === 'client_secret_basic') {
    const basic = Buffer.from(
      `${encodeURIComponent(client.client_id)}:${encodeURIComponent(client.client_secret)}`,
    ).toString('base64');
    headers.authorization = `Basic ${basic}`;
  } else {
    params.set('client_id', client.client_id);
    if (client.client_secret) params.set('client_secret', client.client_secret);
  }
}

/** Token endpoint response → stored token set. Throws on anything unusable. */
function normalizeTokens(body, now = Date.now(), previous = null) {
  if (!body || typeof body.access_token !== 'string' || !body.access_token) {
    throw new OAuthFlowError('token-failed', 'Token response has no access token');
  }
  if (body.token_type && String(body.token_type).toLowerCase() !== 'bearer') {
    throw new OAuthFlowError('token-failed', 'Token type is not Bearer');
  }
  const expiresIn = Number(body.expires_in);
  return {
    access_token: body.access_token,
    // A refresh response without a new refresh token keeps the old one.
    refresh_token: typeof body.refresh_token === 'string' ? body.refresh_token : previous?.refresh_token || null,
    expires_at: Number.isFinite(expiresIn) && expiresIn > 0 ? now + expiresIn * 1000 : null,
    scope: typeof body.scope === 'string' ? body.scope : previous?.scope || null,
  };
}

async function tokenRequest({ fetch: fetchImpl, asMeta, client, params }) {
  const headers = { 'content-type': 'application/x-www-form-urlencoded' };
  clientAuth(client, params, headers);
  const res = await fetchJson(fetchImpl, asMeta.token_endpoint, { method: 'POST', headers, body: params.toString() });
  if (!res.ok) {
    const error = typeof res.body?.error === 'string' ? res.body.error : null;
    if (error === 'invalid_grant' || error === 'invalid_client' || error === 'unauthorized_client') {
      throw new ReauthRequiredError();
    }
    throw new OAuthFlowError('token-failed', `Token request failed (HTTP ${res.status}${error ? `, ${error}` : ''})`);
  }
  return res.body;
}

async function exchangeCode({ fetch: fetchImpl, asMeta, client, code, verifier, redirectUri, resource, now = Date.now() }) {
  const params = new URLSearchParams({
    grant_type: 'authorization_code',
    code,
    redirect_uri: redirectUri,
    code_verifier: verifier,
    resource,
  });
  return normalizeTokens(await tokenRequest({ fetch: fetchImpl, asMeta, client, params }), now);
}

async function refreshTokens({ fetch: fetchImpl, asMeta, client, tokens, resource, now = Date.now() }) {
  if (!tokens?.refresh_token) throw new ReauthRequiredError();
  const params = new URLSearchParams({
    grant_type: 'refresh_token',
    refresh_token: tokens.refresh_token,
    resource,
  });
  if (tokens.scope) params.set('scope', tokens.scope);
  return normalizeTokens(await tokenRequest({ fetch: fetchImpl, asMeta, client, params }), now, tokens);
}

/**
 * Access tokens for one OAuth connection, with proactive, serialized refresh.
 * `load()` returns the stored record { tokens, client, asMeta, resource };
 * `save(record)` persists it atomically and must resolve before the new token
 * is handed out, so a rotated refresh token is never lost.
 */
class TokenManager {
  constructor({ load, save, fetch: fetchImpl, now = () => Date.now(), skewMs = REFRESH_SKEW_MS }) {
    Object.assign(this, { load, save, fetchImpl, now, skewMs });
    this._inflight = null;
  }

  async accessToken() {
    const record = await this.load();
    if (!record?.tokens?.access_token) throw new ReauthRequiredError();
    const exp = record.tokens.expires_at;
    if (exp && exp - this.skewMs <= this.now()) return (await this.refresh(record.tokens.access_token)).access_token;
    return record.tokens.access_token;
  }

  /**
   * Refresh once, even if many callers ask at the same time. `staleToken` is
   * the token the caller saw fail; if the store already holds a different one
   * (another caller refreshed meanwhile), that one is returned instead.
   */
  refresh(staleToken = null) {
    if (this._inflight) return this._inflight;
    this._inflight = (async () => {
      const record = await this.load();
      if (!record?.tokens) throw new ReauthRequiredError();
      if (staleToken && record.tokens.access_token !== staleToken
        && !(record.tokens.expires_at && record.tokens.expires_at - this.skewMs <= this.now())) {
        return record.tokens;
      }
      const tokens = await refreshTokens({
        fetch: this.fetchImpl,
        asMeta: record.asMeta,
        client: record.client,
        tokens: record.tokens,
        resource: record.resource,
        now: this.now(),
      });
      await this.save({ ...record, tokens });
      return tokens;
    })().finally(() => {
      this._inflight = null;
    });
    return this._inflight;
  }
}

module.exports = {
  CLIENT_METADATA_URL,
  OAuthFlowError,
  ReauthRequiredError,
  assertSafeUrl,
  authServerMetadataUrls,
  buildAuthorizeUrl,
  canonicalResource,
  chooseClient,
  clientMetadata,
  discoverAuthServer,
  discoverProtectedResource,
  exchangeCode,
  isLoopbackHost,
  normalizeTokens,
  parseWwwAuthenticate,
  pkcePair,
  protectedResourceMetadataUrls,
  randomState,
  refreshTokens,
  resourceMatches,
  TokenManager,
};
