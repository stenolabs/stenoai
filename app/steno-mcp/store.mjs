// Read-only access to the meetings Steno writes, for the Steno MCP server.
//
// Everything here is synchronous, dependency-free, and never writes. The MCP
// wiring lives in server.mjs; this module owns the parts with security weight:
//
//  - Where the notes are. Mirrors src/config.py get_user_data_dir() and
//    get_data_dirs(): STENOAI_USER_DATA_DIR wins (test isolation), then the
//    user's custom storage_path from config.json, then the per-OS data dir. As
//    list-meetings does, a custom storage path also keeps the default output
//    dir visible, so notes written before the path change still show.
//  - What can be read. Files are found by listing output/ and transcripts/,
//    never by joining a caller-supplied id into a path. Every file is resolved
//    with realpath and must sit inside the realpath of its storage root, so a
//    symlink that points out of the store is skipped. Only regular files under
//    a size cap are read.
//  - What the user allowed. The folder allowlist and "exclude transcripts"
//    switch are read from config.json on every call, so a change in Steno's
//    Settings applies to a running server. A config.json that exists but
//    cannot be parsed fails closed: no meetings are visible.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const SUMMARY_MD = '_summary.md';
export const SUMMARY_JSON = '_summary.json';
export const TRANSCRIPT_TXT = '_transcript.txt';

/** Largest single file the server will read (bytes). */
export const MAX_FILE_BYTES = 8 * 1024 * 1024;
/** Upper bounds on tool output, so one call cannot flood an assistant's context. */
export const LIMITS = Object.freeze({
  searchDefault: 10,
  searchMax: 50,
  snippetChars: 240,
  noteMaxChars: 60_000,
  transcriptDefaultChars: 40_000,
  transcriptMaxChars: 200_000,
  actionItemsMax: 300,
  queryMaxChars: 500,
});

/** Per-OS Steno data dir (config.json, folders.json). Mirrors get_user_data_dir(). */
export function getUserDataDir({
  env = process.env,
  platform = process.platform,
  home = os.homedir(),
} = {}) {
  if (env.STENOAI_USER_DATA_DIR) return env.STENOAI_USER_DATA_DIR;
  if (platform === 'darwin') return path.join(home, 'Library', 'Application Support', 'stenoai');
  if (platform === 'win32') {
    return path.join(env.APPDATA || path.join(home, 'AppData', 'Roaming'), 'stenoai');
  }
  return path.join(env.XDG_DATA_HOME || path.join(home, '.local', 'share'), 'stenoai');
}

export class ConfigUnreadableError extends Error {}

/** Read config.json. Absent -> {}; present but unreadable -> throws (fail closed). */
export function readConfig(dataDir) {
  const cfgPath = path.join(dataDir, 'config.json');
  let text;
  try {
    text = fs.readFileSync(cfgPath, 'utf8');
  } catch (err) {
    if (err && err.code === 'ENOENT') return {};
    throw new ConfigUnreadableError('Steno settings could not be read');
  }
  try {
    const parsed = JSON.parse(text);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error('not an object');
    }
    return parsed;
  } catch {
    throw new ConfigUnreadableError('Steno settings could not be read');
  }
}

/**
 * The server-side scope settings. `folderAllowlist` is null for "all meetings",
 * or a Set of folder ids. A malformed allowlist narrows access rather than
 * widening it: anything that is set but not an array becomes an empty allowlist
 * (nothing visible). Transcripts are excluded only by a literal true, matching
 * Config.get_mcp_exclude_transcripts().
 */
export function readScope(config) {
  const raw = config.mcp_folder_allowlist;
  let folderAllowlist = null;
  if (raw !== undefined && raw !== null) {
    folderAllowlist = new Set(
      Array.isArray(raw) ? raw.filter((id) => typeof id === 'string' && id) : [],
    );
  }
  return {
    folderAllowlist,
    excludeTranscripts: config.mcp_exclude_transcripts === true,
  };
}

function realDir(dir) {
  try {
    const real = fs.realpathSync.native(dir);
    return fs.statSync(real).isDirectory() ? real : null;
  } catch {
    return null;
  }
}

