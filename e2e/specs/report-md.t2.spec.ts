import { test, expect } from '../fixtures/electron';
import { realUserDataDir, fileSig } from '../fixtures/real-user-data';
import { writeUserConfig, writeMeetingMarkdown } from '../fixtures/user-config';
import { startMockOllama } from '../fixtures/mock-ollama';
import { readFileSync, existsSync } from 'fs';
import path from 'path';

/**
 * T2 — generate-report on a REAL `.md` meeting writes a sidecar (`_reports.json`)
 * and get-meeting merges it back. This is the bug class the `.json`-seeded spec
 * missed: the old path stored reports in the meeting JSON itself; the new path
 * uses a `<stem>_reports.json` sidecar alongside the `.md` file.
 *
 * Test contract:
 *  1. `generateReport(mdFile, templateId)` writes `<stem>_reports.json` next to
 *     the `.md` file (NOT inline in the `.md`).
 *  2. `get-meeting(mdFile)` returns `reports` (length 1) and `active_report`
 *     from the sidecar.
 *  3. `setActiveReport` + `deleteReport` each mutate only the sidecar.
 *
 * Model-free: mock-ollama replies with a fixed string; no ASR.
 */

const TRANSCRIPT =
  'Alice: Q2 pipeline looks strong. Bob: we should hire three engineers by Q3.';

const SUMMARY_MARKDOWN =
  '## Summary\n\nQ2 pipeline reviewed. Hiring plans discussed.\n\n## Key Points\n\n- Pipeline strong\n- 3 hires planned';

const REPORT_REPLY =
  '## Status Report\n- Pipeline healthy\n- 3 engineers needed by Q3\n\n## Next Steps\n- Open reqs ASAP';

type GenerateReportResult = { success: boolean; error?: string };
type Report = { id: string; template_id: string; content: string };
type Meeting = {
  reports?: Report[];
  active_report?: string | null;
};
type StenoWindow = Window & {
  stenoai: {
    meetings: {
      generateReport: (summaryFile: string, templateId: string) => Promise<GenerateReportResult>;
      get: (summaryFile: string) => Promise<{ success: boolean; meeting?: Meeting }>;
      setActiveReport: (summaryFile: string, reportId: string) => Promise<{ success: boolean }>;
      deleteReport: (summaryFile: string, reportId: string) => Promise<{ success: boolean }>;
      reprocess: (summaryFile: string, regenTitle: boolean, name: string) => Promise<{ success: boolean; error?: string }>;
    };
    templates: {
      save: (template: Record<string, unknown>) => Promise<{ success: boolean; template?: { id: string } }>;
      list: () => Promise<{ success: boolean; templates?: Array<{ id: string; name: string }> }>;
    };
    on: {
      summaryComplete: (cb: (e: { success: boolean }) => void) => () => void;
    };
  };
};

const readSidecar = (sidecarPath: string): { reports: Report[]; active_report: string | null } => {
  if (!existsSync(sidecarPath)) return { reports: [], active_report: null };
  return JSON.parse(readFileSync(sidecarPath, 'utf8'));
};

/** Derive the sidecar path from a `*_summary.md` path. */
const sidecarFor = (summaryFile: string): string => {
  const dir = path.dirname(summaryFile);
  const base = path.basename(summaryFile, '.md'); // e.g. 'meeting_summary'
  const stem = base.endsWith('_summary') ? base.slice(0, -'_summary'.length) : base;
  return path.join(dir, `${stem}_reports.json`);
};

