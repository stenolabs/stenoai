'use strict';

/**
 * Local (stdio) MCP servers for Suggested actions: a command the user typed in
 * Connect -> Custom MCP server -> "Command on this computer" (for example
 * `npx -y @modelcontextprotocol/server-filesystem ~/Notes`), launched as a
 * child process speaking MCP over stdin/stdout (newline-delimited JSON-RPC,
 * the MCP stdio transport). The sibling of mcp-remote-client.js, on the same
 * @modelcontextprotocol/client Client.
 *
 * What runs: only the command, arguments and environment the user saved (the
 * actions service asks for a native confirmation before saving one). A
 * suggestion or a chat turn can pick one of the server's tools and its
 * arguments, never what is executed.
 *
 * Lifecycle: started lazily on first use, kept for IDLE_MS so a suggestion and
 * its approvals reuse one process, then stopped; a crash or an idle stop just
 * means the next use starts it again. stop()/stopAll() kill the whole process
 * tree (npx and uvx start the real server as a grandchild): on POSIX the
 * server leads its own process group and the group is signalled; on Windows
 * `taskkill /T /F`. The handshake and every request carry a timeout.
 *
 * Finding the command like a shell would: an app launched from the Dock or
 * Start menu does not get the PATH a terminal has (macOS gives GUI apps only
 * /usr/bin:/bin:/usr/sbin:/sbin), so `npx` from Homebrew or nvm would not be
 * found. The search path is the login shell's PATH (asked once, macOS and
 * Linux), then this process's PATH, then the usual install locations. On
 * Windows PATHEXT applies, and `.cmd` / `.bat` shims (npx.cmd) are started
 * through cross-spawn, which quotes them for cmd.exe safely.
 *
 * The child's environment is a minimal set (HOME, PATH, TEMP, ...; the SDK's
 * own default list) plus the user's variables, so Steno's own environment,
 * such as a provider key, is never handed to it. Its stderr is drained and
 * discarded: it may echo secrets. Logs carry tool names and error kinds only.
 */

const crypto = require('node:crypto');
const childProcess = require('node:child_process');
const nodeFs = require('node:fs');
const nodeOs = require('node:os');
const nodePath = require('node:path');

const { toolSummary, resultLink, resultText } = require('./mcp-remote-client');

const HANDSHAKE_TIMEOUT_MS = 60 * 1000; // npx/uvx may download the server on first run
const LIST_TIMEOUT_MS = 30 * 1000;
const CALL_TIMEOUT_MS = 60 * 1000;
const IDLE_MS = 10 * 60 * 1000;
const KILL_GRACE_MS = 1500;
const LOGIN_SHELL_TIMEOUT_MS = 4000;
const MAX_LINE_BYTES = 8 * 1024 * 1024;
const TOOLS_PAGE_LIMIT = 10;
const MAX_TOOLS = 200;

const POSIX_ENV = ['HOME', 'LOGNAME', 'SHELL', 'TERM', 'USER', 'LANG', 'LC_ALL', 'TMPDIR'];
const WIN_ENV = [
  'APPDATA', 'COMSPEC', 'HOMEDRIVE', 'HOMEPATH', 'LOCALAPPDATA', 'PATHEXT', 'PROCESSOR_ARCHITECTURE',
  'PROGRAMDATA', 'PROGRAMFILES', 'PROGRAMFILES(X86)', 'PROGRAMW6432', 'SYSTEMDRIVE', 'SYSTEMROOT',
  'TEMP', 'TMP', 'USERNAME', 'USERPROFILE', 'WINDIR',
];

class LocalServerError extends Error {
  /** code: 'command-not-found' | 'local-timeout' | 'local-exited' | 'local-failed' */
  constructor(code, message) {
    super(message || code);
    this.name = 'LocalServerError';
    this.code = code;
  }
}

/** env[name] ignoring case (Windows has "Path"). */
function envGet(env, name) {
  const key = Object.keys(env || {}).find((k) => k.toUpperCase() === name.toUpperCase());
  return key ? env[key] : undefined;
}

