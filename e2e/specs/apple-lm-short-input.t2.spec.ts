import { readFileSync, writeFileSync } from 'fs';
import path from 'path';
import { test, expect } from '../fixtures/electron';
import { readUserConfig, writeMeetingSummary, writeUserConfig } from '../fixtures/user-config';

type StenoWindow = Window & {
  stenoai: {
    models: { getCurrent: () => Promise<{ success: boolean; model?: string }> };
    meetings: {
      generateReport: (file: string, templateId: string) => Promise<{
        success: boolean;
        error?: string;
      }>;
      reprocess: (file: string, regenTitle: boolean, name: string) => Promise<{
        success: boolean;
        error?: string;
      }>;
    };
  };
};

// Real bundled backend, status-only Apple fixture. Generation must never run:
// this test needs no Apple model, network, Ollama or production user data.
for (const oversized of ['transcript', 'notes', 'template'] as const) {
  test(`Apple rejects oversized ${oversized} and preserves the meeting and selection`, async ({
    launchApp,
    userDataDir,
  }) => {
    test.skip(process.platform !== 'darwin', 'Apple Intelligence is macOS-only');
    writeUserConfig(userDataDir, {
      ai_provider: 'local',
      model: 'apple:system',
      summary_model_source: 'user',
      language: 'en',
      custom_templates: [{
        id: 'apple-limit-template',
        name: 'Synthetic limit template',
        prompt: 'T'.repeat(2001),
        format: 'markdown',
        language: 'en',
      }],
    });
    const file = writeMeetingSummary(userDataDir, 'apple-limit', {
      name: 'Synthetic guard test',
      summary: 'Existing summary must survive.',
      transcript: oversized === 'transcript' ? 'A'.repeat(2001) : 'The project is MAPLE.',
    });
    if (oversized === 'notes') {
      const meeting = JSON.parse(readFileSync(file, 'utf8'));
      meeting.user_notes = 'N'.repeat(5000);
      writeFileSync(file, JSON.stringify(meeting));
    }
    const reportFile = path.join(userDataDir, 'output', 'apple-limit_reports.json');
    writeFileSync(reportFile, JSON.stringify({ reports: [], active_report: 'standard' }));
    const before = readFileSync(file, 'utf8');
    const reportBefore = readFileSync(reportFile, 'utf8');
    const { page } = await launchApp({
      env: {
        STENOAI_DISABLE_APPLE_LM: '0',
        STENOAI_ENABLE_EXPERIMENTAL_APPLE_LM: '1',
        STENOAI_APPLE_LM_STATE_FILE: path.join(userDataDir, 'unavailable-marker'),
      },
    });
    // Finish the real backend's first-use config migrations before taking the
    // baseline. App-window readiness alone does not wait for those writes.
    const current = await page.evaluate(() => (window as StenoWindow).stenoai.models.getCurrent());
    expect(current.model).toBe('apple:system');
    const configBefore = readUserConfig(userDataDir);
    const result = await page.evaluate(
      ({ file: f, report }) => report
        ? (window as StenoWindow).stenoai.meetings.generateReport(f, 'apple-limit-template')
        : (window as StenoWindow).stenoai.meetings.reprocess(f, false, 'Synthetic guard test'),
      { file, report: oversized === 'template' },
    );
    expect(result.success).toBe(false);
    expect(result.error).toContain('Apple Intelligence currently supports only short transcripts');
    expect(result.error).toContain('No model was switched automatically');
    expect(readFileSync(file, 'utf8')).toBe(before);
    expect(readFileSync(reportFile, 'utf8')).toBe(reportBefore);
    expect(readUserConfig(userDataDir)).toEqual(configBefore);
    expect(readUserConfig(userDataDir).model).toBe('apple:system');
  });
}
