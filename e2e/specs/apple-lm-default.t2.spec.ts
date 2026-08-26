import { chmodSync, mkdtempSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';
import { test, expect } from '../fixtures/electron';
import { realUserDataDir, fileSig } from '../fixtures/real-user-data';
import { readUserConfig } from '../fixtures/user-config';

/**
 * T2 — Apple System Language Model (Advanced / 3B Core) default resolution.
 *
 * Model-free: uses a lightweight mock script pointed to via STENOAI_APPLE_LM_BIN
 * with STENOAI_DISABLE_APPLE_LM: '0'. Verifies that on Darwin, when Apple LM is
 * reported available, a fresh launch defaults to `apple:system`, surfaces it via
 * the preload bridge, lists it in supported_models, and persists to disk.
 */

type ListResult = {
  success: boolean;
  current_model?: string;
  supported_models?: Record<string, { installed?: boolean; name?: string; description?: string }>;
};

type CurrentModel = { success: boolean; model?: string };

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
  };
};

test('fresh install defaults to apple:system when Apple Intelligence is available', async ({
  launchApp,
  userDataDir,
}) => {
  test.skip(process.platform !== 'darwin', 'Apple SystemLanguageModel is macOS-only');

  const realDirBefore = fileSig(realUserDataDir());
  const fixtureDir = mkdtempSync(path.join(tmpdir(), 'stenoai-apple-lm-'));
  const mockScript = path.join(fixtureDir, 'mock-steno-apple-lm.sh');

  writeFileSync(
    mockScript,
    [
      '#!/usr/bin/env bash',
      'set -euo pipefail',
      'cmd="${1:-status}"',
      'case "$cmd" in',
      '  status)',
      '    echo \'{"available":true,"variant":"coreAdvanced3","display_name":"Apple Intelligence"}\'',
      '    ;;',
      '  complete)',
      '    echo \'{"text":"Mocked response"}\'',
      '    ;;',
      '  stream)',
      '    echo \'{"delta":"Mocked"}\'',
      '    echo \'{"done":true}\'',
      '    ;;',
      '  *)',
      '    echo \'{"error":"unknown_command"}\'',
      '    exit 1',
      '    ;;',
      'esac',
    ].join('\n'),
  );
  chmodSync(mockScript, 0o755);

  const { page } = await launchApp({
    env: {
      STENOAI_DISABLE_APPLE_LM: '0',
      STENOAI_APPLE_LM_BIN: mockScript,
    },
  });

  // Preload get-current-model returns apple:system
  const current = await page.evaluate(() =>
    (window as StenoWindow).stenoai.models.getCurrent(),
  );
  expect(current.success).toBe(true);
  expect(current.model).toBe('apple:system');

  // getProvider also returns model: apple:system
  const provider = await page.evaluate(() =>
    (window as StenoWindow).stenoai.ai.getProvider(),
  );
  expect(provider.success).toBe(true);
  expect(provider.model).toBe('apple:system');

  // On-disk config reflects apple:system with auto source
  await expect
    .poll(() => readUserConfig(userDataDir).model)
    .toBe('apple:system');
  expect(readUserConfig(userDataDir).summary_model_source).toBe('auto');

  // models.list includes apple:system as installed
  const listed = await page.evaluate(() =>
    (window as StenoWindow).stenoai.models.list(),
  );
  expect(listed.success).toBe(true);
  expect(listed.supported_models?.['apple:system']?.installed).toBe(true);
  expect(listed.supported_models?.['apple:system']?.description).toContain('Advanced');

  // Explicit user switch to another model updates config and sets source to user
  await page.evaluate(() =>
    (window as StenoWindow).stenoai.models.set('gemma4:e2b-it-qat'),
  );
  await expect
    .poll(() => readUserConfig(userDataDir).model)
    .toBe('gemma4:e2b-it-qat');
  expect(readUserConfig(userDataDir).summary_model_source).toBe('user');

  expect(fileSig(realUserDataDir())).toBe(realDirBefore);
});
