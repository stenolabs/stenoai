import { test, expect } from '../fixtures/electron';

/**
 * T1 — a finished chat answer whose save fails is not dropped (mock IPC).
 * `__holdNextChatSave` / `__failChatSave` in app/e2e-mock-ipc.js hold the next
 * save-chat-sessions and fail it on demand; STENOAI_E2E_HOLD_CHAT holds the
 * answer itself (`__finishChat`) so the user message's save completes first.
 * ChatTurnPersister retries once, then keeps the turn and shows the
 * chat.saveError notice with Try again / Dismiss; the answer stays on screen.
 */

type App = import('@playwright/test').ElectronApplication;
type Page = import('@playwright/test').Page;

const REPLY = '1. First point\n\n2. Second point\n\n3. Third point';

async function askAndFailTheSaveTwice(page: Page, app: App) {
  await page.evaluate(() => {
    window.location.hash = '#/chat';
  });
  const input = page.getByRole('textbox').first();
  await input.fill('Summarise my week');
  await input.press('Enter');
  // The user message is saved; the answer is held until released.
  await expect.poll(() => app.evaluate(() => typeof (globalThis as any).__finishChat)).toBe('function');
  await app.evaluate(() => {
    (globalThis as any).__holdNextChatSave = true;
    (globalThis as any).__finishChat();
  });
  // First save attempt: fail it, and hold the retry too.
  await expect.poll(() => app.evaluate(() => typeof (globalThis as any).__failChatSave)).toBe('function');
  await app.evaluate(() => {
    const fail = (globalThis as any).__failChatSave;
    (globalThis as any).__failChatSave = undefined;
    (globalThis as any).__holdNextChatSave = true;
    fail();
  });
  // The retry (after a short delay): fail it as well.
  await expect.poll(() => app.evaluate(() => typeof (globalThis as any).__failChatSave), { timeout: 10_000 }).toBe('function');
  await app.evaluate(() => {
    const fail = (globalThis as any).__failChatSave;
    (globalThis as any).__failChatSave = undefined;
    fail();
  });
  await expect(page.getByTestId('chat-save-failed')).toContainText('Could not save this chat update.');
}

/** Assistant messages saved to disk (the mock's store), via the preload bridge. */
const savedAssistantMessages = (page: Page) =>
  page.evaluate(async () => {
    const res = await (window as any).stenoai.chat.load();
    const sessions = res?.data?.sessions ?? [];
    return sessions.flatMap((s: any) => s.messages).filter((m: any) => m.role === 'assistant').map((m: any) => m.content);
  });

test('a failed save keeps the answer on screen; Try again saves it', async ({ launchApp }) => {
  const { page, app } = await launchApp({ mockIpc: true, env: { STENOAI_E2E_HOLD_CHAT: '1' } });
  await askAndFailTheSaveTwice(page, app);
  // The answer is still readable while the notice is up.
  await expect(page.getByText('First point')).toBeVisible();
  await expect(page.getByText('Third point')).toBeVisible();

  await page.getByRole('button', { name: 'Try again' }).click();
  await expect(page.getByTestId('chat-save-failed')).toHaveCount(0);
  await expect(page.getByText('Third point')).toBeVisible();
  // The answer is on disk now.
  await expect.poll(() => savedAssistantMessages(page)).toEqual([REPLY]);
});

test('Dismiss gives the answer up explicitly and saves nothing more', async ({ launchApp }) => {
  const { page, app } = await launchApp({ mockIpc: true, env: { STENOAI_E2E_HOLD_CHAT: '1' } });
  await askAndFailTheSaveTwice(page, app);
  expect(await savedAssistantMessages(page)).toEqual([]);

  await page.getByRole('button', { name: 'Dismiss' }).click();
  await expect(page.getByTestId('chat-save-failed')).toHaveCount(0);
  await expect(page.getByText('Third point')).toHaveCount(0);
  // The user message stays; no assistant message was ever saved.
  await expect(page.getByText('Summarise my week')).toBeVisible();
  expect(await savedAssistantMessages(page)).toEqual([]);
});
