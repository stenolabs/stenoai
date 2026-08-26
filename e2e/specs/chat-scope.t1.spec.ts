import { test, expect } from '../fixtures/electron';

/**
 * T1 — renderer-only, mock IPC. Validates the selected-meetings chat scope:
 * selecting specific meetings updates the scope chip, forwards the meeting
 * summary file paths to the chat-global-stream IPC, persists across follow-up
 * turns in the conversation, and clears cleanly back to all-notes scope.
 */

const SCOPE_ENV = {
  STENOAI_E2E_SEED_MEETINGS: '1',
  STENOAI_E2E_MOCK_GLOBAL_CHAT: '1',
};

const SCOPE_TRIGGER = '[data-testid="scope-picker-trigger"]';
const SCOPE_POPOVER = '[data-testid="scope-picker-popover"]';
const SCOPE_ALL_NOTES = '[data-testid="scope-all-notes"]';

test('selecting two meetings scopes global chat and survives follow-up questions', async ({
  launchApp,
}) => {
  const { app, page } = await launchApp({ mockIpc: true, env: SCOPE_ENV });

  await page.evaluate(() => {
    window.location.hash = '#/chat';
  });

  const trigger = page.locator(SCOPE_TRIGGER).first();
  await expect(trigger).toBeVisible();
  await expect(trigger).toHaveText('All notes');

  // Open the scope picker and select two meetings
  await trigger.click();
  await expect(page.locator(SCOPE_POPOVER)).toBeVisible();

  const standupOption = page.locator('[data-meeting-file="standup.json"]');
  const marketingOption = page.locator('[data-meeting-file="marketing.json"]');

  await expect(standupOption).toBeVisible();
  await expect(marketingOption).toBeVisible();

  await standupOption.click();
  await marketingOption.click();

  // Close popover by clicking outside or checking trigger
  await page.keyboard.press('Escape');
  await expect(trigger).toHaveText('2 notes');

  // Submit first question
  const q1 = 'What was discussed in these syncs?';
  const input = page.locator('input[type="text"]').first();
  await input.click();
  await input.fill(q1);
  await page.keyboard.press('Enter');

  // Wait for conversation view and streamed answer
  await expect(page).toHaveURL(/#\/chat\/s-/);
  await expect(page.locator('text=Based on the selected notes')).toBeVisible({ timeout: 10_000 });

  // Verify conversation view scope chip still reflects 2 notes
  const convoTrigger = page.locator(SCOPE_TRIGGER).first();
  await expect(convoTrigger).toHaveText('2 notes');

  // Inspect captured IPC queries from main process
  let queries = await app.evaluate(() => {
    return (
      globalThis as unknown as {
        __stenoai_e2e_global_chat_queries: Array<{
          queryId: string;
          question: string;
          folderId: string | null;
          meetingFiles: string[] | null;
        }>;
      }
    ).__stenoai_e2e_global_chat_queries;
  });

  expect(queries.length).toBeGreaterThanOrEqual(1);
  expect(queries[0].question).toBe(q1);
  expect(queries[0].folderId).toBeNull();
  expect(queries[0].meetingFiles).toEqual(['standup.json', 'marketing.json']);

  // Submit follow-up question
  const q2 = 'Any deadlines mentioned?';
  const convoInput = page.locator('input[type="text"]').first();
  await convoInput.click();
  await convoInput.fill(q2);
  await page.keyboard.press('Enter');

  await expect(page.locator('text=everything is on track')).toBeVisible({ timeout: 10_000 });

  queries = await app.evaluate(() => {
    return (
      globalThis as unknown as {
        __stenoai_e2e_global_chat_queries: Array<{
          queryId: string;
          question: string;
          folderId: string | null;
          meetingFiles: string[] | null;
        }>;
      }
    ).__stenoai_e2e_global_chat_queries;
  });

  expect(queries.length).toBeGreaterThanOrEqual(2);
  const secondQuery = queries[queries.length - 1];
  expect(secondQuery.question).toBe(q2);
  expect(secondQuery.folderId).toBeNull();
  expect(secondQuery.meetingFiles).toEqual(['standup.json', 'marketing.json']);
});

test('clearing meeting selection returns to All notes scope', async ({ launchApp }) => {
  const { app, page } = await launchApp({ mockIpc: true, env: SCOPE_ENV });

  await page.evaluate(() => {
    window.location.hash = '#/chat';
  });

  const trigger = page.locator(SCOPE_TRIGGER).first();
  await trigger.click();

  const standupOption = page.locator('[data-meeting-file="standup.json"]');
  await standupOption.click();
  await page.keyboard.press('Escape');

  // Single meeting selection shows "1 note"
  await expect(trigger).toHaveText('1 note');

  // Open and clear selection back to All notes
  await trigger.click();
  await page.locator(SCOPE_ALL_NOTES).click();

  await expect(trigger).toHaveText('All notes');

  // Submit question with no selection
  const q = 'Summarise recent progress across all meetings.';
  const input = page.locator('input[type="text"]').first();
  await input.click();
  await input.fill(q);
  await page.keyboard.press('Enter');

  await expect(page).toHaveURL(/#\/chat\/s-/);

  const queries = await app.evaluate(() => {
    return (
      globalThis as unknown as {
        __stenoai_e2e_global_chat_queries: Array<{
          queryId: string;
          question: string;
          folderId: string | null;
          meetingFiles: string[] | null;
        }>;
      }
    ).__stenoai_e2e_global_chat_queries;
  });

  expect(queries.length).toBeGreaterThanOrEqual(1);
  const lastQuery = queries[queries.length - 1];
  expect(lastQuery.question).toBe(q);
  expect(lastQuery.folderId).toBeNull();
  expect(lastQuery.meetingFiles).toBeNull();
});
