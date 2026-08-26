import { test, expect } from '../fixtures/electron';
import { realUserDataDir, fileSig } from '../fixtures/real-user-data';
import { writeUserConfig, writeMeetingSummary } from '../fixtures/user-config';
import { startMockOllama } from '../fixtures/mock-ollama';
import { readFileSync } from 'fs';

/**
 * T2 — summarisation FAILURE contract (regression for the swallowed-stream bug /
 * GH #301). Drives the real `reprocess` path (re-summarise an existing
 * transcript — NO ASR, NO real model) with a mock Ollama that returns a 404
 * "model not found" on /api/chat, and asserts the failure is surfaced honestly:
 *
 *   1. reprocess reports failure (success:false), NOT a false success.
 *   2. the pre-existing summary on disk is byte-for-byte UNCHANGED — the failed
 *      stream must not clobber it with an empty summary.
 *
 * Before the fix the streaming generators swallowed the provider error and ended
 * the stream silently, so the consumer saw an empty-but-"successful" stream, wrote
 * an empty summary, printed STREAM_COMPLETE and exited 0. Model-free: the mock
 * never loads a model, so this runs in the model-free t2 lane (no @pipeline tag).
 */

const TRANSCRIPT =
  'Alice: we ship the release on Friday. Bob: the budget is fifty thousand dollars.';

const SEEDED_SUMMARY = 'PRE-EXISTING summary that a failed reprocess must NOT clobber';

type ReprocessResult = { success: boolean; error?: string };
type StenoWindow = Window & {
  stenoai: {
    meetings: {
      reprocess: (summaryFile: string, regenTitle: boolean, name: string) => Promise<ReprocessResult>;
    };
  };
};

const readSummary = (file: string) => JSON.parse(readFileSync(file, 'utf8'));

test('reprocess surfaces a stream failure and leaves the existing summary untouched', async ({
  launchApp,
  userDataDir,
}) => {
  const realDirBefore = fileSig(realUserDataDir());

  // Local provider so the summarizer talks to the mock Ollama on 11434.
  writeUserConfig(userDataDir, { ai_provider: 'local' });
  const summaryFile = writeMeetingSummary(userDataDir, 'failure', {
    name: 'Failure Meeting',
    summary: SEEDED_SUMMARY,
    key_points: ['seeded point'],
    action_items: ['seeded action'],
    transcript: TRANSCRIPT,
  });
  const summarySigBefore = fileSig(summaryFile);

  // Mock Ollama answers /api/chat with the real Ollama 404 shape so the stream
  // fails mid-flight instead of returning content.
  const ollama = await startMockOllama({
    chatError: { status: 404, message: "model 'gemma4:e2b-it-qat' not found" },
  });
  try {
    const { page } = await launchApp({
      env: { OLLAMA_HOST: `http://127.0.0.1:${ollama.port}` },
    });
    const res = await page.evaluate(
      (f) => (window as StenoWindow).stenoai.meetings.reprocess(f, false, 'Failure Meeting'),
      summaryFile,
    );

    // (1) The operation must report failure, not a false success.
    expect(res.success).toBe(false);

    // The summariser must have actually attempted the call (proves we exercised
    // the streaming path, not an earlier bail-out).
    expect(ollama.chatCalls()).toBeGreaterThanOrEqual(1);

    // (2) The pre-existing summary on disk is byte-for-byte unchanged — a failed
    // stream must not overwrite it with an empty summary.
    expect(fileSig(summaryFile)).toBe(summarySigBefore);
    const after = readSummary(summaryFile);
    expect(after.summary).toBe(SEEDED_SUMMARY);
    expect(after.key_points).toEqual(['seeded point']);
    expect(after.action_items).toEqual(['seeded action']);

    // Keystone: the real user-data dir is byte-for-byte untouched.
    expect(fileSig(realUserDataDir())).toBe(realDirBefore);
  } finally {
    await ollama.close();
  }
});
