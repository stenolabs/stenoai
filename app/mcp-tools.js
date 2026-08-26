'use strict';

const fs = require('fs');
const path = require('path');

// Bounds and limits (stated explicitly per spec):
// - LIMIT_DEFAULT: 20 meetings per page
// - LIMIT_MIN: 1 meeting
// - LIMIT_MAX: 200 meetings max per page
// - QUESTION_MAX_LENGTH: 4000 characters for ask_meetings
// - SEARCH_QUERY_MAX_LENGTH: 500 characters for search_meetings
// - MEETING_IDS_MAX_COUNT: 50 meeting IDs max for ask_meetings
// - FOLDER_ID_MAX_LENGTH: 100 characters
// - DEFAULT_TIMEOUT_MS: 60000 ms (1 minute)
const LIMIT_DEFAULT = 20;
const LIMIT_MIN = 1;
const LIMIT_MAX = 200;
const QUESTION_MAX_LENGTH = 4000;
const SEARCH_QUERY_MAX_LENGTH = 500;
const MEETING_IDS_MAX_COUNT = 50;
const FOLDER_ID_MAX_LENGTH = 100;
const DEFAULT_TIMEOUT_MS = 60000;

function clampLimit(limit) {
  if (typeof limit !== 'number' || Number.isNaN(limit)) {
    return LIMIT_DEFAULT;
  }
  const intVal = Math.floor(limit);
  if (intVal < LIMIT_MIN) return LIMIT_MIN;
  if (intVal > LIMIT_MAX) return LIMIT_MAX;
  return intVal;
}

/**
 * Parse a markdown meeting note (mirrors simple_recorder._parse_meeting_markdown / app/main.js).
 */
function parseMeetingMarkdown(content, mdPath) {
  const meta = {};
  let body = content;
  if (content.startsWith('---')) {
    const parts = content.split('---');
    if (parts.length >= 3) {
      const fmText = parts[1].trim();
      body = parts.slice(2).join('---').trim();
      for (const line of fmText.split('\n')) {
        const colon = line.indexOf(':');
        if (colon === -1) continue;
        const key = line.slice(0, colon).trim();
        let value = line.slice(colon + 1).trim();
        if (value.startsWith('"') && value.endsWith('"')) {
          value = value.slice(1, -1).replace(/\\(.)/g, '$1');
        } else if (value.startsWith('[')) {
          try {
            value = JSON.parse(value);
          } catch (_) {
            value = [];
          }
        } else if (value === 'null') {
          value = null;
        } else if (value === 'true') {
          value = true;
        } else if (value === 'false') {
          value = false;
        } else if (/^-?\d+$/.test(value)) {
          value = parseInt(value, 10);
        }
        meta[key] = value;
      }
    }
  }

  const sections = {};
  let currentSection = null;
  let currentLines = [];
  for (const line of body.split('\n')) {
    if (line.startsWith('## ')) {
      if (currentSection) sections[currentSection] = currentLines.join('\n').trim();
      currentSection = line.slice(3).trim().toLowerCase();
      currentLines = [];
    } else {
      currentLines.push(line);
    }
  }
  if (currentSection) sections[currentSection] = currentLines.join('\n').trim();

  const participants = sections.participants
    ? sections.participants.split(',').map((p) => p.trim()).filter(Boolean)
    : (Array.isArray(meta.participants) ? meta.participants : (Array.isArray(meta.attendees) ? meta.attendees : []));

  const keyPoints = [];
  if (sections['key points']) {
    for (let line of sections['key points'].split('\n')) {
      line = line.trim();
      if (line.startsWith('- ')) keyPoints.push(line.slice(2));
    }
  }

  const actionItems = [];
  if (sections['action items']) {
    for (let line of sections['action items'].split('\n')) {
      line = line.trim();
      if (line.startsWith('- ')) actionItems.push(line.slice(2).replace('[ ] ', '').replace('[x] ', ''));
    }
  }

  const stem = path.basename(mdPath).replace(/\.md$/, '');
  const sessionInfo = {
    name: meta.title || stem,
    processed_at: meta.date || '',
    duration_seconds: meta.duration_seconds ?? null,
    summary_file: mdPath,
  };

  return {
    session_info: sessionInfo,
    title: meta.title || stem,
    date: meta.date || '',
    duration_seconds: meta.duration_seconds ?? null,
    summary: sections.summary || '',
    participants,
    attendees: participants,
    key_points: keyPoints,
    action_items: actionItems,
    transcript: sections.transcript || '',
    user_notes: sections['user notes'] ?? null,
    folders: Array.isArray(meta.folders) ? meta.folders : [],
  };
}

