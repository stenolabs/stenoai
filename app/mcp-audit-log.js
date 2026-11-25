'use strict';

/**
 * Local audit log of every approved action: <userData>/mcp-actions-audit.jsonl.
 *
 * One JSON object per line: time, connection (id, name, origin), tool, a
 * SHA-256 of the canonical arguments, the result (status, link, error
 * class) and, when the user had chosen "Always allow" for the app so no card
 * was shown, `autoApproved: true`. The arguments themselves are NOT written: they carry meeting
 * content, and the hash is enough to prove what was sent when compared with
 * the card or the receiving system. Nothing is ever sent anywhere from here.
 *
 * The file rotates to .1 at 5 MB so it cannot grow without bound.
 */

const crypto = require('node:crypto');
const nodeFs = require('node:fs');
const nodePath = require('node:path');

const MAX_BYTES = 5 * 1024 * 1024;

/** JSON with object keys sorted at every level, so equal arguments hash equally. */
function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((k) => `${JSON.stringify(k)}:${canonicalJson(value[k])}`).join(',')}}`;
  }
  return JSON.stringify(value === undefined ? null : value);
}

function argumentsHash(args) {
  return crypto.createHash('sha256').update(canonicalJson(args ?? {})).digest('hex');
}

function createAuditLog({ file, fs = nodeFs, path = nodePath, now = () => new Date() }) {
  function append(entry) {
    const line = {
      time: now().toISOString(),
      connectionId: entry.connectionId,
      connectionName: entry.connectionName,
      origin: entry.origin,
      tool: entry.tool,
      argumentsSha256: argumentsHash(entry.arguments),
      status: entry.status,
      ...(entry.autoApproved ? { autoApproved: true } : {}),
      ...(entry.link ? { link: entry.link } : {}),
      ...(entry.error ? { error: String(entry.error).slice(0, 200) } : {}),
      ...(entry.noteId ? { noteId: entry.noteId } : {}),
    };
    fs.mkdirSync(path.dirname(file), { recursive: true });
    try {
      if (fs.existsSync(file) && fs.statSync(file).size > MAX_BYTES) fs.renameSync(file, `${file}.1`);
    } catch (_) { /* rotation is best effort; appending still works */ }
    fs.appendFileSync(file, `${JSON.stringify(line)}\n`, { mode: 0o600 });
    return line;
  }

  /** Newest first. Unparseable lines are skipped. */
  function recent(limit = 50) {
    try {
      if (!fs.existsSync(file)) return [];
      const lines = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean);
      const out = [];
      for (let i = lines.length - 1; i >= 0 && out.length < limit; i -= 1) {
        try {
          out.push(JSON.parse(lines[i]));
        } catch (_) { /* skip */ }
      }
      return out;
    } catch (_) {
      return [];
    }
  }

  return { append, recent, file };
}

module.exports = { createAuditLog, argumentsHash, canonicalJson };