/** realpath of `candidate` when it is a regular file strictly inside `root`, else null. */
export function resolveInside(root, candidate) {
  let real;
  try {
    real = fs.realpathSync.native(candidate);
  } catch {
    return null;
  }
  const rel = path.relative(root, real);
  if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) return null;
  try {
    const st = fs.statSync(real);
    if (!st.isFile() || st.size > MAX_FILE_BYTES) return null;
  } catch {
    return null;
  }
  return real;
}

/**
 * The storage roots to read, primary first. Each is a realpath'd directory.
 * Mirrors get_data_dirs() plus list-meetings' scan of the default output dir
 * when a custom storage path is set.
 */
export function resolveRoots({ env = process.env, platform, home, config } = {}) {
  const dataDir = getUserDataDir({ env, platform, home });
  const cfg = config ?? readConfig(dataDir);
  const custom = typeof cfg.storage_path === 'string' ? cfg.storage_path.trim() : '';
  const candidates = [];
  if (env.STENOAI_USER_DATA_DIR) {
    candidates.push(dataDir);
  } else if (custom && path.isAbsolute(custom)) {
    candidates.push(custom, dataDir);
  } else {
    candidates.push(dataDir);
  }
  const roots = [];
  for (const c of candidates) {
    const real = realDir(c);
    if (real && !roots.includes(real)) roots.push(real);
  }
  return { dataDir, roots, config: cfg };
}

// ---------------------------------------------------------------------------
// Parsing (mirrors simple_recorder._parse_meeting_markdown)
// ---------------------------------------------------------------------------

function parseScalar(raw) {
  const value = raw.trim();
  if (value.length >= 2 && value.startsWith('"') && value.endsWith('"')) {
    return value.slice(1, -1).replace(/\\(.)/g, '$1');
  }
  if (value.startsWith('[')) {
    try {
      const arr = JSON.parse(value);
      return Array.isArray(arr) ? arr : [];
    } catch {
      return [];
    }
  }
  if (value === 'null') return null;
  if (value === 'true') return true;
  if (value === 'false') return false;
  if (/^-?\d+$/.test(value)) return Number.parseInt(value, 10);
  return value;
}

export function parseMarkdownNote(content) {
  let meta = {};
  let body = content;
  if (content.startsWith('---')) {
    const end = content.indexOf('---', 3);
    if (end !== -1) {
      for (const line of content.slice(3, end).trim().split('\n')) {
        const idx = line.indexOf(':');
        if (idx === -1) continue;
        meta[line.slice(0, idx).trim()] = parseScalar(line.slice(idx + 1));
      }
      body = content.slice(end + 3).trim();
    }
  }
  const sections = [];
  let current = null;
  for (const line of body.split(/\r?\n/)) {
    if (line.startsWith('## ')) {
      current = { heading: line.slice(3).trim(), lines: [] };
      sections.push(current);
    } else if (current) {
      current.lines.push(line);
    }
  }
  return {
    meta,
    sections: sections.map((s) => ({ heading: s.heading, text: s.lines.join('\n').trim() })),
  };
}

function bulletLines(text) {
  return (text || '')
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l.startsWith('- ') || l.startsWith('* '))
    .map((l) => l.slice(2));
}

/** Strip the header block simple_recorder writes above the "=====" separator. */
export function transcriptBody(text) {
  const lines = text.split(/\r?\n/);
  const sep = lines.findIndex((l) => /^={20,}\s*$/.test(l));
  return (sep === -1 ? text : lines.slice(sep + 1).join('\n')).trim();
}

function asString(v) {
  return typeof v === 'string' ? v : '';
}

function asStringList(v) {
  return Array.isArray(v) ? v.filter((x) => typeof x === 'string') : [];
}

