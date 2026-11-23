'use strict';

/**
 * Action connections (Connect page → Turn meetings into actions), persisted in
 * <userData>/mcp-connections.json. The main process is the only reader and
 * writer (no Python consumer), so this file is owned here rather than routed
 * through the Python config like the Steno MCP scope settings.
 *
 * What is stored: id, name, URL, kind (a connector id or "custom"), auth type,
 * a custom header NAME, the enable toggle, the account label and the last
 * tools/list. A local command server (transport "stdio", kind "local") stores
 * its command, arguments and the NAMES of its environment variables; the
 * values are secrets. The on/off state of built-in actions (the Email
 * drafts) lives under `builtins`. What is never stored here: any token,
 * secret, environment value or OAuth client secret (mcp-secret-store.js).
 */

const crypto = require('node:crypto');
const nodeFs = require('node:fs');
const nodePath = require('node:path');

const VERSION = 1;
const MAX_CONNECTIONS = 20;
const AUTH_TYPES = ['none', 'bearer', 'header', 'oauth'];
// RFC 7230 token characters, minus headers we must never let a user override.
const HEADER_NAME_RE = /^[A-Za-z0-9!#$%&'*+.^_`|~-]{1,64}$/;
const RESERVED_HEADERS = new Set([
  'host', 'content-length', 'content-type', 'accept', 'connection', 'transfer-encoding',
  'mcp-session-id', 'mcp-protocol-version', 'last-event-id', 'cookie', 'origin',
]);

function isPrivateHost(hostname) {
  const h = String(hostname || '').toLowerCase().replace(/^\[|\]$/g, '');
  if (h === 'localhost' || h === '::1' || /^127(\.\d{1,3}){3}$/.test(h)) return 'device';
  if (/^10(\.\d{1,3}){3}$/.test(h) || /^192\.168(\.\d{1,3}){2}$/.test(h)
    || /^172\.(1[6-9]|2\d|3[01])(\.\d{1,3}){2}$/.test(h) || /^169\.254(\.\d{1,3}){2}$/.test(h)
    || /^f[cd][0-9a-f]{2}:/.test(h) || /^fe80:/.test(h)
    || /\.(local|lan|internal|home\.arpa)$/.test(h)) return 'network';
  return null;
}

/**
 * Validate an endpoint URL. https anywhere; plain http only on this device or
 * the local network (self-hosted n8n). No credentials in the URL, no
 * fragment. Returns { url, origin, locality } or null.
 * locality: 'device' | 'network' | 'internet'.
 */
function normalizeEndpointUrl(raw) {
  try {
    if (typeof raw !== 'string') return null;
    const trimmed = raw.trim();
    if (!trimmed || trimmed.length > 2048 || !/^[\x21-\x7e]+$/.test(trimmed) || trimmed.includes('\\')) return null;
    const url = new URL(trimmed);
    if (url.username || url.password || url.hash || trimmed.includes('#')) return null;
    const privacy = isPrivateHost(url.hostname);
    if (url.protocol !== 'https:' && !(url.protocol === 'http:' && privacy)) return null;
    return { url: url.href, origin: url.origin, locality: privacy || 'internet' };
  } catch (_) {
    return null;
  }
}

function normalizeHeaderName(name) {
  if (typeof name !== 'string') return null;
  const n = name.trim();
  if (!HEADER_NAME_RE.test(n) || RESERVED_HEADERS.has(n.toLowerCase())) return null;
  return n;
}

const MAX_COMMAND = 1024;
const MAX_ARGS = 64;
const MAX_ARG = 4096;
const MAX_ENV = 32;
const MAX_ENV_VALUE = 8192;
const ENV_NAME_RE = /^[A-Za-z_][A-Za-z0-9_]{0,127}$/;

/**
 * Validate a local command server: { command, args, env }. Throws an Error
 * with code 'invalid-command' | 'invalid-args' | 'invalid-env'.
 */
function normalizeLocalCommand({ command, args, env } = {}) {
  const fail = (code) => {
    const e = new Error(code);
    e.code = code;
    throw e;
  };
  const cmd = typeof command === 'string' ? command.trim() : '';
  if (!cmd || cmd.length > MAX_COMMAND || /[\u0000-\u001f\u007f]/.test(cmd)) fail('invalid-command');
  const list = args === undefined || args === null ? [] : args;
  if (!Array.isArray(list) || list.length > MAX_ARGS) fail('invalid-args');
  for (const a of list) {
    if (typeof a !== 'string' || a.length > MAX_ARG || /[\0\r\n]/.test(a)) fail('invalid-args');
  }
  const vars = env === undefined || env === null ? {} : env;
  if (typeof vars !== 'object' || Array.isArray(vars) || Object.keys(vars).length > MAX_ENV) fail('invalid-env');
  const outEnv = {};
  for (const [k, v] of Object.entries(vars)) {
    if (!ENV_NAME_RE.test(k) || typeof v !== 'string' || v.length > MAX_ENV_VALUE || v.includes('\0')) fail('invalid-env');
    outEnv[k] = v;
  }
  return { command: cmd, args: list.slice(), env: outEnv };
}

function cleanName(name, fallback) {
  const n = typeof name === 'string' ? name.replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, 80) : '';
  return n || fallback;
}

