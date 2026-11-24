// Diagnostics for the Steno MCP server: an error log and a "last used" stamp.
//
// The server runs inside an assistant (Claude Code, Codex, Cursor, Claude
// Desktop), so when it fails the user sees only that client's terse error.
// These leave a trail in Steno's own data dir instead:
//
//   <userData>/logs/steno-mcp.log      startup and tool errors, size-capped
//                                     (rotated once to steno-mcp.log.1)
//   <userData>/steno-mcp-last-used.json  when a tool last ran, per client name
//
// Neither ever holds meeting content: a log line is a timestamp, a tool name,
// an error class and a message with quoted text and file paths redacted.
// Every write is best effort; a diagnostics failure never fails a tool call.

import fs from 'node:fs';
import path from 'node:path';

export const LOG_FILE = 'steno-mcp.log';
export const LAST_USED_FILE = 'steno-mcp-last-used.json';
export const LOG_MAX_BYTES = 256 * 1024;
const MESSAGE_MAX_CHARS = 300;
// Rewriting the stamp on every call of a busy session is pointless churn.
const LAST_USED_MIN_INTERVAL_MS = 10_000;

/** An error message with anything that could be note text or a path removed. */
export function redact(message) {
  return String(message ?? '')
    .replace(/"[^"\n]*"|'[^'\n]*'|`[^`\n]*`/g, '"…"')
    // Any token with a slash is (part of) a path; an unquoted path with a
    // space ("Application Support") leaves slashed fragments, caught too.
    .replace(/[^\s"'`,;()]*[\\/][^\s"'`,;()]*/g, '<path>')
    .replace(/<path>(?:\s+<path>)+/g, '<path>')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, MESSAGE_MAX_CHARS);
}

const errorClass = (err) => (err && typeof err === 'object' && err.constructor?.name) || typeof err;
const errorMessage = (err) => (err && typeof err === 'object' && 'message' in err ? err.message : err);

export function createDiagnostics({ dataDir, now = () => new Date(), stderr = process.stderr } = {}) {
  const logDir = dataDir ? path.join(dataDir, 'logs') : null;
  const logPath = logDir ? path.join(logDir, LOG_FILE) : null;
  const lastUsedPath = dataDir ? path.join(dataDir, LAST_USED_FILE) : null;
  const lastStamp = new Map();

  function append(line) {
    if (!logPath) return;
    try {
      fs.mkdirSync(logDir, { recursive: true });
      try {
        if (fs.statSync(logPath).size + line.length > LOG_MAX_BYTES) {
          fs.renameSync(logPath, `${logPath}.1`);
        }
      } catch {
        // No log yet.
      }
      fs.appendFileSync(logPath, line);
    } catch {
      // Best effort.
    }
  }

  /** Log one line: `<time> <level> [tool=<name>] <message>`. */
  function log(level, message, { tool } = {}) {
    const text = `${tool ? `tool=${tool} ` : ''}${message}`;
    try {
      stderr.write(`[steno-mcp] ${level}: ${text}\n`);
    } catch {
      // stderr closed.
    }
    append(`${now().toISOString()} ${level.toUpperCase()} ${text}\n`);
  }

  /** An error, as class + redacted message only. */
  function logError(where, err, { tool, withMessage = true } = {}) {
    const msg = withMessage ? redact(errorMessage(err)) : '';
    log('error', `${where}: ${errorClass(err)}${msg ? `: ${msg}` : ''}`, { tool });
  }

  /** Stamp the last-used file for this MCP client (by its clientInfo name). */
  function markUsed(clientName) {
    if (!lastUsedPath) return;
    const name = typeof clientName === 'string' && clientName.trim() ? clientName.trim().slice(0, 100) : 'unknown';
    const at = now();
    const previous = lastStamp.get(name);
    if (previous !== undefined && at.getTime() - previous < LAST_USED_MIN_INTERVAL_MS) return;
    lastStamp.set(name, at.getTime());
    try {
      let data = {};
      try {
        data = JSON.parse(fs.readFileSync(lastUsedPath, 'utf8'));
      } catch {
        data = {};
      }
      const clients = data && typeof data.clients === 'object' && data.clients ? data.clients : {};
      const iso = at.toISOString();
      const next = { last_used_at: iso, clients: { ...clients, [name]: iso } };
      const tmp = `${lastUsedPath}.${process.pid}.tmp`;
      fs.mkdirSync(path.dirname(lastUsedPath), { recursive: true });
      fs.writeFileSync(tmp, `${JSON.stringify(next, null, 2)}\n`);
      fs.renameSync(tmp, lastUsedPath);
    } catch (err) {
      logError('last-used', err);
    }
  }

  return { log, logError, markUsed, logPath, lastUsedPath };
}