let loginPathPromise = null;

/** The login shell's PATH, asked once; null off macOS/Linux or on any failure. */
function loginShellPath({ platform = process.platform, env = process.env, execFile = childProcess.execFile } = {}) {
  if (platform === 'win32') return Promise.resolve(null);
  if (loginPathPromise) return loginPathPromise;
  loginPathPromise = new Promise((resolve) => {
    const shell = typeof env.SHELL === 'string' && nodePath.isAbsolute(env.SHELL) ? env.SHELL : '/bin/sh';
    const marker = '__STENO_PATH__';
    try {
      execFile(shell, ['-ilc', `printf '${marker}%s${marker}' "$PATH"`], {
        timeout: LOGIN_SHELL_TIMEOUT_MS,
        env: { HOME: env.HOME || nodeOs.homedir(), USER: env.USER || '', SHELL: shell, TERM: 'dumb' },
        stdio: ['ignore', 'pipe', 'ignore'],
        maxBuffer: 1024 * 1024,
      }, (_error, stdout) => {
        // A noisy rc file can make the shell exit non-zero after printing; the marker decides.
        const m = new RegExp(`${marker}(.*?)${marker}`, 's').exec(String(stdout || ''));
        resolve(m && m[1].trim() ? m[1].trim() : null);
      });
    } catch (_) {
      resolve(null);
    }
  });
  return loginPathPromise;
}

/** The directories to search, in order, without duplicates. */
function searchDirs({ platform = process.platform, env = process.env, home = nodeOs.homedir(), loginPath = null } = {}) {
  const sep = platform === 'win32' ? ';' : ':';
  const fallbacks = platform === 'win32'
    ? []
    : [
      ...(platform === 'darwin' ? ['/opt/homebrew/bin', '/opt/homebrew/sbin'] : []),
      '/usr/local/bin',
      nodePath.join(home, '.local', 'bin'),
      nodePath.join(home, '.cargo', 'bin'),
      nodePath.join(home, '.bun', 'bin'),
      nodePath.join(home, '.volta', 'bin'),
      nodePath.join(home, '.deno', 'bin'),
      '/usr/bin', '/bin', '/usr/sbin', '/sbin',
    ];
  const all = [loginPath, envGet(env, 'PATH')]
    .filter((p) => typeof p === 'string' && p)
    .flatMap((p) => p.split(sep))
    .concat(fallbacks)
    .map((d) => d.trim())
    .filter((d) => d && (platform === 'win32' ? /^[A-Za-z]:[\\/]|^\\\\/.test(d) : d.startsWith('/')));
  return [...new Set(all)];
}

function isExecutableFile(fs, file, platform) {
  try {
    const st = fs.statSync(file);
    if (!st.isFile()) return false;
    if (platform === 'win32') return true;
    fs.accessSync(file, fs.constants.X_OK);
    return true;
  } catch (_) {
    return false;
  }
}

/**
 * The absolute file `command` names, searched like a shell would, or null.
 * A command with a path separator is taken as a path (relative to home).
 */
function resolveCommand(command, { dirs, platform = process.platform, env = process.env, fs = nodeFs, home = nodeOs.homedir() }) {
  if (typeof command !== 'string' || !command.trim()) return null;
  const pathApi = platform === 'win32' ? nodePath.win32 : nodePath.posix;
  const cmd = command.trim().replace(/^~(?=$|[\\/])/, home);
  const exts = platform === 'win32'
    ? (envGet(env, 'PATHEXT') || '.COM;.EXE;.BAT;.CMD').split(';').filter(Boolean).map((e) => e.toLowerCase())
    : [''];
  const candidatesFor = (base) => {
    if (platform !== 'win32') return [base];
    const hasExt = exts.includes(pathApi.extname(base).toLowerCase());
    return hasExt ? [base] : exts.map((e) => `${base}${e}`);
  };
  if (/[\\/]/.test(cmd)) {
    const abs = pathApi.isAbsolute(cmd) ? cmd : pathApi.join(home, cmd);
    return candidatesFor(abs).find((f) => isExecutableFile(fs, f, platform)) || null;
  }
  for (const dir of dirs) {
    for (const f of candidatesFor(pathApi.join(dir, cmd))) {
      if (isExecutableFile(fs, f, platform)) return f;
    }
  }
  return null;
}