/**
 * Resolve and validate a meeting_id through validateMeetingFilePath.
 * Ensures no path traversal occurs and rejects files outside allowed output directories.
 */
async function resolveAndValidateMeetingId(meetingId, argName, validateMeetingFilePath, getOutputDir) {
  if (typeof meetingId !== 'string' || !meetingId.trim()) {
    return { error: `Invalid ${argName}: must be a non-empty string` };
  }
  const trimmed = meetingId.trim();

  // If meeting_id is a simple basename without path separators, try resolving within outputDir
  let candidate = trimmed;
  if (!trimmed.includes('/') && !trimmed.includes('\\')) {
    const outDir = typeof getOutputDir === 'function' ? getOutputDir() : null;
    if (outDir) {
      candidate = path.join(outDir, trimmed);
    }
  }

  let validated;
  try {
    validated = await validateMeetingFilePath(candidate);
  } catch (_) {
    return { error: `Invalid ${argName}: validation failed` };
  }

  // Fallback for direct basename mocks if candidate failed and differed
  if ((!validated || validated.error) && candidate !== trimmed) {
    try {
      validated = await validateMeetingFilePath(trimmed);
    } catch (_) {
      return { error: `Invalid ${argName}: validation failed` };
    }
  }

  if (!validated || validated.error) {
    return { error: `Invalid ${argName}: validation failed` };
  }

  const realPath = validated.realPath || candidate;
  return { realPath };
}

/**
 * Parse streaming output from chat-global-streaming.
 */
function parseChatStreamOutput(stdout) {
  const lines = String(stdout || '').split(/\r?\n/);
  const chunks = [];
  let streamError = null;

  for (const line of lines) {
    if (line.startsWith('CHAT_CHUNK:')) {
      try {
        const chunk = Buffer.from(line.slice(11), 'base64').toString('utf-8');
        chunks.push(chunk);
      } catch (_) {
        // ignore decoding errors
      }
    } else if (line.startsWith('CHAT_STREAM_ERROR:')) {
      streamError = line.slice(18).trim() || 'Cross-note chat stream error';
    }
  }

  if (streamError) {
    return { error: streamError };
  }

  if (chunks.length > 0) {
    return { answer: chunks.join('') };
  }

  // Fallback for non-chunked plain text stdout (e.g. from a test mock)
  const trimmed = stdout ? stdout.trim() : '';
  if (trimmed && !trimmed.startsWith('CHAT_CHUNK:') && !trimmed.startsWith('CHAT_STREAM_')) {
    return { answer: trimmed };
  }

  return { answer: '' };
}

/**
 * Format a meeting list entry into human-readable text.
 */
function formatMeetingListText(meetings) {
  if (!meetings || meetings.length === 0) {
    return 'No meetings found.';
  }
  const lines = [`Found ${meetings.length} meeting(s):`, ''];
  for (const m of meetings) {
    const dur = m.duration_seconds != null ? ` (${Math.round(m.duration_seconds / 60)} min)` : '';
    const dateStr = m.date ? ` - ${m.date}` : '';
    const attStr = m.attendees && m.attendees.length > 0 ? ` [Attendees: ${m.attendees.join(', ')}]` : '';
    lines.push(`- **${m.title || 'Untitled note'}**${dur}${dateStr}${attStr}`);
    lines.push(`  ID: \`${m.id}\``);
  }
  return lines.join('\n');
}

/**
 * Format meeting detail into human-readable text.
 */
