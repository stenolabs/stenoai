import { existsSync, readFileSync } from 'fs';
import path from 'path';
import { test, expect } from '../fixtures/electron';
import { readUserConfig, writeUserConfig, writeMeetingSummary } from '../fixtures/user-config';

type StenoWindow = Window & {
  stenoai: {
    models: {
      getCurrent: () => Promise<{ model?: string }>;
      list: () => Promise<{ supported_models?: Record<string, { selectable?: boolean; description?: string }> }>;
      set: (model: string) => Promise<{ success: boolean; error?: string }>;
    };
    meetings: {
      reprocess: (file: string, title: boolean, name: string) => Promise<{ success: boolean; error?: string }>;
      generateReport: (file: string, templateId: string) => Promise<{ success: boolean; error?: string }>;
    };
  };
};

for (const selected of [false, true]) {
  test(`Apple experiment off preserves ${selected ? 'previous Apple selection' : 'normal default'}`, async ({
    launchApp, userDataDir,
  }) => {
    test.skip(process.platform !== 'darwin', 'Apple-only runtime guard');
    if (selected) {
      writeUserConfig(userDataDir, {
        ai_provider: 'local', model: 'apple:system', summary_model_source: 'user',
        custom_templates: [{ id: 'gate-template', name: 'Gate test', prompt: 'Summarize the facts.', format: 'markdown', language: 'en' }],
      });
    }
    const file = writeMeetingSummary(userDataDir, 'experimental-gate', {
      name: 'Synthetic experiment gate', summary: 'Preserve this summary.', transcript: 'Project MAPLE.',
    });
    const original = readFileSync(file, 'utf8');
    const { page } = await launchApp({ env: {
      STENOAI_DISABLE_APPLE_LM: '0',
      STENOAI_ENABLE_EXPERIMENTAL_APPLE_LM: '0',
      // Reports Apple available if reached: must NOT bypass the experiment gate.
      STENOAI_APPLE_LM_STATE_FILE: path.join(userDataDir, 'missing-marker'),
    } });
    const current = await page.evaluate(() => (window as StenoWindow).stenoai.models.getCurrent());
    const configBefore = readUserConfig(userDataDir);
    const listed = await page.evaluate(() => (window as StenoWindow).stenoai.models.list());
    const apple = listed.supported_models?.['apple:system'];
    if (selected) {
      expect(current.model).toBe('apple:system');
      expect(apple?.selectable).toBe(false);
      expect(apple?.description).toContain('experimental and disabled by default');
      const result = await page.evaluate(
        (f) => (window as StenoWindow).stenoai.meetings.reprocess(f, false, 'Synthetic experiment gate'), file,
      );
      expect(result.success).toBe(false);
      expect(result.error).toContain('experimental and disabled by default');
      const report = await page.evaluate(
        (f) => (window as StenoWindow).stenoai.meetings.generateReport(f, 'gate-template'), file,
      );
      expect(report.success).toBe(false);
      expect(report.error).toContain('experimental and disabled by default');
      expect(existsSync(path.join(userDataDir, 'output', 'experimental-gate_reports.json'))).toBe(false);
    } else {
      expect(current.model).not.toBe('apple:system');
      expect(apple).toBeUndefined();
    }
    const rejected = await page.evaluate(() => (window as StenoWindow).stenoai.models.set('apple:system'));
    expect(rejected.success).toBe(false);
    expect(readUserConfig(userDataDir)).toEqual(configBefore);
    expect(readFileSync(file, 'utf8')).toBe(original);
  });
}
