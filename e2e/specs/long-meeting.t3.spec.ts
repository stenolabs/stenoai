import { test, expect } from '../fixtures/electron';
import { startMockOllama } from '../fixtures/mock-ollama';
import { makeWav } from '../fixtures/make-wav';
import { realUserDataDir, fileSig } from '../fixtures/real-user-data';
import { selectEngine, isEngineModelReady, E2E_ENGINE } from '../fixtures/engine';
import { killOllama } from '../fixtures/kill-ollama';
import { mkdirSync, existsSync } from 'fs';
import path from 'path';

/**
 * T3 — long-meeting chunking smoke (nightly only). Drives a multi-minute
 * synthetic WAV through the real pipeline and asserts it COMPLETES (summary
 * written, HEARTBEAT observed) rather than failing or returning empty.
 *
 * What this covers: the parakeet long-file CHUNKING PLUMBING. The onnx and MLX
 * backends window audio into PARAKEET_CHUNK_DURATION_S (60 s) slices and merge
 * the per-window results (src/_parakeet_onnx.py transcribe_file). Any file
 * longer than one chunk exercises that multi-window path end to end through the
 * app IPC. The engine is parakeet (onnx CPU on the Windows nightly runner; MLX
 * locally on a Mac) — whisper.cpp does NOT use this code path, so this spec is
 * parakeet-only.
 *
 * What this does NOT cover: the original long-meeting OOM was MLX/Metal-specific
 * (a 33-min file allocating ~40 GB on Metal). GitHub-hosted runners have no
 * Metal, so this exercises the chunking plumbing on CPU, not the GPU OOM — that
 * needs a Metal-capable runner (tracked follow-up). T3 is nightly because it's
 * minutes-long, not seconds.
 *
 * Duration is env-tunable (STENOAI_E2E_LONG_WAV_SECONDS) so the nightly job can
 * trade realism against CPU time. The default 1200 s against the 60 s chunk size
 * (45 s step after the 15 s overlap) windows into ~26 chunks — the multi-window
 * merge path is exercised many times over, not just twice.
 */

const LONG_WAV_SECONDS = Number(process.env.STENOAI_E2E_LONG_WAV_SECONDS) || 1200;

type StenoWindow = Window & {
  stenoai: {
    recording: { processSystemAudio: (p: string, name: string) => Promise<{ success?: boolean }> };
    on: { debugLog: (cb: (line: unknown) => void) => void };
  };
  __hb?: string[];
};

test('@long-meeting long WAV runs the chunking path to completion; real dir untouched', async ({
  launchApp,
  userDataDir,
}) => {
  if (E2E_ENGINE !== 'parakeet') {
    test.skip(true, 'long-meeting chunking is parakeet-only (whisper.cpp does not window via PARAKEET_CHUNK_DURATION_S)');
  }

  // A multi-minute CPU transcription far outlasts any per-test default; size the
  // budget off the audio length with generous headroom for model load.
  test.setTimeout(LONG_WAV_SECONDS * 1000 + 600_000);

  // Mock Ollama on 11434 so summarisation never reaches a real LLM (same setup
  // as the short pipeline smoke). Kill any stray real Ollama first.
  killOllama();
  const ollama = await startMockOllama();

  const realDirBefore = fileSig(realUserDataDir());

  try {
    const { page } = await launchApp({
      env: { OLLAMA_HOST: `http://127.0.0.1:${ollama.port}` },
    });
    await selectEngine(page);

    const modelReady = await isEngineModelReady(page);
    if (!modelReady) {
      // eslint-disable-next-line no-console
      console.warn(`[t3:@long-meeting] SKIPPED: ${E2E_ENGINE} model not installed on this runner.`);
      test.info().annotations.push({ type: 'skip-reason', description: `${E2E_ENGINE} model not installed` });
    }
    test.skip(!modelReady, `${E2E_ENGINE} model not installed`);

    // A long sine WAV: non-speech (empty transcript per window) but it still
    // flows through every chunk, which is what the plumbing test wants.
    const recordingsDir = path.join(userDataDir, 'recordings');
    mkdirSync(recordingsDir, { recursive: true });
    const wavPath = path.join(recordingsDir, 'long_meeting.wav');
    makeWav(wavPath, { seconds: LONG_WAV_SECONDS });

    await page.evaluate(() => {
      const w = window as StenoWindow;
      w.__hb = [];
      w.stenoai.on.debugLog((line: unknown) => {
        if (typeof line === 'string' && line.includes('HEARTBEAT')) w.__hb!.push(line);
      });
    });

    const queued = await page.evaluate(
      (p) => (window as StenoWindow).stenoai.recording.processSystemAudio(p, 'E2E Long Meeting'),
      wavPath,
    );
    expect(queued?.success).toBe(true);

    // Completion is the assertion: the summary lands, proving the long file
    // chunked + merged through the pipeline rather than failing or going empty.
    const summaryPath = path.join(userDataDir, 'output', 'long_meeting_summary.md');
    await expect
      .poll(() => existsSync(summaryPath), {
        timeout: LONG_WAV_SECONDS * 1000 + 300_000,
        intervals: [2000],
      })
      .toBe(true);

    // Liveness: transcription actually ran (both backends emit at least the
    // `HEARTBEAT:transcribe:start` beat before decoding).
    const heartbeats = await page.evaluate(() => (window as StenoWindow).__hb ?? []);
    expect(heartbeats.some((l) => l.includes('HEARTBEAT:transcribe'))).toBe(true);

    // Witness the multi-WINDOW chunking path specifically on the onnx backend —
    // the path that runs in the nightly (Windows/Linux CPU). Its chunked loop
    // emits `HEARTBEAT:transcribe:<done>/<total>` per window where <total> is the
    // window count, so a real <total> >= 2 proves the long file split into
    // multiple windows (the bare :start beat above would pass even without
    // chunking — exactly the weak-assertion gap this guards). The pinned
    // parakeet-mlx build (local macOS) doesn't surface per-window beats, so the
    // strong check is gated to the backend that emits them; local is dev-only and
    // still asserts completion + liveness above.
    if (process.platform !== 'darwin') {
      const windowTotals = heartbeats
        .map((l) => /HEARTBEAT:transcribe:\d+\/(\d+)/.exec(l)?.[1])
        .filter((n): n is string => Boolean(n))
        .map(Number);
      expect(Math.max(0, ...windowTotals)).toBeGreaterThanOrEqual(2);
    }

    // Keystone: the real user-data dir is byte-for-byte untouched.
    expect(fileSig(realUserDataDir())).toBe(realDirBefore);
  } finally {
    await ollama.close();
    killOllama();
  }
});
