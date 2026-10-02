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
 * T2 — auto-summarize toggle (#258). Proves the "transcript-first" contract:
 * with `auto_summarize_enabled=false`, a recording stops at a transcript-only
 * note (frontmatter `notes_generated: false`, a `## Transcript` section, NO
 * `## Summary`) and makes ZERO Ollama calls; then the real app's "Generate
 * notes" CTA drives reprocess, which adds the summary and clears the flag with
 * exactly ONE Ollama call.
 *
 * Model-free by construction (mirrors live-transcript-fallback.t2): a silent
 * STEREO wav fails the RMS energy gate on both channels, so batch transcription
 * returns the silence sentinel WITHOUT loading an ASR model, and --live-transcript
 * rescues it into a real transcript. Summarisation (phase 2 only) goes to the
 * mock Ollama. So this runs in the fast model-free t2 lanes (macOS + Windows).
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
  'Welcome everyone to the weekly sync. We shipped the new onboarding flow on Tuesday. ' +
  'The remaining blocker is the billing migration, which Dana is driving. ' +
  'We agreed to cut the release on Friday if the staging soak is clean.';

// Fixed assistant reply the parser keys on (## Summary / ## Key Points).
const FIXED_REPLY = [
  '## Summary',
  'The team shipped onboarding and plans a Friday release pending a clean soak.',
  '',
  '## Key Points',
  '- Onboarding flow shipped Tuesday',
  '- Billing migration is the remaining blocker',
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

test('auto-summarize off writes a transcript-only note with no LLM call; the Generate-notes CTA reprocesses it', async ({
  launchApp,
  userDataDir,
}) => {
  test.setTimeout(180_000);
  if (!existsSync(BACKEND)) {
    // eslint-disable-next-line no-console
    console.warn(`[t2] SKIPPED auto-summarize: backend bundle missing at ${BACKEND}`);
    test.info().annotations.push({ type: 'skip-reason', description: 'backend bundle not built' });
  }
  test.skip(!existsSync(BACKEND), 'backend bundle not built');

  const realDirBefore = fileSig(realUserDataDir());

  // Local provider (summariser talks to mock Ollama on 11434) + toggle OFF.
  // This test starts after onboarding. A partial existing config without this
  // marker triggers the upgrade privacy notice and blocks the Generate button.
  writeUserConfig(userDataDir, {
    ai_provider: 'local', auto_summarize_enabled: false, privacy_notice_seen: true,
  });

  // Silent STEREO wav -> both channels skip the RMS gate -> batch transcription
  // returns the silence sentinel with no model loaded; --live-transcript rescues
  // it into a real transcript.
  const recordingsDir = path.join(userDataDir, 'recordings');
  mkdirSync(recordingsDir, { recursive: true });
  const wavPath = path.join(recordingsDir, 'notesoff.wav');
  makeWav(wavPath, { seconds: 4, amplitude: 0, channels: 2 });

  const liveFile = path.join(userDataDir, 'live-transcript.txt');
  writeFileSync(liveFile, LIVE_TRANSCRIPT, 'utf-8');

  const summaryPath = path.join(userDataDir, 'output', 'notesoff_summary.md');

  killOllama();
  const ollama = await startMockOllama({ chatReply: FIXED_REPLY });
  try {
    // Phase 1 — backend, toggle OFF: transcript-only note, zero LLM calls.
    const res = await runBackend(
      ['process-streaming', wavPath, '--name', 'Notes Off Meeting', '--live-transcript', liveFile],
      userDataDir,
    );
    expect(res.code, `backend stderr:\n${res.stderr}`).toBe(0);
    expect(res.stdout).toContain('SUMMARY_SKIPPED');

    expect(existsSync(summaryPath), `no summary at ${summaryPath}\n${res.stdout}`).toBe(true);
    let summaryMd = readFileSync(summaryPath, 'utf8');
    expect(summaryMd).toMatch(/notes_generated:\s*false/i);
    expect(summaryMd).toContain('## Transcript');
    expect(summaryMd).toContain('billing migration');
    expect(summaryMd).not.toContain('## Summary');

    // The gate must run before any Ollama call — nothing hit /api/chat.
    expect(ollama.chatCalls()).toBe(0);

    // Phase 2 — real app: open the note, click "Generate notes", reprocess it.
    const { page } = await launchApp();
    await expect(page.locator('html')).toHaveAttribute('data-privacy-gate', 'true');
    const meetingHash = `/meetings/${encodeURIComponent(summaryPath)}`;

    // Navigate straight to the note detail. Re-set the hash each poll so a
    // one-shot first-run setup-gate redirect (fires only on neutral routes when
    // no ASR model is installed — the model-free CI lane) can't strand us: the
    // gate is one-shot, so re-navigating converges deterministically.
    await expect
      .poll(
        async () => {
          await page.evaluate((h) => {
            window.location.hash = h;
          }, meetingHash);
          return page.getByTestId('generate-notes-dock-button').isVisible();
        },
        { timeout: 20_000, intervals: [250] },
      )
      .toBe(true);

    await page.getByTestId('generate-notes-dock-button').click();

    // Reprocess rewrites the note with a summary and drops notes_generated.
    await expect
      .poll(() => readFileSync(summaryPath, 'utf8').includes('## Summary'), {
        timeout: 60_000,
        intervals: [500],
      })
      .toBe(true);

    summaryMd = readFileSync(summaryPath, 'utf8');
    expect(summaryMd).not.toMatch(/notes_generated:\s*false/i);
    expect(ollama.chatCalls()).toBe(1);

    // The UI must actually reflect the new state, not just the on-disk file — a
    // stale query would leave the old "No notes yet" CTA showing even though the
    // note now has a summary.
    await expect(page.getByTestId('no-notes-yet')).toHaveCount(0);
    await expect(page.getByTestId('tab-summary-content')).toBeVisible();

    // Keystone: the real user-data dir is byte-for-byte untouched.
    expect(fileSig(realUserDataDir())).toBe(realDirBefore);
  } finally {
    await ollama.close();
    killOllama();
  }
});

test('auto-summarize off also skips title generation and the default-template report (not just the main summary)', async ({
  userDataDir,
}) => {
  test.setTimeout(120_000);
  if (!existsSync(BACKEND)) {
    test.skip(true, 'backend bundle not built');
  }

  // default_template_id != 'standard' makes generate_default_template_report
  // attempt a SECOND /api/chat call after the main summary; 'shareable-summary'
  // is the pre-seeded builtin sample template, so no template setup is needed.
  // 'Meeting' matches _AUTO_NAMED_PATTERN, so title generation would also fire a
  // /api/chat call if the auto-summarize gate didn't return before reaching it.
  // A regression that gates only the main summary call (but leaves title-gen or
  // the default-template report unconditional) would show up here as
  // chatCalls() > 0 or a reports sidecar appearing, even though the earlier test
  // (which uses the 'standard' default template and an explicit name) would
  // still pass.
  writeUserConfig(userDataDir, {
    ai_provider: 'local',
    auto_summarize_enabled: false,
    default_template_id: 'shareable-summary',
  });

  const recordingsDir = path.join(userDataDir, 'recordings');
  mkdirSync(recordingsDir, { recursive: true });
  const wavPath = path.join(recordingsDir, 'notesofftemplate.wav');
  makeWav(wavPath, { seconds: 4, amplitude: 0, channels: 2 });

  const liveFile = path.join(userDataDir, 'live-transcript.txt');
  writeFileSync(liveFile, LIVE_TRANSCRIPT, 'utf-8');

  const summaryPath = path.join(userDataDir, 'output', 'notesofftemplate_summary.md');
  const sidecarPath = path.join(userDataDir, 'output', 'notesofftemplate_reports.json');

  killOllama();
  const ollama = await startMockOllama({ chatReply: FIXED_REPLY });
  try {
    const res = await runBackend(
      ['process-streaming', wavPath, '--name', 'Meeting', '--live-transcript', liveFile],
      userDataDir,
    );
    expect(res.code, `backend stderr:\n${res.stderr}`).toBe(0);
    expect(res.stdout).toContain('SUMMARY_SKIPPED');
    expect(res.stdout).not.toContain('TITLE:');

    expect(existsSync(summaryPath)).toBe(true);
    const summaryMd = readFileSync(summaryPath, 'utf8');
    expect(summaryMd).toMatch(/notes_generated:\s*false/i);
    expect(summaryMd).not.toContain('## Summary');

    // No default-template report was generated into the sidecar.
    expect(existsSync(sidecarPath)).toBe(false);

    // Zero Ollama calls total: main summary, title generation, AND the
    // default-template report are all skipped by the same gate.
    expect(ollama.chatCalls()).toBe(0);
  } finally {
    await ollama.close();
    killOllama();
  }
});