/** The child's environment: a minimal inherited set, the search PATH, then the user's variables. */
function childEnv({ userEnv = {}, dirs, platform = process.platform, env = process.env }) {
  const out = {};
  for (const name of platform === 'win32' ? WIN_ENV : POSIX_ENV) {
    const v = envGet(env, name);
    if (typeof v === 'string' && !v.startsWith('()')) out[name] = v;
  }
  out.PATH = dirs.join(platform === 'win32' ? ';' : ':');
  for (const [k, v] of Object.entries(userEnv || {})) {
    if (typeof v !== 'string') continue;
    if (k.toUpperCase() === 'PATH') {
      // The user's PATH comes first; ours stays as the fallback.
      out.PATH = `${v}${platform === 'win32' ? ';' : ':'}${out.PATH}`;
    } else {
      out[k] = v;
    }
  }
  return out;
}

function defaultSpawn(file, args, options) {
  // cross-spawn: on Windows it starts .cmd/.bat shims through cmd.exe with
  // correct quoting (Node refuses them without a shell since CVE-2024-27980).
  const crossSpawn = require('cross-spawn');
  return crossSpawn(file, args, options);
}

/** Kill `child` and everything it started. */
function killTree(child, { platform = process.platform, sync = false, execFile = childProcess.execFile, execFileSync = childProcess.execFileSync } = {}) {
  if (!child || !child.pid) return;
  const pid = child.pid;
  const exited = child.exitCode !== null || child.signalCode !== null;
  try { child.stdin?.end(); } catch (_) {}
  if (platform === 'win32') {
    if (exited) return; // taskkill needs the parent alive to walk the tree
    const args = ['/PID', String(pid), '/T', '/F'];
    try {
      if (sync) execFileSync('taskkill', args, { windowsHide: true, stdio: 'ignore' });
      else execFile('taskkill', args, { windowsHide: true }, () => {});
    } catch (_) {
      try { child.kill(); } catch (_e) {}
    }
    return;
  }
  const signal = (sig) => {
    try {
      process.kill(-pid, sig); // the process group: npx's grandchild too
    } catch (_) {
      try { child.kill(sig); } catch (_e) {}
    }
  };
  if (sync) {
    signal('SIGKILL');
    return;
  }
  signal('SIGTERM');
  const timer = setTimeout(() => {
    // The group, even if the server itself already exited: a grandchild may not have.
    try { process.kill(-pid, 'SIGKILL'); } catch (_) {}
    if (child.exitCode === null && child.signalCode === null) { try { child.kill('SIGKILL'); } catch (_) {} }
  }, KILL_GRACE_MS);
  timer.unref?.();
}

/**
 * The MCP stdio transport on a child process: newline-delimited JSON-RPC on
 * stdin/stdout. Implements the SDK's Transport interface.
 */
class ProcessTransport {
  constructor({ file, args, env, cwd, platform = process.platform, spawn = defaultSpawn }) {
    Object.assign(this, { file, args, env, cwd, platform, spawn });
    this.child = null;
    this.buffer = '';
    this.closed = false;
    this.onclose = undefined;
    this.onerror = undefined;
    this.onmessage = undefined;
  }

