import { test, expect } from '../fixtures/electron';

/**
 * T1 — renderer-only, mock IPC. Pins the Chat composer's model indicator
 * (WS2): the label must reflect the ACTIVE ai_provider, not stored cloud_*
 * prefs. The old label keyed off cloud_provider, so a local/adapter user saw a
 * stale "openai · gpt-4o" — the bug behind #198. Wire shapes are stubbed in
 * app/e2e-mock-ipc.js; the mapping itself is formatActiveModel in lib/chat.ts.
 */

const indicator = '[data-testid="chat-model-indicator"]';

test('local provider shows the Ollama model, not a stale cloud model', async ({ launchApp }) => {
  const { page } = await launchApp({ mockIpc: true });

  // Default mock provider is 'local' with model gemma4:e2b-it-qat.
  await page.evaluate(() => {
    window.location.hash = '#/chat';
  });

  const label = page.locator(indicator).first();
  await expect(label).toBeVisible();
  // A short name in the composer; the provider and full id in its tooltip.
  await expect(label).toHaveText('Gemma 4 E2B');
  await label.hover();
  await expect(page.getByRole('tooltip')).toContainText('Ollama · gemma4:e2b-it-qat');
  await expect(page.getByRole('tooltip')).toContainText('May omit older notes');
  // Must NOT leak the stored cloud default (the #198 regression).
  await expect(label).not.toContainText('openai');
  await expect(label).not.toContainText('gpt-4o');
});

test('cloud provider shows "<provider> · <model>"', async ({ launchApp }) => {
  const { page } = await launchApp({ mockIpc: true });

  // Switch to cloud on a non-chat route, then mount Chat fresh so the provider
  // query refetches the new state.
  await page.evaluate(() => {
    window.location.hash = '#/settings';
  });
  await page.evaluate(() => (window as unknown as { stenoai: { ai: { setProvider: (p: string) => Promise<unknown> } } }).stenoai.ai.setProvider('cloud'));
  await page.evaluate(() => {
    window.location.hash = '#/chat';
  });

  const label = page.locator(indicator).first();
  await expect(label).toHaveText('gpt-4o');
  await label.hover();
  await expect(page.getByRole('tooltip')).toContainText('openai · gpt-4o');
});

test('remote provider shows "Remote Ollama · <model>"', async ({ launchApp }) => {
  const { page } = await launchApp({ mockIpc: true });

  await page.evaluate(() => {
    window.location.hash = '#/settings';
  });
  await page.evaluate(() => (window as unknown as { stenoai: { ai: { setProvider: (p: string) => Promise<unknown> } } }).stenoai.ai.setProvider('remote'));
  await page.evaluate(() => {
    window.location.hash = '#/chat';
  });

  const label = page.locator(indicator).first();
  await expect(label).toHaveText('Gemma 4 E2B');
  await label.hover();
  await expect(page.getByRole('tooltip')).toContainText('Remote Ollama · gemma4:e2b-it-qat');
});

test('org/adapter provider shows "Organisation", never a cloud model id', async ({ launchApp }) => {
  const { page } = await launchApp({ mockIpc: true });

  // Sign in to the org → hard-lock flips the provider to adapter.
  await page.evaluate(() => {
    window.location.hash = '#/settings?tab=organisation';
  });
  await expect(page.getByTestId('org-sign-in-card')).toBeVisible();
  await page.getByPlaceholder('https://steno-adapter.yourcompany.com').fill('https://e2e.example.com');
  await page.getByPlaceholder('you@yourcompany.com').fill('e2e@example.com');
  await page.getByPlaceholder('••••••').fill('hunter2');
  await page.getByRole('button', { name: /sign in with password/i }).click();
  await expect(page.getByTestId('org-signed-in-card')).toBeVisible();

  await page.evaluate(() => {
    window.location.hash = '#/chat';
  });

  const label = page.locator(indicator).first();
  await expect(label).toBeVisible();
  await expect(label).toHaveText('Organisation');
});
