import { test, expect } from '../fixtures/electron';
import { realUserDataDir, fileSig } from '../fixtures/real-user-data';
import { writeUserConfig, writeMeetingSummary } from '../fixtures/user-config';
import { startMockOllama } from '../fixtures/mock-ollama';
import { readFileSync, existsSync } from 'fs';
import path from 'path';

/**
 * T2 — report-versions round-trip. Drives `reprocess` (NO ASR, NO real model)
 * with a capturing mock Ollama and asserts the full versions contract:
 *   1. reprocess snapshots the prior Standard note into the sidecar (`<stem>_reports.json`)
 *      as a backup (template_id 'standard-backup', non-empty content) and writes the new
 *      mock LLM output as the live summary in the meeting JSON.
 *   2. setActiveReport(backupId) → active_report === backupId in the sidecar.
 *   3. setActiveReport('standard') → active_report === null in the sidecar.
 *   4. deleteReport(backupId) → reports[] is empty in the sidecar.
 *
 * Model-free: the transcript is pre-seeded and the LLM is the mock.
 * The isolation keystone (STENOAI_USER_DATA_DIR) prevents writes to the real
 * ~/Library/Application Support/stenoai.
 */

const TRANSCRIPT =
  'Alice: Q2 sales are up 15 percent. Bob: we need to hire two engineers.';

// Pre-existing summary that will become the backup content.
const SEEDED_SUMMARY = 'Old Q2 summary that will be snapshotted as backup.';

// Mock LLM reply in the format _parse_streamed_markdown keys on.
const REPROCESS_REPLY = [
  '## Summary',
  'new summary',
  '',
  '## Key Points',
  '- kp',
  '',
].join('\n');

type ReprocessResult = { success: boolean; error?: string };
type SetActiveResult = { success: boolean; error?: string };
type DeleteResult = { success: boolean; error?: string };
type StenoWindow = Window & {
  stenoai: {
    meetings: {
      reprocess: (summaryFile: string, regenTitle: boolean, name: string) => Promise<ReprocessResult>;
      setActiveReport: (summaryFile: string, reportId: string) => Promise<SetActiveResult>;
      deleteReport: (summaryFile: string, reportId: string) => Promise<DeleteResult>;
    };
    on: {
      summaryComplete: (cb: (e: { success: boolean }) => void) => () => void;
    };
  };
};

const readSummary = (file: string) => JSON.parse(readFileSync(file, 'utf8'));

type Report = { id: string; template_id: string; content: string };

const readSidecar = (sidecarPath: string): { reports: Report[]; active_report: string | null } => {
  if (!existsSync(sidecarPath)) return { reports: [], active_report: null };
  return JSON.parse(readFileSync(sidecarPath, 'utf8'));
};

/** Derive the sidecar path from a `*_summary.json` path. */
const sidecarFor = (summaryFile: string): string => {
  const dir = path.dirname(summaryFile);
  const base = path.basename(summaryFile, '.json'); // e.g. 'report-versions_summary'
  const stem = base.endsWith('_summary') ? base.slice(0, -'_summary'.length) : base;
  return path.join(dir, `${stem}_reports.json`);
};

test('reprocess backup + set-active + delete round-trip', async ({
  launchApp,
  userDataDir,
}) => {
  const realDirBefore = fileSig(realUserDataDir());

  // Local provider so the summarizer talks to mock Ollama on 11434.
  writeUserConfig(userDataDir, { ai_provider: 'local' });
  const summaryFile = writeMeetingSummary(userDataDir, 'report-versions', {
    name: 'Report Versions Meeting',
    summary: SEEDED_SUMMARY,
    transcript: TRANSCRIPT,
  });
  const sidecarPath = sidecarFor(summaryFile);

  const ollama = await startMockOllama({ chatReply: REPROCESS_REPLY });
  try {
    const { page } = await launchApp({
      env: { OLLAMA_HOST: `http://127.0.0.1:${ollama.port}` },
    });
    // --- Step 1: reprocess and wait for summaryComplete ---
    const completed: boolean = await page.evaluate(
      ([f, name]) =>
        new Promise<boolean>((resolve) => {
          const timer = setTimeout(() => resolve(false), 30_000);
          const w = window as unknown as StenoWindow;
          const off = w.stenoai.on.summaryComplete((e) => {
            if (e && e.success) {
              clearTimeout(timer);
              off();
              resolve(true);
            }
          });
          w.stenoai.meetings.reprocess(f, false, name);
        }),
      [summaryFile, 'Report Versions Meeting'] as [string, string],
    );

    expect(completed).toBe(true);

    // Poll until the meeting JSON reflects the new live summary (written after STREAM_COMPLETE).
    await expect
      .poll(() => readSummary(summaryFile).summary, { timeout: 15_000 })
      .toBe('new summary');

    // Assert backup in the sidecar: exactly one entry with template_id 'standard-backup'
    // and non-empty content (the pre-existing summary was captured as markdown).
    await expect
      .poll(() => readSidecar(sidecarPath).reports.length, { timeout: 10_000 })
      .toBe(1);

    const sidecarAfterReprocess = readSidecar(sidecarPath);
    expect(sidecarAfterReprocess.reports).toHaveLength(1);
    const backup = sidecarAfterReprocess.reports[0];
    expect(backup.template_id).toBe('standard-backup');
    expect(backup.content.trim()).not.toBe('');
    // The backup content is derived from the seeded summary.
    expect(backup.content).toContain('Old Q2 summary');

    // active_report is null after reprocess (live Standard note is the default view).
    expect(sidecarAfterReprocess.active_report ?? null).toBeNull();

    const backupId = backup.id as string;
    expect(backupId).toBeTruthy();

    // --- Step 2: setActiveReport to the backup ---
    const setRes = await page.evaluate(
      ([f, id]) => (window as unknown as StenoWindow).stenoai.meetings.setActiveReport(f, id),
      [summaryFile, backupId] as [string, string],
    );
    expect(setRes.success).toBe(true);

    // Poll until active_report is the backup id in the sidecar.
    await expect
      .poll(() => readSidecar(sidecarPath).active_report, { timeout: 10_000 })
      .toBe(backupId);

    // --- Step 3: setActiveReport back to 'standard' ---
    const clearRes = await page.evaluate(
      ([f]) => (window as unknown as StenoWindow).stenoai.meetings.setActiveReport(f, 'standard'),
      [summaryFile] as [string],
    );
    expect(clearRes.success).toBe(true);

    // Poll until active_report is null in the sidecar.
    await expect
      .poll(() => readSidecar(sidecarPath).active_report ?? null, { timeout: 10_000 })
      .toBeNull();

    // --- Step 4: deleteReport ---
    const delRes = await page.evaluate(
      ([f, id]) => (window as unknown as StenoWindow).stenoai.meetings.deleteReport(f, id),
      [summaryFile, backupId] as [string, string],
    );
    expect(delRes.success).toBe(true);

    // Poll until reports[] is empty in the sidecar.
    await expect
      .poll(() => readSidecar(sidecarPath).reports.length, { timeout: 10_000 })
      .toBe(0);

    // Keystone: the real user-data dir is byte-for-byte untouched.
    expect(fileSig(realUserDataDir())).toBe(realDirBefore);
  } finally {
    await ollama.close();
  }
});
