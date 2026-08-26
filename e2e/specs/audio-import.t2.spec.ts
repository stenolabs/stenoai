import { test, expect } from '../fixtures/electron';
import { startMockOllama } from '../fixtures/mock-ollama';
import { makeWav } from '../fixtures/make-wav';
import { realUserDataDir, fileSig } from '../fixtures/real-user-data';
import { selectEngine, isEngineModelReady, E2E_ENGINE } from '../fixtures/engine';
import { killOllama } from '../fixtures/kill-ollama';
import { mkdirSync, existsSync, rmSync } from 'fs';
import path from 'path';

/**
 * T2 — local audio-file import (@pipeline). Drives `process-recording`
 * (the picker / drag-drop entry point) with a file that lives OUTSIDE the
 * recordings dir and asserts the import is non-destructive end to end.
 *
 * This needs the model-bearing lane precisely because the bug it guards is
 * post-transcription: `process-streaming` unlinks the processed audio after a
 * successful transcribe when keep_recordings is off (the default). Before the
 * copy-on-import fix the *original* was passed straight through and deleted;
 * now the handler copies the file into recordings/ first, so the unlink only
 * touches our copy and the user's source survives. With a real model the
 * transcription succeeds, the unlink fires, and "the original still exists"
 * is a genuine regression assertion that fails on the pre-fix code.
 *
 * Collision de-duplication (a re-import of a same-basename file must not
 * overwrite the first import's note) is covered model-free in
 * audio-import-collision.t2; this spec keeps to one import to stay within the
 * pipeline lane's budget. Tagged @pipeline so it runs in the model-bearing job
 * and stays out of the fast model-free T2 lane.
 */

type StenoWindow = Window & {
  stenoai: {
    recording: {
      processFile: (filePath: string, name: string) => Promise<{ success?: boolean; error?: string }>;
      getDir: () => Promise<{ success?: boolean; path?: string }>;
    };
  };
};

test('@pipeline importing a file creates a note and leaves the original on disk', async ({
  launchApp,
  userDataDir,
}) => {
  // Model load + transcribe + summarise can outlast Playwright's 30 s default
  // on a cold CI runner; give the file-poll below room.
  test.setTimeout(180_000);

  // Mock Ollama on 11434 so summarisation never reaches a real LLM (kill any
  // stray real one first so the successful bind proves the port is ours).
  killOllama();
  const ollama = await startMockOllama();

  const realDirBefore = fileSig(realUserDataDir());

  // Captured after launch so the finally block can tidy the copy without
  // re-launching the app.
  let recordingsDir: string | undefined;

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

    // The source lives OUTSIDE the recordings dir — this is the "import a file
    // from elsewhere on disk" case (e.g. ~/Desktop/interview.m4a). It sits in
    // the per-test temp dir so it's still hermetic.
    const srcDir = path.join(userDataDir, 'import-src');
    mkdirSync(srcDir, { recursive: true });
    const srcPath = path.join(srcDir, 'imported.wav');
    makeWav(srcPath, { seconds: 5 });

    // Where the handler copies imports to (so the finally can tidy it).
    const dir = await page.evaluate(() =>
      (window as StenoWindow).stenoai.recording.getDir(),
    );
    recordingsDir = dir?.path;

    // Drive the real import pipeline through the app IPC (same path as the
    // picker and drag-drop). Fire-and-forget: resolves once the file is copied
    // and queued, not when transcription finishes.
    const queued = await page.evaluate(
      (p) => (window as StenoWindow).stenoai.recording.processFile(p, 'Imported Note'),
      srcPath,
    );
    expect(queued?.success).toBe(true);

    // Completion: the summary lands in the temp output dir. The file name comes
    // from the copy's stem (`imported`), proving the file flowed through the
    // pipeline and a note was created.
    const summaryPath = path.join(userDataDir, 'output', 'imported_summary.md');
    await expect
      .poll(() => existsSync(summaryPath), { timeout: 120_000, intervals: [1000] })
      .toBe(true);

    // The regression guard: the summary exists, so transcription succeeded and
    // process-streaming has run its post-success cleanup (the unlink). The
    // user's ORIGINAL file must still be on disk — it would be gone here on the
    // pre-fix code, which fed the original straight to the pipeline.
    expect(existsSync(srcPath)).toBe(true);

    // Keystone: the real user-data dir is byte-for-byte untouched.
    expect(fileSig(realUserDataDir())).toBe(realDirBefore);
  } finally {
    await ollama.close();
    // Teardown: the app may have spawned its own `ollama serve` despite the
    // mock (probe race); don't let it outlive the test.
    killOllama();
    // Best-effort: the copy lands in the app's recordings dir (now
    // STENOAI_USER_DATA_DIR-isolated, so the fixture tears it down anyway).
    // keep_recordings defaults off, so a successful transcribe already unlinked
    // it; this just tidies a skipped/failed mid-way run.
    if (recordingsDir) {
      rmSync(path.join(recordingsDir, 'imported.wav'), { force: true });
    }
  }
});
