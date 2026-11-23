'use strict';

/**
 * Suggested actions: the service behind the Connect page's "Turn meetings
 * into actions" section and the action cards under a note.
 *
 *   connections  mcp-connections.js (config) + mcp-secret-store.js (secrets)
 *   auth         bearer / custom header token, or OAuth 2.1 (mcp-oauth.js)
 *   transport    Streamable HTTP (mcp-remote-client.js); a command on this
 *                computer over stdio (mcp-stdio-client.js); or the built-in
 *                Email drafts, which open a mailto: draft (mcp-email.js)
 *   suggestions  the configured summariser provider, via the Python CLI
 *                `suggest-actions` (src/action_suggest.py), given ONLY the
 *                note's summary and action items plus the enabled tools
 *   cards        <userData>/mcp-actions/<hash>.json, one file per note
 *   audit        <userData>/mcp-actions-audit.jsonl (mcp-audit-log.js)
 *
 * Rules this module enforces, whatever the renderer asks for:
 *   - Nothing runs without approve(); there is no auto-run path.
 *   - approve() sends exactly the arguments it is given, after validating
 *     them against the tool's schema, to a tool the enabled connection
 *     actually listed. Dismiss sends nothing.
 *   - The org adapter's policy (actions disabled / endpoint allowlist /
 *     local commands / email drafts) is checked before every call, not only
 *     when the UI renders.
 *   - Tokens never reach logs, errors, the renderer or a child process.
 *   - A local command runs only as the user saved it, after a native
 *     confirmation in the main process (confirmLocalCommand); suggestions
 *     and chat choose a tool and its arguments, never what is executed.
 *
 * Electron-free: everything with side effects is injected, so the whole flow
 * runs under node --test against the mock MCP server (mcp-actions.test.js).
 */

const crypto = require('node:crypto');
const nodeFs = require('node:fs');
const nodePath = require('node:path');

const oauth = require('./mcp-oauth');
const remote = require('./mcp-remote-client');
const { createConnectionsStore, normalizeEndpointUrl, normalizeHeaderName, normalizeLocalCommand, cleanName } = require('./mcp-connections');
const email = require('./mcp-email');
const { createStdioPool } = require('./mcp-stdio-client');
const { createSecretStore } = require('./mcp-secret-store');
const { createAuditLog } = require('./mcp-audit-log');
const { connectorById, publicCatalogue } = require('./mcp-connectors');
const { validateArguments, compactSchema } = require('./mcp-schema');
const { startLoopback: defaultStartLoopback } = require('./mcp-oauth-loopback');
const { redactCredentials } = require('./diagnostics-filter');
const { checkProposal, placeholderArguments, noteText } = require('./mcp-proposals');
const simpleActions = require('./mcp-simple-actions');

const MAX_PROPOSALS = 5;
const MAX_PROMPT_TOOLS = 60;
const MAX_TOKEN_LENGTH = 8192;
const MCP_PROTOCOL_PROBE_VERSION = '2025-06-18';
const SIMPLE_ACTIONS_TTL_MS = 10 * 60 * 1000;

class ActionError extends Error {
  constructor(code, message) {
    super(message || code);
    this.name = 'ActionError';
    this.code = code;
  }
}

function isValidToken(token) {
  return typeof token === 'string' && token.length > 0 && token.length <= MAX_TOKEN_LENGTH && /^[\x20-\x7e]+$/.test(token);
}

function originOf(url) {
  return new URL(url).origin;
}

function allowedByList(url, allowlist) {
  if (!Array.isArray(allowlist)) return true;
  let target;
  try {
    target = new URL(url);
  } catch {
    return false;
  }
  return allowlist.some((entry) => {
    if (typeof entry !== 'string' || !entry) return false;
    try {
      const e = new URL(entry);
      if (e.origin !== target.origin) return false;
      const prefix = e.pathname.replace(/\/+$/, '');
      return !prefix || target.pathname === prefix || target.pathname.startsWith(`${prefix}/`);
    } catch {
      return false;
    }
  });
}

/** 'http' (a URL endpoint), 'stdio' (a command on this computer) or 'builtin' (Email drafts). */
function transportOf(c) {
  if (c?.transport === 'stdio' || c?.transport === 'builtin') return c.transport;
  return 'http';
}

/** Where a connection runs: a local command and Email drafts never leave this computer. */
function localityOf(c) {
  if (transportOf(c) !== 'http') return 'device';
  return normalizeEndpointUrl(c.url)?.locality || 'internet';
}

/** The URL origin of an HTTP endpoint; null for a local command or Email drafts. */
function connectionOrigin(c) {
  if (transportOf(c) !== 'http') return null;
  return normalizeEndpointUrl(c.url)?.origin || null;
}

/** For logs and the audit line: an origin, never a command line or an address. */
function logLabel(c) {
  const transport = transportOf(c);
  if (transport === 'stdio') return 'local server';
  if (transport === 'builtin') return c.kind;
  return connectionOrigin(c) || 'endpoint';
}

/**
 * Whether the org policy allows this connection: the endpoint allowlist for
 * URLs; for a local command, localCommandsAllowed (off by default once an org
 * restricts endpoints); for Email drafts, emailDraftsAllowed.
 */
function connectionAllowed(c, policy) {
  const transport = transportOf(c);
  if (transport === 'builtin') return policy.emailDraftsAllowed !== false;
  if (transport === 'stdio') return policy.localCommandsAllowed !== false;
  return allowedByList(c.url, policy.endpointAllowlist);
}

/** How a local command reads in the UI: the command and its arguments, bounded. */
function commandLine(c) {
  const text = [c.command, ...(Array.isArray(c.args) ? c.args : [])].map((a) => (/\s/.test(a) ? JSON.stringify(a) : a)).join(' ');
  return text.length > 300 ? `${text.slice(0, 299)}…` : text;
}

/** Public view of a connection for the renderer: no secrets, a locality, the policy verdict. */
function publicConnection(c, policy) {
  const transport = transportOf(c);
  return {
    id: c.id,
    name: c.name,
    url: c.url || '',
    origin: connectionOrigin(c),
    locality: localityOf(c),
    kind: c.kind,
    transport,
    builtin: transport === 'builtin',
    ...(transport === 'stdio' ? { command: commandLine(c), envKeys: Array.isArray(c.envKeys) ? c.envKeys : [] } : {}),
    auth: c.auth,
    headerName: c.headerName || null,
    enabled: c.enabled === true,
    account: c.account || null,
    status: c.status || 'ok',
    tools: (c.tools || []).map((t) => ({ name: t.name, title: t.title || null, description: t.description || '', readOnly: t.readOnly === true })),
    toolsFetchedAt: c.toolsFetchedAt || null,
    blockedByPolicy: !connectionAllowed(c, policy),
  };
}

