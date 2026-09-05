import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';
import { test, expect } from '../fixtures/electron';
import { realUserDataDir, fileSig } from '../fixtures/real-user-data';
import { readUserConfig } from '../fixtures/user-config';

/**
 * T2 - Apple System Language Model explicit opt-in.
 *
 * Model-free: uses the status-only E2E fixture with STENOAI_DISABLE_APPLE_LM: '0'.
 * Verifies that on Darwin, when Apple LM is reported available, a fresh launch
 * keeps the Ollama default, lists Apple in supported_models, and only persists
 * `apple:system` after an explicit choice.
 */

type ListResult = {
  success: boolean;
  current_model?: string;
  supported_models?: Record<string, { installed?: boolean; name?: string; description?: string }>;
};

type CurrentModel = { success: boolean; model?: string; error?: string };
type SetupResult = { success?: boolean; skipped?: boolean };

type StenoWindow = Window & {
  stenoai: {
    models: {
      list: () => Promise<ListResult>;
      getCurrent: () => Promise<CurrentModel>;
      set: (name: string) => Promise<{ success?: boolean }>;
    };
    ai: {
      getProvider: () => Promise<{ success: boolean; model?: string; ai_provider?: string }>;
    };
    setup: {
      ollamaAndModel: () => Promise<SetupResult>;
    };
  };
};

test('fresh install offers Apple Intelligence without selecting it', async ({
  launchApp,
  userDataDir,
}) => {
  test.skip(process.platform !== 'darwin', 'Apple SystemLanguageModel is macOS-only');

  const realDirBefore = fileSig(realUserDataDir());
  const fixtureDir = mkdtempSync(path.join(tmpdir(), 'stenoai-apple-lm-'));
  const unavailableMarker = path.join(fixtureDir, 'unavailable');

  try {
    const { page } = await launchApp({
      env: {
        STENOAI_DISABLE_APPLE_LM: '0',
        STENOAI_ENABLE_EXPERIMENTAL_APPLE_LM: '1',
        STENOAI_APPLE_LM_STATE_FILE: unavailableMarker,
      },
    });

    // A fresh install keeps the existing Ollama default.
    const current = await page.evaluate(() =>
      (window as StenoWindow).stenoai.models.getCurrent(),
    );
    expect(current.success, current.error).toBe(true);
    expect(current.model).not.toBe('apple:system');

    // Provider output agrees with the persisted selection.
    const provider = await page.evaluate(() =>
      (window as StenoWindow).stenoai.ai.getProvider(),
    );
    expect(provider.success).toBe(true);
    expect(provider.model).toBe(current.model);

    // Apple is available, but config is unchanged until the explicit selection.
    await expect
      .poll(() => readUserConfig(userDataDir).model)
      .not.toBe('apple:system');

    // models.list includes apple:system as installed
    const listed = await page.evaluate(() =>
      (window as StenoWindow).stenoai.models.list(),
    );
    expect(listed.success).toBe(true);
    expect(listed.supported_models?.['apple:system']?.installed).toBe(true);
    expect(listed.supported_models?.['apple:system']?.description).toContain('OS-managed');

    // Explicit user switch opts into Apple and records user provenance.
    await page.evaluate(() =>
      (window as StenoWindow).stenoai.models.set('apple:system'),
    );
    await expect
      .poll(() => readUserConfig(userDataDir).model)
      .toBe('apple:system');
    expect(readUserConfig(userDataDir).summary_model_source).toBe('user');

    // A later OS availability change must not silently replace the selection.
    writeFileSync(unavailableMarker, '');

    // Re-running first-run setup must preserve that explicit Apple choice.
    const repeatedSetup = await page.evaluate(() =>
      (window as StenoWindow).stenoai.setup.ollamaAndModel(),
    );
    expect(repeatedSetup.success).toBe(true);
    expect(repeatedSetup.skipped).toBe(true);
    const afterRepeatedSetup = await page.evaluate(() =>
      (window as StenoWindow).stenoai.models.getCurrent(),
    );
    expect(afterRepeatedSetup.model).toBe('apple:system');
    expect(readUserConfig(userDataDir).model).toBe('apple:system');

    const unavailable = await page.evaluate(() =>
      (window as StenoWindow).stenoai.models.list(),
    );
    expect(unavailable.supported_models?.['apple:system']?.installed).toBe(false);
    expect(unavailable.supported_models?.['apple:system']?.description).toContain(
      'Enable Apple Intelligence',
    );

    expect(fileSig(realUserDataDir())).toBe(realDirBefore);
  } finally {
    rmSync(fixtureDir, { recursive: true, force: true });
  }
});
