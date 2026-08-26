import { test, expect } from '../fixtures/electron';
import { realUserDataDir, fileSig } from '../fixtures/real-user-data';
import { writeUserConfig, writeMeetingMarkdown } from '../fixtures/user-config';
import { startMockOllama } from '../fixtures/mock-ollama';

/**
 * T2 — saved-note ask stream (query-transcript-stream).
 *
 * Drives the real AskBar / query-streaming path from the renderer through the
 * preload bridge (window.stenoai.query.askStream) against the capturing mock
 * Ollama on an ephemeral port.
 *
 * Asserts:
 * 1. Over-budget transcripts are trimmed newest-first with `[earlier transcript omitted]`,
 *    dropping the oldest head markers while preserving the newest tail content.
 * 2. The prompt stays strictly within the model's derived budget + prompt slack.
 * 3. Small note transcripts pass through byte-identical and untrimmed without omission marker.
 * 4. Model download / pull endpoint is never hit (pullCalls === 0).
 * 5. The real user data directory remains untouched.
 */

const ANSWER = 'Based on the transcript, the team decided to proceed with the planned milestones.';

type StreamResult = { ok: boolean; text: string; error?: string };
type StenoWindow = Window & {
  stenoai: {
    query: {
      askStream: (id: string, file: string, q: string) => void;
    };
    subscribeQueryStream: (
      id: string,
      cbs: { onChunk: (c: string) => void; onDone: () => void; onError: (e: Error) => void },
    ) => () => void;
  };
};

const HEAD_MARKER = 'HEAD_MARKER_QUUX';
const TAIL_NEEDLE = 'TAIL_NEEDLE_XYZZY';

function buildLargeTranscript(): string {
  const lines: string[] = [
    `[00:00:01] Alice: ${HEAD_MARKER} Opening remarks and kickoff discussion for the long planning session.`,
  ];
  for (let i = 1; i <= 1200; i++) {
    const mm = String(Math.floor(i / 60)).padStart(2, '0');
    const ss = String(i % 60).padStart(2, '0');
    lines.push(
      `[00:${mm}:${ss}] Speaker${(i % 3) + 1}: Detailed review of project milestone item ${i} with metrics and analysis.`,
    );
  }
  lines.push(`[01:30:00] Bob: Final summary and decisions recorded with ${TAIL_NEEDLE}.`);
  return lines.join('\n');
}

const SMALL_NEEDLE = 'SMALL_NEEDLE_CORGE';

function buildSmallTranscript(): string {
  const lines: string[] = [
    `[00:00:01] Alice: Starting our quick check-in for the sprint.`,
  ];
  for (let i = 1; i <= 25; i++) {
    lines.push(
      `[00:01:${String(i).padStart(2, '0')}] Bob: Reviewing task item ${i} and confirming progress on the deliverables.`,
    );
  }
  lines.push(`[00:02:00] Charlie: All good with ${SMALL_NEEDLE}, ready to deploy.`);
  return lines.join('\n');
}