function formatMeetingDetailText(meeting) {
  const parts = [];
  parts.push(`# ${meeting.title || 'Untitled note'}`);
  parts.push(`ID: \`${meeting.id}\``);
  if (meeting.date) parts.push(`Date: ${meeting.date}`);
  if (meeting.duration_seconds != null) {
    const mins = Math.round(meeting.duration_seconds / 60);
    parts.push(`Duration: ${mins} min (${meeting.duration_seconds}s)`);
  }
  if (meeting.attendees && meeting.attendees.length > 0) {
    parts.push(`Attendees: ${meeting.attendees.join(', ')}`);
  }
  if (meeting.folders && meeting.folders.length > 0) {
    parts.push(`Folders: ${meeting.folders.join(', ')}`);
  }
  if (meeting.summary) {
    parts.push(`\n## Summary\n${meeting.summary}`);
  }
  if (meeting.key_points && meeting.key_points.length > 0) {
    parts.push(`\n## Key Points\n${meeting.key_points.map((p) => `- ${p}`).join('\n')}`);
  }
  if (meeting.action_items && meeting.action_items.length > 0) {
    parts.push(`\n## Action Items\n${meeting.action_items.map((a) => `- ${a}`).join('\n')}`);
  }
  if (meeting.user_notes) {
    parts.push(`\n## User Notes\n${meeting.user_notes}`);
  }
  return parts.join('\n');
}

/**
 * Format search results into human-readable text.
 */
function formatSearchResultsText(query, results) {
  if (!results || results.length === 0) {
    return `No meetings found matching "${query}".`;
  }
  const lines = [`Found ${results.length} meeting(s) matching "${query}":`, ''];
  for (const r of results) {
    const dur = r.duration_seconds != null ? ` (${Math.round(r.duration_seconds / 60)} min)` : '';
    const dateStr = r.date ? ` - ${r.date}` : '';
    const fieldsStr = r.matched_fields && r.matched_fields.length > 0 ? ` (matched in: ${r.matched_fields.join(', ')})` : '';
    lines.push(`- **${r.title || 'Untitled note'}**${dur}${dateStr}${fieldsStr}`);
    lines.push(`  ID: \`${r.id}\``);
  }
  return lines.join('\n');
}

/**
 * Format folder list into human-readable text.
 */
function formatFolderListText(folders) {
  if (!folders || folders.length === 0) {
    return 'No folders found.';
  }
  const lines = [`Found ${folders.length} folder(s):`, ''];
  for (const f of folders) {
    const name = f.name || f.id || 'Untitled folder';
    const icon = f.icon ? `${f.icon} ` : '';
    lines.push(`- ${icon}**${name}** (ID: \`${f.id}\`)`);
  }
  return lines.join('\n');
}

/**
 * Tool definitions conforming to Model Context Protocol (MCP) tool schema.
 */
const TOOL_DEFINITIONS = [
  {
    name: 'list_meetings',
    title: 'List Meetings',
    description:
      'List recorded and processed meetings sorted newest-first. Returns metadata including note ID, title, date, duration, folders, and attendees. Does not return meeting summaries or transcripts.',
    inputSchema: {
      type: 'object',
      properties: {
        limit: {
          type: 'integer',
          description: 'Maximum number of meetings to return (default 20, max 200)',
          default: 20,
          minimum: 1,
          maximum: 200,
        },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'get_meeting',
    title: 'Get Meeting Details',
    description:
      'Retrieve details and summary of a specific meeting by its meeting ID. Returns title, date, duration, folders, attendees, summary, key points, action items, and user notes. Does not return the full transcript (use get_meeting_transcript for transcript text).',
    inputSchema: {
      type: 'object',
      properties: {
        meeting_id: {
          type: 'string',
          description: 'The meeting summary file name or ID (e.g. 20240101_120000_summary.json)',
        },
      },
      required: ['meeting_id'],
      additionalProperties: false,
    },
  },
  {
    name: 'get_meeting_transcript',
    title: 'Get Meeting Transcript',
    description: 'Retrieve the full transcript text for a specific meeting by its meeting ID.',
    inputSchema: {
      type: 'object',
      properties: {
        meeting_id: {
          type: 'string',
          description: 'The meeting summary file name or ID (e.g. 20240101_120000_summary.json)',
        },
      },
      required: ['meeting_id'],
      additionalProperties: false,
    },
  },
  {
    name: 'search_meetings',
    title: 'Search Meetings',
    description:
      'Search meetings by substring query across title, summary, key points, action items, user notes, and attendees. Supports multilingual matching including Traditional Chinese (zh-Hant) and English.',
    inputSchema: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description: 'Search keyword or phrase to match against meeting metadata and summary content',
        },
        limit: {
          type: 'integer',
          description: 'Maximum number of matching meetings to return (default 20, max 200)',
          default: 20,
          minimum: 1,
          maximum: 200,
        },
      },
      required: ['query'],
      additionalProperties: false,
    },
  },
  {
    name: 'list_folders',
    title: 'List Folders',
    description: 'List all meeting folders and their metadata including folder IDs, names, colors, icons, and order.',
    inputSchema: {
      type: 'object',
      properties: {},
      additionalProperties: false,
    },
  },
  {
    name: 'ask_meetings',
    title: 'Ask Across Meetings',
    description:
      'Ask a question across meeting notes using cross-note AI synthesis. Can be scoped to specific meeting IDs or a folder ID. Note: this tool executes an LLM model call.',
    inputSchema: {
      type: 'object',
      properties: {
        question: {
          type: 'string',
          description: 'Question to ask across the meeting notes',
        },
        meeting_ids: {
          type: 'array',
          items: {
            type: 'string',
          },
          description: 'Optional list of meeting summary IDs or paths to restrict the answer corpus to',
        },
        folder_id: {
          type: 'string',
          description: 'Optional folder ID to restrict the answer corpus to (ignored if meeting_ids is provided)',
        },
      },
      required: ['question'],
      additionalProperties: false,
    },
  },
];

