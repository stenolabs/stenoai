import { test, expect } from '../fixtures/electron';
import type { ElectronApplication, Page } from '@playwright/test';

/**
 * T1 - renderer-only, mock IPC. The stepped onboarding (You -> How Steno
 * thinks -> Getting ready) and its guided cloud-key step:
 *   - leaving the first screen starts the speech-model download in the
 *     background, before any engine is chosen;
 *   - Cloud shows OpenAI / Anthropic / OpenRouter cards whose "Get a key"
 *     opens each provider's key page;
 *   - the pasted key picks its provider from its prefix, is tested live
 *     (mock test-cloud-api answers from the key), and the outcome is spelled
 *     out: connected with a model, invalid key, no credit, offline;
 *   - Begin setup stays shut until the key connects, then finishes with the
 *     "You're ready" state.
 * The real backend side of OpenRouter (config keys + encrypted key) is in
 * ai-provider.t2.
 */

async function openSetup(page: Page) {
  await page.evaluate(() => {
    window.location.hash = '#/setup';
  });
  await expect(page.getByRole('heading', { name: 'Welcome to Steno' })).toBeVisible();
}

async function spyOnOpenExternal(app: ElectronApplication) {
  await app.evaluate(({ shell }) => {
    const state = globalThis as unknown as { openedUrls: string[] };
    state.openedUrls = [];
    shell.openExternal = async (url) => {
      state.openedUrls.push(url);
    };
  });
}

const openedUrls = (app: ElectronApplication) =>
  app.evaluate(() => (globalThis as unknown as { openedUrls: string[] }).openedUrls);

test('the speech model starts downloading as soon as the first screen is left', async ({ launchApp }) => {
  const { app, page } = await launchApp({
    mockIpc: true,
    env: { STENOAI_E2E_SETUP_PROGRESS: '1' },
  });
  await openSetup(page);

  // Step 1: the name is optional, so Continue works with it empty.
  const stepper = page.getByRole('list', { name: 'Setup progress' });
  await expect(stepper.locator('[aria-current="step"]')).toContainText('You');
  await expect(page.getByLabel('What should we call you?')).toHaveValue('');
  const callsBefore = await app.evaluate(() => (global as { __mockIpcCalls: string[] }).__mockIpcCalls.length);
  await page.getByRole('button', { name: 'Continue', exact: true }).click();

  // Step 2 is showing, and the download is already running behind it.
  await expect(page.getByRole('heading', { name: 'How should Steno think?' })).toBeVisible();
  await expect(stepper.locator('[aria-current="step"]')).toContainText('How Steno thinks');
  await expect
    .poll(() =>
      app.evaluate(
        (_e, from) => (global as { __mockIpcCalls: string[] }).__mockIpcCalls.slice(from),
        callsBefore,
      ),
    )
    .toContain('setup-parakeet');
  await expect(page.locator('[data-setup-background-hint]')).toBeVisible();

  // Local is the default and needs nothing else.
  await expect(page.getByRole('radio', { name: /On this computer/ })).toHaveAttribute('aria-checked', 'true');
  await expect(page.getByRole('button', { name: 'Begin setup' })).toBeEnabled();

  // Arrow keys move the choice (radio-group keyboard pattern).
  await page.getByRole('radio', { name: /On this computer/ }).focus();
  await page.keyboard.press('ArrowRight');
  await expect(page.getByRole('radio', { name: /Cloud/ })).toHaveAttribute('aria-checked', 'true');
  await expect(page.getByRole('radio', { name: /Cloud/ })).toBeFocused();

  // Back returns to step 1 without restarting anything.
  await page.getByRole('button', { name: 'Back' }).click();
  await expect(page.getByRole('heading', { name: 'Welcome to Steno' })).toBeVisible();
});

