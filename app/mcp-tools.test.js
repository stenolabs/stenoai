'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { createMcpTools, TOOL_DEFINITIONS } = require('./mcp-tools');

function createTempNotesDir() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'stenoai-mcp-tools-test-'));
  const outputDir = path.join(tmp, 'output');
  fs.mkdirSync(outputDir, { recursive: true });
  return { tmp, outputDir };
}

test('TOOL_DEFINITIONS exposes six tools with descriptions, titles, and schemas', () => {
  assert.equal(Array.isArray(TOOL_DEFINITIONS), true);
  assert.equal(TOOL_DEFINITIONS.length, 6);

  const names = TOOL_DEFINITIONS.map((t) => t.name);
  assert.deepEqual(names.sort(), [
    'ask_meetings',
    'get_meeting',
    'get_meeting_transcript',
    'list_folders',
    'list_meetings',
    'search_meetings',
  ].sort());

  const askTool = TOOL_DEFINITIONS.find((t) => t.name === 'ask_meetings');
  assert.match(askTool.description, /model call/i);

  for (const def of TOOL_DEFINITIONS) {
    assert.ok(def.name);
    assert.ok(def.title);
    assert.ok(def.description);
    assert.ok(def.inputSchema);
    assert.equal(def.inputSchema.type, 'object');
  }
});

test('createMcpTools requires dependencies', () => {
  assert.throws(() => createMcpTools(), /requires runPythonScript/);
  assert.throws(
    () => createMcpTools({ runPythonScript: async () => {} }),
    /requires validateMeetingFilePath/
  );
});

test('list_meetings: clamps limit and maps newest-first list with structuredContent', async () => {
  const calls = [];
  const fakeMeetings = [
    {
      session_info: {
        summary_file: '/path/to/output/20260826_100000_summary.json',
        name: 'Product Sync',
        processed_at: '2026-08-26T10:00:00Z',
        duration_seconds: 1800,
        folders: ['folder-1'],
        participants: ['Alice', 'Bob'],
      },
    },
    {
      session_info: {
        summary_file: '/path/to/output/20260825_140000_summary.json',
        name: 'Design Review',
        processed_at: '2026-08-25T14:00:00Z',
        duration_seconds: 2400,
        folders: [],
        participants: ['Carol'],
      },
    },
  ];

  const tools = createMcpTools({
    runPythonScript: async (script, args, wantString) => {
      calls.push({ script, args, wantString });
      return JSON.stringify(fakeMeetings);
    },
    validateMeetingFilePath: async () => ({ error: 'Not implemented' }),
  });

  // Default limit
  const res = await tools.call('list_meetings', {});
  assert.equal(res.isError, undefined);
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0], {
    script: 'simple_recorder.py',
    args: ['list-meetings'],
    wantString: true,
  });

  assert.equal(Array.isArray(res.content), true);
  assert.match(res.content[0].text, /Product Sync/);
  assert.match(res.content[0].text, /Design Review/);

  assert.ok(res.structuredContent);
  assert.equal(res.structuredContent.meetings.length, 2);
  assert.deepEqual(res.structuredContent.meetings[0], {
    id: '20260826_100000_summary.json',
    title: 'Product Sync',
    date: '2026-08-26T10:00:00Z',
    duration_seconds: 1800,
    folders: ['folder-1'],
    attendees: ['Alice', 'Bob'],
  });

  // Clamped limit: limit = 1
  const resClamped = await tools.call('list_meetings', { limit: 1 });
  assert.equal(resClamped.structuredContent.meetings.length, 1);
  assert.equal(resClamped.structuredContent.meetings[0].id, '20260826_100000_summary.json');

  // Clamped limit: negative -> min (1)
  const resMin = await tools.call('list_meetings', { limit: -10 });
  assert.equal(resMin.structuredContent.meetings.length, 1);

  // Clamped limit: excessive (> 200) -> 200
  const resMax = await tools.call('list_meetings', { limit: 999 });
  assert.equal(resMax.structuredContent.meetings.length, 2);
});