/**
 * Factory for MCP tools.
 *
 * @param {object} deps
 * @param {(script: string, args: string[], wantString?: boolean) => Promise<string>} deps.runPythonScript
 * @param {(summaryFile: string) => Promise<{ realPath?: string, error?: string }>} deps.validateMeetingFilePath
 * @param {() => string} [deps.getOutputDir]
 * @param {number} [deps.timeoutMs]
 * @param {(args: string[]) => import('child_process').ChildProcess} deps.spawnBackend
 * @param {(pid: number) => void} deps.killBackendTree
 */
function createMcpTools({
  runPythonScript,
  validateMeetingFilePath,
  getOutputDir,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  spawnBackend,
  killBackendTree,
} = {}) {
  if (typeof runPythonScript !== 'function') {
    throw new TypeError('createMcpTools requires runPythonScript function');
  }
  if (typeof validateMeetingFilePath !== 'function') {
    throw new TypeError('createMcpTools requires validateMeetingFilePath function');
  }
  async function handleListMeetings(args = {}) {
    const limit = clampLimit(args.limit);
    let raw;
    try {
      raw = await runPythonScript('simple_recorder.py', ['list-meetings'], true);
    } catch (_) {
      return {
        isError: true,
        content: [{ type: 'text', text: 'Failed to list meetings from backend' }],
        structuredContent: { error: 'Failed to list meetings from backend' },
      };
    }

    let allMeetings = [];
    try {
      const parsed = typeof raw === 'string' ? JSON.parse(raw.trim()) : raw;
      if (Array.isArray(parsed)) {
        allMeetings = parsed;
      }
    } catch (_) {
      return {
        isError: true,
        content: [{ type: 'text', text: 'Failed to parse meeting list from backend' }],
        structuredContent: { error: 'Failed to parse meeting list from backend' },
      };
    }

    const meetings = allMeetings.slice(0, limit).map((m) => {
      const summaryFile = m.session_info?.summary_file || m.summary_file || '';
      const id = summaryFile ? path.basename(summaryFile) : (m.id || '');
      const title = m.session_info?.name || m.title || 'Untitled note';
      const date = m.session_info?.processed_at || m.session_info?.date || m.date || '';
      const duration_seconds = m.session_info?.duration_seconds ?? m.duration_seconds ?? null;
      const folders = Array.isArray(m.folders)
        ? m.folders
        : Array.isArray(m.session_info?.folders)
          ? m.session_info.folders
          : [];
      const attendees = Array.isArray(m.participants)
        ? m.participants
        : Array.isArray(m.attendees)
          ? m.attendees
          : Array.isArray(m.session_info?.participants)
            ? m.session_info.participants
            : [];
      return {
        id,
        title,
        date,
        duration_seconds,
        folders,
        attendees,
      };
    });

    return {
      content: [{ type: 'text', text: formatMeetingListText(meetings) }],
      structuredContent: {
        meetings,
      },
    };
  }

  async function handleGetMeeting(args = {}) {
    if (!args || typeof args.meeting_id !== 'string') {
      return {
        isError: true,
        content: [{ type: 'text', text: 'Invalid meeting_id: argument is required' }],
        structuredContent: { error: 'Invalid meeting_id: argument is required' },
      };
    }

    const validated = await resolveAndValidateMeetingId(
      args.meeting_id,
      'meeting_id',
      validateMeetingFilePath,
      getOutputDir
    );
    if (validated.error) {
      return {
        isError: true,
        content: [{ type: 'text', text: validated.error }],
        structuredContent: { error: validated.error },
      };
    }

    const { realPath } = validated;
    let content;
    try {
      content = await fs.promises.readFile(realPath, 'utf-8');
    } catch (_) {
      return {
        isError: true,
        content: [{ type: 'text', text: 'Failed to read meeting file' }],
        structuredContent: { error: 'Failed to read meeting file' },
      };
    }

    let parsed;
    if (realPath.endsWith('.md')) {
      parsed = parseMeetingMarkdown(content, realPath);
    } else {
      try {
        parsed = JSON.parse(content);
      } catch (_) {
        return {
          isError: true,
          content: [{ type: 'text', text: 'Failed to parse meeting file' }],
          structuredContent: { error: 'Failed to parse meeting file' },
        };
      }
    }

    const id = path.basename(realPath);
    const title = parsed.session_info?.name || parsed.title || 'Untitled note';
    const date = parsed.session_info?.processed_at || parsed.session_info?.date || parsed.date || '';
    const duration_seconds = parsed.session_info?.duration_seconds ?? parsed.duration_seconds ?? null;
    const folders = Array.isArray(parsed.folders)
      ? parsed.folders
      : Array.isArray(parsed.session_info?.folders)
        ? parsed.session_info.folders
        : [];
    const attendees = Array.isArray(parsed.participants)
      ? parsed.participants
      : Array.isArray(parsed.attendees)
        ? parsed.attendees
        : Array.isArray(parsed.session_info?.participants)
          ? parsed.session_info.participants
          : [];
    const summary = parsed.summary || '';
    const key_points = Array.isArray(parsed.key_points) ? parsed.key_points : [];
    const action_items = Array.isArray(parsed.action_items) ? parsed.action_items : [];
    const user_notes = parsed.user_notes ?? null;

    const resultData = {
      id,
      title,
      date,
      duration_seconds,
      folders,
      attendees,
      summary,
      key_points,
      action_items,
      user_notes,
    };

    return {
      content: [{ type: 'text', text: formatMeetingDetailText(resultData) }],
      structuredContent: resultData,
    };
  }

  async function handleGetMeetingTranscript(args = {}) {
    if (!args || typeof args.meeting_id !== 'string') {
      return {
        isError: true,
        content: [{ type: 'text', text: 'Invalid meeting_id: argument is required' }],
        structuredContent: { error: 'Invalid meeting_id: argument is required' },
      };
    }

    const validated = await resolveAndValidateMeetingId(
      args.meeting_id,
      'meeting_id',
      validateMeetingFilePath,
      getOutputDir
    );
    if (validated.error) {
      return {
        isError: true,
        content: [{ type: 'text', text: validated.error }],
        structuredContent: { error: validated.error },
      };
    }

    const { realPath } = validated;
    let content;
    try {
      content = await fs.promises.readFile(realPath, 'utf-8');
    } catch (_) {
      return {
        isError: true,
        content: [{ type: 'text', text: 'Failed to read meeting file' }],
        structuredContent: { error: 'Failed to read meeting file' },
      };
    }

    let parsed;
    if (realPath.endsWith('.md')) {
      parsed = parseMeetingMarkdown(content, realPath);
    } else {
      try {
        parsed = JSON.parse(content);
      } catch (_) {
        return {
          isError: true,
          content: [{ type: 'text', text: 'Failed to parse meeting file' }],
          structuredContent: { error: 'Failed to parse meeting file' },
        };
      }
    }

    const id = path.basename(realPath);
    const title = parsed.session_info?.name || parsed.title || 'Untitled note';
    const transcript = parsed.transcript || parsed.diarised_text || '';

    const textOutput = transcript.trim() ? transcript : '(No transcript available for this meeting)';

    return {
      content: [{ type: 'text', text: textOutput }],
      structuredContent: {
        id,
        title,
        transcript,
      },
    };
  }

  async function handleSearchMeetings(args = {}) {
    if (!args || typeof args.query !== 'string' || !args.query.trim()) {
      return {
        isError: true,
        content: [{ type: 'text', text: 'Invalid query: search query must be a non-empty string' }],
        structuredContent: { error: 'Invalid query: search query must be a non-empty string' },
      };
    }

    const rawQuery = args.query.trim();
    if (rawQuery.length > SEARCH_QUERY_MAX_LENGTH) {
      return {
        isError: true,
        content: [{ type: 'text', text: `Invalid query: exceeds maximum length of ${SEARCH_QUERY_MAX_LENGTH} characters` }],
        structuredContent: { error: 'Invalid query: query too long' },
      };
    }

    const limit = clampLimit(args.limit);
    let raw;
    try {
      raw = await runPythonScript('simple_recorder.py', ['list-meetings'], true);
    } catch (_) {
      return {
        isError: true,
        content: [{ type: 'text', text: 'Failed to search meetings from backend' }],
        structuredContent: { error: 'Failed to search meetings from backend' },
      };
    }

    let allMeetings = [];
    try {
      const parsed = typeof raw === 'string' ? JSON.parse(raw.trim()) : raw;
      if (Array.isArray(parsed)) {
        allMeetings = parsed;
      }
    } catch (_) {
      return {
        isError: true,
        content: [{ type: 'text', text: 'Failed to parse meeting list from backend' }],
        structuredContent: { error: 'Failed to parse meeting list from backend' },
      };
    }

    const queryLower = rawQuery.toLowerCase();
    const results = [];

    for (const m of allMeetings) {
      const matched_fields = [];
      const title = m.session_info?.name || m.title || '';
      const summary = m.summary || '';
      const key_points = Array.isArray(m.key_points) ? m.key_points.join(' ') : '';
      const action_items = Array.isArray(m.action_items) ? m.action_items.join(' ') : '';
      const user_notes = m.user_notes || '';
      const attendeesArr = Array.isArray(m.participants)
        ? m.participants
        : Array.isArray(m.attendees)
          ? m.attendees
          : Array.isArray(m.session_info?.participants)
            ? m.session_info.participants
            : [];
      const attendees = attendeesArr.join(' ');
      const foldersArr = Array.isArray(m.folders)
        ? m.folders
        : Array.isArray(m.session_info?.folders)
          ? m.session_info.folders
          : [];
      const folders = foldersArr.join(' ');

      if (title && title.toLowerCase().includes(queryLower)) matched_fields.push('title');
      if (summary && summary.toLowerCase().includes(queryLower)) matched_fields.push('summary');
      if (key_points && key_points.toLowerCase().includes(queryLower)) matched_fields.push('key_points');
      if (action_items && action_items.toLowerCase().includes(queryLower)) matched_fields.push('action_items');
      if (user_notes && user_notes.toLowerCase().includes(queryLower)) matched_fields.push('user_notes');
      if (attendees && attendees.toLowerCase().includes(queryLower)) matched_fields.push('attendees');
      if (folders && folders.toLowerCase().includes(queryLower)) matched_fields.push('folders');

      if (matched_fields.length > 0) {
        const summaryFile = m.session_info?.summary_file || m.summary_file || '';
        const id = summaryFile ? path.basename(summaryFile) : (m.id || '');
        const date = m.session_info?.processed_at || m.session_info?.date || m.date || '';
        const duration_seconds = m.session_info?.duration_seconds ?? m.duration_seconds ?? null;
        results.push({
          id,
          title: title || 'Untitled note',
          date,
          duration_seconds,
          folders: foldersArr,
          attendees: attendeesArr,
          matched_fields,
        });
      }
    }

    const limitedResults = results.slice(0, limit);

    return {
      content: [{ type: 'text', text: formatSearchResultsText(rawQuery, limitedResults) }],
      structuredContent: {
        query: rawQuery,
        results: limitedResults,
      },
    };
  }

  async function handleListFolders() {
    let raw;
    try {
      raw = await runPythonScript('simple_recorder.py', ['list-folders'], true);
    } catch (_) {
      return {
        isError: true,
        content: [{ type: 'text', text: 'Failed to list folders from backend' }],
        structuredContent: { error: 'Failed to list folders from backend' },
      };
    }

    let folders = [];
    try {
      const parsed = typeof raw === 'string' ? JSON.parse(raw.trim()) : raw;
      if (Array.isArray(parsed)) {
        folders = parsed;
      } else if (parsed && Array.isArray(parsed.folders)) {
        folders = parsed.folders;
      }
    } catch (_) {
      return {
        isError: true,
        content: [{ type: 'text', text: 'Failed to parse folders from backend' }],
        structuredContent: { error: 'Failed to parse folders from backend' },
      };
    }

    return {
      content: [{ type: 'text', text: formatFolderListText(folders) }],
      structuredContent: {
        folders,
      },
    };
  }

  async function handleAskMeetings(args = {}) {
    if (!args || typeof args.question !== 'string' || !args.question.trim()) {
      return {
        isError: true,
        content: [{ type: 'text', text: 'Invalid question: question must be a non-empty string' }],
        structuredContent: { error: 'Invalid question: question must be a non-empty string' },
      };
    }

    const rawQuestion = args.question.trim();
    if (rawQuestion.length > QUESTION_MAX_LENGTH) {
      return {
        isError: true,
        content: [{ type: 'text', text: `Invalid question: exceeds maximum length of ${QUESTION_MAX_LENGTH} characters` }],
        structuredContent: { error: 'Invalid question: question too long' },
      };
    }

    const validatedPaths = [];
    if (args.meeting_ids !== undefined) {
      if (!Array.isArray(args.meeting_ids)) {
        return {
          isError: true,
          content: [{ type: 'text', text: 'Invalid meeting_ids: must be an array of string IDs' }],
          structuredContent: { error: 'Invalid meeting_ids: must be an array of string IDs' },
        };
      }
      if (args.meeting_ids.length > MEETING_IDS_MAX_COUNT) {
        return {
          isError: true,
          content: [{ type: 'text', text: `Invalid meeting_ids: exceeds maximum count of ${MEETING_IDS_MAX_COUNT} IDs` }],
          structuredContent: { error: 'Invalid meeting_ids: too many IDs' },
        };
      }

      for (const mId of args.meeting_ids) {
        const validated = await resolveAndValidateMeetingId(
          mId,
          'meeting_ids',
          validateMeetingFilePath,
          getOutputDir
        );
        if (validated.error) {
          return {
            isError: true,
            content: [{ type: 'text', text: validated.error }],
            structuredContent: { error: validated.error },
          };
        }
        validatedPaths.push(validated.realPath);
      }
    }

    let folderId = null;
    if (args.folder_id !== undefined && args.folder_id !== null) {
      if (typeof args.folder_id !== 'string') {
        return {
          isError: true,
          content: [{ type: 'text', text: 'Invalid folder_id: must be a string' }],
          structuredContent: { error: 'Invalid folder_id: must be a string' },
        };
      }
      const trimmedFolder = args.folder_id.trim();
      if (trimmedFolder.length > FOLDER_ID_MAX_LENGTH) {
        return {
          isError: true,
          content: [{ type: 'text', text: `Invalid folder_id: exceeds maximum length of ${FOLDER_ID_MAX_LENGTH} characters` }],
          structuredContent: { error: 'Invalid folder_id: too long' },
        };
      }
      if (trimmedFolder && trimmedFolder !== 'all') {
        folderId = trimmedFolder;
      }
    }

    const cliArgs = ['chat-global-streaming', '-q', rawQuestion];
    if (validatedPaths.length > 0) {
      for (const p of validatedPaths) {
        cliArgs.push('--meeting', p);
      }
    } else if (folderId) {
      cliArgs.push('-f', folderId);
    }

    if (typeof spawnBackend !== 'function') {
      // A silent fallback to runPythonScript would reintroduce the unkillable-child defect
      return {
        isError: true,
        content: [{ type: 'text', text: 'Cross-note chat failed' }],
        structuredContent: { error: 'Cross-note chat failed' },
      };
    }

    const maxStdoutBytes = 10 * 1024 * 1024; // 10 MiB safety cap
    const execResult = await new Promise((resolve) => {
      let child;
      let timeoutTimer = null;
      let isResolved = false;

      const done = (result) => {
        if (isResolved) return;
        isResolved = true;
        if (timeoutTimer) {
          clearTimeout(timeoutTimer);
          timeoutTimer = null;
        }
        resolve(result);
      };

      try {
        child = spawnBackend(cliArgs);
      } catch (_) {
        return done({ ok: false, error: 'Cross-note chat failed' });
      }

      if (!child) {
        return done({ ok: false, error: 'Cross-note chat failed' });
      }

      timeoutTimer = setTimeout(() => {
        if (typeof killBackendTree === 'function' && child.pid !== undefined) {
          try {
            killBackendTree(child.pid);
          } catch (_) {}
        } else if (typeof child.kill === 'function') {
          try {
            child.kill();
          } catch (_) {}
        }
        done({ ok: false, isTimeout: true, error: 'Cross-note chat timed out' });
      }, timeoutMs);

      let stdout = '';
      if (child.stdout) {
        child.stdout.on('data', (data) => {
          if (stdout.length < maxStdoutBytes) {
            stdout += data.toString();
          }
        });
      }

      // Drain stderr to prevent pipe-buffer deadlock (~64KB OS buffer fills on chatty runs);
      // explicitly do not log stderr content to preserve privacy boundaries.
      if (child.stderr) {
        if (typeof child.stderr.resume === 'function') {
          child.stderr.resume();
        } else if (typeof child.stderr.on === 'function') {
          child.stderr.on('data', () => {});
        }
      }

      child.once('error', () => {
        done({ ok: false, error: 'Cross-note chat failed' });
      });

      child.once('close', (code) => {
        if (code === 0) {
          done({ ok: true, stdout });
        } else {
          done({ ok: false, error: 'Cross-note chat failed' });
        }
      });
    });

    if (!execResult.ok) {
      const errText = execResult.isTimeout ? 'Cross-note chat timed out' : 'Cross-note chat failed';
      return {
        isError: true,
        content: [{ type: 'text', text: errText }],
        structuredContent: { error: errText },
      };
    }

    const stdout = execResult.stdout || '';

    const parsedStream = parseChatStreamOutput(stdout);
    if (parsedStream.error) {
      return {
        isError: true,
        content: [{ type: 'text', text: `Cross-note chat failed: ${parsedStream.error}` }],
        structuredContent: { error: parsedStream.error },
      };
    }

    const answer = parsedStream.answer || '';
    return {
      content: [{ type: 'text', text: answer || '(No response generated)' }],
      structuredContent: {
        question: rawQuestion,
        answer,
      },
    };
  }

  async function call(name, args = {}) {
    switch (name) {
      case 'list_meetings':
        return await handleListMeetings(args);
      case 'get_meeting':
        return await handleGetMeeting(args);
      case 'get_meeting_transcript':
        return await handleGetMeetingTranscript(args);
      case 'search_meetings':
        return await handleSearchMeetings(args);
      case 'list_folders':
        return await handleListFolders(args);
      case 'ask_meetings':
        return await handleAskMeetings(args);
      default:
        return {
          isError: true,
          content: [{ type: 'text', text: `Unknown tool: ${name}` }],
          structuredContent: { error: `Unknown tool: ${name}` },
        };
    }
  }

  return {
    definitions: TOOL_DEFINITIONS,
    call,
  };
}

module.exports = {
  createMcpTools,
  TOOL_DEFINITIONS,
  LIMIT_DEFAULT,
  LIMIT_MIN,
  LIMIT_MAX,
  QUESTION_MAX_LENGTH,
  SEARCH_QUERY_MAX_LENGTH,
  MEETING_IDS_MAX_COUNT,
};
