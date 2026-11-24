import { test, expect } from '../fixtures/electron';

/**
 * T1 — chat answers render as they stream, not when the turn ends. The mock
 * sends the reply word by word and holds the last word until the test
 * releases it (STENOAI_E2E_CHAT_STREAM in app/e2e-mock-ipc.js).
 */
test('a chat answer shows its first words before the stream finishes', async ({ launchApp }) => {
  const { app, page } = await launchApp({
    mockIpc: true,
    env: { STENOAI_E2E_CHAT_STREAM: '1', STENOAI_E2E_CHAT_REPLY: 'Streaming answers arrive word by word FINALWORD' },
  });
  await page.evaluate(() => { window.location.hash = '#/chat'; });
  const input = page.getByRole('textbox', { name: 'Ask about your notes' });
  await input.fill('Tell me something');
  await input.press('Enter');

  // The trace says what the answer read, with a live thinking line until words arrive.
  await expect(page.getByTestId('chat-tool-step').filter({ hasText: 'Read 3 notes' })).toBeVisible();
  await expect(page.getByText(/Streaming answers arrive word by word/)).toBeVisible();
  await expect(page.getByTestId('chat-thinking')).toHaveCount(0);
  await expect(page.getByText(/FINALWORD/)).toHaveCount(0);

  await app.evaluate(() => (globalThis as unknown as { __finishChat: () => void }).__finishChat());
  await expect(page.getByText(/word by word FINALWORD/)).toBeVisible();
});

test('leaving a conversation mid-answer keeps the answer: it streams on return and is saved', async ({ launchApp }) => {
  const { app, page } = await launchApp({
    mockIpc: true,
    env: { STENOAI_E2E_CHAT_STREAM: '1', STENOAI_E2E_CHAT_REPLY: 'Answer that outlives the page DONE' },
  });
  await page.evaluate(() => { window.location.hash = '#/chat'; });
  const input = page.getByRole('textbox', { name: 'Ask about your notes' });
  await input.fill('Keep going');
  await input.press('Enter');
  await expect(page.getByText(/Answer that outlives the page/)).toBeVisible();
  const conversation = await page.evaluate(() => window.location.hash);

  // Leave while it is still answering, then come back: still streaming.
  await page.evaluate(() => { window.location.hash = '#/connect'; });
  await expect(page.getByRole('heading', { name: 'Connect', exact: true })).toBeVisible();
  await page.evaluate((h) => { window.location.hash = h; }, conversation);
  await expect(page.getByText(/Answer that outlives the page/)).toBeVisible();

  // Finish while away: the answer is still saved to the session.
  await page.evaluate(() => { window.location.hash = '#/connect'; });
  await app.evaluate(() => (globalThis as unknown as { __finishChat: () => void }).__finishChat());
  await expect.poll(async () => {
    const saved = await page.evaluate(() => window.stenoai.chat.load());
    const s = saved.success ? saved.data?.sessions.find((x: { name: string }) => x.name === 'Keep going') : null;
    return s?.messages.at(-1)?.content ?? null;
  }).toBe('Answer that outlives the page DONE');
  await page.evaluate((h) => { window.location.hash = h; }, conversation);
  await expect(page.getByText('Answer that outlives the page DONE')).toBeVisible();
});

test('a model that cannot use tools says so, with a way to switch model', async ({ launchApp }) => {
  const { page } = await launchApp({ mockIpc: true, env: { STENOAI_E2E_CHAT_NOTICE: '1', STENOAI_E2E_CHAT_REPLY: 'Plain answer.' } });
  await page.evaluate(() => { window.location.hash = '#/chat'; });
  const input = page.getByRole('textbox', { name: 'Ask about your notes' });
  await input.fill('create a notion page called Launch plan');
  await input.press('Enter');
  const notice = page.getByTestId('chat-tools-notice').first();
  await expect(notice).toContainText("Gemma 4 E2B can't use your connected apps (Notion)");
  await notice.getByRole('button', { name: 'Open AI settings' }).click();
  await expect(page).toHaveURL(/#\/settings\?tab=ai/);
});
