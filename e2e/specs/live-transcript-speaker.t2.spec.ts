import { test, expect } from '../fixtures/electron';
import { writeUserConfig } from '../fixtures/user-config';
import { realUserDataDir, fileSig } from '../fixtures/real-user-data';
import { E2E_ENGINE } from '../fixtures/engine';
import { makeSequentialStereoSpeech, hasMacSpeechTools } from '../fixtures/make-speech-stereo';
import { spawn } from 'child_process';
import { existsSync } from 'fs';
import path from 'path';

/**
 * T2 (@pipeline) — proves the actual bug this PR fixes: live-transcript's
 * per-channel VAD + speaker attribution. Feeds a real, deterministic
 * interleaved-stereo stream (mic=L, system=R; two distinct TTS sentences,
 * non-overlapping in time — see fixtures/make-speech-stereo.js) directly
 * into the `transcribe-stream` sidecar's stdin and asserts the LIVE_SEG
 * output on stdout carries the correct `speaker` per channel, with no
 * cross-channel clobber and stable chronological ordering.
 *
 * Requires the real Parakeet model — live-transcript is Parakeet-only (see
 * simple_recorder.py's _LiveVadPipeline._load_shared, which rejects any
 * other configured engine with a LIVE_ERROR). Unlike the whisper-in-CI
 * fallback the other @pipeline specs use (fixtures/engine.ts), there's no
 * whisper live-transcript path to fall back to, so this can only run where
 * parakeet-mlx actually loads: local Apple Silicon dev machines.
 * GitHub-hosted macOS CI runners have no Metal GPU (see fixtures/engine.ts's
 * own comment on this), so this skips loudly there — same "skip if the
 * environment can't support it" contract every other @pipeline spec follows
 * for a missing model, just one level earlier (missing GPU vs missing
 * weights).
 *
 * Drives the backend binary directly (no Electron/Playwright app launch, no
 * real audio capture) — mirrors live-transcript-fallback.t2.spec.ts's
 * direct-CLI pattern, adapted for a long-lived stdin/stdout process instead
 * of a one-shot command.
 */

const BACKEND = path.resolve(
  __dirname,
  '..',
  '..',
  'dist',
  'stenoai',
  process.platform === 'win32' ? 'stenoai.exe' : 'stenoai',
);

interface LiveSeg {
  text: string;
  start: number;
  end: number;
  is_final: boolean;
  speaker: 'You' | 'Others';
}

interface RunResult {
  segments: LiveSeg[];
  liveError: { stage?: string; error?: string } | null;
}

function runTranscribeStream(stdinBuffer: Buffer, userDataDir: string): Promise<RunResult> {
  return new Promise((resolve, reject) => {
    const proc = spawn(BACKEND, ['transcribe-stream'], {
      // Same Apple LM pin as the electron fixture (see auto-summarize.t2).
      env: { ...process.env, STENOAI_USER_DATA_DIR: userDataDir, STENOAI_DISABLE_APPLE_LM: '1' },
    });
    let buffered = '';
    let stderr = '';
    const segments: LiveSeg[] = [];
    let liveError: RunResult['liveError'] = null;
    proc.stdout.on('data', (d) => {
      buffered += d.toString();
      let nl;
      while ((nl = buffered.indexOf('\n')) !== -1) {
        const line = buffered.slice(0, nl);
        buffered = buffered.slice(nl + 1);
        if (line.startsWith('LIVE_SEG:')) {
          try {
            segments.push(JSON.parse(line.slice('LIVE_SEG:'.length)));
          } catch {
            /* ignore parse hiccups on a truncated line */
          }
        } else if (line.startsWith('LIVE_ERROR:') && !liveError) {
          try {
            liveError = JSON.parse(line.slice('LIVE_ERROR:'.length));
          } catch {
            liveError = { error: line };
          }
        }
      }
    });
    proc.stderr.on('data', (d) => (stderr += d.toString()));
    proc.on('error', reject);
    proc.on('close', (code) => {
      // _load_shared/create_pair failures return cleanly (exit 0) after
      // printing LIVE_ERROR — a non-zero exit here means something else
      // (an unhandled crash) went wrong, which should still fail the test.
      if (code !== 0) {
        reject(new Error(`transcribe-stream exited ${code}\nstderr:\n${stderr}`));
        return;
      }
      resolve({ segments, liveError });
    });
    proc.stdin.write(stdinBuffer);
    proc.stdin.end();
  });
}