function createConnectionsStore({ file, fs = nodeFs, path = nodePath, now = () => Date.now() }) {
  function read() {
    try {
      const data = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (!data || typeof data !== 'object') throw new Error('bad');
      return {
        version: VERSION,
        autoSuggest: data.autoSuggest !== false,
        builtins: data.builtins && typeof data.builtins === 'object' && !Array.isArray(data.builtins) ? data.builtins : {},
        connections: Array.isArray(data.connections) ? data.connections.filter((c) => c && typeof c.id === 'string') : [],
      };
    } catch (_) {
      return { version: VERSION, autoSuggest: true, builtins: {}, connections: [] };
    }
  }

  function write(data) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = `${file}.${process.pid}.${crypto.randomUUID()}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify({ ...data, version: VERSION }, null, 2), { mode: 0o600 });
    fs.renameSync(tmp, file);
  }

  function list() {
    return read().connections;
  }

  function get(id) {
    return read().connections.find((c) => c.id === id) || null;
  }

  function add(input) {
    const data = read();
    if (data.connections.length >= MAX_CONNECTIONS) throw new Error('Too many connections');
    const endpoint = normalizeEndpointUrl(input.url);
    if (!endpoint) throw new Error('Endpoint URL is invalid');
    if (!AUTH_TYPES.includes(input.auth)) throw new Error('Auth type is invalid');
    const headerName = input.auth === 'header' ? normalizeHeaderName(input.headerName) : null;
    if (input.auth === 'header' && !headerName) throw new Error('Header name is invalid');
    const connection = {
      id: crypto.randomUUID(),
      name: cleanName(input.name, new URL(endpoint.url).hostname),
      url: endpoint.url,
      kind: typeof input.kind === 'string' ? input.kind : 'custom',
      auth: input.auth,
      ...(headerName ? { headerName } : {}),
      enabled: true,
      createdAt: now(),
      account: null,
      tools: [],
      toolsFetchedAt: null,
      status: 'ok',
    };
    data.connections.push(connection);
    write(data);
    return connection;
  }

  /** Add a local command server. `envKeys`: the variable names (values are secrets). */
  function addLocal(input) {
    const data = read();
    if (data.connections.length >= MAX_CONNECTIONS) throw new Error('Too many connections');
    const { command, args } = normalizeLocalCommand({ command: input.command, args: input.args });
    const envKeys = Array.isArray(input.envKeys) ? input.envKeys.filter((k) => ENV_NAME_RE.test(k)).slice(0, MAX_ENV) : [];
    const connection = {
      id: crypto.randomUUID(),
      name: cleanName(input.name, path.basename(command) || command),
      url: null,
      transport: 'stdio',
      command,
      args,
      envKeys,
      kind: 'local',
      auth: 'none',
      enabled: true,
      createdAt: now(),
      account: null,
      tools: [],
      toolsFetchedAt: null,
      status: 'ok',
    };
    data.connections.push(connection);
    write(data);
    return connection;
  }

  function update(id, patch) {
    const data = read();
    const i = data.connections.findIndex((c) => c.id === id);
    if (i === -1) return null;
    const allowed = {};
    for (const key of ['name', 'enabled', 'account', 'tools', 'toolsFetchedAt', 'status', 'lastError']) {
      if (Object.hasOwn(patch, key)) allowed[key] = patch[key];
    }
    if (Object.hasOwn(allowed, 'name')) allowed.name = cleanName(allowed.name, data.connections[i].name);
    if (Object.hasOwn(allowed, 'enabled')) allowed.enabled = allowed.enabled === true;
    data.connections[i] = { ...data.connections[i], ...allowed };
    write(data);
    return data.connections[i];
  }

  function remove(id) {
    const data = read();
    const before = data.connections.length;
    data.connections = data.connections.filter((c) => c.id !== id);
    if (data.connections.length !== before) write(data);
    return data.connections.length !== before;
  }

  function getAutoSuggest() {
    return read().autoSuggest;
  }

  function setAutoSuggest(value) {
    const data = read();
    data.autoSuggest = value === true;
    write(data);
    return data.autoSuggest;
  }

  /** Whether a built-in action ("email") is on; on unless the user turned it off. */
  function getBuiltinEnabled(name) {
    return read().builtins?.[name]?.enabled !== false;
  }

  function setBuiltinEnabled(name, value) {
    const data = read();
    data.builtins = { ...data.builtins, [name]: { enabled: value === true } };
    write(data);
    return value === true;
  }

  return { list, get, add, addLocal, update, remove, getAutoSuggest, setAutoSuggest, getBuiltinEnabled, setBuiltinEnabled, file };
}

module.exports = {
  createConnectionsStore, normalizeEndpointUrl, normalizeHeaderName, normalizeLocalCommand, isPrivateHost, AUTH_TYPES, ENV_NAME_RE,
};
