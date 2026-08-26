import { test, expect } from '../fixtures/electron';
import { startMockOllama } from '../fixtures/mock-ollama';
import { makeWav } from '../fixtures/make-wav';
import { realUserDataDir, fileSig } from '../fixtures/real-user-data';
import { selectEngine, isEngineModelReady, E2E_ENGINE } from '../fixtures/engine';
import { killOllama } from '../fixtures/kill-ollama';
import { mkdirSync, existsSync } from 'fs';
import path from 'path';

/**
 * T2 — real-backend transcription pipeline smoke (@pipeline). Drives a synthetic
 * WAV through the app's streaming pipeline (process-streaming) and asserts it
 * runs end to end: HEARTBEAT markers observed on the debug-log channel, a
 * summary written into the temp dir, and the real user-data dir untouched.
 *
 * Plumbing + HEARTBEAT only — never asserts transcript text (a sine WAV is
 * non-speech, so the engine returns an empty transcript; the pipeline still
 * completes and writes the summary). Engine + model handling lives in
 * fixtures/engine.ts (parakeet local / whisper CI). Tagged @pipeline so CI runs
 * it in the model-bearing job and keeps the org-lock T2 model-free.
 */

// Narrowed preload surface this spec drives directly (engine bits live in
// fixtures/engine.ts). e2e/ is outside renderer/, so window.stenoai isn't
// ambiently typed here.
type StenoWindow = Window & {
  stenoai: {
    recording: { processSystemAudio: (p: string, name: string) => Promise<{ success?: boolean }> };
    on: { debugLog: (cb: (line: unknown) => void) => void };
  };
  __hb?: string[];
};

test('@pipeline synthetic WAV runs the full pipeline: HEARTBEAT + summary, real dir untouched', async ({
  launchApp,
  userDataDir,
}) => {
  // The pipeline (model load + transcribe + summarise) can outlast Playwright's
  // 30 s default, especially on a cold CI runner — give it room above the
  // file-poll timeout below.
  test.setTimeout(180_000);

  // Mock Ollama on the hardcoded 11434 so summarisation never reaches a real
  // LLM. Kill any stray real Ollama first; the successful bind then proves the
  // port is ours (plan risk 2). The app probes /api/tags and skips its own
  // `ollama serve` on the mock's 200.
  killOllama();
  const ollama = await startMockOllama();

  const realDirBefore = fileSig(realUserDataDir());

  try {
    const { page } = await launchApp({
      env: { OLLAMA_HOST: `http://127.0.0.1:${ollama.port}` },
    });
    await selectEngine(page);

    // Skip loudly if the active engine's model isn't installed (transcribe would
    // otherwise auto-download ~0.5 GB). CI installs it before this spec.
    const modelReady = await isEngineModelReady(page);
    if (!modelReady) {
      // eslint-disable-next-line no-console
      console.warn(`[t2:@pipeline] SKIPPED: ${E2E_ENGINE} model not installed on this runner.`);
      test.info().annotations.push({ type: 'skip-reason', description: `${E2E_ENGINE} model not installed` });
    }
    test.skip(!modelReady, `${E2E_ENGINE} model not installed`);

    // Write the WAV into the temp recordings dir — an allowed base dir now that
    // getAllowedBaseDirs() honors getUserDataDir().
    const recordingsDir = path.join(userDataDir, 'recordings');
    mkdirSync(recordingsDir, { recursive: true });
    const wavPath = path.join(recordingsDir, 'pipeline.wav');
    makeWav(wavPath, { seconds: 5 });

    // Collect HEARTBEAT lines forwarded to the renderer's debug-log channel.
    // Subscribe BEFORE driving so the first (immediately-forwarded) beat is seen.
    await page.evaluate(() => {
      const w = window as StenoWindow;
      w.__hb = [];
      w.stenoai.on.debugLog((line: unknown) => {
        if (typeof line === 'string' && line.includes('HEARTBEAT')) w.__hb!.push(line);
      });
    });

    // Drive the real streaming pipeline through the app IPC.
    const queued = await page.evaluate(
      (p) => (window as StenoWindow).stenoai.recording.processSystemAudio(p, 'E2E Pipeline'),
      wavPath,
    );
    expect(queued?.success).toBe(true);

    // Completion: the summary .md lands in the temp output dir.
    const summaryPath = path.join(userDataDir, 'output', 'pipeline_summary.md');
    await expect
      .poll(() => existsSync(summaryPath), { timeout: 120_000, intervals: [1000] })
      .toBe(true);

    // HEARTBEAT markers were observed during the run.
    const heartbeats = await page.evaluate(() => (window as StenoWindow).__hb ?? []);
    expect(heartbeats.some((l) => l.includes('HEARTBEAT:transcribe'))).toBe(true);

    // Keystone: the real user-data dir is byte-for-byte untouched.
    expect(fileSig(realUserDataDir())).toBe(realDirBefore);
  } finally {
    await ollama.close();
    // Teardown: the app may have spawned its own `ollama serve` despite the mock
    // (e.g. a probe race); don't let it outlive the test.
    killOllama();
  }
});