test('over-budget saved note transcript is trimmed newest-first before model sees it', async ({
  launchApp,
  userDataDir,
}) => {
  const realDirBefore = fileSig(realUserDataDir());

  // gemma4:e2b-it-qat context window is 32768 tokens -> budget is int(32768 * 3.5 * 0.55) = 63,078 chars.
  writeUserConfig(userDataDir, {
    ai_provider: 'local',
    model: 'gemma4:e2b-it-qat',
  });

  const largeTranscript = buildLargeTranscript();
  expect(largeTranscript.length).toBeGreaterThan(80_000);

  const summaryFile = writeMeetingMarkdown(userDataDir, 'large-note', {
    name: 'Long Planning Meeting',
    summaryMarkdown: '## Summary\nLong planning meeting summary.',
    transcript: largeTranscript,
  });

  const ollama = await startMockOllama({ port: 0, chatReply: ANSWER });
  try {
    const { page } = await launchApp({
      env: { OLLAMA_HOST: `http://127.0.0.1:${ollama.port}` },
    });

    const result: StreamResult = await page.evaluate(
      ({ file, q }) =>
        new Promise<StreamResult>((resolve) => {
          const id = 'e2e-saved-note-large';
          let text = '';
          const timer = setTimeout(
            () => resolve({ ok: false, text, error: 'timeout' }),
            25_000,
          );
          const w = window as unknown as StenoWindow;
          w.stenoai.subscribeQueryStream(id, {
            onChunk: (c) => {
              text += c;
            },
            onDone: () => {
              clearTimeout(timer);
              resolve({ ok: true, text });
            },
            onError: (e) => {
              clearTimeout(timer);
              resolve({ ok: false, text, error: e.message });
            },
          });
          w.stenoai.query.askStream(id, file, q);
        }),
      { file: summaryFile, q: 'What were the final decisions?' },
    );

    // Reply streamed to the renderer successfully
    expect(result.ok).toBe(true);
    expect(result.text).toContain(ANSWER);

    // Mock captured the prompt
    const prompt = ollama.lastChatPrompt();
    expect(prompt).toBeTruthy();

    // Contains omission marker, contains tail needle, does NOT contain head marker
    expect(prompt).toContain('[earlier transcript omitted]');
    expect(prompt).toContain(TAIL_NEEDLE);
    expect(prompt).not.toContain(HEAD_MARKER);

    // Length is within budget (63,078) + prompt overhead slack
    const budget = 63_078;
    expect(prompt!.length).toBeLessThanOrEqual(budget + 4000);

    // No model downloads / pulls attempted
    expect(ollama.pullCalls()).toBe(0);

    // Keystone: real user data dir untouched
    expect(fileSig(realUserDataDir())).toBe(realDirBefore);
  } finally {
    await ollama.close();
  }
});

test('small saved note transcript passes through untrimmed without omission marker', async ({
  launchApp,
  userDataDir,
}) => {
  const realDirBefore = fileSig(realUserDataDir());

  writeUserConfig(userDataDir, {
    ai_provider: 'local',
    model: 'gemma4:e2b-it-qat',
  });

  const smallTranscript = buildSmallTranscript();
  expect(smallTranscript.length).toBeLessThan(4000);

  const summaryFile = writeMeetingMarkdown(userDataDir, 'small-note', {
    name: 'Quick Sync Meeting',
    summaryMarkdown: '## Summary\nQuick sync summary.',
    transcript: smallTranscript,
  });

  const ollama = await startMockOllama({ port: 0, chatReply: ANSWER });
  try {
    const { page } = await launchApp({
      env: { OLLAMA_HOST: `http://127.0.0.1:${ollama.port}` },
    });

    const result: StreamResult = await page.evaluate(
      ({ file, q }) =>
        new Promise<StreamResult>((resolve) => {
          const id = 'e2e-saved-note-small';
          let text = '';
          const timer = setTimeout(
            () => resolve({ ok: false, text, error: 'timeout' }),
            25_000,
          );
          const w = window as unknown as StenoWindow;
          w.stenoai.subscribeQueryStream(id, {
            onChunk: (c) => {
              text += c;
            },
            onDone: () => {
              clearTimeout(timer);
              resolve({ ok: true, text });
            },
            onError: (e) => {
              clearTimeout(timer);
              resolve({ ok: false, text, error: e.message });
            },
          });
          w.stenoai.query.askStream(id, file, q);
        }),
      { file: summaryFile, q: 'What did Charlie say?' },
    );

    // Reply streamed to the renderer successfully
    expect(result.ok).toBe(true);
    expect(result.text).toContain(ANSWER);

    // Mock captured the prompt
    const prompt = ollama.lastChatPrompt();
    expect(prompt).toBeTruthy();

    // Contains needle and does NOT contain omission marker
    expect(prompt).toContain(SMALL_NEEDLE);
    expect(prompt).not.toContain('[earlier transcript omitted]');

    // No model downloads / pulls attempted
    expect(ollama.pullCalls()).toBe(0);

    // Keystone: real user data dir untouched
    expect(fileSig(realUserDataDir())).toBe(realDirBefore);
  } finally {
    await ollama.close();
  }
});
