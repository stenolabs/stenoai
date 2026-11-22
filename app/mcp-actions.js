'use strict';

/**
 * Suggested actions: the service behind the Connect page's "Turn meetings
 * into actions" section and the action cards under a note.
 *
 *   connections  mcp-connections.js (config) + mcp-secret-store.js (secrets)
 *   auth         bearer / custom header token, or OAuth 2.1 (mcp-oauth.js)
 *   transport    Streamable HTTP (mcp-remote-client.js)
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
 *   - The org adapter's policy (actions disabled / endpoint allowlist) is
 *     checked before every network call, not only when the UI renders.
 *   - Tokens never reach logs, errors, the renderer or a child process.
 *
 * Electron-free: everything with side effects is injected, so the whole flow
 * runs under node --test against the mock MCP server (mcp-actions.test.js).
 */

const crypto = require('node:crypto');
const nodeFs = require('node:fs');
const nodePath = require('node:path');

const oauth = require('./mcp-oauth');
const remote = require('./mcp-remote-client');
const { createConnectionsStore, normalizeEndpointUrl, normalizeHeaderName } = require('./mcp-connections');
const { createSecretStore } = require('./mcp-secret-store');
const { createAuditLog } = require('./mcp-audit-log');
const { connectorById, publicCatalogue } = require('./mcp-connectors');
const { validateArguments, compactSchema } = require('./mcp-schema');
const { startLoopback: defaultStartLoopback } = require('./mcp-oauth-loopback');
const { redactCredentials } = require('./diagnostics-filter');

const MAX_PROPOSALS = 5;
const MAX_PROMPT_TOOLS = 60;
const MAX_TOKEN_LENGTH = 8192;
const MCP_PROTOCOL_PROBE_VERSION = '2025-06-18';

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

