import { test, expect } from '../fixtures/electron';
import { realUserDataDir, fileSig } from '../fixtures/real-user-data';
import { enableDeterministicRecording, writeMeetingMarkdown } from '../fixtures/user-config';
import { readFileSync, writeFileSync, existsSync, realpathSync } from 'fs';
import path from 'path';

/**
 * T2 — Live meeting chat & carry-over migration. Model-free and hermetic
 * (no ASR, no LLM, no network): drives the preload bridge and asserts
 * backend state on disk and fixed error responses over IPC.
 */

type ChatSession = {
  id: string;
  summaryFile: string;
  messages: Array<{ role: string; content: string }>;
  title?: string;
};

type ChatSessionsV2 = {
  version?: number;
  sessions: ChatSession[];
};

type QueryDonePayload = {
  queryId: string;
  success: boolean;
  error?: string;
};

type MigratedEvent = {
  fromKey: string;
  toKey: string;
};
type StenoWindow = Window & {
  stenoai: {
    recording: {
      start: (
        name?: string,
        trigger?: string,
        appendTo?: string,
      ) => Promise<{ success: boolean; error?: string }>;
      stop: () => Promise<{ success: boolean; error?: string }>;
      getSystemAudioSupport: () => Promise<{ success: boolean; supported?: boolean }>;
    };
    query: {
      askLiveStream: (
        queryId: string,
        sessionName: string,
        question: string,
        history?: unknown,
      ) => void;
    };
    on: {
      queryDone: (cb: (payload: QueryDonePayload) => void) => () => void;
      chatSessionsMigrated: (cb: (payload: MigratedEvent) => void) => () => void;
    };
  };
};

test('chat session carry-over: live session is migrated to real summary file on stop and event fires', async ({
  launchApp,
  userDataDir,
}) => {
  const sessionName = 'Sprint Planning Carryover';
  const liveKey = `live:${sessionName}`;

  const realDirBefore = fileSig(realUserDataDir());
  enableDeterministicRecording(userDataDir);

  const targetSummaryFile = writeMeetingMarkdown(userDataDir, 'carryover_target', {
    name: sessionName,
    summaryMarkdown: 'Existing note for the continued recording.',
    transcript: 'Earlier transcript text.',
  });

  // Seed chat_sessions_v2.json with a live session and a preserved session already on the note.
  const seededV2: ChatSessionsV2 = {
    version: 2,
    sessions: [
      {
        id: 'live-session-1',
        summaryFile: liveKey,
        title: 'Live Q&A during planning',
        messages: [
          { role: 'user', content: 'What was decided about sprint goals?' },
          { role: 'assistant', content: 'Focus on parity features first.' },
        ],
      },
      {
        id: 'existing-note-session-2',
        summaryFile: targetSummaryFile,
        title: 'Existing note chat',
        messages: [
          { role: 'user', content: 'Who attended?' },
          { role: 'assistant', content: 'Alice and Bob.' },
        ],
      },
    ],
  };

  const v2Path = path.join(userDataDir, 'chat_sessions_v2.json');
  writeFileSync(v2Path, JSON.stringify(seededV2, null, 2), 'utf8');

  const { page } = await launchApp();

  const support = await page.evaluate(() =>
    (window as StenoWindow).stenoai.recording.getSystemAudioSupport(),
  );
  if (!support?.supported) {
    // eslint-disable-next-line no-console
    console.warn(
      '[t2] SKIPPED chat session carry-over: system-audio path unsupported on this host.',
    );
    test.info().annotations.push({
      type: 'skip-reason',
      description: 'isSystemAudioSupported() false; deterministic record path unavailable',
    });
  }
  test.skip(!support?.supported, 'system-audio path unsupported on this runner');

  // Register listener for chat-sessions-migrated before starting recording.
  await page.evaluate(() => {
    (window as unknown as { __migratedEvents: MigratedEvent[] }).__migratedEvents = [];
    (window as StenoWindow).stenoai.on.chatSessionsMigrated((event) => {
      (window as unknown as { __migratedEvents: MigratedEvent[] }).__migratedEvents.push(event);
    });
  });
  // Start a continued recording against the existing note; stop uses the same renderer-facing
  // path as the app and migrates live:<sessionName> to the append target.
  const started = await page.evaluate(
    ({ name, appendTo }) => (window as StenoWindow).stenoai.recording.start(name, undefined, appendTo),
    { name: sessionName, appendTo: targetSummaryFile },
  );
  expect(started.success).toBe(true);

  // Stop recording to trigger carry-over migration
  const stopped = await page.evaluate(() =>
    (window as StenoWindow).stenoai.recording.stop(),
  );
  expect(stopped.success).toBe(true);

  // Poll on-disk chat_sessions_v2.json until the live: session is migrated
  await expect
    .poll(
      () => {
        if (!existsSync(v2Path)) return false;
        try {
          const data = JSON.parse(readFileSync(v2Path, 'utf8')) as ChatSessionsV2;
          return data.sessions.some(
            (s) => s.id === 'live-session-1' && !s.summaryFile.startsWith('live:'),
          );
        } catch {
          return false;
        }
      },
      { timeout: 10_000 },
    )
    .toBe(true);

  const updatedV2 = JSON.parse(readFileSync(v2Path, 'utf8')) as ChatSessionsV2;
  const migratedSession = updatedV2.sessions.find((s) => s.id === 'live-session-1');
  const preserved = updatedV2.sessions.find((s) => s.id === 'existing-note-session-2');
  expect(migratedSession).toBeDefined();
  // What matters is that the carried-over conversation lands under the SAME key
  // the renderer already uses for this note - a canonicalised variant of the
  // path would leave the chat invisible in the UI.
  expect(migratedSession!.summaryFile).toBe(preserved!.summaryFile);
  expect(realpathSync(migratedSession!.summaryFile)).toBe(realpathSync(targetSummaryFile));
  expect(migratedSession!.messages).toHaveLength(2);
  expect(JSON.stringify(updatedV2)).not.toContain(liveKey);
  expect(updatedV2.sessions.some((s) => s.summaryFile.startsWith('live:'))).toBe(false);

  // Pre-existing session for the same note is preserved untouched.
  const preservedSession = updatedV2.sessions.find((s) => s.id === 'existing-note-session-2');
  expect(preservedSession).toBeDefined();
  expect(preservedSession!.summaryFile).toBe(targetSummaryFile);
  expect(preservedSession!.messages).toEqual([
    { role: 'user', content: 'Who attended?' },
    { role: 'assistant', content: 'Alice and Bob.' },
  ]);

  // Assert chat-sessions-migrated event fired exactly once with expected mapping
  const events = await page.evaluate(() => {
    return (window as unknown as { __migratedEvents: MigratedEvent[] }).__migratedEvents;
  });
  expect(events.length).toBe(1);
  expect(events[0].fromKey).toBe(liveKey);
  expect(events[0].toKey).toBe(migratedSession!.summaryFile);

  // Keystone: real user-data dir untouched
  expect(fileSig(realUserDataDir())).toBe(realDirBefore);
});