test('generate-report on a .md meeting writes the sidecar and get-meeting merges it', async ({
  launchApp,
  userDataDir,
}) => {
  const realDirBefore = fileSig(realUserDataDir());

  writeUserConfig(userDataDir, { ai_provider: 'local' });
  const summaryFile = writeMeetingMarkdown(userDataDir, 'md-report-gen', {
    name: 'MD Report Gen Meeting',
    summaryMarkdown: SUMMARY_MARKDOWN,
    transcript: TRANSCRIPT,
  });
  const sidecarPath = sidecarFor(summaryFile);

  const ollama = await startMockOllama({ chatReply: REPORT_REPLY });
  try {
    const { page } = await launchApp({
      env: { OLLAMA_HOST: `http://127.0.0.1:${ollama.port}` },
    });
    // Create a template so we have a valid templateId.
    const saveRes = await page.evaluate(
      () =>
        (window as StenoWindow).stenoai.templates.save({
          name: 'MD Status Template',
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

    // Wait for the sidecar to appear on disk (STREAM_COMPLETE fires before atomic write).
    await expect
      .poll(() => readSidecar(sidecarPath).reports.length, { timeout: 15_000 })
      .toBe(1);

    // ── Assertion 1: sidecar on disk is correct ────────────────────────────
    const sidecar = readSidecar(sidecarPath);
    expect(sidecar.reports).toHaveLength(1);
    expect(sidecar.reports[0].content).toContain('Pipeline healthy');
    expect(sidecar.reports[0].content).toContain('3 engineers needed');
    expect(sidecar.reports[0].template_id).toBe(templateId);
    expect(sidecar.active_report).toBe(sidecar.reports[0].id);
    const reportId = sidecar.reports[0].id;

    // ── Assertion 2: the .md file itself is NOT modified ──────────────────
    const mdContent = readFileSync(summaryFile, 'utf8');
    expect(mdContent).not.toContain('reports');
    expect(mdContent).not.toContain(reportId);

    // ── Assertion 3: get-meeting merges the sidecar ───────────────────────
    const getRes = await page.evaluate(
      ([f]) => (window as unknown as StenoWindow).stenoai.meetings.get(f),
      [summaryFile] as [string],
    );
    expect(getRes.success).toBe(true);
    expect(getRes.meeting?.reports).toHaveLength(1);
    expect(getRes.meeting?.reports?.[0].content).toContain('Pipeline healthy');
    expect(getRes.meeting?.active_report).toBe(reportId);

    // ── Assertion 4: setActiveReport mutates the sidecar ─────────────────
    // 'standard' is not a real id in this meeting; calling set-active-report
    // with a non-existent id should fail gracefully (the backend returns
    // success:false). We instead call with the real reportId to prove a round-
    // trip that leaves the sidecar consistent, then verify.
    const setRes = await page.evaluate(
      ([f, rid]) => (window as unknown as StenoWindow).stenoai.meetings.setActiveReport(f, rid),
      [summaryFile, reportId] as [string, string],
    );
    expect(setRes.success).toBe(true);

    await expect
      .poll(() => readSidecar(sidecarPath).active_report, { timeout: 5_000 })
      .toBe(reportId);

    // ── Assertion 5: deleteReport removes the report from the sidecar ─────
    const delRes = await page.evaluate(
      ([f, rid]) => (window as unknown as StenoWindow).stenoai.meetings.deleteReport(f, rid),
      [summaryFile, reportId] as [string, string],
    );
    expect(delRes.success).toBe(true);

    await expect
      .poll(() => readSidecar(sidecarPath).reports.length, { timeout: 5_000 })
      .toBe(0);

    const afterDelete = readSidecar(sidecarPath);
    expect(afterDelete.reports).toHaveLength(0);
    expect(afterDelete.active_report).toBeNull();

    // ── Final: get-meeting reflects the deletion ──────────────────────────
    const getAfterDelete = await page.evaluate(
      ([f]) => (window as unknown as StenoWindow).stenoai.meetings.get(f),
      [summaryFile] as [string],
    );
    expect(getAfterDelete.success).toBe(true);
    expect(getAfterDelete.meeting?.reports ?? []).toHaveLength(0);
    expect(getAfterDelete.meeting?.active_report ?? null).toBeNull();

    // Keystone: the real user-data dir is byte-for-byte untouched.
    expect(fileSig(realUserDataDir())).toBe(realDirBefore);
  } finally {
    await ollama.close();
  }
});

/**
 * Fix 1 (#249) — reprocessing a REAL `.md` meeting must snapshot the prior
 * Standard note into the sidecar as a `standard-backup`. Before the fix the
 * snapshot lived only in the `.json` branch, so a `.md` reprocess silently lost
 * the previous summary. Model-free: mock-ollama returns a new summary markdown.
 */

// Mock LLM reply that becomes the new live `.md` summary on reprocess.
const MD_REPROCESS_REPLY = [
  '## Summary',
  'Regenerated Q2 summary.',
  '',
  '## Key Points',
  '- Reprocessed',
].join('\n');

test('reprocessing a .md meeting backs up the prior Standard note into the sidecar', async ({
  launchApp,
  userDataDir,
}) => {
  const realDirBefore = fileSig(realUserDataDir());

  writeUserConfig(userDataDir, { ai_provider: 'local' });
  const summaryFile = writeMeetingMarkdown(userDataDir, 'md-reprocess-backup', {
    name: 'MD Reprocess Backup Meeting',
    summaryMarkdown: SUMMARY_MARKDOWN,
    transcript: TRANSCRIPT,
  });
  const sidecarPath = sidecarFor(summaryFile);

  const ollama = await startMockOllama({ chatReply: MD_REPROCESS_REPLY });
  try {
    const { page } = await launchApp({
      env: { OLLAMA_HOST: `http://127.0.0.1:${ollama.port}` },
    });
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
      [summaryFile, 'MD Reprocess Backup Meeting'] as [string, string],
    );
    expect(completed).toBe(true);

    // The `.md` file is rewritten with the new summary.
    await expect
      .poll(() => readFileSync(summaryFile, 'utf8').includes('Regenerated Q2 summary.'), {
        timeout: 15_000,
      })
      .toBe(true);

    // A standard-backup of the PRIOR note now lands in the sidecar.
    await expect
      .poll(() => readSidecar(sidecarPath).reports.length, { timeout: 15_000 })
      .toBe(1);

    const sidecar = readSidecar(sidecarPath);
    const backup = sidecar.reports[0];
    expect(backup.template_id).toBe('standard-backup');
    // The backup captured the prior summary markdown, not the new one.
    expect(backup.content).toContain('Pipeline strong');
    expect(backup.content).not.toContain('Regenerated Q2 summary.');
    // active_report stays null so the live (regenerated) note is the default view.
    expect(sidecar.active_report ?? null).toBeNull();

    // Keystone: the real user-data dir is byte-for-byte untouched.
    expect(fileSig(realUserDataDir())).toBe(realDirBefore);
  } finally {
    await ollama.close();
  }
});
