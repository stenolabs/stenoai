import { test, expect } from '../fixtures/electron';
import { realUserDataDir, fileSig } from '../fixtures/real-user-data';
import { writeUserConfig } from '../fixtures/user-config';
import { startMockOllama } from '../fixtures/mock-ollama';
import { killOllama } from '../fixtures/kill-ollama';
import { makeWav } from '../fixtures/make-wav';
import { spawn } from 'child_process';
import { mkdirSync, writeFileSync, readFileSync, existsSync, statSync } from 'fs';
import path from 'path';

/**
 * T2 — live-transcript fallback (#207 / PR #247). Proves the load-bearing
 * Electron->Python contract that rescues a meeting when the post-stop batch
 * transcription comes back EMPTY: process-streaming, handed the live transcript
 * via --live-transcript, must NOT discard the meeting as "No speech detected" —
 * it writes the live text as the transcript, marks the note is_live_transcript,
 * and keeps the audio for a later retry.
 *
 * Model-free by construction: the input is a silent STEREO wav, which both
 * channels' RMS energy gate skips, so transcribe_diarised returns the silence
 * sentinel WITHOUT loading an ASR model (verified: no engine touched on
 * digital silence). Summarisation goes to the mock Ollama. So this runs in the
 * fast model-free t2 jobs, NOT the @pipeline lane.
 *
 * Why drive the backend directly instead of the app IPC: the live transcript
 * the renderer accumulates lives in main.js's in-memory liveTranscriptState,
 * which only the live ASR sidecar (a model) can populate — there is no
 * model-free way to seed it through the app. So the Electron snapshot/drain
 * half is model-coupled and left to manual / @pipeline coverage; this spec
 * pins the half that the bug actually lived in: the --live-transcript arg
 * contract + the Python rescue decision + the on-disk result.
 */

const BACKEND = path.resolve(
  __dirname,
  '..',
  '..',
  'dist',
  'stenoai',
  process.platform === 'win32' ? 'stenoai.exe' : 'stenoai',
);

// A realistic multi-sentence live transcript (the user watched this stream in
// during recording). Well above any non-empty floor.
const LIVE_TRANSCRIPT =
  'Welcome everyone to the weekly sync. We shipped the new onboarding flow on Tuesday. ' +
  'The remaining blocker is the billing migration, which Dana is driving. ' +
  'We agreed to cut the release on Friday if the staging soak is clean.';

// Fixed assistant reply in the markdown the parser keys on
// (## Summary / ## Key Points / ## Action Items).
const FIXED_REPLY = [
  '## Summary',
  'The team shipped onboarding and plans a Friday release pending a clean soak.',
  '',
  '## Key Points',
  '- Onboarding flow shipped Tuesday',
  '- Billing migration is the remaining blocker',
  '',
  '## Action Items',
  '- Dana to drive the billing migration',
  '',
].join('\n');

type SpawnResult = { code: number | null; stdout: string; stderr: string };

function runBackend(args: string[], userDataDir: string, extraEnv?: Record<string, string>): Promise<SpawnResult> {
  return new Promise((resolve, reject) => {
    const proc = spawn(BACKEND, args, {
      // Same Apple LM pin as the electron fixture (see auto-summarize.t2).
      env: {
        ...process.env,
        STENOAI_USER_DATA_DIR: userDataDir,
        STENOAI_DISABLE_APPLE_LM: '1',
        ...(extraEnv ?? {}),
      },
    });
    let stdout = '';
    let stderr = '';
    proc.stdout.on('data', (d) => (stdout += d.toString()));
    proc.stderr.on('data', (d) => (stderr += d.toString()));
    proc.on('error', reject);
    proc.on('close', (code) => resolve({ code, stdout, stderr }));
  });
}