test('fixed errors: query with no active recording returns NO_ACTIVE_TRANSCRIPT', async ({
  launchApp,
}) => {
  const realDirBefore = fileSig(realUserDataDir());
  const { page } = await launchApp();

  const result = await page.evaluate(
    ({ queryId, sessionName, question }) => {
      return new Promise<QueryDonePayload>((resolve) => {
        const win = window as StenoWindow;
        const off = win.stenoai.on.queryDone((payload) => {
          if (payload.queryId === queryId) {
            off();
            resolve(payload);
          }
        });
        win.stenoai.query.askLiveStream(queryId, sessionName, question);
      });
    },
    {
      queryId: 'test-no-active-rec',
      sessionName: 'Idle Session',
      question: 'What is our launch date?',
    },
  );
  expect(result.success).toBe(false);
  expect(result.error).toBe('No active live transcript for this session');
  expect(result.error).not.toContain('launch date');
  expect(result.error).not.toContain('Idle Session');

  // Keystone: real user-data dir untouched
  expect(fileSig(realUserDataDir())).toBe(realDirBefore);
});

test('fixed errors: malformed history payload returns INVALID_HISTORY', async ({
  launchApp,
}) => {
  const realDirBefore = fileSig(realUserDataDir());
  const { page } = await launchApp();

  const result = await page.evaluate(
    ({ queryId, sessionName, question, malformedHistory }) => {
      return new Promise<QueryDonePayload>((resolve) => {
        const win = window as StenoWindow;
        const off = win.stenoai.on.queryDone((payload) => {
          if (payload.queryId === queryId) {
            off();
            resolve(payload);
          }
        });
        win.stenoai.query.askLiveStream(
          queryId,
          sessionName,
          question,
          malformedHistory,
        );
      });
    },
    {
      queryId: 'test-invalid-history',
      sessionName: 'Any Session',
      question: 'What are the risks?',
      malformedHistory: { invalid: 'not-an-array' },
    },
  );

  expect(result.success).toBe(false);
  expect(result.error).toBe('Invalid chat history');

  // Keystone: real user-data dir untouched
  expect(fileSig(realUserDataDir())).toBe(realDirBefore);
});