test('guided cloud keys: provider cards, key pages, detection and a live test', async ({ launchApp }) => {
  const { app, page } = await launchApp({
    mockIpc: true,
    env: { STENOAI_E2E_OPEN_EXTERNAL: '1', STENOAI_E2E_MOCK_PARAKEET_INSTALLED: '1' },
  });
  await spyOnOpenExternal(app);
  await openSetup(page);
  await page.getByRole('button', { name: 'Continue', exact: true }).click();
  await page.getByRole('radio', { name: /Cloud/ }).click();

  // Three guided providers, OpenRouter first and marked as the easy start.
  const cards = page.locator('[data-setup-provider]');
  await expect(cards).toHaveCount(3);
  await expect(cards.nth(0)).toHaveAttribute('data-setup-provider', 'openrouter');
  await expect(cards.nth(0)).toContainText('Easiest start');
  await expect(cards.nth(0)).toContainText('One key, many models');

  // Each "Get a key" opens that provider's own key page.
  for (const [name, url] of [
    ['OpenRouter', 'https://openrouter.ai/settings/keys'],
    ['OpenAI', 'https://platform.openai.com/api-keys'],
    ['Anthropic', 'https://console.anthropic.com/settings/keys'],
  ] as const) {
    await page.getByRole('button', { name: `Get a key from ${name}` }).click();
    await expect.poll(() => openedUrls(app)).toContain(url);
  }

  // Begin setup is shut until a key connects.
  // Clicking anywhere on a provider card selects it, not just its header.
  await page.locator('[data-setup-provider="openai"] ol').click();
  await expect(page.locator('[data-setup-provider="openai"]')).toHaveAttribute('data-selected', '');

  const begin = page.getByRole('button', { name: 'Begin setup' });
  await expect(begin).toBeDisabled();
  await expect(page.getByText('Connect your API key to continue.')).toBeVisible();

  // The key's prefix picks its provider, whichever card was selected.
  const key = page.getByLabel('Paste your API key');
  await key.fill('sk-ant-api03-bad');
  await expect(page.locator('[data-setup-provider="anthropic"]')).toHaveAttribute('data-selected', '');
  await expect(page.locator('[data-setup-cloud-detected]')).toHaveText('Looks like an Anthropic key');

  // A rejected key says so, in plain words.
  await page.getByRole('button', { name: 'Connect' }).click();
  await expect(page.locator('[data-setup-cloud-error]')).toHaveText(
    "Anthropic didn't accept that key. Check you copied all of it, or create a new one.",
  );
  await expect(begin).toBeDisabled();

  // No credit and offline are told apart from a bad key.
  await key.fill('sk-proj-nocredit');
  await expect(page.locator('[data-setup-provider="openai"]')).toHaveAttribute('data-selected', '');
  await key.press('Enter');
  await expect(page.locator('[data-setup-cloud-error]')).toContainText('the OpenAI account has no credit');
  await key.fill('sk-or-v1-offline');
  await page.getByRole('button', { name: 'Connect' }).click();
  await expect(page.locator('[data-setup-cloud-error]')).toHaveText(
    "Couldn't reach OpenRouter. Check your internet connection and try again.",
  );

  // A good OpenRouter key connects with its default model, by friendly name.
  await key.fill('sk-or-v1-good');
  await expect(page.locator('[data-setup-provider="openrouter"]')).toHaveAttribute('data-selected', '');
  await page.getByRole('button', { name: 'Connect' }).click();
  await expect(page.locator('[data-setup-cloud-ok]')).toHaveText('Connected · Gemini 2.5 Flash ready');
  const tested = await app.evaluate(() => (global as { __cloudKeyTests?: { providers: string[] } }).__cloudKeyTests?.providers);
  expect(tested).toEqual(['anthropic', 'openai', 'openrouter', 'openrouter']);

  // Editing the key after a test invalidates it.
  await key.fill('sk-or-v1-good2');
  await expect(begin).toBeDisabled();
  await key.fill('sk-or-v1-good');
  await page.getByRole('button', { name: 'Connect' }).click();
  await expect(page.locator('[data-setup-cloud-ok]')).toBeVisible();

  await begin.click();
  await expect(page.getByRole('heading', { name: "You're ready" })).toBeVisible();
  await expect(page.locator('[data-setup-step="ollama"]')).toHaveAttribute('data-setup-status', 'done');
  await expect(page.locator('[data-setup-step="ollama"]')).toContainText('Connected to OpenRouter');
  await expect(page.getByRole('button', { name: 'Start your first note' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Continue to app' })).toBeVisible();

  // The choice reached the (mock) backend: cloud + openrouter + key set.
  const snapshot = await page.evaluate(() =>
    (window as unknown as { stenoai: { ai: { getProvider: () => Promise<Record<string, unknown>> } } }).stenoai.ai.getProvider(),
  );
  expect(snapshot).toMatchObject({
    ai_provider: 'cloud',
    cloud_provider: 'openrouter',
    cloud_model: 'google/gemini-2.5-flash',
    cloud_api_key_set: true,
  });
  // Cloud never starts the local model download.
  const calls = await app.evaluate(() => (global as { __mockIpcCalls: string[] }).__mockIpcCalls);
  expect(calls).not.toContain('setup-ollama-and-model');
});

test('a key with no recognisable prefix uses the selected card', async ({ launchApp }) => {
  const { app, page } = await launchApp({
    mockIpc: true,
    env: { STENOAI_E2E_MOCK_PARAKEET_INSTALLED: '1' },
  });
  await openSetup(page);
  await page.getByRole('button', { name: 'Continue', exact: true }).click();
  await page.getByRole('radio', { name: /Cloud/ }).click();
  await page.getByRole('button', { name: /^Anthropic/ }).click();
  await page.getByLabel('Paste your API key').fill('proxy-token-123');
  await page.getByRole('button', { name: 'Connect' }).click();
  await expect(page.locator('[data-setup-cloud-ok]')).toHaveText('Connected · Claude Haiku 4.5 ready');
  const tested = await app.evaluate(() => (global as { __cloudKeyTests?: { providers: string[] } }).__cloudKeyTests?.providers);
  expect(tested).toEqual(['anthropic']);
});

test('the ready state offers to start a first note', async ({ launchApp }) => {
  const { app, page } = await launchApp({
    mockIpc: true,
    env: { STENOAI_E2E_MOCK_PARAKEET_INSTALLED: '1' },
  });
  await openSetup(page);
  await page.getByRole('button', { name: 'Continue', exact: true }).click();
  await page.getByRole('button', { name: 'Begin setup' }).click();
  await expect(page.getByRole('heading', { name: "You're ready" })).toBeVisible();
  await page.getByRole('button', { name: 'Start your first note' }).click();
  await expect.poll(() => page.evaluate(() => location.hash)).toBe('#/');
  await expect
    .poll(() => app.evaluate(() => (global as { __mockIpcCalls: string[] }).__mockIpcCalls))
    .toContain('set-privacy-notice-seen');
});

test('the custom endpoint URL has an accessible hint in Setup and Settings', async ({ launchApp }) => {
  const { page } = await launchApp({
    mockIpc: true,
    env: { STENOAI_E2E_MOCK_PARAKEET_INSTALLED: '1' },
  });
  const customEndpoint = 'Custom endpoint (LiteLLM, vLLM, …)';
  const hint = 'Any OpenAI-compatible API, such as a LiteLLM proxy your organisation runs.';
  const baseUrl = page.getByRole('textbox', { name: 'API base URL' });

  await openSetup(page);
  await page.getByRole('button', { name: 'Continue', exact: true }).click();
  await page.getByRole('radio', { name: /Cloud/ }).click();
  await page.getByRole('button', { name: /^Other providers/ }).click();
  await page.locator('#setup-cloud-provider').click();
  await page.getByRole('option', { name: customEndpoint }).click();
  await expect(baseUrl).toHaveAccessibleDescription(hint);

  await page.evaluate(() => {
    window.location.hash = '#/settings?tab=ai';
  });
  await page.getByTestId('ai-provider-select').click();
  await page.getByRole('option', { name: /Cloud/ }).click();
  await page.getByTestId('cloud-service-select').click();
  await page.getByRole('option', { name: customEndpoint }).click();
  await expect(baseUrl).toHaveAccessibleDescription(hint);
});

test('Settings offers OpenRouter with friendly model names and a key link', async ({ launchApp }) => {
  const { app, page } = await launchApp({
    mockIpc: true,
    env: { STENOAI_E2E_OPEN_EXTERNAL: '1', STENOAI_E2E_MOCK_PARAKEET_INSTALLED: '1' },
  });
  await spyOnOpenExternal(app);
  await page.evaluate(() => {
    window.location.hash = '#/settings?tab=ai';
  });
  await page.getByTestId('ai-provider-select').click();
  await page.getByRole('option', { name: /Cloud/ }).click();
  await page.getByTestId('cloud-service-select').click();
  await page.getByRole('option', { name: 'OpenRouter (many models)' }).click();
  await expect(page.getByTestId('cloud-service-select')).toContainText('OpenRouter');

  // Recommended picks are there before any connection test, by name + tier.
  const model = page.getByTestId('cloud-model-select');
  await expect(model).toContainText('Gemini 2.5 Flash');
  await model.click();
  await expect(page.getByRole('option', { name: /Claude Sonnet 4\.5/ })).toContainText('Balanced · anthropic/claude-sonnet-4.5');
  await expect(page.getByRole('option', { name: /Gemini 2\.5 Pro/ })).toContainText('Best');
  await expect(page.getByRole('option', { name: 'Custom…' })).toBeVisible();
  await page.getByRole('option', { name: /Claude Sonnet 4\.5/ }).click();
  await expect(model).toContainText('Claude Sonnet 4.5');

  await page.getByRole('button', { name: 'Get a key from OpenRouter' }).click();
  await expect.poll(() => openedUrls(app)).toContain('https://openrouter.ai/settings/keys');
});