/** A meeting, normalised from either a .md note or a legacy _summary.json. */
function loadMeeting(root, stem, summaryReal, kind) {
  let text;
  try {
    text = fs.readFileSync(summaryReal, 'utf8');
  } catch {
    return null;
  }
  if (kind === 'md') {
    const { meta, sections } = parseMarkdownNote(text);
    const get = (name) =>
      sections.find((s) => s.heading.toLowerCase() === name)?.text ?? '';
    return {
      id: stem,
      root,
      kind,
      title: asString(meta.title) || stem,
      date: asString(meta.date),
      durationSeconds: typeof meta.duration_seconds === 'number' ? meta.duration_seconds : null,
      folders: asStringList(meta.folders),
      participants: get('participants')
        .split(',')
        .map((p) => p.trim())
        .filter(Boolean),
      sections: sections.filter((s) => s.heading.toLowerCase() !== 'transcript'),
      inlineTranscript: get('transcript'),
      actionItems: bulletLines(get('action items')),
    };
  }
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    return null;
  }
  if (!data || typeof data !== 'object') return null;
  const info = data.session_info && typeof data.session_info === 'object' ? data.session_info : {};
  const sections = [];
  if (asString(data.summary)) sections.push({ heading: 'Summary', text: data.summary });
  const participants = asStringList(data.participants);
  if (participants.length) sections.push({ heading: 'Participants', text: participants.join(', ') });
  const keyPoints = asStringList(data.key_points);
  if (keyPoints.length) {
    sections.push({ heading: 'Key Points', text: keyPoints.map((k) => `- ${k}`).join('\n') });
  }
  const actions = asStringList(data.action_items);
  if (actions.length) {
    sections.push({ heading: 'Action Items', text: actions.map((a) => `- [ ] ${a}`).join('\n') });
  }
  if (asString(data.user_notes)) sections.push({ heading: 'User Notes', text: data.user_notes });
  return {
    id: stem,
    root,
    kind,
    title: asString(info.name) || stem,
    date: asString(info.processed_at),
    durationSeconds: typeof info.duration_seconds === 'number' ? info.duration_seconds : null,
    folders: asStringList(data.folders),
    participants,
    sections,
    inlineTranscript: asString(data.transcript),
    actionItems: actions.map((a) => `[ ] ${a}`),
  };
}

function listSummaries(root) {
  const outDir = path.join(root, 'output');
  let entries;
  try {
    entries = fs.readdirSync(outDir, { withFileTypes: true });
  } catch {
    return [];
  }
  const found = [];
  // JSON first: when both exist for one stem, JSON wins (as in list-meetings).
  for (const [suffix, kind] of [
    [SUMMARY_JSON, 'json'],
    [SUMMARY_MD, 'md'],
  ]) {
    for (const entry of entries) {
      if (!entry.name.endsWith(suffix) || entry.name.startsWith('.')) continue;
      if (!entry.isFile() && !entry.isSymbolicLink()) continue;
      const stem = entry.name.slice(0, -suffix.length);
      if (!stem) continue;
      found.push({ stem, kind, file: path.join(outDir, entry.name) });
    }
  }
  return found;
}

/**
 * Load the visible store: every meeting the scope allows, newest first, plus
 * the folders list. Throws ConfigUnreadableError when config.json is corrupt.
 */
export function loadStore(opts = {}) {
  const { dataDir, roots, config } = resolveRoots(opts);
  const scope = readScope(config);
  const seen = new Set();
  const meetings = [];
  for (const root of roots) {
    for (const { stem, kind, file } of listSummaries(root)) {
      if (seen.has(stem)) continue;
      const real = resolveInside(root, file);
      if (!real) continue;
      const meeting = loadMeeting(root, stem, real, kind);
      if (!meeting) continue;
      seen.add(stem);
      if (scope.folderAllowlist && !meeting.folders.some((f) => scope.folderAllowlist.has(f))) {
        continue;
      }
      meetings.push(meeting);
    }
  }
  meetings.sort((a, b) => (b.date || '').localeCompare(a.date || '') || a.id.localeCompare(b.id));
  const folders = loadFolders(roots[0]);
  return { dataDir, roots, scope, meetings, folders };
}

/** folders.json sits next to output/ in the primary root (get_folders_manager). */
function loadFolders(root) {
  if (!root) return [];
  const real = resolveInside(root, path.join(root, 'folders.json'));
  if (!real) return [];
  try {
    const data = JSON.parse(fs.readFileSync(real, 'utf8'));
    if (!data || !Array.isArray(data.folders)) return [];
    return data.folders
      .filter((f) => f && typeof f === 'object' && typeof f.id === 'string')
      .map((f) => ({ id: f.id, name: asString(f.name) || f.id }));
  } catch {
    return [];
  }
}

// ---------------------------------------------------------------------------
// Tool logic. Each returns plain data; server.mjs turns it into MCP results.
// ---------------------------------------------------------------------------