  start() {
    return new Promise((resolve, reject) => {
      let started = false;
      let child;
      try {
        child = this.spawn(this.file, this.args, {
          env: this.env,
          cwd: this.cwd,
          stdio: ['pipe', 'pipe', 'pipe'],
          shell: false,
          windowsHide: true,
          // Its own process group on POSIX, so the whole tree can be signalled.
          detached: this.platform !== 'win32',
        });
      } catch (e) {
        reject(new LocalServerError(e?.code === 'ENOENT' ? 'command-not-found' : 'local-failed'));
        return;
      }
      this.child = child;
      child.on('error', (e) => {
        if (!started) reject(new LocalServerError(e?.code === 'ENOENT' ? 'command-not-found' : 'local-failed'));
        else this.onerror?.(new LocalServerError('local-failed'));
      });
      child.on('spawn', () => {
        started = true;
        resolve();
      });
      child.on('exit', () => this._closed());
      child.stdout.setEncoding('utf8');
      child.stdout.on('data', (chunk) => this._read(chunk));
      child.stdout.on('error', () => {});
      child.stdin.on('error', () => {});
      // Drained, never logged: a server may print its token on stderr.
      child.stderr?.on('data', () => {});
      child.stderr?.on('error', () => {});
    });
  }

  _read(chunk) {
    this.buffer += chunk;
    if (this.buffer.length > MAX_LINE_BYTES) {
      this.buffer = '';
      this.onerror?.(new LocalServerError('local-failed', 'Message too large'));
      this.close();
      return;
    }
    let nl = this.buffer.indexOf('\n');
    while (nl !== -1) {
      const line = this.buffer.slice(0, nl).replace(/\r$/, '').trim();
      this.buffer = this.buffer.slice(nl + 1);
      // A server that prints a banner on stdout breaks the spec; skip non-JSON lines.
      if (line.startsWith('{')) {
        let message = null;
        try { message = JSON.parse(line); } catch (_) { message = null; }
        if (message && typeof message === 'object') this.onmessage?.(message);
      }
      nl = this.buffer.indexOf('\n');
    }
  }

  _closed() {
    if (this.closed) return;
    this.closed = true;
    this.onclose?.();
  }

  async send(message) {
    const child = this.child;
    if (!child || this.closed || !child.stdin.writable) throw new LocalServerError('local-exited');
    const line = `${JSON.stringify(message)}\n`;
    if (!child.stdin.write(line)) await new Promise((resolve) => child.stdin.once('drain', resolve));
  }

  async close({ sync = false } = {}) {
    const child = this.child;
    killTree(child, { platform: this.platform, sync });
    this._closed();
  }
}

function defaultCreateClient(clientInfo) {
  const { Client } = require('@modelcontextprotocol/client');
  return new Client(clientInfo, { capabilities: {} });
}

/** A short-form error kind for an SDK/transport failure. */
function errorKind(e) {
  if (e instanceof LocalServerError) return e.code;
  const msg = String(e?.message || '');
  if (e?.code === -32001 || /timed? ?out/i.test(msg)) return 'local-timeout';
  if (e?.code === -32000 || /connection closed|not connected/i.test(msg)) return 'local-exited';
  return null; // a JSON-RPC error from the server itself: pass through
}

function withTimeout(promise, ms, onTimeout) {
  let timer;
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      timer = setTimeout(() => {
        onTimeout?.();
        reject(new LocalServerError('local-timeout'));
      }, ms);
      timer.unref?.();
    }),
  ]).finally(() => clearTimeout(timer));
}

/**
 * Running local servers, one per connection id.
 *   spec: { id, command, args: string[], env: { NAME: value } }
 */
