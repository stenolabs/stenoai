import { test, expect } from '../fixtures/electron';
import { startMockOllama } from '../fixtures/mock-ollama';
import { makeWav } from '../fixtures/make-wav';
import { realUserDataDir, fileSig } from '../fixtures/real-user-data';
import { selectEngine, isEngineModelReady, E2E_ENGINE } from '../fixtures/engine';
import { killOllama } from '../fixtures/kill-ollama';
import { mkdirSync, existsSync, readFileSync, rmSync } from 'fs';
import path from 'path';

/**
 * T2 — import-collision dedup, end-to-end through the real backend (@pipeline).
 *
 * The model-free audio-import-collision.t2 seeds a fake note in the JS-computed
 * output dir and asserts only the JS-side copy bumps the stem. It structurally
 * CANNOT catch a JS↔Python directory disagreement, because it never drives the
 * Python round-trip that writes the real note. That blind spot is exactly how
 * #233 slipped through: in dev the JS resolvers returned repo-root recordings/
 * while the frozen backend wrote under ~/Library, so noteExists() checked an
 * always-empty dir and a re-import silently overwrote the first note.
 *
 * This spec closes the gap. It runs the FULL pipeline twice with the same
 * basename, letting the real backend write each summary, and asserts the second
 * import is bumped to <stem>-1 with the first note byte-for-byte intact. It is
 * the precise #233 scenario: by the time the second import runs, the first
 * import's audio has been unlinked (keep_recordings off) but its durable note
 * survives — so the dedup MUST consult the output dir the backend actually
 * wrote to. Fails on the pre-fix resolvers (JS checks repo output/, backend
 * wrote temp output/), passes once both layers honor STENOAI_USER_DATA_DIR.
 *
 * Tagged @pipeline: needs the model-bearing lane (two real transcriptions) and
 * stays out of the fast model-free T2 lane.
 */

type StenoWindow = Window & {
  stenoai: {
    recording: {
      processFile: (filePath: string, name: string) => Promise<{ success?: boolean; error?: string }>;
      getDir: () => Promise<{ success?: boolean; path?: string }>;
    };
  };
};

test('@pipeline a re-import of a same-basename file is deduped end-to-end and keeps the first note', async ({
  launchApp,
  userDataDir,
}) => {
  // Two full transcribe+summarise passes plus two completion polls and an unlink
  // poll; budget well above double the single-run @pipeline spec (180 s) so a
  // cold CI runner (whisper, no Metal) has headroom and doesn't flake.
  test.setTimeout(480_000);

  // Mock Ollama on 11434 so summarisation never reaches a real LLM (kill any
  // stray real one first so the successful bind proves the port is ours).
  killOllama();
  const ollama = await startMockOllama();

  const realDirBefore = fileSig(realUserDataDir());

  // Summaries land in the isolated temp output dir (both layers honor the
  // STENOAI_USER_DATA_DIR keystone). process-streaming writes <stem>_summary.md
  // (and emits SAVED:) — NOT _summary.json — so we poll the .md.
  const outputDir = path.join(userDataDir, 'output');
  const firstNote = path.join(outputDir, 'imported_summary.md');
  const secondNote = path.join(outputDir, 'imported-1_summary.md');

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

    const dir = await page.evaluate(() =>
      (window as StenoWindow).stenoai.recording.getDir(),
    );
    recordingsDir = dir?.path;
    // getDir() must resolve to the isolated temp dir — the heart of #233. If it
    // returned repo-root recordings/ (the old dev quirk) while the backend wrote
    // under the override, the dedup would consult the wrong output dir.
    expect(recordingsDir).toBe(path.join(userDataDir, 'recordings'));

    // First import: a file that lives OUTSIDE the recordings dir.
    const srcDir1 = path.join(userDataDir, 'import-src-1');
    mkdirSync(srcDir1, { recursive: true });
    const srcPath1 = path.join(srcDir1, 'imported.wav');
    makeWav(srcPath1, { seconds: 5 });

    const queued1 = await page.evaluate(
      (p) => (window as StenoWindow).stenoai.recording.processFile(p, 'Imported Note'),
      srcPath1,
    );
    expect(queued1?.success).toBe(true);

    // Let the FIRST import finish: the note is written and (keep_recordings off)
    // the copied audio is unlinked. This is the trap — the stem is now free in
    // recordings/ but the durable note exists in output/.
    await expect
      .poll(() => existsSync(firstNote), { timeout: 150_000, intervals: [1000] })
      .toBe(true);
    await expect
      .poll(() => existsSync(path.join(recordingsDir!, 'imported.wav')), {
        timeout: 30_000,
        intervals: [500],
      })
      .toBe(false);
    const firstNoteBody = readFileSync(firstNote, 'utf8');
    expect(firstNoteBody.length).toBeGreaterThan(0);

    // Second import: a DIFFERENT file that happens to share the basename.
    const srcDir2 = path.join(userDataDir, 'import-src-2');
    mkdirSync(srcDir2, { recursive: true });
    const srcPath2 = path.join(srcDir2, 'imported.wav');
    makeWav(srcPath2, { seconds: 5 });

    const queued2 = await page.evaluate(
      (p) => (window as StenoWindow).stenoai.recording.processFile(p, 'Imported Note Again'),
      srcPath2,
    );
    expect(queued2?.success).toBe(true);

    // The dedup must have bumped it: the second note lands at imported-1, not
    // imported. On the pre-fix code JS checked the wrong (empty) output dir, so
    // the second import reused "imported" and overwrote the first note.
    await expect
      .poll(() => existsSync(secondNote), { timeout: 150_000, intervals: [1000] })
      .toBe(true);

    // The first import's note is byte-for-byte intact — nothing overwrote it.
    expect(readFileSync(firstNote, 'utf8')).toBe(firstNoteBody);

    // Keystone: the real user-data dir is byte-for-byte untouched.
    expect(fileSig(realUserDataDir())).toBe(realDirBefore);
  } finally {
    await ollama.close();
    // Teardown: the app may have spawned its own `ollama serve` despite the
    // mock (probe race); don't let it outlive the test.
    killOllama();
    // Best-effort copy cleanup (the temp dir is torn down by the fixture anyway).
    if (recordingsDir) {
      rmSync(path.join(recordingsDir, 'imported.wav'), { force: true });
      rmSync(path.join(recordingsDir, 'imported-1.wav'), { force: true });
    }
  }
});