export class ToolError extends Error {}

const DATE_RE = /^\d{4}-\d{2}-\d{2}/;

function normaliseDateBound(value, name) {
  if (value === undefined || value === null || value === '') return null;
  if (typeof value !== 'string' || !DATE_RE.test(value)) {
    throw new ToolError(`${name} must be a date like 2026-11-22`);
  }
  return value.slice(0, 10);
}

function inRange(meeting, from, to) {
  const day = (meeting.date || '').slice(0, 10);
  if (from && (!day || day < from)) return false;
  if (to && (!day || day > to)) return false;
  return true;
}

function folderNames(meeting, folders) {
  return meeting.folders
    .map((id) => folders.find((f) => f.id === id)?.name)
    .filter(Boolean);
}

function resolveFolderFilter(store, folder) {
  if (folder === undefined || folder === null || folder === '') return null;
  if (typeof folder !== 'string') throw new ToolError('folder must be a folder name or id');
  const visible = visibleFolders(store);
  const lower = folder.toLowerCase();
  const match = visible.find((f) => f.id === folder) || visible.find((f) => f.name.toLowerCase() === lower);
  if (!match) throw new ToolError(`No folder named "${folder.slice(0, 80)}". Use list_folders to see folders.`);
  return match.id;
}

function visibleFolders(store) {
  const allow = store.scope.folderAllowlist;
  return allow ? store.folders.filter((f) => allow.has(f.id)) : store.folders;
}

/** Transcript text for a visible meeting, or '' when there is none. */
function readTranscript(meeting) {
  const candidate = path.join(meeting.root, 'transcripts', `${meeting.id}${TRANSCRIPT_TXT}`);
  const real = resolveInside(meeting.root, candidate);
  if (real) {
    try {
      return transcriptBody(fs.readFileSync(real, 'utf8'));
    } catch {
      // fall through to the inline copy
    }
  }
  return meeting.inlineTranscript || '';
}

function noteText(meeting) {
  return [meeting.title, ...meeting.sections.map((s) => `${s.heading}\n${s.text}`)].join('\n');
}

function snippetAround(text, terms) {
  const lower = text.toLowerCase();
  let at = -1;
  for (const t of terms) {
    const i = lower.indexOf(t);
    if (i !== -1 && (at === -1 || i < at)) at = i;
  }
  const half = Math.floor(LIMITS.snippetChars / 2);
  const start = Math.max(0, at === -1 ? 0 : at - half);
  const raw = text.slice(start, start + LIMITS.snippetChars).replace(/\s+/g, ' ').trim();
  return `${start > 0 ? '…' : ''}${raw}${start + LIMITS.snippetChars < text.length ? '…' : ''}`;
}

export function searchMeetings(store, { query = '', from, to, folder, limit } = {}) {
  if (typeof query !== 'string') throw new ToolError('query must be text');
  const q = query.slice(0, LIMITS.queryMaxChars).toLowerCase().trim();
  const terms = q.split(/\s+/).filter(Boolean);
  const fromDay = normaliseDateBound(from, 'from');
  const toDay = normaliseDateBound(to, 'to');
  const folderId = resolveFolderFilter(store, folder);
  const max = Math.min(
    Math.max(1, Number.isInteger(limit) ? limit : LIMITS.searchDefault),
    LIMITS.searchMax,
  );
  const results = [];
  let total = 0;
  for (const meeting of store.meetings) {
    if (!inRange(meeting, fromDay, toDay)) continue;
    if (folderId && !meeting.folders.includes(folderId)) continue;
    const note = noteText(meeting);
    let where = 'note';
    let haystack = note;
    if (terms.length) {
      const noteLower = note.toLowerCase();
      let matched = terms.every((t) => noteLower.includes(t));
      if (!matched && !store.scope.excludeTranscripts) {
        const transcript = readTranscript(meeting);
        const combined = `${noteLower}\n${transcript.toLowerCase()}`;
        if (terms.every((t) => combined.includes(t))) {
          matched = true;
          where = 'transcript';
          haystack = transcript;
        }
      }
      if (!matched) continue;
    } else {
      haystack = meeting.sections.find((s) => s.heading.toLowerCase() === 'summary')?.text || note;
    }
    total += 1;
    if (results.length >= max) continue;
    results.push({
      id: meeting.id,
      title: meeting.title,
      date: meeting.date || null,
      folders: folderNames(meeting, store.folders),
      matched_in: terms.length ? where : null,
      snippet: snippetAround(haystack, terms),
    });
  }
  return { results, total_matches: total, truncated: total > results.length };
}

