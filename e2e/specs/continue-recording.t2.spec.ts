import { test, expect } from '../fixtures/electron';
import { realUserDataDir, fileSig } from '../fixtures/real-user-data';
import { writeUserConfig } from '../fixtures/user-config';
import { startMockOllama } from '../fixtures/mock-ollama';
import { killOllama } from '../fixtures/kill-ollama';
import { makeWav } from '../fixtures/make-wav';
import { spawn } from 'child_process';
import { mkdirSync, writeFileSync, readFileSync, readdirSync, existsSync } from 'fs';
import path from 'path';

/**
 * T2 — continue-recording (append) + Regenerate notes. Proves the
 * "stop is the new pause" lifecycle end-to-end at the backend contract:
 *
 * 1. A first recording produces a note (transcript-only, auto-summarize off).
 * 2. A second recording processed with --append-to folds its transcript into
 *    THAT note (a "--- Resumed" separator, both segments present), marks it
 *    `notes_stale: true`, extends duration, and creates NO second note.
 * 3. `reprocess` regenerates the summary from the combined transcript and
 *    clears the stale flag (one mock-Ollama call).
 * 4. A failed continuation (silent audio, no live rescue) exits non-zero and
 *    leaves the target note byte-for-byte untouched.
 *
 * Model-free by construction (mirrors auto-summarize.t2): silent stereo wavs
 * skip the ASR model via the RMS gate and are rescued by --live-transcript.
 */

const BACKEND = path.resolve(
  __dirname,
  '..',
  '..',
  'dist',
  'stenoai',
  process.platform === 'win32' ? 'stenoai.exe' : 'stenoai',
);

const SEGMENT_ONE =
  'Welcome to the planning session. We agreed the beta ships next week.';
const SEGMENT_TWO =
  'Back after the break. One more decision: the pricing page copy is final.';

const FIXED_REPLY = [
  '## Summary',
  'Beta ships next week and the pricing page copy was finalised.',
  '',
  '## Key Points',
  '- Beta ships next week',
  '- Pricing copy final',
  '',
].join('\n');

type SpawnResult = { code: number | null; stdout: string; stderr: string };

function runBackend(args: string[], userDataDir: string, extraEnv?: Record<string, string>): Promise<SpawnResult> {
  return new Promise((resolve, reject) => {
    const proc = spawn(BACKEND, args, {
      // Same Apple LM pin as the electron fixture: a directly spawned backend
      // on a host with a built sidecar would summarise on-device and never
      // reach the deterministic Ollama fixture this spec counts calls on.
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

test('append folds a second segment into the note, marks it stale, and reprocess clears it', async ({
  userDataDir,
}) => {
  test.setTimeout(180_000);
  test.skip(!existsSync(BACKEND), 'backend bundle not built');

  const realDirBefore = fileSig(realUserDataDir());
  writeUserConfig(userDataDir, { ai_provider: 'local', auto_summarize_enabled: false });

  const recordingsDir = path.join(userDataDir, 'recordings');
  mkdirSync(recordingsDir, { recursive: true });

  // ── Segment 1: a normal recording → transcript-only note.
  const wav1 = path.join(recordingsDir, 'segment1.wav');
  makeWav(wav1, { seconds: 4, amplitude: 0, channels: 2 });
  const live1 = path.join(userDataDir, 'live1.txt');
  writeFileSync(live1, SEGMENT_ONE, 'utf-8');

  const res1 = await runBackend(
    ['process-streaming', wav1, '--name', 'Planning', '--live-transcript', live1],
    userDataDir,
  );
  expect(res1.code, `seg1 stderr:\n${res1.stderr}`).toBe(0);
  const summaryPath = path.join(userDataDir, 'output', 'segment1_summary.md');
  expect(existsSync(summaryPath)).toBe(true);

  // ── Segment 2: continue-recording → appended to the SAME note.
  const wav2 = path.join(recordingsDir, 'segment2.wav');
  makeWav(wav2, { seconds: 4, amplitude: 0, channels: 2 });
  const live2 = path.join(userDataDir, 'live2.txt');
  writeFileSync(live2, SEGMENT_TWO, 'utf-8');

  const res2 = await runBackend(
    [
      'process-streaming', wav2,
      '--name', 'Planning',
      '--live-transcript', live2,
      '--append-to', summaryPath,
    ],
    userDataDir,
  );
  expect(res2.code, `seg2 stderr:\n${res2.stderr}`).toBe(0);
  expect(res2.stdout).toContain('SUMMARY_SKIPPED');
  expect(res2.stdout).toContain(`SAVED:${summaryPath}`);

  let md = readFileSync(summaryPath, 'utf8');
  expect(md).toContain(SEGMENT_ONE);
  expect(md).toContain('--- Resumed');
  expect(md).toContain(SEGMENT_TWO);
  expect(md).toMatch(/notes_stale:\s*true/);
  // No second note was created for the continuation.
  const notes = readdirSync(path.join(userDataDir, 'output')).filter((f) =>
    f.endsWith('_summary.md'),
  );
  expect(notes).toEqual(['segment1_summary.md']);

  // ── Regenerate: reprocess reads the combined transcript, writes the
  // summary, and clears the stale flag. One mock-Ollama call.
  killOllama();
  const ollama = await startMockOllama({ chatReply: FIXED_REPLY });
  try {
    const res3 = await runBackend(['reprocess', summaryPath], userDataDir, {
      OLLAMA_HOST: `http://127.0.0.1:${ollama.port}`,
    });
    expect(res3.code, `reprocess stderr:\n${res3.stderr}\n${res3.stdout}`).toBe(0);
    expect(res3.stdout).toContain('STREAM_COMPLETE');
    expect(ollama.chatCalls()).toBe(1);

    md = readFileSync(summaryPath, 'utf8');
    expect(md).toContain('## Summary');
    expect(md).not.toMatch(/notes_stale/);
    // The combined transcript survives the rewrite.
    expect(md).toContain(SEGMENT_ONE);
    expect(md).toContain(SEGMENT_TWO);
  } finally {
    await ollama.close();
  }

  // ── Failed continuation: silent audio with NO live rescue must exit
  // non-zero and leave the note byte-for-byte untouched.
  const before = readFileSync(summaryPath, 'utf8');
  const wav3 = path.join(recordingsDir, 'segment3.wav');
  makeWav(wav3, { seconds: 4, amplitude: 0, channels: 2 });
  const res4 = await runBackend(
    ['process-streaming', wav3, '--name', 'Planning', '--append-to', summaryPath],
    userDataDir,
  );
  expect(res4.code).not.toBe(0);
  expect(readFileSync(summaryPath, 'utf8')).toBe(before);

  // Keystone: the real user-data dir is byte-for-byte untouched.
  expect(fileSig(realUserDataDir())).toBe(realDirBefore);
});
