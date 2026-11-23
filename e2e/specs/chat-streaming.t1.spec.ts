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