const LOCAL_ERROR_CODES = new Set(['command-not-found', 'local-timeout', 'local-exited', 'local-failed']);

function createActionsService({
  userDataDir,
  safeStorage,
  fetch: fetchImpl,
  openAuthorizeUrl,
  runSuggest,
  getPolicy = async () => ({ actionsEnabled: true, endpointAllowlist: null, managed: false }),
  log = () => {},
  now = () => Date.now(),
  createClient,
  createTransport,
  startLoopback = defaultStartLoopback,
  clientInfo = { name: 'Steno', version: '0' },
  clientMetadataUrl = oauth.CLIENT_METADATA_URL,
  fs = nodeFs,
  path = nodePath,
  oauthTimeoutMs,
  // Email drafts: open a mailto: URL (validated again by the caller) and
  // put a long body on the clipboard.
  openMailto = async () => { throw new Error('openMailto not configured'); },
  writeClipboard = null,
  // Local command servers: a native confirmation of exactly what will run,
  // before it is saved. Absent means local commands cannot be added.
  confirmLocalCommand = null,
  stdioPool = null,
}) {
  const connections = createConnectionsStore({ file: path.join(userDataDir, 'mcp-connections.json'), fs, path, now });
  const local = stdioPool || createStdioPool({ clientInfo, log });
  const secrets = createSecretStore({ dir: path.join(userDataDir, 'mcp-credentials'), safeStorage, fs, path });
  const audit = createAuditLog({ file: path.join(userDataDir, 'mcp-actions-audit.jsonl'), fs, path, now: () => new Date(now()) });
  const cardsDir = path.join(userDataDir, 'mcp-actions');
  const tokenManagers = new Map();
  const running = new Set();
  const simpleCache = new Map(); // connection id -> { key, at, actions }
  let activeAuth = null;

  const secretKey = (id) => `conn:${id}`;
  const registrationKey = (issuer) => `dcr:${issuer}`;

  const registrations = {
    get: async (issuer) => secrets.load(registrationKey(issuer), originOf(issuer)),
    save: async (issuer, record) => secrets.save(registrationKey(issuer), originOf(issuer), record),
  };

  // ── policy ────────────────────────────────────────────────────────────
  async function policy() {
    try {
      const p = await getPolicy();
      const endpointAllowlist = Array.isArray(p?.endpointAllowlist) ? p.endpointAllowlist : null;
      return {
        actionsEnabled: p?.actionsEnabled !== false,
        endpointAllowlist,
        // An org that restricts endpoints has not allowed arbitrary local
        // programs either, unless it says so.
        localCommandsAllowed: p?.localCommandsAllowed === true || (p?.localCommandsAllowed !== false && !endpointAllowlist),
        emailDraftsAllowed: p?.emailDraftsAllowed !== false,
        managed: p?.managed === true,
        reason: p?.reason || null,
      };
    } catch (_) {
      // getPolicy is expected to fail closed itself; this is the backstop.
      return {
        actionsEnabled: false, endpointAllowlist: [], localCommandsAllowed: false, emailDraftsAllowed: false, managed: true, reason: 'policy-unavailable',
      };
    }
  }

  function notAllowedError(connection) {
    const transport = transportOf(connection);
    if (transport === 'stdio') return new ActionError('local-not-allowed', 'Your organisation does not allow local commands');
    if (transport === 'builtin') return new ActionError('email-not-allowed', 'Your organisation has turned off email drafts');
    return new ActionError('endpoint-not-allowed', 'Your organisation does not allow this endpoint');
  }

  /** Policy check before any call. `target`: a connection, or a URL about to be added. */
  async function assertAllowed(target) {
    const p = await policy();
    if (!p.actionsEnabled) throw new ActionError('disabled-by-org', 'Your organisation has turned off actions');
    if (!target) return p;
    const connection = typeof target === 'string' ? { url: target } : target;
    if (!connectionAllowed(connection, p)) throw notAllowedError(connection);
    return p;
  }

  // ── built-in Email drafts ─────────────────────────────────────────────
  // Not stored as a connection: always present, on unless the user (or the
  // org) turned it off. It has one tool, draft_email, run locally on Approve.
  function emailConnection() {
    return {
      id: email.EMAIL_CONNECTION_ID,
      name: 'Email',
      url: null,
      transport: 'builtin',
      kind: email.EMAIL_KIND,
      auth: 'none',
      enabled: connections.getBuiltinEnabled(email.EMAIL_KIND),
      status: 'ok',
      account: null,
      tools: [email.EMAIL_TOOL],
      toolsFetchedAt: 1,
    };
  }

  function getConnection(id) {
    return id === email.EMAIL_CONNECTION_ID ? emailConnection() : connections.get(id);
  }

  function allConnections() {
    return [...connections.list(), emailConnection()];
  }

  // ── local command servers ─────────────────────────────────────────────
  const localSecretOrigin = (connection) => `local:${connection.id}`;

  function stdioSpec(connection) {
    const saved = secrets.load(secretKey(connection.id), localSecretOrigin(connection));
    const env = saved && saved.type === 'env' && saved.env && typeof saved.env === 'object' ? saved.env : {};
    if ((connection.envKeys || []).some((k) => typeof env[k] !== 'string')) {
      throw new ActionError('needs-auth', 'The environment variables for this command are missing');
    }
    return { id: connection.id, command: connection.command, args: connection.args || [], env };
  }

  /** tools/list on any transport. */
  async function listToolsOf(connection) {
    const transport = transportOf(connection);
    if (transport === 'builtin') return connection.tools;
    if (transport === 'stdio') return local.listTools(stdioSpec(connection));
    return remote.listTools(clientOptions(connection));
  }

  /** One tool call on any transport: { isError, link, text, clipboard? }. */
  async function callToolOf(connection, name, args) {
    const transport = transportOf(connection);
    if (transport === 'builtin') {
      if (name !== email.EMAIL_TOOL_NAME) throw new ActionError('tool-unavailable', 'Unknown action');
      try {
        return await email.runDraftEmail(args, { openMailto, writeClipboard });
      } catch (e) {
        if (e instanceof email.EmailDraftError) throw new ActionError('invalid-arguments', 'Check the email addresses');
        throw new ActionError('mail-app-failed', 'Could not open your mail app');
      }
    }
    if (transport === 'stdio') return local.callTool(stdioSpec(connection), name, args);
    return remote.callTool(clientOptions(connection), name, args);
  }

  // ── auth ──────────────────────────────────────────────────────────────
  function tokenManagerFor(connection) {
    let tm = tokenManagers.get(connection.id);
    if (tm && tm.url === connection.url) return tm;
    const origin = originOf(connection.url);
    tm = new oauth.TokenManager({
      load: async () => {
        const v = secrets.load(secretKey(connection.id), origin);
        return v && v.type === 'oauth' ? v : null;
      },
      save: async (record) => secrets.save(secretKey(connection.id), origin, { ...record, type: 'oauth' }),
      fetch: fetchImpl,
      now,
    });
    tm.url = connection.url;
    tokenManagers.set(connection.id, tm);
    return tm;
  }

  function markNeedsReauth(connection) {
    connections.update(connection.id, { status: 'needs-auth' });
  }

  /** { authProvider?, headers } for one connection. Throws if its secret is gone. */
  function authFor(connection) {
    const origin = originOf(connection.url);
    if (connection.auth === 'none') return { headers: {} };
    if (connection.auth === 'bearer' || connection.auth === 'header') {
      const secret = secrets.load(secretKey(connection.id), origin);
      if (!secret || !isValidToken(secret.token)) throw new ActionError('needs-auth', 'The token for this connection is missing');
      if (connection.auth === 'bearer') return { authProvider: { token: async () => secret.token }, headers: {} };
      return { headers: { [connection.headerName]: secret.token } };
    }
    const tm = tokenManagerFor(connection);
    let last = null;
    return {
      headers: {},
      authProvider: {
        token: async () => {
          try {
            last = await tm.accessToken();
            return last;
          } catch (e) {
            if (e instanceof oauth.ReauthRequiredError) markNeedsReauth(connection);
            throw e;
          }
        },
        onUnauthorized: async () => {
          try {
            await tm.refresh(last);
          } catch (e) {
            if (e instanceof oauth.ReauthRequiredError) markNeedsReauth(connection);
            throw e;
          }
        },
      },
    };
  }

  function clientOptions(connection) {
    const auth = authFor(connection);
    return {
      url: connection.url,
      ...auth,
      fetch: fetchImpl,
      clientInfo,
      ...(createClient ? { createClient } : {}),
      ...(createTransport ? { createTransport } : {}),
    };
  }

  function classifyError(e) {
    const name = e?.constructor?.name || e?.name || '';
    if (e instanceof oauth.ReauthRequiredError || name === 'UnauthorizedError' || e?.code === 'needs-auth' || /\b401\b/.test(String(e?.message))) {
      return 'needs-auth';
    }
    if (e instanceof ActionError) return e.code;
    if (typeof e?.code === 'string' && LOCAL_ERROR_CODES.has(e.code)) return e.code;
    return 'error';
  }

  // ── connections ───────────────────────────────────────────────────────
  async function list() {
    const p = await policy();
    return {
      connections: allConnections().map((c) => publicConnection(c, p)),
      connectors: publicCatalogue(),
      autoSuggest: connections.getAutoSuggest(),
      policy: {
        actionsEnabled: p.actionsEnabled,
        managed: p.managed,
        endpointAllowlist: p.endpointAllowlist,
        localCommandsAllowed: p.localCommandsAllowed,
        emailDraftsAllowed: p.emailDraftsAllowed,
        reason: p.reason,
      },
      secureStorage: secrets.available(),
    };
  }

  async function refreshTools(id) {
    const connection = getConnection(id);
    if (!connection) throw new ActionError('not-found', 'Connection not found');
    if (transportOf(connection) === 'builtin') return publicConnection(connection, await policy());
    await assertAllowed(connection);
    try {
      const tools = await listToolsOf(connection);
      connections.update(id, { tools, toolsFetchedAt: now(), status: 'ok', lastError: null });
      log(`[actions] ${logLabel(connection)} listed ${tools.length} tools`);
    } catch (e) {
      const status = classifyError(e);
      connections.update(id, { status: status === 'needs-auth' ? 'needs-auth' : 'error', lastError: status });
      log(`[actions] ${logLabel(connection)} tools/list failed (${status})`);
      const message = status === 'needs-auth' ? 'Sign in again to use this connection'
        : transportOf(connection) === 'stdio' ? 'Could not start this command' : 'Could not reach this endpoint';
      throw new ActionError(status, message);
    }
    return publicConnection(connections.get(id), await policy());
  }

  /**
   * Add a command that runs on this computer as an MCP server over stdio.
   * The user confirms exactly what will run in a native dialog first; the
   * environment values are stored encrypted, like tokens.
   */
  async function addLocal({ name, command, args, env } = {}) {
    let spec;
    try {
      spec = normalizeLocalCommand({ command, args, env });
    } catch (e) {
      if (e.code === 'env-not-allowed') {
        // Validated here, in main, whatever the renderer checked: these
        // variables make a runtime load or run code of their own.
        const err = new ActionError('env-not-allowed', `${e.variable} cannot be set for a local server`);
        err.variable = e.variable;
        throw err;
      }
      throw new ActionError(e.code || 'invalid-command', 'Check the command');
    }
    const p = await assertAllowed();
    if (!p.localCommandsAllowed) throw new ActionError('local-not-allowed', 'Your organisation does not allow local commands');
    const envKeys = Object.keys(spec.env);
    if (envKeys.length && !secrets.available()) throw new ActionError('secure-storage', 'Could not store the variables securely');
    if (typeof confirmLocalCommand !== 'function') throw new ActionError('local-not-allowed', 'Local commands are not available');
    // The dialog shows the same cleaned name the connection will carry, and
    // the variable values, not only their names (local-command-confirm.js).
    const shownName = cleanName(name, '');
    const confirmed = await confirmLocalCommand({ name: shownName, command: spec.command, args: spec.args, envKeys, env: spec.env });
    if (confirmed !== true) throw new ActionError('not-confirmed', 'Not added');
    const connection = connections.addLocal({ name: shownName, command: spec.command, args: spec.args, envKeys });
    if (envKeys.length) {
      try {
        secrets.save(secretKey(connection.id), localSecretOrigin(connection), { type: 'env', env: spec.env });
      } catch (_) {
        connections.remove(connection.id);
        throw new ActionError('secure-storage', 'Could not store the variables securely');
      }
    }
    log('[actions] local server added');
    try {
      return await refreshTools(connection.id);
    } catch (_) {
      // Kept, so the user can see the problem and retry or remove it.
      return publicConnection(connections.get(connection.id), await policy());
    }
  }

  /** Add a custom endpoint (bearer / header / none) and list its tools. */
  async function addCustom({ name, url, auth, headerName, token }) {
    const endpoint = normalizeEndpointUrl(url);
    if (!endpoint) throw new ActionError('invalid-url', 'Enter an https URL, or http on this computer or your network');
    if (!['none', 'bearer', 'header', 'oauth'].includes(auth)) throw new ActionError('invalid-auth', 'Choose how to sign in');
    if ((auth === 'bearer' || auth === 'header') && !isValidToken(token)) throw new ActionError('invalid-token', 'Enter the token');
    if (auth === 'header' && !normalizeHeaderName(headerName)) throw new ActionError('invalid-header', 'Enter a valid header name');
    await assertAllowed(endpoint.url);
    const connection = connections.add({ name, url: endpoint.url, kind: 'custom', auth, headerName });
    try {
      if (auth === 'bearer' || auth === 'header') {
        secrets.save(secretKey(connection.id), endpoint.origin, { type: auth, token });
      }
    } catch (e) {
      connections.remove(connection.id);
      throw new ActionError('secure-storage', 'Could not store the token securely');
    }
    if (auth === 'oauth') return authorize(connection.id);
    try {
      return await refreshTools(connection.id);
    } catch (e) {
      // Keep the connection so the user can see the problem and retry or remove it.
      return publicConnection(connections.get(connection.id), await policy());
    }
  }

  async function connectConnector(connectorId) {
    const connector = connectorById(connectorId);
    if (!connector) throw new ActionError('not-found', 'Unknown connector');
    if (connector.status !== 'available' && !connector.staticClient) {
      throw new ActionError('needs-registration', 'This connector is not available yet');
    }
    await assertAllowed(connector.url);
    const existing = connections.list().find((c) => c.kind === connector.id);
    if (existing) return authorize(existing.id);
    const connection = connections.add({ name: connector.name, url: connector.url, kind: connector.id, auth: 'oauth' });
    connections.update(connection.id, { status: 'needs-auth' });
    try {
      return await authorize(connection.id);
    } catch (e) {
      remove(connection.id);
      throw e;
    }
  }

  async function probe(url) {
    const res = await fetchImpl(url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
        'mcp-protocol-version': MCP_PROTOCOL_PROBE_VERSION,
      },
      body: JSON.stringify({
        jsonrpc: '2.0', id: 0, method: 'initialize',
        params: { protocolVersion: MCP_PROTOCOL_PROBE_VERSION, capabilities: {}, clientInfo },
      }),
    });
    try { await res.body?.cancel?.(); } catch (_) {}
    return { status: res.status, challenge: oauth.parseWwwAuthenticate(res.headers.get('www-authenticate')) };
  }

  function cancelAuthorize() {
    if (!activeAuth) return false;
    activeAuth.close();
    activeAuth = null;
    return true;
  }

  /** OAuth 2.1 sign-in for an existing OAuth connection. Resolves the public connection. */
  async function authorize(id) {
    const connection = connections.get(id);
    if (!connection) throw new ActionError('not-found', 'Connection not found');
    if (connection.auth !== 'oauth') throw new ActionError('invalid-auth', 'This connection does not use sign-in');
    await assertAllowed(connection.url);
    cancelAuthorize();
    const serverUrl = new URL(connection.url);
    const allowLoopbackHttp = serverUrl.protocol === 'http:' && oauth.isLoopbackHost(serverUrl.hostname);
    const vendor = connectorById(connection.kind);

    let flow;
    try {
      const { challenge } = await probe(connection.url);
      const pr = await oauth.discoverProtectedResource({ serverUrl: connection.url, fetch: fetchImpl, challenge, allowLoopbackHttp });
      const asMeta = await oauth.discoverAuthServer({ issuer: pr.issuer, fetch: fetchImpl, allowLoopbackHttp });
      const cached = vendor?.noDcrCache ? null : await registrations.get(pr.issuer);
      let preferredPort = 0;
      try {
        if (cached?.redirect_uri) preferredPort = Number(new URL(cached.redirect_uri).port) || 0;
      } catch (_) { /* ignore */ }
      const state = oauth.randomState();
      flow = await startLoopback({ state, preferredPort, ...(oauthTimeoutMs ? { timeoutMs: oauthTimeoutMs } : {}) });
      activeAuth = flow;
      const previous = secrets.load(secretKey(id), originOf(connection.url));
      const scope = [pr.scope, previous?.tokens?.scope]
        .filter(Boolean).join(' ').split(/\s+/).filter((s, i, all) => s && all.indexOf(s) === i).join(' ');
      const client = await oauth.chooseClient({
        asMeta, issuer: pr.issuer, redirectUri: flow.redirectUri, scope, fetch: fetchImpl, registrations, vendor, clientMetadataUrl,
      });
      const pkce = oauth.pkcePair();
      const authorizeUrl = oauth.buildAuthorizeUrl({
        asMeta, client, redirectUri: flow.redirectUri, state, challenge: pkce.challenge, scope, resource: pr.resource,
      });
      await openAuthorizeUrl(authorizeUrl);
      const { code } = await flow.result;
      const tokens = await oauth.exchangeCode({
        fetch: fetchImpl, asMeta, client, code, verifier: pkce.verifier, redirectUri: flow.redirectUri, resource: pr.resource, now: now(),
      });
      secrets.save(secretKey(id), originOf(connection.url), {
        type: 'oauth',
        tokens,
        // A public client's id is enough; a confidential client's secret stays in this envelope.
        client: { client_id: client.client_id, client_secret: client.client_secret, token_endpoint_auth_method: client.token_endpoint_auth_method },
        asMeta: { issuer: asMeta.issuer, token_endpoint: asMeta.token_endpoint, authorization_endpoint: asMeta.authorization_endpoint },
        resource: pr.resource,
      });
      tokenManagers.delete(id);
      connections.update(id, { status: 'ok', lastError: null });
      log(`[actions] ${originOf(connection.url)} signed in (${client.method})`);
    } catch (e) {
      const code = e?.code || 'error';
      const provider = e?.providerError
        ? ` provider=${e.providerError}${e.providerDescription ? ` "${redactProviderText(e.providerDescription)}"` : ''}`
        : '';
      log(`[actions] ${originOf(connection.url)} sign-in failed (${code})${provider}`);
      connections.update(id, { status: 'needs-auth' });
      if (e instanceof ActionError) throw e;
      const mapped = authorizeFailureCode(connection.kind, e);
      if (mapped) throw new ActionError(mapped, 'Sign-in did not complete');
      throw new ActionError(code === 'cancelled' || code === 'timeout' || code === 'denied' ? code : (e instanceof oauth.OAuthFlowError ? code : 'auth-failed'),
        code === 'needs-registration' ? 'This service needs Steno to be registered with it first' : 'Sign-in did not complete');
    } finally {
      if (flow && activeAuth === flow) activeAuth = null;
      if (flow) flow.close();
    }
    try {
      return await refreshTools(id);
    } catch (_) {
      return publicConnection(connections.get(id), await policy());
    }
  }

  async function setEnabled(id, enabled) {
    if (id === email.EMAIL_CONNECTION_ID) {
      connections.setBuiltinEnabled(email.EMAIL_KIND, enabled === true);
      return publicConnection(emailConnection(), await policy());
    }
    const c = connections.update(id, { enabled: enabled === true });
    if (!c) throw new ActionError('not-found', 'Connection not found');
    if (!c.enabled && transportOf(c) === 'stdio') local.stop(id);
    return publicConnection(c, await policy());
  }

  function remove(id) {
    if (id === email.EMAIL_CONNECTION_ID) throw new ActionError('invalid-state', 'Turn Email drafts off instead');
    tokenManagers.delete(id);
    local.stop(id);
    secrets.remove(secretKey(id));
    return connections.remove(id);
  }

  /** App quit: stop every local server now. */
  function shutdown() {
    local.stopAll({ sync: true });
  }

  function setAutoSuggest(value) {
    return connections.setAutoSuggest(value === true);
  }

  // ── cards ─────────────────────────────────────────────────────────────
  function cardsFile(summaryPath) {
    const id = crypto.createHash('sha256').update(path.basename(summaryPath)).digest('hex').slice(0, 32);
    return path.join(cardsDir, `${id}.json`);
  }

  function readCards(summaryPath) {
    try {
      const data = JSON.parse(fs.readFileSync(cardsFile(summaryPath), 'utf8'));
      return Array.isArray(data.cards) ? data.cards : [];
    } catch (_) {
      return [];
    }
  }

  function writeCards(summaryPath, cards) {
    fs.mkdirSync(cardsDir, { recursive: true });
    const file = cardsFile(summaryPath);
    const tmp = `${file}.${process.pid}.${crypto.randomUUID()}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify({ version: 1, note: path.basename(summaryPath), cards }, null, 2), { mode: 0o600 });
    fs.renameSync(tmp, file);
  }

  function enrichCard(card, p) {
    const connection = getConnection(card.connectionId);
    const tool = connection?.tools?.find((t) => t.name === card.tool) || null;
    // A simple action's card edits the flat fields; card.tool is the vendor
    // tool it translates to, and sendTemplate is how (see mcp-simple-actions.js).
    const simple = card.simple && typeof card.simple === 'object' ? card.simple : null;
    return {
      ...card,
      connectionName: connection?.name || card.connectionName,
      connectionAvailable: Boolean(connection && connection.enabled && tool && connectionAllowed(connection, p)),
      connectionKind: connection?.kind || null,
      origin: connection ? connectionOrigin(connection) : null,
      locality: connection ? localityOf(connection) : null,
      inputSchema: simple ? simple.schema : tool?.inputSchema || null,
      toolTitle: simple ? simple.title : tool?.title || null,
      toolDescription: simple ? simple.description || null : tool?.description || null,
      sendTemplate: simple ? simple.template : null,
    };
  }

  async function getCards(summaryPath) {
    const p = await policy();
    return readCards(summaryPath).map((c) => enrichCard(c, p));
  }

  function usableConnections(p) {
    return allConnections().filter((c) => c.enabled && c.status !== 'needs-auth'
      && connectionAllowed(c, p) && (c.tools || []).length > 0);
  }

  /**
   * Tool catalogue for the model: write-capable tools of enabled, allowed
   * connections. Tools the server marks destructive (delete, overwrite) are
   * never suggested.
   */
  function toolCatalogue(p) {
    const out = [];
    for (const c of usableConnections(p)) {
      for (const t of c.tools) {
        if (t.readOnly || t.destructive) continue;
        out.push({
          connection_id: c.id,
          connection_name: c.name,
          tool: t.name,
          description: (t.description || t.title || '').slice(0, 400),
          input_schema: compactSchema(t.inputSchema),
        });
        if (out.length >= MAX_PROMPT_TOOLS) return out;
      }
    }
    return out;
  }

  /** Run a vendor read tool for a simple action's prefetch; resolves the result text. */
  async function prefetchRead(connection, name, args) {
    await assertAllowed(connection.url);
    const res = await remote.callTool(clientOptions(connection), name, args);
    if (res.isError) {
      const err = new Error('prefetch failed');
      err.code = 'tool-error';
      throw err;
    }
    return res.text;
  }

  /**
   * The simple actions of one connection (mcp-simple-actions.js), prefetched
   * values included, cached for a few minutes per tools list. [] for an
   * unknown kind or when the vendor tool is missing: the generic path then.
   */
  async function simpleActionsOf(connection) {
    if (!simpleActions.hasSimpleActions(connection.kind)) return [];
    const key = `${connection.toolsFetchedAt || 0}:${(connection.tools || []).length}`;
    const hit = simpleCache.get(connection.id);
    if (hit && hit.key === key && now() - hit.at < SIMPLE_ACTIONS_TTL_MS) return hit.actions;
    const actions = await simpleActions.buildSimpleActions({
      kind: connection.kind,
      tools: connection.tools,
      read: (name, args) => prefetchRead(connection, name, args),
      log,
    });
    simpleCache.set(connection.id, { key, at: now(), actions });
    return actions;
  }

  /**
   * What the summariser is offered: a known connector's simple actions when
   * it has them, otherwise the connection's write tools (src/action_suggest.py
   * shortlists and compacts those against the note).
   */
  async function suggestCatalogue(p) {
    const out = [];
    for (const c of usableConnections(p)) {
      const simple = await simpleActionsOf(c);
      if (simple.length) {
        for (const a of simple) {
          out.push({
            connection_id: c.id, connection_name: c.name, tool: a.id, title: a.title, description: a.description,
            input_schema: a.schema, simple: true, simpleAction: a,
          });
        }
        continue;
      }
      if (transportOf(c) === 'builtin') {
        // Flat by design, so src/action_suggest.py always keeps it (like a
        // simple action); `kind` tells it to ground the recipients.
        out.push({
          connection_id: c.id, connection_name: c.name, tool: email.EMAIL_TOOL.name, title: email.EMAIL_TOOL.title,
          description: email.EMAIL_TOOL.description, input_schema: email.EMAIL_TOOL.inputSchema, simple: true, kind: c.kind,
        });
        continue;
      }
      for (const t of c.tools) {
        if (t.readOnly || t.destructive) continue;
        out.push({
          connection_id: c.id,
          connection_name: c.name,
          tool: t.name,
          title: t.title || null,
          description: (t.description || t.title || '').slice(0, 400),
          input_schema: compactSchema(t.inputSchema),
        });
        if (out.length >= MAX_PROMPT_TOOLS) return out;
      }
    }
    return out;
  }

  async function hasUsableConnections() {
    const p = await policy();
    return p.actionsEnabled && toolCatalogue(p).length > 0;
  }

  /**
   * Ask the summariser for up to five tool calls for this note. `auto` is the
   * after-generation path: it respects the auto-suggest setting and never
   * replaces cards the note already has.
   */
  async function suggest(summaryPath, { auto = false } = {}) {
    const p = await policy();
    if (!p.actionsEnabled) throw new ActionError('disabled-by-org', 'Your organisation has turned off actions');
    const existing = readCards(summaryPath);
    if (auto && (!connections.getAutoSuggest() || existing.length > 0)) return { skipped: true, cards: existing.map((c) => enrichCard(c, p)) };
    if (!toolCatalogue(p).length) {
      if (auto) return { skipped: true, cards: [] };
      throw new ActionError('no-connections', 'Connect a tool first');
    }
    // After each note, only when the user connected something: the built-in
    // Email drafts alone never start a model run nobody asked for.
    if (auto && !usableConnections(p).some((c) => transportOf(c) !== 'builtin')) return { skipped: true, cards: [] };
    const catalogue = await suggestCatalogue(p);

    const tmpDir = path.join(userDataDir, 'tmp');
    fs.mkdirSync(tmpDir, { recursive: true });
    const toolsFile = path.join(tmpDir, `mcp-tools-${crypto.randomUUID()}.json`);
    const forModel = catalogue.map(({ simpleAction, ...entry }) => entry);
    fs.writeFileSync(toolsFile, JSON.stringify({ tools: forModel, max_proposals: MAX_PROPOSALS }), { mode: 0o600, flag: 'wx' });
    let result;
    try {
      result = await runSuggest(summaryPath, toolsFile);
    } finally {
      try { fs.unlinkSync(toolsFile); } catch (_) {}
    }
    if (!result || result.success !== true) {
      throw new ActionError(result?.error_code || 'suggest-failed', 'Could not suggest actions');
    }

    const byKey = new Map(catalogue.map((t) => [`${t.connection_id}\u0000${t.tool}`, t]));
    const proposals = (Array.isArray(result.proposals) ? result.proposals : []).slice(0, MAX_PROPOSALS);
    // The note context the Python side showed the model (title, summary,
    // action items): what a proposal must cite and draw identifiers from.
    const note = result.note && typeof result.note === 'object' ? result.note : null;
    const fresh = [];
    const dropped = { uncited: 0, placeholder: 0, 'ungrounded-id': 0, 'ungrounded-email': 0 };
    for (const proposal of proposals) {
      // src/action_suggest.py already repaired names; this is the backstop.
      const sameConnection = catalogue.filter((t) => t.connection_id === proposal.connection_id).map((t) => t.tool);
      const toolName = simpleActions.resolveToolName(proposal.tool, sameConnection);
      const entry = toolName ? byKey.get(`${proposal.connection_id}\u0000${toolName}`) : null;
      if (!entry || !proposal.arguments || typeof proposal.arguments !== 'object' || Array.isArray(proposal.arguments)) continue;
      const connection = getConnection(entry.connection_id);
      const simple = entry.simpleAction || null;
      const tool = connection.tools.find((t) => t.name === (simple ? simple.vendorTool : entry.tool));
      if (!tool) continue;
      const schema = simple ? simple.schema : tool.inputSchema;
      let args = simple ? simpleActions.coerceArguments(schema, proposal.arguments) : proposal.arguments;
      // A draft keeps only recipients written in the note; the user fills in the rest.
      if (transportOf(connection) === 'builtin') args = email.groundRecipients(simpleActions.coerceArguments(schema, args), noteText(note)).args;
      const check = checkProposal({ ...proposal, arguments: args }, schema, note);
      if (!check.ok) {
        dropped[check.reason] += 1;
        continue;
      }
      fresh.push({
        actionItem: check.actionItem.slice(0, 400),
        id: crypto.randomUUID(),
        connectionId: connection.id,
        connectionName: connection.name,
        tool: tool.name,
        ...(simple ? { simple: simpleCardPart(simple) } : {}),
        arguments: args,
        reason: typeof proposal.reason === 'string' ? proposal.reason.slice(0, 300) : '',
        validationErrors: validateArguments(schema, args),
        status: 'proposed',
        createdAt: now(),
        updatedAt: now(),
      });
    }
    // Keep the history (approved, failed, dismissed); replace open proposals.
    const cards = [...existing.filter((c) => c.status !== 'proposed'), ...fresh];
    writeCards(summaryPath, cards);
    const droppedTotal = Object.values(dropped).reduce((a, b) => a + b, 0);
    log(`[actions] suggested ${fresh.length} action(s) from ${proposals.length} proposal(s)`
      + (droppedTotal ? `; dropped ${droppedTotal} (uncited ${dropped.uncited}, placeholder ${dropped.placeholder}, invented id ${dropped['ungrounded-id']}, invented email ${dropped['ungrounded-email']})` : ''));
    return { skipped: false, cards: cards.map((c) => enrichCard(c, p)) };
  }

  function updateCard(summaryPath, cardId, patch) {
    const cards = readCards(summaryPath);
    const i = cards.findIndex((c) => c.id === cardId);
    if (i === -1) throw new ActionError('not-found', 'Action not found');
    cards[i] = { ...cards[i], ...patch, updatedAt: now() };
    writeCards(summaryPath, cards);
    return cards[i];
  }

  async function dismiss(summaryPath, cardId) {
    const card = readCards(summaryPath).find((c) => c.id === cardId);
    if (!card) throw new ActionError('not-found', 'Action not found');
    if (card.status === 'running' || card.status === 'done') throw new ActionError('invalid-state', 'This action can no longer be dismissed');
    updateCard(summaryPath, cardId, { status: 'dismissed' });
    return getCards(summaryPath);
  }

  /**
   * Run one approved action with exactly `args`. Re-checks policy, the
   * connection, that the tool is one it listed, and the schema.
   */
  async function approve(summaryPath, cardId, args) {
    const card = readCards(summaryPath).find((c) => c.id === cardId);
    if (!card) throw new ActionError('not-found', 'Action not found');
    if (card.status !== 'proposed' && card.status !== 'failed') throw new ActionError('invalid-state', 'This action has already run');
    if (running.has(cardId)) throw new ActionError('invalid-state', 'This action is already running');
    const connection = getConnection(card.connectionId);
    if (!connection || !connection.enabled) throw new ActionError('connection-unavailable', 'The connection for this action is off or removed');
    await assertAllowed(connection);
    const tool = (connection.tools || []).find((t) => t.name === card.tool);
    if (!tool) throw new ActionError('tool-unavailable', 'The endpoint no longer offers this tool');
    const simple = card.simple && typeof card.simple === 'object' ? card.simple : null;
    // A simple action is checked on its own flat fields (what the user
    // edited), then translated; the vendor payload is checked again.
    let errors = validateArguments(simple ? simple.schema : tool.inputSchema, args);
    const callArgs = simple && !errors.length ? simpleActions.fillTemplate(simple.template, args) : args;
    if (simple && !errors.length) errors = validateArguments(tool.inputSchema, callArgs);
    if (errors.length) {
      updateCard(summaryPath, cardId, { arguments: args, validationErrors: errors });
      const err = new ActionError('invalid-arguments', 'Some fields need fixing');
      err.validationErrors = errors;
      throw err;
    }

    running.add(cardId);
    updateCard(summaryPath, cardId, { status: 'running', arguments: args, validationErrors: [] });
    let outcome;
    try {
      const res = await callToolOf(connection, tool.name, callArgs);
      outcome = res.isError
        ? { status: 'failed', result: { status: 'tool-error', link: res.link, text: res.text, detail: failureDetail(res.text) } }
        : { status: 'done', result: { status: 'ok', link: res.link, text: res.text, ...(res.clipboard ? { clipboard: true } : {}) } };
    } catch (e) {
      const status = classifyError(e);
      if (status === 'needs-auth' && transportOf(connection) === 'http') connections.update(connection.id, { status: 'needs-auth' });
      outcome = { status: 'failed', result: { status, link: null, text: '', detail: status === 'needs-auth' ? '' : failureDetail(e?.message) } };
    } finally {
      running.delete(cardId);
    }
    audit.append({
      connectionId: connection.id,
      connectionName: connection.name,
      origin: connectionOrigin(connection) || logLabel(connection),
      tool: tool.name,
      arguments: callArgs,
      status: outcome.result.status,
      link: outcome.result.link,
      noteId: path.basename(cardsFile(summaryPath), '.json'),
    });
    log(`[actions] ${logLabel(connection)} ${tool.name} -> ${outcome.result.status}`);
    updateCard(summaryPath, cardId, { ...outcome, approvedAt: now() });
    return (await getCards(summaryPath)).find((c) => c.id === cardId);
  }

  function recent(limit = 50) {
    return audit.recent(limit);
  }

  // ── chat agent (chat-agent.js) ──────────────────────────────────────────
  // Chat offers the model the enabled connections' tools. Read-only tools run
  // straight away through callReadTool; anything else becomes an action card
  // (proposeChatAction) under a chat key instead of a note, and runs only
  // through the same approve() as a note's cards: same validation, policy
  // re-check and audit line. Destructive tools are never offered.

  /**
   * Tools the chat model may use, per enabled and allowed connection. A known
   * connector's simple actions come first; `simpleOnly` (a small local model)
   * offers only those for that connector instead of its raw vendor tools.
   */
  async function chatToolset({ simpleOnly = false } = {}) {
    const p = await policy();
    if (!p.actionsEnabled) return [];
    const out = [];
    for (const c of usableConnections(p)) {
      const simple = await simpleActionsOf(c);
      for (const a of simple) {
        out.push({
          connectionId: c.id,
          connectionName: c.name,
          tool: a.id,
          title: a.title,
          description: a.description,
          inputSchema: a.schema,
          readOnly: false,
          simple: a,
        });
      }
      if (simpleOnly && simple.length) continue;
      for (const t of c.tools) {
        if (t.destructive) continue;
        out.push({
          connectionId: c.id,
          connectionName: c.name,
          tool: t.name,
          title: t.title || null,
          description: (t.description || t.title || '').slice(0, 400),
          inputSchema: compactSchema(t.inputSchema),
          readOnly: t.readOnly === true,
        });
        if (out.length >= MAX_PROMPT_TOOLS) return out;
      }
    }
    return out;
  }

  function chatTool(connectionId, toolName) {
    const connection = getConnection(connectionId);
    if (!connection || !connection.enabled) throw new ActionError('connection-unavailable', 'The connection is off or removed');
    const tool = (connection.tools || []).find((t) => t.name === toolName);
    if (!tool || tool.destructive) throw new ActionError('tool-unavailable', 'The endpoint does not offer this tool');
    return { connection, tool };
  }

  /** Run a tool the server marks read-only. Returns { text, isError }. */
  async function callReadTool(connectionId, toolName, args) {
    const { connection, tool } = chatTool(connectionId, toolName);
    if (!tool.readOnly) throw new ActionError('not-read-only', 'This tool needs approval');
    await assertAllowed(connection);
    const errors = validateArguments(tool.inputSchema, args);
    if (errors.length) return { isError: true, text: `Invalid arguments: ${errors.map((e) => `${e.path} ${e.message}`).join('; ')}` };
    try {
      const res = await callToolOf(connection, tool.name, args);
      log(`[actions] chat read ${logLabel(connection)} ${tool.name} -> ${res.isError ? 'tool-error' : 'ok'}`);
      return { isError: res.isError, text: res.text };
    } catch (e) {
      const status = classifyError(e);
      if (status === 'needs-auth' && transportOf(connection) === 'http') connections.update(connection.id, { status: 'needs-auth' });
      log(`[actions] chat read ${logLabel(connection)} ${tool.name} -> ${status}`);
      return { isError: true, text: status === 'needs-auth' ? 'The connection needs the user to sign in again.' : 'The tool could not be reached.' };
    }
  }

  /**
   * Turn a model's write call into an action card under `chatKey`. Required
   * arguments that are missing or placeholders are refused (the model is told
   * to ask the user) rather than shown as a card.
   */
  async function proposeChatAction(chatKey, { connectionId, tool: toolName, arguments: args, reason, simple: simpleId }) {
    const p = await policy();
    if (!p.actionsEnabled) throw new ActionError('disabled-by-org', 'Your organisation has turned off actions');
    let connection;
    let tool;
    let simple = null;
    if (typeof simpleId === 'string' && simpleId) {
      // Looked up again here rather than trusted from the caller.
      connection = getConnection(connectionId);
      if (!connection || !connection.enabled) throw new ActionError('connection-unavailable', 'The connection is off or removed');
      simple = (await simpleActionsOf(connection)).find((a) => a.id === simpleId) || null;
      tool = simple ? (connection.tools || []).find((t) => t.name === simple.vendorTool) : null;
      if (!simple || !tool) throw new ActionError('tool-unavailable', 'The endpoint does not offer this tool');
    } else {
      ({ connection, tool } = chatTool(connectionId, toolName));
      if (tool.readOnly) throw new ActionError('invalid-state', 'Read-only tools do not need approval');
    }
    if (!connectionAllowed(connection, p)) throw notAllowedError(connection);
    const schema = simple ? simple.schema : tool.inputSchema;
    const raw = args && typeof args === 'object' && !Array.isArray(args) ? args : {};
    let safeArgs = simple ? simpleActions.coerceArguments(schema, raw) : raw;
    if (transportOf(connection) === 'builtin') {
      // The user may have typed the addresses in chat; drop only example
      // or malformed ones, which the card would refuse anyway.
      safeArgs = simpleActions.coerceArguments(schema, safeArgs);
      for (const key of ['to', 'cc']) {
        if (!Object.hasOwn(safeArgs, key)) continue;
        const list = (Array.isArray(safeArgs[key]) ? safeArgs[key] : [safeArgs[key]]).filter((v) => typeof v === 'string' && !email.isPlaceholderEmail(v));
        safeArgs = { ...safeArgs, [key]: list.map((v) => v.trim()) };
        if (!list.length) delete safeArgs[key];
      }
    }
    const missing = placeholderArguments(schema, safeArgs);
    if (missing.length) return { rejected: 'placeholder', missing };
    const card = {
      id: crypto.randomUUID(),
      connectionId: connection.id,
      connectionName: connection.name,
      tool: tool.name,
      ...(simple ? { simple: simpleCardPart(simple) } : {}),
      arguments: safeArgs,
      reason: typeof reason === 'string' ? reason.slice(0, 300) : '',
      validationErrors: validateArguments(schema, safeArgs),
      status: 'proposed',
      createdAt: now(),
      updatedAt: now(),
    };
    writeCards(chatKey, [...readCards(chatKey), card]);
    return { card: enrichCard(card, p) };
  }

  return {
    list, addCustom, addLocal, shutdown, connectConnector, authorize, cancelAuthorize, refreshTools, setEnabled, remove, setAutoSuggest,
    getCards, suggest, approve, dismiss, recent, hasUsableConnections,
    chatToolset, callReadTool, proposeChatAction,
    // exposed for tests
    _stores: { connections, secrets, audit, cardsFile, local },
  };
}

/** What a card keeps of a simple action: enough to edit, preview and translate it. */
function simpleCardPart(action) {
  return { action: action.id, title: action.title, description: action.description, schema: action.schema, template: action.template };
}

/**
 * The endpoint's own failure message for the card's Details disclosure: the
 * tool result's error text or the JSON-RPC error message, one paragraph,
 * about 300 characters, with tokens and credentialed URLs redacted.
 */
function failureDetail(text) {
  if (typeof text !== 'string' || !text.trim()) return '';
  const flat = redactCredentials(text)
    .replace(/https?:\/\/[^\s/@]+:[^\s/@]+@\S+/gi, '[redacted-url]')
    .replace(/[\u0000-\u001f\u007f]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return flat.length > 300 ? `${flat.slice(0, 299)}…` : flat;
}

/** Provider text for the log only: one line, no credentials, no email addresses. */
function redactProviderText(text) {
  return redactCredentials(String(text))
    .replace(/[\u0000-\u001f\u007f]+/g, ' ')
    .replace(/[^\s@"]+@[^\s@"]+/g, '[email]')
    .slice(0, 200);
}

/**
 * Provider-specific meaning of a failed authorize callback, or null for the
 * generic handling. Atlassian's Rovo MCP refuses accounts with no Jira or
 * Confluence site ("Your account isn't associated with a supported site"),
 * either as an error callback whose description mentions the site, or by
 * ending the flow without a code. A plain access_denied (the user clicked
 * Cancel) keeps the generic "denied".
 */
function authorizeFailureCode(kind, err) {
  if (kind !== 'atlassian' || !err) return null;
  if (err.code === 'no-code') return 'atlassian-no-site';
  if ((err.code === 'denied' || err.code === 'authorize-failed')
    && /\b(site|supported)\b/i.test(String(err.providerDescription || ''))) {
    return 'atlassian-no-site';
  }
  return null;
}

module.exports = { createActionsService, ActionError, allowedByList, publicConnection, connectionAllowed, authorizeFailureCode, redactProviderText, failureDetail };
