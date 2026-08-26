import { test, expect } from '../fixtures/electron';
import { realUserDataDir, fileSig } from '../fixtures/real-user-data';
import { writeUserConfig } from '../fixtures/user-config';
import { startMockOllama } from '../fixtures/mock-ollama';
import { killOllama } from '../fixtures/kill-ollama';
import { makeWav } from '../fixtures/make-wav';
import { spawn } from 'child_process';
import { mkdirSync, writeFileSync, readFileSync, existsSync } from 'fs';
import path from 'path';

/**
 * T2 — instant-stop backend contract (the pieces the pipeline owns; the
 * placeholder write + navigation live in main.js and are covered by the T1).
 * Proves:
 *
 * 1. The parser surfaces an instant-stop placeholder's `processing: true` as
 *    `session_info.processing`.
 * 2. process-streaming, rewriting the note in place, PRESERVES a My-notes edit
 *    made on the placeholder (`## User Notes`) over the older `--notes` draft —
 *    the edit-during-the-background-window must not be clobbered.
 * 3. The final note drops `processing` and gains the summary.
 *
 * Model-free (mirrors continue-recording.t2 / auto-summarize.t2): a silent
 * stereo wav skips the ASR model via the RMS gate and is rescued by
 * --live-transcript; the summary goes to the mock Ollama.
 */

const BACKEND = path.resolve(
  __dirname,
  '..',
  '..',
  'dist',
  'stenoai',
  process.platform === 'win32' ? 'stenoai.exe' : 'stenoai',
);

const LIVE_TRANSCRIPT =
  'Welcome to the sync. We shipped onboarding on Tuesday and cut the release Friday.';

// Includes a '## ' heading the user typed inside their own notes — the notes
// preserve must run to end-of-file, NOT truncate at that heading.
const EDITED_NOTES = 'EDITED: ping Dana about the migration.\n\n## Follow-ups\n- confirm the soak';
const OLD_DRAFT_NOTES = 'OLD DRAFT: this should be overwritten by the edit.';

const FIXED_REPLY = ['## Summary', 'Onboarding shipped; release cut Friday.', '', '## Key Points', '- shipped', ''].join('\n');

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

// A placeholder note as main.js writes it at stop: processing:true, a live
// transcript, and My notes the user has since edited.
function placeholderNote(): string {
  return [
    '---',
    'title: "Instant Note"',
    'date: "2026-07-12T10:00:00"',
    'is_diarised: false',
    'is_live_transcript: true',
    'processing: true',
    'notes_generated: false',
    '---',
    '',
    '## Transcript',
    '',
    'live text placeholder',
    '',
    '## User Notes',
    '',
    EDITED_NOTES,
    '',
  ].join('\n');
}

test('placeholder processing flag parses; the rewrite preserves the edited My notes and clears processing', async ({
  userDataDir,
}) => {
  test.setTimeout(180_000);
  test.skip(!existsSync(BACKEND), 'backend bundle not built');

  const realDirBefore = fileSig(realUserDataDir());
  writeUserConfig(userDataDir, { ai_provider: 'local', auto_summarize_enabled: true });

  const recordingsDir = path.join(userDataDir, 'recordings');
  const outputDir = path.join(userDataDir, 'output');
  mkdirSync(recordingsDir, { recursive: true });
  mkdirSync(outputDir, { recursive: true });

  // The audio stem drives the summary path — name them to match so
  // process-streaming targets the placeholder we write.
  const wavPath = path.join(recordingsDir, 'instantstop.wav');
  makeWav(wavPath, { seconds: 4, amplitude: 0, channels: 2 });
  const summaryPath = path.join(outputDir, 'instantstop_summary.md');
  writeFileSync(summaryPath, placeholderNote(), 'utf-8');

  // 1. The parser surfaces the placeholder's processing flag.
  const listRes = await runBackend(['list-meetings'], userDataDir);
  expect(listRes.code, listRes.stderr).toBe(0);
  const meetings = JSON.parse(listRes.stdout);
  const placeholder = meetings.find(
    (m: { session_info: { summary_file: string } }) => m.session_info.summary_file === summaryPath,
  );
  expect(placeholder, 'placeholder note listed').toBeTruthy();
  expect(placeholder.session_info.processing).toBe(true);

  // The OLDER draft (what --notes points at); the placeholder's edited notes
  // must win over this.
  const live = path.join(userDataDir, 'live.txt');
  writeFileSync(live, LIVE_TRANSCRIPT, 'utf-8');
  const draft = path.join(outputDir, 'Instant Note_notes.txt');
  writeFileSync(draft, OLD_DRAFT_NOTES, 'utf-8');

  // 2 + 3. Run the background pass — it rewrites the note in place.
  killOllama();
  const ollama = await startMockOllama({ chatReply: FIXED_REPLY });
  try {
    const res = await runBackend(
      ['process-streaming', wavPath, '--name', 'Instant Note', '--live-transcript', live, '--notes', draft],
      userDataDir,
      { OLLAMA_HOST: `http://127.0.0.1:${ollama.port}` },
    );
    expect(res.code, `stderr:\n${res.stderr}`).toBe(0);

    // Normalise CRLF: Python's write_text emits \r\n on Windows note files, so
    // a multi-line ('\n') substring assertion would spuriously miss there.
    const md = readFileSync(summaryPath, 'utf8').replace(/\r\n/g, '\n');
    // The whole edit survived (incl. the '## Follow-ups' heading + its lines —
    // not truncated at the heading); the older draft did not.
    expect(md).toContain(EDITED_NOTES);
    expect(md).toContain('## Follow-ups');
    expect(md).toContain('- confirm the soak');
    expect(md).not.toContain(OLD_DRAFT_NOTES);
    // Summary landed, transcript upgraded to the batch/live text.
    expect(md).toContain('## Summary');
    expect(md).toContain('## Transcript');
    // processing flag cleared (a fresh rewrite never re-adds it).
    expect(md).not.toMatch(/^processing:/m);
  } finally {
    await ollama.close();
  }

  // Parser no longer reports processing.
  const listAfter = JSON.parse((await runBackend(['list-meetings'], userDataDir)).stdout);
  const done = listAfter.find(
    (m: { session_info: { summary_file: string } }) => m.session_info.summary_file === summaryPath,
  );
  expect(done.session_info.processing).toBeFalsy();

  expect(fileSig(realUserDataDir())).toBe(realDirBefore);
});