test('get_meeting: validates meeting_id, parses JSON, and returns details without transcript', async () => {
  const { tmp, outputDir } = createTempNotesDir();
  try {
    const summaryFile = path.join(outputDir, '20260826_110000_summary.json');
    const meetingData = {
      session_info: {
        summary_file: summaryFile,
        name: 'Sprint Planning',
        processed_at: '2026-08-26T11:00:00Z',
        duration_seconds: 3600,
        folders: ['eng'],
      },
      participants: ['Dev A', 'Dev B'],
      summary: 'Discussed Q3 goals.',
      key_points: ['Point 1', 'Point 2'],
      action_items: ['Item 1'],
      user_notes: 'Important notes.',
      transcript: 'Full transcript text that should not be returned by get_meeting.',
    };
    fs.writeFileSync(summaryFile, JSON.stringify(meetingData), 'utf-8');

    const tools = createMcpTools({
      runPythonScript: async () => {
        throw new Error('should not be called');
      },
      validateMeetingFilePath: async (file) => {
        if (file.includes('..') || !file.startsWith(outputDir)) {
          return { error: 'Access denied' };
        }
        return { realPath: file };
      },
      getOutputDir: () => outputDir,
    });

    const res = await tools.call('get_meeting', { meeting_id: '20260826_110000_summary.json' });
    assert.equal(res.isError, undefined);
    assert.ok(res.content[0].text.includes('Sprint Planning'));
    assert.ok(res.content[0].text.includes('Discussed Q3 goals.'));
    assert.ok(!res.content[0].text.includes('Full transcript text'));

    assert.deepEqual(res.structuredContent, {
      id: '20260826_110000_summary.json',
      title: 'Sprint Planning',
      date: '2026-08-26T11:00:00Z',
      duration_seconds: 3600,
      folders: ['eng'],
      attendees: ['Dev A', 'Dev B'],
      summary: 'Discussed Q3 goals.',
      key_points: ['Point 1', 'Point 2'],
      action_items: ['Item 1'],
      user_notes: 'Important notes.',
    });
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('get_meeting: parses legacy .md files correctly', async () => {
  const { tmp, outputDir } = createTempNotesDir();
  try {
    const mdFile = path.join(outputDir, '20260826_120000_summary.md');
    const mdContent = `---
title: "Quarterly Review"
date: "2026-08-26"
duration_seconds: 1200
folders: ["finance"]
---

## Summary
Reviewed financials.

## Key Points
- Revenue up 10%
- Hiring on track

## Action Items
- [ ] Send report
- [x] Schedule follow-up

## User Notes
Personal note here.

## Transcript
Confidential transcript text.
`;
    fs.writeFileSync(mdFile, mdContent, 'utf-8');

    const tools = createMcpTools({
      runPythonScript: async () => {},
      validateMeetingFilePath: async (file) => ({ realPath: file }),
      getOutputDir: () => outputDir,
    });

    const res = await tools.call('get_meeting', { meeting_id: '20260826_120000_summary.md' });
    assert.equal(res.isError, undefined);
    assert.equal(res.structuredContent.title, 'Quarterly Review');
    assert.equal(res.structuredContent.summary, 'Reviewed financials.');
    assert.deepEqual(res.structuredContent.key_points, ['Revenue up 10%', 'Hiring on track']);
    assert.deepEqual(res.structuredContent.action_items, ['Send report', 'Schedule follow-up']);
    assert.equal(res.structuredContent.user_notes, 'Personal note here.');
    assert.deepEqual(res.structuredContent.folders, ['finance']);
    assert.equal(res.structuredContent.transcript, undefined);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('get_meeting_transcript: returns full transcript', async () => {
  const { tmp, outputDir } = createTempNotesDir();
  try {
    const summaryFile = path.join(outputDir, '20260826_130000_summary.json');
    const meetingData = {
      session_info: {
        summary_file: summaryFile,
        name: 'Interview Note',
        processed_at: '2026-08-26T13:00:00Z',
      },
      transcript: 'Alice: Hello everyone.\nBob: Hi Alice.',
    };
    fs.writeFileSync(summaryFile, JSON.stringify(meetingData), 'utf-8');

    const tools = createMcpTools({
      runPythonScript: async () => {},
      validateMeetingFilePath: async (file) => ({ realPath: file }),
      getOutputDir: () => outputDir,
    });

    const res = await tools.call('get_meeting_transcript', {
      meeting_id: '20260826_130000_summary.json',
    });
    assert.equal(res.isError, undefined);
    assert.equal(res.content[0].text, 'Alice: Hello everyone.\nBob: Hi Alice.');
    assert.deepEqual(res.structuredContent, {
      id: '20260826_130000_summary.json',
      title: 'Interview Note',
      transcript: 'Alice: Hello everyone.\nBob: Hi Alice.',
    });
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('Path traversal and validation failures return isError and never echo external paths', async () => {
  let pythonInvoked = false;
  const tools = createMcpTools({
    runPythonScript: async () => {
      pythonInvoked = true;
      return '[]';
    },
    validateMeetingFilePath: async (target) => {
      if (target.includes('..') || target.startsWith('/etc') || target.includes('outside')) {
        return { error: 'Access denied' };
      }
      return { realPath: target };
    },
    getOutputDir: () => '/home/user/stenoai/output',
  });

  // Path traversal with relative dots
  const resDots = await tools.call('get_meeting', { meeting_id: '../../etc/passwd_summary.json' });
  assert.equal(resDots.isError, true);
  assert.match(resDots.content[0].text, /meeting_id/i);
  assert.ok(!resDots.content[0].text.includes('/etc/passwd'));
  assert.equal(pythonInvoked, false);

  // Absolute path outside allowed directory
  const resAbs = await tools.call('get_meeting_transcript', { meeting_id: '/etc/shadow_summary.json' });
  assert.equal(resAbs.isError, true);
  assert.match(resAbs.content[0].text, /meeting_id/i);
  assert.ok(!resAbs.content[0].text.includes('/etc/shadow'));
  assert.equal(pythonInvoked, false);

  // Missing or invalid argument types
  const resMissing = await tools.call('get_meeting', {});
  assert.equal(resMissing.isError, true);
  assert.match(resMissing.content[0].text, /meeting_id/i);
});

test('search_meetings: performs multilingual substring matching (including zh-Hant) and names matched fields', async () => {
  const fakeMeetings = [
    {
      session_info: {
        summary_file: '/path/to/output/20260826_150000_summary.json',
        name: '臺北專案週會',
        processed_at: '2026-08-26T15:00:00Z',
        duration_seconds: 1200,
        folders: ['台灣隊'],
        participants: ['唐鳳', '柴柴'],
      },
      summary: '討論本週若水日報與數位韌性進度。',
      key_points: ['加速本地模型推論', '強化離線隱私'],
      action_items: ['撰寫繁體中文說明文件'],
      user_notes: '備註事項',
    },
    {
      session_info: {
        summary_file: '/path/to/output/20260826_160000_summary.json',
        name: 'Weekly Sync',
        processed_at: '2026-08-26T16:00:00Z',
        duration_seconds: 1800,
        folders: ['global'],
        participants: ['Alice'],
      },
      summary: 'Architecture discussion for cloud sync.',
      key_points: ['Security review'],
      action_items: ['Deploy release'],
      user_notes: null,
    },
  ];

  const tools = createMcpTools({
    runPythonScript: async () => JSON.stringify(fakeMeetings),
    validateMeetingFilePath: async () => ({ error: 'Not needed' }),
  });

  // zh-Hant search: '數位韌性'
  const resZh = await tools.call('search_meetings', { query: '數位韌性' });
  assert.equal(resZh.isError, undefined);
  assert.equal(resZh.structuredContent.results.length, 1);
  const zhMatch = resZh.structuredContent.results[0];
  assert.equal(zhMatch.id, '20260826_150000_summary.json');
  assert.equal(zhMatch.title, '臺北專案週會');
  assert.deepEqual(zhMatch.matched_fields, ['summary']);

  // zh-Hant search in attendee: '唐鳳'
  const resAttendee = await tools.call('search_meetings', { query: '唐鳳' });
  assert.equal(resAttendee.structuredContent.results.length, 1);
  assert.deepEqual(resAttendee.structuredContent.results[0].matched_fields, ['attendees']);

  // English case-insensitive search: 'architecture'
  const resEn = await tools.call('search_meetings', { query: 'ARCHITECTURE' });
  assert.equal(resEn.structuredContent.results.length, 1);
  assert.equal(resEn.structuredContent.results[0].title, 'Weekly Sync');
  assert.deepEqual(resEn.structuredContent.results[0].matched_fields, ['summary']);

  // Empty query validation
  const resEmpty = await tools.call('search_meetings', { query: '' });
  assert.equal(resEmpty.isError, true);
  assert.match(resEmpty.content[0].text, /query/i);
});

test('list_folders: returns folder list with text and structuredContent', async () => {
  const fakeFolders = [
    { id: 'f-1', name: 'Work', color: '#ff0000', icon: '📁' },
    { id: 'f-2', name: 'Personal', color: '#00ff00', icon: '🏠' },
  ];

  const tools = createMcpTools({
    runPythonScript: async (script, args) => {
      assert.equal(script, 'simple_recorder.py');
      assert.deepEqual(args, ['list-folders']);
      return JSON.stringify({ folders: fakeFolders });
    },
    validateMeetingFilePath: async () => ({ error: 'Not needed' }),
  });

  const res = await tools.call('list_folders', {});
  assert.equal(res.isError, undefined);
  assert.match(res.content[0].text, /Work/);
  assert.match(res.content[0].text, /Personal/);
  assert.deepEqual(res.structuredContent, { folders: fakeFolders });
});

test('ask_meetings: assembles multiple CHAT_CHUNK lines, honours --meeting and -f flags (success path)', async () => {
  const { EventEmitter } = require('events');
  const executedCalls = [];
  const chunk1 = Buffer.from('Here is ').toString('base64');
  const chunk2 = Buffer.from('the assembled ').toString('base64');
  const chunk3 = Buffer.from('answer across meetings.').toString('base64');

  const tools = createMcpTools({
    runPythonScript: async () => '',
    spawnBackend: (args) => {
      executedCalls.push({ args });
      const child = new EventEmitter();
      child.stdout = new EventEmitter();
      child.stderr = new EventEmitter();
      child.pid = 12345;
      setImmediate(() => {
        child.stdout.emit('data', Buffer.from(`CHAT_CHUNK:${chunk1}\n`));
        child.stdout.emit('data', Buffer.from(`CHAT_CHUNK:${chunk2}\nCHAT_CHUNK:${chunk3}\nCHAT_STREAM_COMPLETE\n`));
        child.emit('close', 0);
      });
      return child;
    },
    validateMeetingFilePath: async (target) => {
      if (target.includes('invalid')) {
        return { error: 'Access denied' };
      }
      return { realPath: `/canonical/path/${path.basename(target)}` };
    },
    getOutputDir: () => '/canonical/path',
  });

  // Call with multiple meeting_ids and folder_id (meeting_ids takes precedence for --meeting)
  const res = await tools.call('ask_meetings', {
    question: 'What decisions were made?',
    meeting_ids: ['note1_summary.json', 'note2_summary.json'],
    folder_id: 'folder-abc',
  });

  assert.equal(res.isError, undefined);
  assert.equal(executedCalls.length, 1);
  assert.deepEqual(executedCalls[0].args, [
    'chat-global-streaming',
    '-q',
    'What decisions were made?',
    '--meeting',
    '/canonical/path/note1_summary.json',
    '--meeting',
    '/canonical/path/note2_summary.json',
  ]);

  assert.equal(res.content[0].text, 'Here is the assembled answer across meetings.');
  assert.deepEqual(res.structuredContent, {
    question: 'What decisions were made?',
    answer: 'Here is the assembled answer across meetings.',
  });

  // Call with folder_id only
  executedCalls.length = 0;
  const resFolder = await tools.call('ask_meetings', {
    question: 'Summarize folder',
    folder_id: 'finance-folder',
  });
  assert.equal(resFolder.isError, undefined);
  assert.deepEqual(executedCalls[0].args, [
    'chat-global-streaming',
    '-q',
    'Summarize folder',
    '-f',
    'finance-folder',
  ]);
});

test('ask_meetings: drains large stderr while streaming stdout and completes successfully', async () => {
  const { EventEmitter } = require('events');
  const chunk = Buffer.from('Completed answer despite chatty stderr.').toString('base64');

  const tools = createMcpTools({
    runPythonScript: async () => '',
    spawnBackend: () => {
      const child = new EventEmitter();
      child.stdout = new EventEmitter();
      child.stderr = new EventEmitter();
      let resumed = false;
      child.stderr.resume = () => {
        resumed = true;
      };
      child.pid = 23456;
      setImmediate(() => {
        // Emit large stderr (simulating chatty backend logging >64KB)
        const largeLog = Buffer.alloc(128 * 1024, 'X');
        child.stderr.emit('data', largeLog);
        child.stdout.emit('data', Buffer.from(`CHAT_CHUNK:${chunk}\nCHAT_STREAM_COMPLETE\n`));
        child.emit('close', 0);
      });
      return child;
    },
    validateMeetingFilePath: async (p) => ({ realPath: p }),
  });

  const res = await tools.call('ask_meetings', {
    question: 'Testing stderr drain',
  });

  assert.equal(res.isError, undefined);
  assert.equal(res.content[0].text, 'Completed answer despite chatty stderr.');
  assert.deepEqual(res.structuredContent, {
    question: 'Testing stderr drain',
    answer: 'Completed answer despite chatty stderr.',
  });
});

test('ask_meetings: fails loudly with isError when spawnBackend is missing (no silent fallback)', async () => {
  const tools = createMcpTools({
    runPythonScript: async () => 'Should not be called',
    validateMeetingFilePath: async (p) => ({ realPath: p }),
  });

  const res = await tools.call('ask_meetings', {
    question: 'Missing spawnBackend dependency',
  });

  assert.equal(res.isError, true);
  assert.equal(res.content[0].text, 'Cross-note chat failed');
  assert.deepEqual(res.structuredContent, {
    error: 'Cross-note chat failed',
  });
});

test('ask_meetings: rejects unvalidated meeting_ids before backend invocation', async () => {
  let backendInvoked = false;
  const tools = createMcpTools({
    runPythonScript: async () => '',
    spawnBackend: () => {
      backendInvoked = true;
    },
    validateMeetingFilePath: async (p) => {
      if (p.includes('bad_note')) return { error: 'Access denied' };
      return { realPath: p };
    },
  });

  const res = await tools.call('ask_meetings', {
    question: 'Test question',
    meeting_ids: ['good_note_summary.json', 'bad_note_summary.json'],
  });

  assert.equal(res.isError, true);
  assert.match(res.content[0].text, /meeting_ids/i);
  assert.equal(backendInvoked, false);
});

test('ask_meetings: turns CHAT_STREAM_ERROR into isError response', async () => {
  const { EventEmitter } = require('events');
  const tools = createMcpTools({
    runPythonScript: async () => '',
    spawnBackend: () => {
      const child = new EventEmitter();
      child.stdout = new EventEmitter();
      child.stderr = new EventEmitter();
      child.pid = 12346;
      setImmediate(() => {
        child.stdout.emit('data', Buffer.from('CHAT_STREAM_ERROR:Local Ollama model failed to load\n'));
        child.emit('close', 0);
      });
      return child;
    },
    validateMeetingFilePath: async (p) => ({ realPath: p }),
  });

  const res = await tools.call('ask_meetings', {
    question: 'Why did the project slip?',
  });

  assert.equal(res.isError, true);
  assert.match(res.content[0].text, /Local Ollama model failed to load/);
  assert.deepEqual(res.structuredContent, {
    error: 'Local Ollama model failed to load',
  });
});

test('ask_meetings: kills process tree on timeout, handles late close, and returns isError', async () => {
  const { EventEmitter } = require('events');
  let killedPid = null;
  let lateChild = null;

  const tools = createMcpTools({
    runPythonScript: async () => '',
    spawnBackend: () => {
      const child = new EventEmitter();
      child.stdout = new EventEmitter();
      child.stderr = new EventEmitter();
      child.pid = 998877;
      lateChild = child;
      // Never emit close before timeout
      return child;
    },
    killBackendTree: (pid) => {
      killedPid = pid;
    },
    validateMeetingFilePath: async (p) => ({ realPath: p }),
    timeoutMs: 50,
  });

  const res = await tools.call('ask_meetings', {
    question: 'Should time out',
  });

  assert.equal(res.isError, true);
  assert.equal(killedPid, 998877);
  assert.match(res.content[0].text, /timed out/i);
  assert.deepEqual(res.structuredContent, {
    error: 'Cross-note chat timed out',
  });

  // (c) late close after timeout does not double-resolve or throw
  assert.doesNotThrow(() => {
    lateChild.emit('close', 0);
  });
});

test('ask_meetings: non-zero exit returns isError with no stderr in result', async () => {
  const { EventEmitter } = require('events');
  const tools = createMcpTools({
    runPythonScript: async () => '',
    spawnBackend: () => {
      const child = new EventEmitter();
      child.stdout = new EventEmitter();
      child.stderr = new EventEmitter();
      child.pid = 554433;
      setImmediate(() => {
        if (child.stderr) child.stderr.emit('data', Buffer.from('Traceback (most recent call last): SecretInternalDetails'));
        child.emit('close', 1);
      });
      return child;
    },
    validateMeetingFilePath: async (p) => ({ realPath: p }),
  });

  const res = await tools.call('ask_meetings', {
    question: 'Failing call',
  });

  assert.equal(res.isError, true);
  assert.equal(res.content[0].text, 'Cross-note chat failed');
  assert.deepEqual(res.structuredContent, {
    error: 'Cross-note chat failed',
  });
  assert.equal(res.content[0].text.includes('SecretInternalDetails'), false);
});
test('call: returns error for unknown tool name', async () => {
  const tools = createMcpTools({
    runPythonScript: async () => {},
    validateMeetingFilePath: async () => ({ realPath: '' }),
  });

  const res = await tools.call('non_existent_tool', {});
  assert.equal(res.isError, true);
  assert.match(res.content[0].text, /Unknown tool/);
  assert.deepEqual(res.structuredContent, {
    error: 'Unknown tool: non_existent_tool',
  });
});
