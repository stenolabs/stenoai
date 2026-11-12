// Steno's connection to iMCP (https://imcp.app), a macOS menu bar app that
// serves the Mac's call history and Contacts to MCP clients. Steno uses exactly
// two of its tools: `phone_calls_fetch` to find the call a recording captured
// (see call-matching.js) and `contacts_search` to put a name to the number.
//
// How iMCP is reached: the app bundles `imcp-server`, a stdio bridge that finds
// the running app over Bonjour (this Mac only) and relays MCP to it. Things that
// shape this module:
//  - The bridge never fails when iMCP is not running; it keeps searching. So the
//    `initialize` request simply waits until iMCP is there and the user has
//    approved Steno in iMCP's window. Status meanwhile comes from asking whether
//    the iMCP process is running.
//  - When iMCP quits, the bridge exits and the connection closes; we reconnect.
//  - Each iMCP service (Phone, Contacts) is switched on by the user, and only
//    then are its tools listed. iMCP announces changes with tools/list_changed.
//  - If iMCP's grant on the call history is missing, `phone_calls_fetch` opens a
//    permission dialog and waits for the user, so tool calls carry a timeout.

const { EventEmitter } = require('node:events');
const { execFile } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const IMCP_DOWNLOAD_URL = 'https://imcp.app/download';
const IMCP_HOMEBREW = 'brew install --cask mattt/tap/iMCP';
const IMCP_PROCESS_NAME = 'iMCP';

const STATUS = Object.freeze({
  OFF: 'off',                             // feature switched off, or not started
  UNSUPPORTED: 'unsupported',             // not macOS
  NOT_INSTALLED: 'not-installed',
  NOT_RUNNING: 'not-running',
  AWAITING_APPROVAL: 'awaiting-approval', // iMCP running, connection not yet accepted
  DECLINED: 'declined',                   // iMCP kept closing the connection: refused in its window
  PHONE_OFF: 'phone-off',                 // connected, Phone not switched on in iMCP
  READY: 'ready',
});

const TOOL_CALLS = 'phone_calls_fetch';
const TOOL_CONTACTS = 'contacts_search';

// initialize waits for the user to start iMCP and approve Steno; give up and
// start over only after a day, so a pending approval window is not torn down.
const CONNECT_TIMEOUT_MS = 24 * 60 * 60 * 1000;
// A tool call that has not answered by now is waiting on a dialog in iMCP.
const TOOL_TIMEOUT_MS = 10 * 1000;
const PENDING_POLL_MS = 3 * 1000;
const RETRY_DELAYS_MS = [5 * 1000, 15 * 1000, 60 * 1000];
// iMCP closes a connection the user refuses. After this many in a row, stop
// asking until the feature is switched on again, rather than re-open the window.
const MAX_REFUSALS = 2;

/** Path of iMCP's bridge, or null. STENOAI_IMCP_SERVER overrides it (tests). */
function findImcpServer({ env = process.env, exists = fs.existsSync, home = os.homedir() } = {}) {
  if (env.STENOAI_IMCP_SERVER) return exists(env.STENOAI_IMCP_SERVER) ? env.STENOAI_IMCP_SERVER : null;
  for (const dir of ['/Applications', path.join(home, 'Applications')]) {
    const candidate = path.join(dir, 'iMCP.app', 'Contents', 'MacOS', 'imcp-server');
    if (exists(candidate)) return candidate;
  }
  return null;
}

/** Whether the iMCP app is running. With a test bridge configured, assume so. */
function isImcpRunning({ env = process.env } = {}) {
  if (env.STENOAI_IMCP_SERVER) return Promise.resolve(true);
  return new Promise((resolve) => {
    execFile('/usr/bin/pgrep', ['-x', IMCP_PROCESS_NAME], (error) => resolve(!error));
  });
}

