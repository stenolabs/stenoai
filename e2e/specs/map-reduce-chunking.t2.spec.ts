import { test, expect } from '../fixtures/electron';
import { writeUserConfig, writeMeetingSummary } from '../fixtures/user-config';
import { startMockOllama } from '../fixtures/mock-ollama';
import { readFileSync } from 'fs';

/**
 * T2 @map-reduce — end-to-end exercise of the map-reduce summarisation path.
 *
 * Drives `reprocess` through the real bundled backend + mock Ollama and asserts:
 *   1. A transcript > 13 107 chars (llama3.2:3b threshold) triggers N map calls
 *      + 1 reduce call (N+1 total), emitting PROGRESS:summarize: lines in order.
 *   2. A short transcript still takes the direct 1-call path (regression guard).
 *
 * Model-free: transcripts are pre-seeded and the LLM is the mock. No ASR, no
 * real model. Tagged @map-reduce; runs in the model-free t2 jobs.
 */

// Chunk math (llama3.2:3b, num_ctx=8192):
//   needs_chunking threshold: estimated_tokens > num_ctx * 0.8
//   chunk budget chars = (num_ctx - 300 - 600) * 2 = 14584 (content + overlap)
//   overlap = floor(14584 * 0.05) = 729; content_budget = 13855
// The 500-line transcript below is 44 390 chars → ceil(44390 / 13855) = 4 map
// chunks, so 4 map calls + 1 reduce = 5 chat calls.
const LONG_TRANSCRIPT = Array.from({ length: 500 }, (_, i) =>
  `Speaker A: This is utterance ${i} of a long planning meeting about the quarterly roadmap.\n`,
).join('');

type ReprocessResult = { success: boolean; error?: string };
type StenoWindow = Window & {
  stenoai: {
    meetings: {
      reprocess: (summaryFile: string, regenTitle: boolean, name: string) => Promise<ReprocessResult>;
    };
    on: {
      summaryComplete: (cb: (e: { success: boolean }) => void) => () => void;
      processingProgress: (cb: (e: { line: string }) => void) => () => void;
    };
  };
};

test.describe('Map-reduce summarization @map-reduce', () => {
  test('long transcript triggers N+1 chat calls (4 map + 1 reduce)', async ({
    launchApp,
    userDataDir,
  }) => {
    // Pin llama3.2:3b so the chunking threshold is predictable.
    writeUserConfig(userDataDir, { ai_provider: 'local', model: 'llama3.2:3b' });
    const summaryFile = writeMeetingSummary(userDataDir, 'long-meeting', {
      name: 'Long Planning Meeting',
      summary: 'stale',
      transcript: LONG_TRANSCRIPT,
    });

    // Map calls get compact extraction replies; reduce call gets the full summary.
    // One queued reply per map chunk (4), then the reduce call falls through to
    // chatReply once the queue is exhausted.
    const ollama = await startMockOllama({
      chatReplyQueue: [
        'KEY POINTS\n- Planning session discussed roadmap.\n\nACTION ITEMS\n- Team to review Q3 budget.',
        'KEY POINTS\n- Team confirmed delivery timeline.\n\nACTION ITEMS\n- Alice to update tracker.',
        'KEY POINTS\n- Risks reviewed for the rollout.\n\nACTION ITEMS\n- Bob to file mitigation plan.',
        'KEY POINTS\n- Next steps and owners assigned.\n\nACTION ITEMS\n- Carol to schedule follow-up.',
      ],
      chatReply:
        '## Summary\nThis was a long planning meeting about the quarterly roadmap.\n\n## Key Points\n- Roadmap agreed\n\n## Action Items\n- Update tracker',
    });
    try {
      const { page } = await launchApp({
        env: { OLLAMA_HOST: `http://127.0.0.1:${ollama.port}` },
      });
      // Capture PROGRESS: events via the IPC bridge.
      const progressLines: string[] = [];
      await page.exposeFunction('captureProgress', (line: string) => {
        progressLines.push(line);
      });
      await page.evaluate(() => {
        const w = window as unknown as StenoWindow;
        w.stenoai.on.processingProgress((e: { line: string }) => {
          (window as any).captureProgress(e.line);
        });
      });

      // Trigger reprocess and wait for completion.
      const completed: boolean = await page.evaluate(
        (f) =>
          new Promise<boolean>((resolve) => {
            const timer = setTimeout(() => resolve(false), 60_000);
            const w = window as unknown as StenoWindow;
            const off = w.stenoai.on.summaryComplete((e) => {
              if (e && e.success) {
                clearTimeout(timer);
                off();
                resolve(true);
              }
            });
            w.stenoai.meetings.reprocess(f, false, 'Long Planning Meeting');
          }),
        summaryFile,
      );

      expect(completed).toBe(true);

      // 4 map calls + 1 reduce call = 5 total.
      expect(ollama.chatCalls()).toBe(5);

      // PROGRESS: lines must arrive in order.
      const summarizeLines = progressLines.filter((l) => l.startsWith('PROGRESS:summarize:'));
      expect(summarizeLines).toEqual([
        'PROGRESS:summarize:1/4',
        'PROGRESS:summarize:2/4',
        'PROGRESS:summarize:3/4',
        'PROGRESS:summarize:4/4',
        'PROGRESS:summarize:reducing',
      ]);

      // Final summary must be saved to disk with the expected shape. `summary`
      // holds the parsed ## Summary body (the header is stripped by the backend's
      // _parse_streamed_markdown; the other sections land in their own fields),
      // so assert on the reduce reply's overview text rather than the header.
      const saved = JSON.parse(readFileSync(summaryFile, 'utf8'));
      expect(saved.summary).toContain('long planning meeting about the quarterly roadmap');
    } finally {
      await ollama.close();
    }
  });

  test('short transcript uses direct path (1 chat call)', async ({
    launchApp,
    userDataDir,
  }) => {
    writeUserConfig(userDataDir, { ai_provider: 'local', model: 'llama3.2:3b' });
    const summaryFile = writeMeetingSummary(userDataDir, 'short-meeting', {
      name: 'Short Meeting',
      summary: 'stale',
      transcript: 'Speaker A: Hello, let us begin.\nSpeaker B: Agreed, let us proceed.\n',
    });

    const ollama = await startMockOllama({
      chatReply:
        '## Summary\nBrief meeting.\n\n## Key Points\n- Started well\n\n## Action Items\n- None',
    });
    try {
      const { page } = await launchApp({
        env: { OLLAMA_HOST: `http://127.0.0.1:${ollama.port}` },
      });
      const completed: boolean = await page.evaluate(
        (f) =>
          new Promise<boolean>((resolve) => {
            const timer = setTimeout(() => resolve(false), 60_000);
            const w = window as unknown as StenoWindow;
            const off = w.stenoai.on.summaryComplete((e) => {
              if (e && e.success) {
                clearTimeout(timer);
                off();
                resolve(true);
              }
            });
            w.stenoai.meetings.reprocess(f, false, 'Short Meeting');
          }),
        summaryFile,
      );

      expect(completed).toBe(true);

      // Short transcript takes the direct path: exactly 1 chat call.
      expect(ollama.chatCalls()).toBe(1);
    } finally {
      await ollama.close();
    }
  });
});