test('empty batch transcription is rescued by the live transcript, marked, and the audio is kept', async ({
  userDataDir,
}) => {
  test.setTimeout(120_000);
  // The bundled backend must exist (built from this branch). Skip loudly if a
  // dev checkout hasn't run pyinstaller yet, rather than emit a path error.
  if (!existsSync(BACKEND)) {
    // eslint-disable-next-line no-console
    console.warn(`[t2] SKIPPED live-transcript fallback: backend bundle missing at ${BACKEND}`);
    test.info().annotations.push({ type: 'skip-reason', description: 'backend bundle not built' });
  }
  test.skip(!existsSync(BACKEND), 'backend bundle not built');

  const realDirBefore = fileSig(realUserDataDir());

  // Local provider so the summariser talks to the mock Ollama on 11434.
  //
  // Model-free without pinning an engine: the batch path builds WhisperTranscriber
  // lazily (self.model = None at construction — src/transcriber.py:452) and only
  // loads the ggml weight inside transcribe_audio (transcriber.py:734). A silent
  // stereo file fails the RMS energy gate on BOTH channels, so transcribe_diarised
  // returns the silence sentinel and transcribe_audio is never reached — no model
  // load or download in the fast t2 lane.
  // auto_summarize_enabled is off by default (#468 made summarisation a
  // post-transcription choice), so this spec — which asserts the summariser ran
  // and embedded the LIVE transcript in its prompt — must opt in explicitly.
  writeUserConfig(userDataDir, { ai_provider: 'local', auto_summarize_enabled: true });

  // Silent STEREO wav -> both channels skip the RMS gate -> batch transcription
  // returns the silence sentinel with no model loaded.
  const recordingsDir = path.join(userDataDir, 'recordings');
  mkdirSync(recordingsDir, { recursive: true });
  const wavPath = path.join(recordingsDir, 'livefallback.wav');
  makeWav(wavPath, { seconds: 4, amplitude: 0, channels: 2 });
  const sizeBefore = statSync(wavPath).size;

  // The live transcript snapshot Electron would have written at stop time.
  const liveFile = path.join(userDataDir, 'live-transcript.txt');
  writeFileSync(liveFile, LIVE_TRANSCRIPT, 'utf-8');

  killOllama();
  const ollama = await startMockOllama({ chatReply: FIXED_REPLY });
  try {
    const res = await runBackend(
      [
        'process-streaming',
        wavPath,
        '--name',
        'Live Fallback Meeting',
        '--live-transcript',
        liveFile,
      ],
      userDataDir,
      { OLLAMA_HOST: `http://127.0.0.1:${ollama.port}` },
    );
    expect(res.code, `backend stderr:\n${res.stderr}`).toBe(0);

    // The note markdown is written with the live transcript as its source and
    // marked is_live_transcript so the UI can tell the user no batch transcript
    // exists. Filename comes from the wav stem.
    const summaryPath = path.join(userDataDir, 'output', 'livefallback_summary.md');
    expect(existsSync(summaryPath), `no summary at ${summaryPath}\n${res.stdout}`).toBe(true);
    const summaryMd = readFileSync(summaryPath, 'utf8');
    expect(summaryMd).toMatch(/is_live_transcript:\s*true/i);

    // The transcript file holds the rescued LIVE text — not the silence
    // sentinel — using the canonical name/header (the crash path used to leave
    // this file missing entirely; the rescue writes it unconditionally).
    const transcriptPath = path.join(userDataDir, 'transcripts', 'livefallback_transcript.txt');
    expect(existsSync(transcriptPath)).toBe(true);
    const transcriptTxt = readFileSync(transcriptPath, 'utf8');
    expect(transcriptTxt).toContain('billing migration');
    expect(transcriptTxt).not.toContain('No speech detected in audio');

    // The note BODY was summarised from the live transcript, not the silence
    // sentinel: the prompt the backend sent the summariser embedded the live
    // text. Without this, a regression that still fed the sentinel into the
    // summary (while the separate transcript file looked right) would pass.
    const prompt = ollama.lastChatPrompt();
    expect(prompt).toBeTruthy();
    expect(prompt).toContain('billing migration');
    expect(prompt).not.toContain('No speech detected in audio');

    // Audio is kept regardless of keep_recordings: it's the user's only retry
    // material for a proper batch transcript later (mirrors the failure path).
    expect(existsSync(wavPath)).toBe(true);
    expect(statSync(wavPath).size).toBe(sizeBefore);

    // Keystone: the real user-data dir is byte-for-byte untouched.
    expect(fileSig(realUserDataDir())).toBe(realDirBefore);
  } finally {
    await ollama.close();
    killOllama();
  }
});