/** Public view of a connection for the renderer: no secrets, a locality, the policy verdict. */
function publicConnection(c, policy) {
  const endpoint = normalizeEndpointUrl(c.url);
  return {
    id: c.id,
    name: c.name,
    url: c.url,
    origin: endpoint ? endpoint.origin : null,
    locality: endpoint ? endpoint.locality : 'internet',
    kind: c.kind,
    auth: c.auth,
    headerName: c.headerName || null,
    enabled: c.enabled === true,
    account: c.account || null,
    status: c.status || 'ok',
    tools: (c.tools || []).map((t) => ({ name: t.name, title: t.title || null, description: t.description || '', readOnly: t.readOnly === true })),
    toolsFetchedAt: c.toolsFetchedAt || null,
    blockedByPolicy: !allowedByList(c.url, policy.endpointAllowlist),
  };
}

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
}) {
  const connections = createConnectionsStore({ file: path.join(userDataDir, 'mcp-connections.json'), fs, path, now });
  const secrets = createSecretStore({ dir: path.join(userDataDir, 'mcp-credentials'), safeStorage, fs, path });
  const audit = createAuditLog({ file: path.join(userDataDir, 'mcp-actions-audit.jsonl'), fs, path, now: () => new Date(now()) });
  const cardsDir = path.join(userDataDir, 'mcp-actions');
  const tokenManagers = new Map();
  const running = new Set();
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
      return {
        actionsEnabled: p?.actionsEnabled !== false,
        endpointAllowlist: Array.isArray(p?.endpointAllowlist) ? p.endpointAllowlist : null,
        managed: p?.managed === true,
        reason: p?.reason || null,
      };
    } catch (_) {
      // getPolicy is expected to fail closed itself; this is the backstop.
      return { actionsEnabled: false, endpointAllowlist: [], managed: true, reason: 'policy-unavailable' };
    }
  }

  async function assertAllowed(url) {
    const p = await policy();
    if (!p.actionsEnabled) throw new ActionError('disabled-by-org', 'Your organisation has turned off actions');
    if (url && !allowedByList(url, p.endpointAllowlist)) {
      throw new ActionError('endpoint-not-allowed', 'Your organisation does not allow this endpoint');
    }
    return p;
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
    return 'error';
  }

  // ── connections ───────────────────────────────────────────────────────
  async function list() {
    const p = await policy();
    return {
      connections: connections.list().map((c) => publicConnection(c, p)),
      connectors: publicCatalogue(),
      autoSuggest: connections.getAutoSuggest(),
      policy: { actionsEnabled: p.actionsEnabled, managed: p.managed, endpointAllowlist: p.endpointAllowlist, reason: p.reason },
      secureStorage: secrets.available(),
    };
  }

  async function refreshTools(id) {
    const connection = connections.get(id);
    if (!connection) throw new ActionError('not-found', 'Connection not found');
    await assertAllowed(connection.url);
    try {
      const tools = await remote.listTools(clientOptions(connection));
      connections.update(id, { tools, toolsFetchedAt: now(), status: 'ok', lastError: null });
      log(`[actions] ${originOf(connection.url)} listed ${tools.length} tools`);
    } catch (e) {
      const status = classifyError(e);
      connections.update(id, { status: status === 'needs-auth' ? 'needs-auth' : 'error', lastError: status });
      log(`[actions] ${originOf(connection.url)} tools/list failed (${status})`);
      throw new ActionError(status, status === 'needs-auth' ? 'Sign in again to use this connection' : 'Could not reach this endpoint');
    }
    return publicConnection(connections.get(id), await policy());
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
    const c = connections.update(id, { enabled: enabled === true });
    if (!c) throw new ActionError('not-found', 'Connection not found');
    return publicConnection(c, await policy());
  }

  function remove(id) {
    tokenManagers.delete(id);
    secrets.remove(secretKey(id));
    return connections.remove(id);
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
    const connection = connections.get(card.connectionId);
    const tool = connection?.tools?.find((t) => t.name === card.tool) || null;
    return {
      ...card,
      connectionName: connection?.name || card.connectionName,
      connectionAvailable: Boolean(connection && connection.enabled && tool && allowedByList(connection.url, p.endpointAllowlist)),
      origin: connection ? originOf(connection.url) : null,
      locality: connection ? normalizeEndpointUrl(connection.url)?.locality || 'internet' : null,
      inputSchema: tool?.inputSchema || null,
      toolTitle: tool?.title || null,
      toolDescription: tool?.description || null,
    };
  }

  async function getCards(summaryPath) {
    const p = await policy();
    return readCards(summaryPath).map((c) => enrichCard(c, p));
  }

  function usableConnections(p) {
    return connections.list().filter((c) => c.enabled && c.status !== 'needs-auth'
      && allowedByList(c.url, p.endpointAllowlist) && (c.tools || []).length > 0);
  }

  /** Tool catalogue for the model: write-capable tools of enabled, allowed connections. */
  function toolCatalogue(p) {
    const out = [];
    for (const c of usableConnections(p)) {
      for (const t of c.tools) {
        if (t.readOnly) continue;
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
    const catalogue = toolCatalogue(p);
    if (!catalogue.length) {
      if (auto) return { skipped: true, cards: [] };
      throw new ActionError('no-connections', 'Connect a tool first');
    }

    const tmpDir = path.join(userDataDir, 'tmp');
    fs.mkdirSync(tmpDir, { recursive: true });
    const toolsFile = path.join(tmpDir, `mcp-tools-${crypto.randomUUID()}.json`);
    fs.writeFileSync(toolsFile, JSON.stringify({ tools: catalogue, max_proposals: MAX_PROPOSALS }), { mode: 0o600, flag: 'wx' });
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
    const fresh = [];
    for (const proposal of proposals) {
      const entry = byKey.get(`${proposal.connection_id}\u0000${proposal.tool}`);
      if (!entry || !proposal.arguments || typeof proposal.arguments !== 'object' || Array.isArray(proposal.arguments)) continue;
      const connection = connections.get(entry.connection_id);
      const tool = connection.tools.find((t) => t.name === entry.tool);
      fresh.push({
        id: crypto.randomUUID(),
        connectionId: connection.id,
        connectionName: connection.name,
        tool: tool.name,
        arguments: proposal.arguments,
        reason: typeof proposal.reason === 'string' ? proposal.reason.slice(0, 300) : '',
        validationErrors: validateArguments(tool.inputSchema, proposal.arguments),
        status: 'proposed',
        createdAt: now(),
        updatedAt: now(),
      });
    }
    // Keep the history (approved, failed, dismissed); replace open proposals.
    const cards = [...existing.filter((c) => c.status !== 'proposed'), ...fresh];
    writeCards(summaryPath, cards);
    log(`[actions] suggested ${fresh.length} action(s) from ${proposals.length} proposal(s)`);
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
    const connection = connections.get(card.connectionId);
    if (!connection || !connection.enabled) throw new ActionError('connection-unavailable', 'The connection for this action is off or removed');
    await assertAllowed(connection.url);
    const tool = (connection.tools || []).find((t) => t.name === card.tool);
    if (!tool) throw new ActionError('tool-unavailable', 'The endpoint no longer offers this tool');
    const errors = validateArguments(tool.inputSchema, args);
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
      const res = await remote.callTool(clientOptions(connection), tool.name, args);
      outcome = res.isError
        ? { status: 'failed', result: { status: 'tool-error', link: res.link, text: res.text } }
        : { status: 'done', result: { status: 'ok', link: res.link, text: res.text } };
    } catch (e) {
      const status = classifyError(e);
      if (status === 'needs-auth') connections.update(connection.id, { status: 'needs-auth' });
      outcome = { status: 'failed', result: { status, link: null, text: '' } };
    } finally {
      running.delete(cardId);
    }
    audit.append({
      connectionId: connection.id,
      connectionName: connection.name,
      origin: originOf(connection.url),
      tool: tool.name,
      arguments: args,
      status: outcome.result.status,
      link: outcome.result.link,
      noteId: path.basename(cardsFile(summaryPath), '.json'),
    });
    log(`[actions] ${originOf(connection.url)} ${tool.name} -> ${outcome.result.status}`);
    updateCard(summaryPath, cardId, { ...outcome, approvedAt: now() });
    return (await getCards(summaryPath)).find((c) => c.id === cardId);
  }

  function recent(limit = 50) {
    return audit.recent(limit);
  }

  return {
    list, addCustom, connectConnector, authorize, cancelAuthorize, refreshTools, setEnabled, remove, setAutoSuggest,
    getCards, suggest, approve, dismiss, recent, hasUsableConnections,
    // exposed for tests
    _stores: { connections, secrets, audit, cardsFile },
  };
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

module.exports = { createActionsService, ActionError, allowedByList, publicConnection, authorizeFailureCode, redactProviderText };