function createStdioPool({
  clientInfo = { name: 'Steno', version: '0' },
  platform = process.platform,
  env = process.env,
  home = nodeOs.homedir(),
  fs = nodeFs,
  log = () => {},
  createClient = defaultCreateClient,
  spawn = defaultSpawn,
  getLoginPath = () => loginShellPath({ platform, env }),
  idleMs = IDLE_MS,
  handshakeTimeoutMs = HANDSHAKE_TIMEOUT_MS,
  listTimeoutMs = LIST_TIMEOUT_MS,
  callTimeoutMs = CALL_TIMEOUT_MS,
} = {}) {
  const sessions = new Map(); // id -> { key, ready: Promise<client>, transport, timer }

  const keyOf = (spec) => crypto.createHash('sha256')
    .update(JSON.stringify([spec.command, spec.args || [], Object.entries(spec.env || {}).sort()]))
    .digest('hex');

  function drop(id, session, { sync = false } = {}) {
    if (sessions.get(id) === session) sessions.delete(id);
    clearTimeout(session.timer);
    session.transport?.close({ sync }).catch?.(() => {});
  }

  function touch(id, session) {
    clearTimeout(session.timer);
    session.timer = setTimeout(() => {
      log('[actions] local server stopped (idle)');
      drop(id, session);
    }, idleMs);
    session.timer.unref?.();
  }

  async function start(spec) {
    const loginPath = await getLoginPath().catch(() => null);
    const dirs = searchDirs({ platform, env, home, loginPath });
    const file = resolveCommand(spec.command, { dirs, platform, env, fs, home });
    if (!file) throw new LocalServerError('command-not-found');
    // A leading ~ means home, as a shell would expand it ("~/Notes").
    const args = (Array.isArray(spec.args) ? spec.args : [])
      .map((a) => (a === '~' ? home : /^~[\\/]/.test(a) ? nodePath.join(home, a.slice(2)) : a));
    const transport = new ProcessTransport({
      file,
      args,
      env: childEnv({ userEnv: spec.env, dirs, platform, env }),
      cwd: home,
      platform,
      spawn,
    });
    const client = createClient(clientInfo);
    return { transport, client };
  }

  async function session(spec) {
    const key = keyOf(spec);
    const existing = sessions.get(spec.id);
    if (existing && existing.key === key && !existing.transport?.closed) {
      touch(spec.id, existing);
      return existing.ready;
    }
    if (existing) drop(spec.id, existing);
    const entry = { key, transport: null, timer: null, ready: null };
    sessions.set(spec.id, entry);
    entry.ready = (async () => {
      const { transport, client } = await start(spec);
      entry.transport = transport;
      transport.onclose = () => {
        if (sessions.get(spec.id) === entry) sessions.delete(spec.id);
        clearTimeout(entry.timer);
      };
      await withTimeout(client.connect(transport, { timeout: handshakeTimeoutMs }), handshakeTimeoutMs + 1000, () => transport.close());
      log('[actions] local server started');
      return client;
    })();
    try {
      const client = await entry.ready;
      touch(spec.id, entry);
      return client;
    } catch (e) {
      drop(spec.id, entry);
      const kind = errorKind(e) || 'local-failed';
      log(`[actions] local server did not start (${kind})`);
      throw new LocalServerError(kind);
    }
  }

  async function run(spec, fn) {
    const client = await session(spec);
    try {
      return await fn(client);
    } catch (e) {
      const kind = errorKind(e);
      if (!kind) throw e;
      // A timed-out or dead server is restarted on the next use.
      const s = sessions.get(spec.id);
      if (s) drop(spec.id, s);
      throw new LocalServerError(kind);
    }
  }

  async function listTools(spec) {
    return run(spec, async (client) => {
      const tools = [];
      let cursor;
      for (let page = 0; page < TOOLS_PAGE_LIMIT; page += 1) {
        const res = await client.listTools(cursor ? { cursor } : undefined, { timeout: listTimeoutMs });
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

  async function callTool(spec, name, args) {
    return run(spec, async (client) => {
      const result = await client.callTool({ name, arguments: args }, { timeout: callTimeoutMs });
      return { isError: result?.isError === true, link: resultLink(result), text: resultText(result) };
    });
  }

  function stop(id) {
    const s = sessions.get(id);
    if (s) drop(id, s);
    return Boolean(s);
  }

  /** Stop every server; `sync` for app quit (kills immediately). */
  function stopAll({ sync = false } = {}) {
    for (const [id, s] of [...sessions]) drop(id, s, { sync });
  }

  function running() {
    return [...sessions.keys()];
  }

  return { listTools, callTool, stop, stopAll, running, _sessions: sessions };
}

module.exports = {
  createStdioPool,
  resolveCommand,
  searchDirs,
  childEnv,
  loginShellPath,
  killTree,
  ProcessTransport,
  LocalServerError,
  HANDSHAKE_TIMEOUT_MS,
};