/** The JSON a tool returned as text; throws with iMCP's message on a tool error. */
function toolJson(result) {
  const text = (result?.content || []).find((c) => c?.type === 'text')?.text;
  if (result?.isError) throw new Error(text || 'iMCP tool error');
  if (typeof text !== 'string') throw new Error('iMCP returned no text');
  return JSON.parse(text);
}

/** A display name from one schema.org Person as iMCP encodes contacts. */
function personName(person) {
  if (!person || typeof person !== 'object') return null;
  if (typeof person.name === 'string' && person.name.trim()) return person.name.trim();
  const parts = [person.givenName, person.familyName].filter((p) => typeof p === 'string' && p.trim());
  return parts.length ? parts.join(' ').trim() : null;
}

function defaultCreateClient(clientInfo) {
  const { Client } = require('@modelcontextprotocol/client');
  return new Client(clientInfo, { capabilities: {} });
}

function defaultCreateTransport(command, env = process.env) {
  const { StdioClientTransport } = require('@modelcontextprotocol/client/stdio');
  const options = { command, args: [], stderr: 'ignore' };
  // The real imcp-server gets the SDK's minimal default environment. A test
  // bridge (STENOAI_IMCP_SERVER) gets everything, for its fixture settings.
  if (env.STENOAI_IMCP_SERVER) options.env = { ...env };
  return new StdioClientTransport(options);
}

class ImcpClient extends EventEmitter {
  constructor({
    clientInfo = { name: 'Steno', version: '0' },
    platform = process.platform,
    findServer = findImcpServer,
    isAppRunning = isImcpRunning,
    createClient = defaultCreateClient,
    createTransport = defaultCreateTransport,
    log = () => {},
    retryDelaysMs = RETRY_DELAYS_MS,
    pendingPollMs = PENDING_POLL_MS,
  } = {}) {
    super();
    Object.assign(this, { clientInfo, platform, findServer, isAppRunning, createClient,
      createTransport, log, retryDelaysMs, pendingPollMs });
    this._status = STATUS.OFF;
    this._contacts = false;
    this._client = null;
    this._started = false;
    this._attempt = 0;
    this._refusals = 0;
    this._retryTimer = null;
    this._pollTimer = null;
  }

  /** { state, contacts }: contacts is whether names can be looked up. */
  get status() {
    return { state: this._status, contacts: this._contacts };
  }

  start() {
    if (this._started) return;
    if (this.platform !== 'darwin') {
      this._setStatus(STATUS.UNSUPPORTED);
      return;
    }
    this._started = true;
    this._attempt = 0;
    this._refusals = 0;
    this._connect();
  }

  async stop() {
    this._started = false;
    clearTimeout(this._retryTimer);
    clearInterval(this._pollTimer);
    const client = this._client;
    this._client = null;
    this._contacts = false;
    this._setStatus(STATUS.OFF);
    if (client) await client.close().catch(() => {});
  }

  /** The newest `limit` calls, as iMCP's `itemListElement` entries. */
  async recentCalls(limit = 10) {
    const client = this._readyClient();
    const json = toolJson(await client.callTool(
      { name: TOOL_CALLS, arguments: { limit } }, { timeout: TOOL_TIMEOUT_MS }));
    return Array.isArray(json?.itemListElement) ? json.itemListElement : [];
  }

  /** The Contacts name for a number, or null (no match, or Contacts off in iMCP). */
  async contactName(number) {
    if (!number || !this._contacts) return null;
    const client = this._readyClient();
    const json = toolJson(await client.callTool(
      { name: TOOL_CONTACTS, arguments: { phone: number } }, { timeout: TOOL_TIMEOUT_MS }));
    const people = Array.isArray(json) ? json : [json];
    for (const person of people) {
      const name = personName(person);
      if (name) return name;
    }
    return null;
  }

  _readyClient() {
    if (this._status !== STATUS.READY || !this._client) throw new Error(`iMCP not ready (${this._status})`);
    return this._client;
  }

  _setStatus(state) {
    if (state === this._status) return;
    this._status = state;
    this.emit('status', this.status);
  }

