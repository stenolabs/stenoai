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
 * T2 — instant transcript, backend contract. main.js hands process-streaming
 * the live transcript as a v1 JSON snapshot (speakers + timestamps, see
 * app/live-transcript-format.js) with --early-summary. The backend must:
 *
 * 1. summarise that live transcript and save the note (EARLY_SAVED) BEFORE
 *    the batch re-transcription runs (TRANSCRIPTION_COMPLETE), so notes are
 *    there seconds after Stop;
 * 2. feed the summariser the LABELLED live transcript ([You]/[Others]);
 * 3. finish with a normal note: no `refining` flag, the live labels kept.
 *
 * Model-free like live-transcript-fallback.t2: a silent stereo wav makes the
 * batch pass return the silence sentinel without loading an ASR model, so it
 * falls back to the live transcript — and, since the early summary already
 * covers exactly that text, the summariser must be called only ONCE. The
 * refine re-summary over a real batch transcript is covered by
 * tests/test_live_snapshot.py (mocked ASR), as it needs speech to transcribe.
 */

const BACKEND = path.resolve(
  __dirname,
  '..',
  '..',
  'dist',
  'stenoai',
  process.platform === 'win32' ? 'stenoai.exe' : 'stenoai',
);

const SNAPSHOT = JSON.stringify({
  format: 'stenoai-live-transcript/v1',
  segments: [
    { start: 1.2, end: 3, speaker: 'You', text: "Let's review the billing migration." },
    { start: 3.5, end: 5, speaker: 'You', text: 'Dana is driving it this sprint.' },
    { start: 6, end: 9.4, speaker: 'Others', text: 'We will cut the release on Friday if the soak is clean.' },
  ],
});

const FIXED_REPLY = [
  '## Summary',
  'Billing migration is underway; release Friday pending a clean soak.',
  '',
  '## Key Points',
  '- Dana drives the billing migration',
  '',
].join('\n');

type SpawnResult = { code: number | null; stdout: string; stderr: string };
function runBackend(args: string[], userDataDir: string): Promise<SpawnResult> {
  return new Promise((resolve, reject) => {
    const proc = spawn(BACKEND, args, {
      env: { ...process.env, STENOAI_USER_DATA_DIR: userDataDir },
    });
    let stdout = '';
    let stderr = '';
    proc.stdout.on('data', (d) => (stdout += d.toString()));
    proc.stderr.on('data', (d) => (stderr += d.toString()));
    proc.on('error', reject);
    proc.on('close', (code) => resolve({ code, stdout, stderr }));
  });
}

test('early summary is saved from the labelled live transcript before the batch pass', async ({
  userDataDir,
}) => {
  test.setTimeout(180_000);
  test.skip(!existsSync(BACKEND), 'backend bundle not built');

  const realDirBefore = fileSig(realUserDataDir());
  writeUserConfig(userDataDir, { ai_provider: 'local', auto_summarize_enabled: true });

  const recordingsDir = path.join(userDataDir, 'recordings');
  mkdirSync(recordingsDir, { recursive: true });
  const wavPath = path.join(recordingsDir, 'instanttranscript.wav');
  makeWav(wavPath, { seconds: 4, amplitude: 0, channels: 2 });
  const live = path.join(userDataDir, 'live.txt');
  writeFileSync(live, SNAPSHOT, 'utf-8');

  killOllama();
  const ollama = await startMockOllama({ chatReply: FIXED_REPLY });
  try {
    const res = await runBackend(
      ['process-streaming', wavPath, '--name', 'Instant Note', '--live-transcript', live, '--early-summary'],
      userDataDir,
    );
    expect(res.code, `stderr:\n${res.stderr}`).toBe(0);

    const summaryPath = path.join(userDataDir, 'output', 'instanttranscript_summary.md');
    const out = res.stdout.replace(/\r\n/g, '\n');
    // 1. The early note lands before the batch pass even reports.
    const early = out.indexOf(`EARLY_SAVED:${summaryPath}`);
    const batch = out.indexOf('TRANSCRIPTION_COMPLETE:');
    expect(early, out).toBeGreaterThanOrEqual(0);
    expect(batch, out).toBeGreaterThan(early);
    // Streamed for the note's StreamingView, then the final save.
    expect(out.slice(0, early)).toContain('CHUNK:');
    expect(out).toMatch(/^SAVED:/m);

    // 2. One summary call, over the speaker-labelled live transcript (the
    //    summariser drops timestamps from its prompt, as for a batch note).
    // Counted by content, not chatCalls(): on a shared machine a stray process
    // from another spec can reach the mock's port mid-run.
    const prompts = ollama
      .chatRequests()
      .map((body) => {
        const msgs = Array.isArray((body as { messages?: unknown }).messages)
          ? ((body as { messages: { content?: unknown }[] }).messages)
          : [];
        return msgs.map((m) => String(m.content ?? '')).join('\n');
      })
      .filter((p) => p.includes('billing migration'));
    expect(prompts.length, prompts.join('\n---\n')).toBe(1);
    const prompt = prompts[0];
    expect(prompt).toContain("[You] Let's review the billing migration. Dana is driving it this sprint.");
    expect(prompt).toContain('[Others] We will cut the release on Friday');

    // 3. A normal finished note, live labels kept.
    const md = readFileSync(summaryPath, 'utf8').replace(/\r\n/g, '\n');
    const frontmatter = md.split('---')[1];
    expect(frontmatter).not.toMatch(/^refining:/m);
    expect(frontmatter).toMatch(/^is_diarised: true$/m);
    expect(frontmatter).toMatch(/^is_live_transcript: true$/m);
    expect(md).toContain('Billing migration is underway');
    expect(md).toContain('[00:06] [Others] We will cut the release on Friday if the soak is clean.');
  } finally {
    await ollama.close();
    killOllama();
  }

  // The parser surfaces neither processing nor refining on the finished note.
  const list = JSON.parse((await runBackend(['list-meetings'], userDataDir)).stdout);
  const note = list.find((m: { session_info: { summary_file: string } }) =>
    m.session_info.summary_file.endsWith('instanttranscript_summary.md'),
  );
  expect(note.session_info.refining).toBeFalsy();
  expect(note.session_info.processing).toBeFalsy();
  expect(note.is_diarised).toBe(true);

  expect(fileSig(realUserDataDir())).toBe(realDirBefore);
});
