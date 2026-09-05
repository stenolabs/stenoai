import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';
import { test, expect } from '../fixtures/electron';
import { startMockOllama } from '../fixtures/mock-ollama';
import { realUserDataDir, fileSig } from '../fixtures/real-user-data';
import { selectEngine, isEngineModelReady, E2E_ENGINE } from '../fixtures/engine';
import { killOllama } from '../fixtures/kill-ollama';
import { isSayAvailable, makeStereoSpeechWav } from '../fixtures/say-stereo-wav';

/**
 * T2 — real-backend per-channel speaker diarization (@pipeline). Drives a
 * REAL synthesized-speech stereo recording through the app's streaming
 * pipeline with STENOAI_DIARIZE_SIDECAR_PATH pointed at a fixture script
 * (fixed 2-speaker JSON, independent of the real steno-diarize/Sortformer
 * binary — that binary was validated directly against real recordings
 * during development; this spec proves the PYTHON-SIDE integration: env
 * override resolution, subprocess invocation + JSON parsing, per-channel
 * cluster labeling, and cross-channel "Speaker N" numbering, end to end
 * through the real Electron + Python app).
 *
 * Needs real (non-sine) speech so Parakeet/whisper.cpp produce real ASR
 * sentence segments to diarize — synthesized via macOS's `say` (see
 * fixtures/say-stereo-wav.ts), since there's no ASR mock seam in this
 * codebase. macOS-only (both `say` and diarize-sidecar are macOS-only);
 * skips loudly elsewhere or when the active engine's model isn't installed.
 */

type StenoWindow = Window & {
  stenoai: {
    recording: { processSystemAudio: (p: string, name: string) => Promise<{ success?: boolean }> };
  };
};

test('@pipeline synthesized two-speaker mic channel becomes You + Speaker 2', async ({
  launchApp,
  userDataDir,
}) => {
  test.setTimeout(180_000);

  test.skip(process.platform !== 'darwin', 'diarize-sidecar and the say TTS fixture are macOS-only');
  test.skip(!isSayAvailable(), 'macOS `say` TTS unavailable on this runner');

  killOllama();
  const ollama = await startMockOllama();
  const realDirBefore = fileSig(realUserDataDir());

  try {
    // Build the real speech fixture BEFORE launching the app: mic channel =
    // two utterances separated by a real acoustic gap, system channel = one
    // short utterance. Pure Node/TTS — no app instance needed yet.
    const recordingsDir = path.join(userDataDir, 'recordings');
    mkdirSync(recordingsDir, { recursive: true });
    const wavPath = path.join(recordingsDir, 'diarize.wav');
    const { micBoundarySeconds } = makeStereoSpeechWav(wavPath, {
      micUtteranceA: 'Hello there, I hope you are having a wonderful and productive day today.',
      micUtteranceB: 'Thanks a lot.',
      systemUtterance: 'Thanks.',
    });

    // Fixture diarizer: always reports the SAME two speaker clusters,
    // independent of which channel WAV it's actually pointed at. The tail
    // cluster is deliberately shorter than the boundary so SPEAKER_0 always
    // stays the dominant (most total speaking time) cluster on BOTH
    // channels — sanity-checked below rather than assumed. Expressed as a
    // fraction of micBoundarySeconds with no floor above it, so the
    // invariant below holds for any micBoundarySeconds > 0 -- a previous
    // version floored this at 1.5s, which made the assertion mathematically
    // impossible whenever isSayAvailable()'s probe let through a runner
    // where `say` produced near-silent audio (micBoundarySeconds well under
    // 1.5s). isSayAvailable() now measures real synthesized duration, so
    // that shouldn't recur, but this formula no longer depends on it either.
    const tailSeconds = Math.min(micBoundarySeconds * 0.6, 3.0);
    expect(tailSeconds).toBeLessThan(micBoundarySeconds);

    const fixtureDir = mkdtempSync(path.join(tmpdir(), 'stenoai-e2e-diarize-'));
    const scriptPath = path.join(fixtureDir, 'mock-steno-diarize.sh');
    writeFileSync(
      scriptPath,
      [
        '#!/usr/bin/env bash',
        'set -euo pipefail',
        `echo '[{"speakerId":"SPEAKER_0","start":0,"end":${micBoundarySeconds}},` +
          `{"speakerId":"SPEAKER_1","start":${micBoundarySeconds},"end":${micBoundarySeconds + tailSeconds}}]'`,
        '',
      ].join('\n'),
    );
    chmodSync(scriptPath, 0o755);

    const { page } = await launchApp({
      env: { STENOAI_DIARIZE_SIDECAR_PATH: scriptPath },
    });
    await selectEngine(page);

    const modelReady = await isEngineModelReady(page);
    if (!modelReady) {
      // eslint-disable-next-line no-console
      console.warn(`[t2:@pipeline] SKIPPED: ${E2E_ENGINE} model not installed on this runner.`);
      test.info().annotations.push({ type: 'skip-reason', description: `${E2E_ENGINE} model not installed` });
    }
    test.skip(!modelReady, `${E2E_ENGINE} model not installed`);

    const queued = await page.evaluate(
      (p) => (window as StenoWindow).stenoai.recording.processSystemAudio(p, 'E2E Diarize'),
      wavPath,
    );
    expect(queued?.success).toBe(true);

    const transcriptPath = path.join(userDataDir, 'transcripts', 'diarize_transcript.txt');
    await expect
      .poll(() => existsSync(transcriptPath), { timeout: 120_000, intervals: [1000] })
      .toBe(true);

    const transcript = readFileSync(transcriptPath, 'utf8');
    // Mic's dominant cluster (utterance A) keeps the legacy "You" label;
    // its minority cluster (utterance B) becomes "Speaker 2". The system
    // channel's single utterance lands in the shared dominant cluster too,
    // so it keeps "Others" rather than becoming a second placeholder.
    expect(transcript).toMatch(/\[You\]/);
    expect(transcript).toMatch(/\[Speaker 2\]/);
    expect(transcript).toMatch(/\[Others\]/);
    expect(transcript).not.toMatch(/\[Speaker 3\]/);

    expect(fileSig(realUserDataDir())).toBe(realDirBefore);
  } finally {
    await ollama.close();
    killOllama();
  }
});