  async _connect() {
    if (!this._started) return;
    const server = this.findServer();
    if (!server) {
      this._setStatus(STATUS.NOT_INSTALLED);
      this._retryLater();
      return;
    }

    const client = this.createClient(this.clientInfo);
    const transport = this.createTransport(server);
    let connected = false;
    client.onclose = () => this._lost(client, connected);
    this._client = client;
    const handshakeDone = this._watchPending(client);
    try {
      // iMCP speaks the classic initialize handshake; skip the newer probe.
      await client.connect(transport, { prior: { kind: 'legacy' }, timeout: CONNECT_TIMEOUT_MS });
    } catch (error) {
      this.log(`[imcp] connect failed: ${error?.message || error}`);
      await this._lost(client, false);
      await client.close().catch(() => {});
      return;
    }
    if (!this._started || this._client !== client) {
      await client.close().catch(() => {});
      return;
    }
    connected = true;
    handshakeDone();
    this._attempt = 0;
    this._refusals = 0;
    client.setNotificationHandler('notifications/tools/list_changed', () => this._refreshTools(client));
    await this._refreshTools(client);
  }

  // While initialize is pending, tell "not running" from "awaiting approval".
  // Returns the function that ends this once the handshake is done.
  _watchPending(client) {
    clearInterval(this._pollTimer);
    let done = false;
    const check = async () => {
      if (done || this._client !== client) return;
      const running = await this.isAppRunning();
      // The handshake may have completed, and the status moved on, meanwhile.
      if (done || this._client !== client) return;
      this._setStatus(running ? STATUS.AWAITING_APPROVAL : STATUS.NOT_RUNNING);
    };
    check();
    this._pollTimer = setInterval(check, this.pendingPollMs);
    return () => {
      done = true;
      clearInterval(this._pollTimer);
    };
  }

  async _refreshTools(client) {
    try {
      const { tools } = await client.listTools(undefined, { cacheMode: 'bypass' });
      const names = new Set((tools || []).map((t) => t.name));
      if (this._client !== client) return;
      this._contacts = names.has(TOOL_CONTACTS);
      // Emit even when the state is unchanged: the Contacts flag may have moved.
      this._status = names.has(TOOL_CALLS) ? STATUS.READY : STATUS.PHONE_OFF;
      this.emit('status', this.status);
    } catch (error) {
      this.log(`[imcp] tools/list failed: ${error?.message || error}`);
      // Without the tool list the status is unknown. Start over, through the
      // reconnect that closing sets off, rather than keep the last status.
      if (this._client === client) await client.close().catch(() => {});
    }
  }

  // The connection is gone: closed by iMCP or the bridge, or never completed.
  // Runs once per client, whichever of close and connect-failure comes first.
  async _lost(client, wasConnected) {
    if (this._client !== client) return;
    this._client = null;
    this._contacts = false;
    clearInterval(this._pollTimer);
    if (!this._started) return;
    // Not ready from this moment; whether iMCP is still there is settled below.
    if (wasConnected) this._setStatus(STATUS.NOT_RUNNING);
    const running = await this.isAppRunning();
    if (!this._started || this._client) return;
    if (running && !wasConnected) {
      this._refusals += 1;
      if (this._refusals >= MAX_REFUSALS) {
        this._setStatus(STATUS.DECLINED);
        return;
      }
    }
    this._setStatus(running ? STATUS.AWAITING_APPROVAL : STATUS.NOT_RUNNING);
    this._retryLater();
  }

  _retryLater() {
    clearTimeout(this._retryTimer);
    const delays = this.retryDelaysMs;
    const delay = delays[Math.min(this._attempt, delays.length - 1)];
    this._attempt += 1;
    this._retryTimer = setTimeout(() => this._connect(), delay);
    this._retryTimer.unref?.();
  }
}

module.exports = {
  ImcpClient,
  STATUS,
  IMCP_DOWNLOAD_URL,
  IMCP_HOMEBREW,
  findImcpServer,
  isImcpRunning,
  personName,
  toolJson,
};