test('@pipeline stereo LIVE_SEG carries correct per-channel speaker, no cross-channel clobber', async ({
  userDataDir,
}) => {
  test.setTimeout(120_000);

  if (!existsSync(BACKEND)) {
    // eslint-disable-next-line no-console
    console.warn(`[t2:@pipeline] SKIPPED live-transcript-speaker: backend bundle missing at ${BACKEND}`);
    test.info().annotations.push({ type: 'skip-reason', description: 'backend bundle not built' });
  }
  test.skip(!existsSync(BACKEND), 'backend bundle not built');

  if (process.platform !== 'darwin' || !hasMacSpeechTools()) {
    // eslint-disable-next-line no-console
    console.warn('[t2:@pipeline] SKIPPED live-transcript-speaker: needs macOS say/afconvert to synthesize test speech');
    test.info().annotations.push({ type: 'skip-reason', description: 'macOS TTS tools unavailable' });
  }
  test.skip(process.platform !== 'darwin' || !hasMacSpeechTools(), 'macOS say/afconvert unavailable');

  if (E2E_ENGINE !== 'parakeet') {
    // Live-transcript has no whisper path at all (Parakeet-only), so the
    // whisper-in-CI fallback the other @pipeline specs use doesn't apply here.
    // eslint-disable-next-line no-console
    console.warn('[t2:@pipeline] SKIPPED live-transcript-speaker: live-transcript is Parakeet-only, this lane runs whisper');
    test.info().annotations.push({ type: 'skip-reason', description: 'live-transcript is Parakeet-only' });
  }
  test.skip(E2E_ENGINE !== 'parakeet', 'live-transcript is Parakeet-only');

  writeUserConfig(userDataDir, { transcription_engine: 'parakeet' });

  const realDirBefore = fileSig(realUserDataDir());
  const { buffer } = makeSequentialStereoSpeech();

  const { segments, liveError } = await runTranscribeStream(buffer, userDataDir);

  if (liveError) {
    // A missing/uninstalled model surfaces as LIVE_ERROR, not a process
    // crash (see runTranscribeStream) — that's a legitimate skip, not a
    // failure. Anything else is a real bug and should fail loudly.
    const skippable = /parakeet|silero|model/i.test(JSON.stringify(liveError));
    // eslint-disable-next-line no-console
    console.warn(`[t2:@pipeline] live-transcript-speaker LIVE_ERROR: ${JSON.stringify(liveError)}`);
    test.info().annotations.push({ type: 'skip-reason', description: `LIVE_ERROR: ${JSON.stringify(liveError)}` });
    test.skip(skippable, `parakeet/silero unavailable: ${JSON.stringify(liveError)}`);
    throw new Error(`Unexpected LIVE_ERROR: ${JSON.stringify(liveError)}`);
  }

  const finals = segments.filter((s) => s.is_final);
  expect(finals.length, `expected at least 2 final segments, got: ${JSON.stringify(finals)}`)
    .toBeGreaterThanOrEqual(2);

  const youFinals = finals.filter((s) => s.speaker === 'You');
  const othersFinals = finals.filter((s) => s.speaker === 'Others');
  expect(youFinals.length, `no You segment produced: ${JSON.stringify(finals)}`).toBeGreaterThan(0);
  expect(othersFinals.length, `no Others segment produced: ${JSON.stringify(finals)}`).toBeGreaterThan(0);

  const youText = youFinals.map((s) => s.text).join(' ').toLowerCase();
  const othersText = othersFinals.map((s) => s.text).join(' ').toLowerCase();

  // Correct per-channel routing: mic content -> You, system content -> Others.
  expect(youText).toMatch(/fox/);
  expect(othersText).toMatch(/dozen|liquor/);

  // No cross-channel clobber: neither side's text contains the other's
  // distinctive content — proves the two channels were actually transcribed
  // independently, not mixed/duplicated/swapped.
  expect(youText).not.toMatch(/dozen|liquor/);
  expect(othersText).not.toMatch(/fox/);

  // Stable ordering: the fixture has mic speak fully before system starts,
  // so the You final(s) must be timestamped before the Others final(s).
  const lastYouStart = Math.max(...youFinals.map((s) => s.start));
  const firstOthersStart = Math.min(...othersFinals.map((s) => s.start));
  expect(lastYouStart).toBeLessThan(firstOthersStart);

  // Keystone: the real user-data dir is byte-for-byte untouched.
  expect(fileSig(realUserDataDir())).toBe(realDirBefore);
});
