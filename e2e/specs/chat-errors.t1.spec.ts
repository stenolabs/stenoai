import { test, expect } from '../fixtures/electron';

/**
 * T1 — a failed chat answer says what went wrong and offers the one fix,
 * instead of the generic "Unable to answer". The mock fails the answer with
 * STENOAI_E2E_CHAT_ERROR=<code> (app/e2e-mock-ipc.js), the same stable code
 * the backend sends on CHAT_STREAM_ERROR:<code> (src/ai_errors.py). Clearing
 * global.__chatErrorCode lets the next attempt succeed.
 */

const SHOTS = process.env.STENOAI_E2E_SHOTS_DIR;
const COMPOSER = 'Ask about your notes';
const allowAnswers = (app: import('@playwright/test').ElectronApplication) =>
  app.evaluate(() => { (globalThis as unknown as { __chatErrorCode: string }).__chatErrorCode = ''; });

test('Ollama not running: the notice restarts it and asks again', async ({ launchApp }) => {
  const { app, page } = await launchApp({
    mockIpc: true,
    env: { STENOAI_E2E_CHAT_ERROR: 'ollama-unreachable', STENOAI_E2E_CHAT_REPLY: 'Answer after restart' },
  });
  await page.evaluate(() => { window.location.hash = '#/chat'; });
  const input = page.getByRole('textbox', { name: COMPOSER });
  await input.fill('What did we decide?');
  await input.press('Enter');

  const notice = page.getByTestId('ai-error');
  await expect(notice).toHaveAttribute('data-ai-error', 'ollama-unreachable');
  await expect(notice.getByText('Ollama isn’t running')).toBeVisible();
  await expect(page.getByText('Unable to answer')).toHaveCount(0);
  if (SHOTS) await page.screenshot({ path: `${SHOTS}/polish-error-ollama.png` });

  await allowAnswers(app);
  await notice.getByRole('button', { name: 'Restart Ollama' }).click();
  await expect(page.getByText('Answer after restart')).toBeVisible();
  const calls = await app.evaluate(() => (globalThis as unknown as { __mockIpcCalls: unknown[] }).__mockIpcCalls);
  expect(calls).toContain('setup-ollama-and-model');
  // Asked again without repeating the question in the thread.
  await expect(page.getByText('What did we decide?', { exact: true })).toHaveCount(1);
});

test('a missing model links to AI settings, and the saved turn keeps only its code', async ({ launchApp }) => {
  const { page } = await launchApp({ mockIpc: true, env: { STENOAI_E2E_CHAT_ERROR: 'model-missing' } });
  await page.evaluate(() => { window.location.hash = '#/chat'; });
  const input = page.getByRole('textbox', { name: COMPOSER });
  await input.fill('Summarise this week');
  await input.press('Enter');

  const notice = page.getByTestId('ai-error');
  await expect(notice.getByText('This model isn’t downloaded')).toBeVisible();
  await expect.poll(async () => {
    const saved = await page.evaluate(() => window.stenoai.chat.load());
    const s = saved.success ? saved.data?.sessions.find((x: { name: string }) => x.name === 'Summarise this week') : null;
    const last = s?.messages.at(-1);
    return last ? { error: last.error, content: last.content } : null;
  }).toEqual({ error: 'model-missing', content: 'This model isn’t downloaded' });

  // Reopening the conversation shows the same notice, from the saved code.
  await page.reload();
  await page.waitForSelector('[data-app-ready]');
  await expect(page.getByTestId('ai-error').getByText('This model isn’t downloaded')).toBeVisible();
  if (SHOTS) await page.screenshot({ path: `${SHOTS}/polish-error-model.png` });

  await page.getByTestId('ai-error').getByRole('button', { name: 'Open AI settings' }).click();
  await expect.poll(() => page.evaluate(() => window.location.hash)).toBe('#/settings?tab=ai');
});

test('the in-meeting Ask bar shows a rate limit with Retry', async ({ launchApp }) => {
  const { app, page } = await launchApp({
    mockIpc: true,
    env: { STENOAI_E2E_SEED_MEETING: '1', STENOAI_E2E_CHAT_ERROR: 'rate-limit', STENOAI_E2E_CHAT_REPLY: 'Second try worked' },
  });
  await page.evaluate(() => { window.location.hash = `#/meetings/${encodeURIComponent('epsilon_summary.json')}`; });
  const bar = page.locator('[data-ask-bar]');
  const input = bar.getByPlaceholder('Ask anything…');
  await input.fill('Who owns the launch?');
  await input.press('Enter');

  const notice = bar.getByTestId('ai-error');
  await expect(notice.getByText('Too many requests, try again in a moment')).toBeVisible();
  if (SHOTS) await page.screenshot({ path: `${SHOTS}/polish-error-ratelimit.png` });

  await allowAnswers(app);
  await notice.getByRole('button', { name: 'Retry' }).click();
  await expect(bar.getByText('Second try worked')).toBeVisible();
  // Asked again without saving the question twice.
  await expect.poll(async () => {
    const saved = await page.evaluate(() => window.stenoai.chat.load());
    const sessions = saved.success ? saved.data?.sessions ?? [] : [];
    return sessions.flatMap((s: { messages: Array<{ role: string; content: string }> }) => s.messages)
      .filter((m: { role: string; content: string }) => m.role === 'user' && m.content === 'Who owns the launch?').length;
  }).toBe(1);
});
