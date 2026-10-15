import { test, expect } from '../fixtures/electron';
import { realUserDataDir, fileSig } from '../fixtures/real-user-data';
import { readUserConfig } from '../fixtures/user-config';
import { existsSync } from 'fs';
import path from 'path';

/**
 * T2 — AI provider configuration matrix. Drives the real backend's `ai` IPC and
 * asserts both the get-ai-provider snapshot and the persisted config.json keys.
 * Model-free + deterministic: every call here is a local config write or local
 * encryption — the network calls (test-cloud-api / test-remote-ollama) and the
 * org-adapter path (covered by the org specs) are intentionally excluded.
 *
 * No org is signed in, so set-ai-provider is not org-locked here.
 */

type ProviderSnapshot = {
  success: boolean;
  ai_provider?: string;
  cloud_provider?: string;
  cloud_api_url?: string;
  cloud_model?: string;
  model?: string;
  cloud_api_key_set?: boolean;
  bedrock_region?: string;
  bedrock_inference_profile?: string;
  remote_ollama_url?: string;
};
type Result = { success?: boolean; error?: string };

type StenoWindow = Window & {
  stenoai: {
    ai: {
      getProvider: () => Promise<ProviderSnapshot>;
      setProvider: (p: string) => Promise<Result>;
      setRemoteOllamaUrl: (url: string) => Promise<Result>;
      setCloudApiUrl: (url: string) => Promise<Result>;
      setCloudApiKey: (key: string) => Promise<Result>;
      setCloudProvider: (p: string) => Promise<Result>;
      setCloudModel: (m: string) => Promise<Result>;
      setBedrockRegion: (r: string) => Promise<Result>;
      setBedrockInferenceProfile: (p: string) => Promise<Result>;
    };
  };
};

const getProvider = (page: import('@playwright/test').Page) =>
  page.evaluate(() => (window as StenoWindow).stenoai.ai.getProvider());


test('provider switch + cloud/bedrock config persist and round-trip through get-ai-provider', async ({
  launchApp,
  userDataDir,
}) => {
  // Well over a dozen backend calls run back to back here, each with its own
  // PyInstaller cold start. On a slow macOS runner (~2 s each) that alone
  // exceeds the 30 s default, so give the sequence room (#574).
  test.setTimeout(90_000);
  const realDirBefore = fileSig(realUserDataDir());
  const { page } = await launchApp();

  // Default snapshot is a coherent local config.
  const initial = await getProvider(page);
  expect(initial.success).toBe(true);
  expect(initial.ai_provider).toBe('local');
  // The active local Ollama model is exposed so the Chat indicator can show it
  // (WS2). Fresh config → the registry default.
  expect(initial.model).toBe('gemma4:e2b-it-qat');

  // Provider switches persist to config.ai_provider and reflect in the snapshot.
  for (const provider of ['remote', 'cloud', 'local']) {
    await page.evaluate(
      (p) => (window as StenoWindow).stenoai.ai.setProvider(p),
      provider,
    );
    await expect.poll(() => readUserConfig(userDataDir).ai_provider).toBe(provider);
    expect((await getProvider(page)).ai_provider).toBe(provider);
  }

  // Cloud config: provider, url, model.
  await page.evaluate(() => (window as StenoWindow).stenoai.ai.setCloudProvider('anthropic'));
  await page.evaluate(() =>
    (window as StenoWindow).stenoai.ai.setCloudApiUrl('https://api.example.test/v1'),
  );
  await page.evaluate(() =>
    (window as StenoWindow).stenoai.ai.setCloudModel('claude-haiku-4-5-20251001'),
  );

  // Bedrock config.
  await page.evaluate(() => (window as StenoWindow).stenoai.ai.setBedrockRegion('us-west-2'));
  await page.evaluate(() =>
    (window as StenoWindow).stenoai.ai.setBedrockInferenceProfile('my-profile'),
  );

  // Remote Ollama URL (no connectivity check — set only).
  await page.evaluate(() =>
    (window as StenoWindow).stenoai.ai.setRemoteOllamaUrl('http://ollama.example.test:11434'),
  );

  await expect
    .poll(async () => {
      const s = await getProvider(page);
      return {
        cloud_provider: s.cloud_provider,
        cloud_api_url: s.cloud_api_url,
        cloud_model: s.cloud_model,
        bedrock_region: s.bedrock_region,
        bedrock_inference_profile: s.bedrock_inference_profile,
        remote_ollama_url: s.remote_ollama_url,
      };
    })
    .toEqual({
      cloud_provider: 'anthropic',
      cloud_api_url: 'https://api.example.test/v1',
      cloud_model: 'claude-haiku-4-5-20251001',
      bedrock_region: 'us-west-2',
      bedrock_inference_profile: 'my-profile',
      remote_ollama_url: 'http://ollama.example.test:11434',
    });

  // Keystone: the real user-data dir is byte-for-byte untouched.
  expect(fileSig(realUserDataDir())).toBe(realDirBefore);
});

test('cloud API key is stored encrypted (safeStorage) in the temp dir, not config.json', async ({
  launchApp,
  userDataDir,
}) => {
  const { app, page } = await launchApp();

  // The key is persisted via safeStorage; on a headless runner with no usable
  // keyring it is unavailable — skip LOUDLY rather than emit a misleading red
  // (mirrors org-lock-lifecycle.t2's keystone guard).
  const encryptionAvailable = await app.evaluate(({ safeStorage }) =>
    safeStorage.isEncryptionAvailable(),
  );
  if (!encryptionAvailable) {
    // eslint-disable-next-line no-console
    console.warn('[t2] SKIPPED cloud-api-key: safeStorage unavailable on this runner.');
    test.info().annotations.push({
      type: 'skip-reason',
      description: 'safeStorage unavailable; cloud key cannot persist on this runner',
    });
  }
  test.skip(!encryptionAvailable, 'safeStorage unavailable on this runner');

  await page.evaluate(() =>
    (window as StenoWindow).stenoai.ai.setCloudApiKey('sk-e2e-secret-123'),
  );

  // Encrypted blob lands in the temp dir...
  await expect
    .poll(() => existsSync(path.join(userDataDir, '.cloud-api-key')), { timeout: 10_000 })
    .toBe(true);
  // ...the snapshot reports it set...
  await expect.poll(async () => (await getProvider(page)).cloud_api_key_set).toBe(true);
  // ...and the plaintext key never appears in config.json.
  expect(JSON.stringify(readUserConfig(userDataDir))).not.toContain('sk-e2e-secret-123');
});
