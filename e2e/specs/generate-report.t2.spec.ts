import { test, expect } from '../fixtures/electron';
import { realUserDataDir, fileSig } from '../fixtures/real-user-data';
import { writeUserConfig, writeMeetingSummary } from '../fixtures/user-config';
import { startMockOllama } from '../fixtures/mock-ollama';
import { readFileSync, existsSync } from 'fs';
import path from 'path';

/**
 * T2 — generate-report persists into reports[] and sets active_report. Drives
 * the real `generate-report` path (NO ASR, NO real model) with a capturing mock
 * Ollama and asserts the two sides of the generate-report contract:
 *   1. The markdown returned by the mock LLM is stored verbatim in
 *      `reports[0].content` in the sidecar `<stem>_reports.json`.
 *   2. `active_report` is set to `reports[0].id` and `reports[0].template_id`
 *      matches the template used.
 *
 * Model-free: the transcript is pre-seeded and the LLM is the mock, so no model
 * loads. The isolation keystone (STENOAI_USER_DATA_DIR) prevents any write to the
 * real ~/Library/Application Support/stenoai.
 */

const TRANSCRIPT =
  'Alice: Q2 sales are up 15 percent. Bob: we need to hire two engineers.';

// A fixed assistant reply: free-form markdown (no required section headers —
// generate-report stores the content verbatim, no parse into sub-fields).
const REPORT_REPLY = '## Status\n- did the thing\n- Q2 up 15%\n\n## Hires\n- 2 engineers needed';

type GenerateReportResult = { success: boolean; error?: string };
type StenoWindow = Window & {
  stenoai: {
    meetings: {
      generateReport: (summaryFile: string, templateId: string) => Promise<GenerateReportResult>;
    };
    templates: {
      save: (template: Record<string, unknown>) => Promise<{ success: boolean; template?: { id: string } }>;
      list: () => Promise<{ success: boolean; templates?: Array<{ id: string }> }>;
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
  const base = path.basename(summaryFile, '.json'); // e.g. 'report-gen_summary'
  const stem = base.endsWith('_summary') ? base.slice(0, -'_summary'.length) : base;
  return path.join(dir, `${stem}_reports.json`);
};

test('generate-report appends to reports[] and sets active_report in the sidecar', async ({
  launchApp,
  userDataDir,
}) => {
  const realDirBefore = fileSig(realUserDataDir());

  // Local provider so the summarizer talks to the mock Ollama on 11434.
  writeUserConfig(userDataDir, { ai_provider: 'local' });
  const summaryFile = writeMeetingSummary(userDataDir, 'report-gen', {
    name: 'Report Gen Meeting',
    summary: 'Existing summary',
    transcript: TRANSCRIPT,
  });
  const sidecarPath = sidecarFor(summaryFile);

  const ollama = await startMockOllama({ chatReply: REPORT_REPLY });
  try {
    const { page } = await launchApp({
      env: { OLLAMA_HOST: `http://127.0.0.1:${ollama.port}` },
    });
    // Create a custom template via the bridge and read back its generated id.
    const saveRes = await page.evaluate(
      () =>
        (window as StenoWindow).stenoai.templates.save({
          name: 'Test Status Template',
          prompt: 'Write a concise status report covering key outcomes and next steps.',
          language: 'auto',
        }),
    );
    expect(saveRes.success).toBe(true);
    const templateId = saveRes.template?.id;
    expect(templateId).toBeTruthy();

    // Drive generate-report and wait for summaryComplete.
    const completed: boolean = await page.evaluate(
      ([f, tid]) =>
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
          w.stenoai.meetings.generateReport(f, tid);
        }),
      [summaryFile, templateId] as [string, string],
    );

    expect(completed).toBe(true);

    // Wait for the sidecar to be written (STREAM_COMPLETE fires before atomic write).
    await expect
      .poll(() => readSidecar(sidecarPath).reports.length, { timeout: 15_000 })
      .toBe(1);

    // Assert the sidecar on disk: reports[] appended, content verbatim, active_report set.
    const sidecar = readSidecar(sidecarPath);
    expect(sidecar.reports).toHaveLength(1);
    expect(sidecar.reports[0].content).toContain('did the thing');
    expect(sidecar.reports[0].content).toContain('Q2 up 15%');
    expect(sidecar.reports[0].template_id).toBe(templateId);
    expect(sidecar.active_report).toBe(sidecar.reports[0].id);

    // Keystone: the real user-data dir is byte-for-byte untouched.
    expect(fileSig(realUserDataDir())).toBe(realDirBefore);
  } finally {
    await ollama.close();
  }
});

test('generate-report with an unknown template surfaces failure and persists no report', async ({
  launchApp,
  userDataDir,
}) => {
  const realDirBefore = fileSig(realUserDataDir());

  writeUserConfig(userDataDir, { ai_provider: 'local' });
  const summaryFile = writeMeetingSummary(userDataDir, 'report-gen-fail', {
    name: 'Report Gen Fail Meeting',
    summary: 'Existing summary',
    transcript: TRANSCRIPT,
  });
  const sidecarPath = sidecarFor(summaryFile);

  // Mock Ollama is started but should never be reached — the unknown-template
  // guard fails before any model call.
  const ollama = await startMockOllama({ chatReply: REPORT_REPLY });
  try {
    const { page } = await launchApp({
      env: { OLLAMA_HOST: `http://127.0.0.1:${ollama.port}` },
    });
    // Drive generate-report with a template id that does not exist and wait for
    // the completion event. It must arrive with success:false (mirroring the
    // first spec's summaryComplete listener), not silently succeed.
    const result: { completed: boolean; success: boolean } = await page.evaluate(
      ([f]) =>
        new Promise<{ completed: boolean; success: boolean }>((resolve) => {
          const timer = setTimeout(() => resolve({ completed: false, success: false }), 30_000);
          const w = window as unknown as StenoWindow;
          const off = w.stenoai.on.summaryComplete((e) => {
            clearTimeout(timer);
            off();
            resolve({ completed: true, success: !!(e && e.success) });
          });
          w.stenoai.meetings.generateReport(f, 'does-not-exist');
        }),
      [summaryFile] as [string],
    );

    // The completion event arrived and reported failure (not silent success).
    expect(result.completed).toBe(true);
    expect(result.success).toBe(false);

    // No report was persisted to the sidecar (sidecar absent or empty).
    const sidecar = readSidecar(sidecarPath);
    expect(sidecar.reports).toHaveLength(0);
    expect(sidecar.active_report).toBeNull();

    // Keystone: the real user-data dir is byte-for-byte untouched.
    expect(fileSig(realUserDataDir())).toBe(realDirBefore);
  } finally {
    await ollama.close();
  }
});