function findMeeting(store, id) {
  if (typeof id !== 'string' || !id) throw new ToolError('id is required');
  // Lookup only: ids are compared against what the store listed, never used
  // to build a path, so "../x" or an absolute path simply does not match.
  const meeting = store.meetings.find((m) => m.id === id);
  if (!meeting) {
    throw new ToolError('No meeting with that id is available. Use search_meetings to find ids.');
  }
  return meeting;
}

function truncate(text, max) {
  if (text.length <= max) return { text, truncated: false };
  return { text: text.slice(0, max), truncated: true };
}

export function getNote(store, { id } = {}) {
  const meeting = findMeeting(store, id);
  const header = [`# ${meeting.title}`, ''];
  if (meeting.date) header.push(`Date: ${meeting.date}`);
  if (meeting.durationSeconds) header.push(`Duration: ${Math.round(meeting.durationSeconds / 60)} min`);
  const folders = folderNames(meeting, store.folders);
  if (folders.length) header.push(`Folders: ${folders.join(', ')}`);
  header.push(`Meeting id: ${meeting.id}`);
  const body = meeting.sections.map((s) => `## ${s.heading}\n\n${s.text}`).join('\n\n');
  const full = `${header.join('\n')}\n\n${body}`.trim();
  const { text, truncated } = truncate(full, LIMITS.noteMaxChars);
  return {
    markdown: truncated ? `${text}\n\n[Note truncated at ${LIMITS.noteMaxChars} characters]` : text,
    meta: {
      id: meeting.id,
      title: meeting.title,
      date: meeting.date || null,
      duration_seconds: meeting.durationSeconds,
      folders,
      participants: meeting.participants,
      transcript_available: !store.scope.excludeTranscripts,
    },
  };
}

export function getTranscript(store, { id, max_chars } = {}) {
  if (store.scope.excludeTranscripts) {
    throw new ToolError(
      'Transcripts are turned off for AI assistants in Steno (Connect > What assistants can see). Use get_note for the summary.',
    );
  }
  const meeting = findMeeting(store, id);
  const max = Math.min(
    Math.max(1, Number.isInteger(max_chars) ? max_chars : LIMITS.transcriptDefaultChars),
    LIMITS.transcriptMaxChars,
  );
  const full = readTranscript(meeting);
  const { text, truncated } = truncate(full, max);
  return { id: meeting.id, title: meeting.title, transcript: text, truncated, total_chars: full.length };
}

export function listActionItems(store, { from, to, owner } = {}) {
  const fromDay = normaliseDateBound(from, 'from');
  const toDay = normaliseDateBound(to, 'to');
  if (owner !== undefined && owner !== null && typeof owner !== 'string') {
    throw new ToolError('owner must be text');
  }
  const ownerLower = (owner || '').toLowerCase().trim();
  const items = [];
  let total = 0;
  for (const meeting of store.meetings) {
    if (!inRange(meeting, fromDay, toDay)) continue;
    for (const raw of meeting.actionItems) {
      const done = /^\[x\]\s*/i.test(raw);
      const text = raw.replace(/^\[[ xX]\]\s*/, '').trim();
      if (!text) continue;
      if (ownerLower && !text.toLowerCase().includes(ownerLower)) continue;
      total += 1;
      if (items.length >= LIMITS.actionItemsMax) continue;
      items.push({ meeting_id: meeting.id, meeting_title: meeting.title, date: meeting.date || null, item: text, done });
    }
  }
  return { items, total, truncated: total > items.length };
}

export function listFolders(store) {
  return {
    folders: visibleFolders(store).map((f) => ({
      id: f.id,
      name: f.name,
      meeting_count: store.meetings.filter((m) => m.folders.includes(f.id)).length,
    })),
    scope: store.scope.folderAllowlist ? 'selected_folders' : 'all_meetings',
  };
}
