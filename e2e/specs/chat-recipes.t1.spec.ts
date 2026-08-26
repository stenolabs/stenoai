import { test, expect } from '../fixtures/electron';

/**
 * T1 — renderer-only, mock IPC. Validates saved chat recipes:
 * - Typing '/' at start of empty input opens recipes menu with presets & saved recipes.
 * - Selecting an item fills the composer with that prompt.
 * - Typing '/' mid-sentence does NOT open the menu.
 * - Keyboard navigation (ArrowUp/ArrowDown/Enter) selects items; Escape closes menu.
 * - Saving composer text as a new recipe persisted via IPC.
 * - Deleting a recipe prompts confirmation and removes it.
 * - Both new-chat and follow-up conversation composers offer it.
 */

const CHAT_INPUT = 'form input[type="text"]';
const RECIPES_MENU = '[data-testid="chat-recipes-menu"]';
const SAVE_BUTTON = '[data-testid="save-recipe-button"]';
const SAVE_DIALOG = '[data-testid="save-recipe-dialog"]';
const LABEL_INPUT = '[data-testid="recipe-label-input"]';
const PROMPT_INPUT = '[data-testid="recipe-prompt-input"]';
const SAVE_SUBMIT = '[data-testid="save-recipe-submit"]';

const LAUNCH_OPTS = {
  mockIpc: true,
  env: {
    STENOAI_E2E_SEED_MEETINGS: '1',
    STENOAI_E2E_MOCK_GLOBAL_CHAT: '1',
  },
} as const;

test('/ on empty composer opens menu and selecting a preset fills input', async ({
  launchApp,
}) => {
  const { page } = await launchApp(LAUNCH_OPTS);

  await page.evaluate(() => {
    window.location.hash = '#/chat';
  });

  const input = page.locator(CHAT_INPUT).first();
  await expect(input).toBeVisible();

  // Focus and press '/'
  await input.click();
  await page.keyboard.press('/');

  // Menu opens and displays presets
  const menu = page.locator(RECIPES_MENU);
  await expect(menu).toBeVisible();
  await expect(menu).toContainText('List recent todos');
  await expect(menu).toContainText('Coach me');

  // Click the first preset
  const firstPreset = page.locator('[data-testid="recipe-item-builtin-0"]');
  await expect(firstPreset).toBeVisible();
  await firstPreset.click();

  // Menu closes and composer input is filled
  await expect(menu).toBeHidden();
  await expect(input).toHaveValue('List my action items from the last week.');
});

test('/ mid-sentence does not open menu', async ({ launchApp }) => {
  const { page } = await launchApp(LAUNCH_OPTS);

  await page.evaluate(() => {
    window.location.hash = '#/chat';
  });

  const input = page.locator(CHAT_INPUT).first();
  await expect(input).toBeVisible();

  await input.click();
  await input.fill('Check /path/to/notes for details');

  // Popover should remain hidden
  const menu = page.locator(RECIPES_MENU);
  await expect(menu).toBeHidden();
  await expect(input).toHaveValue('Check /path/to/notes for details');
});

test('keyboard navigation selects entry and escape closes menu', async ({ launchApp }) => {
  const { page } = await launchApp(LAUNCH_OPTS);

  await page.evaluate(() => {
    window.location.hash = '#/chat';
  });

  const input = page.locator(CHAT_INPUT).first();
  await expect(input).toBeVisible();

  // Open with '/'
  await input.click();
  await page.keyboard.press('/');

  const menu = page.locator(RECIPES_MENU);
  await expect(menu).toBeVisible();

  // Press Escape to close
  await page.keyboard.press('Escape');
  await expect(menu).toBeHidden();

  // Re-open by pressing '/' again
  await input.fill('');
  await page.keyboard.press('/');
  await expect(menu).toBeVisible();

  // ArrowDown to select next item
  await page.keyboard.press('ArrowDown');
  await page.keyboard.press('Enter');

  // Selected item prompt is placed into composer
  await expect(menu).toBeHidden();
  await expect(input).not.toHaveValue('');
});

test('saving composer text as a recipe and deleting it from menu', async ({ launchApp }) => {
  const { page } = await launchApp(LAUNCH_OPTS);

  await page.evaluate(() => {
    window.location.hash = '#/chat';
  });

  const input = page.locator(CHAT_INPUT).first();
  await expect(input).toBeVisible();

  const customPrompt = 'List all decisions made regarding the release date.';
  await input.click();
  await input.fill(customPrompt);

  // Save recipe button appears
  const saveBtn = page.locator(SAVE_BUTTON);
  await expect(saveBtn).toBeVisible();
  await saveBtn.click();

  // Dialog opens
  const dialog = page.locator(SAVE_DIALOG);
  await expect(dialog).toBeVisible();
  await expect(page.locator(PROMPT_INPUT)).toHaveValue(customPrompt);

  // Fill in recipe name and submit
  await page.locator(LABEL_INPUT).fill('Release decisions');
  await page.locator(SAVE_SUBMIT).click();
  await expect(dialog).toBeHidden();

  // Clear input and open slash menu
  await input.fill('');
  await page.keyboard.press('/');

  const menu = page.locator(RECIPES_MENU);
  await expect(menu).toBeVisible();
  await expect(menu).toContainText('Release decisions');

  // Delete the custom recipe
  const deleteBtn = page.locator('[data-testid="delete-recipe-btn-release-decisions"]');
  await expect(deleteBtn).toBeVisible();
  await deleteBtn.click();

  // ConfirmDialog opens
  const confirmDialog = page.locator('[data-confirm-dialog]');
  await expect(confirmDialog).toBeVisible();
  await expect(confirmDialog).toContainText('Delete recipe "Release decisions"?');

  // Confirm delete
  await confirmDialog.getByRole('button', { name: 'Delete' }).click();
  await expect(confirmDialog).toBeHidden();

  // Deleting closes the menu, so re-open it: asserting `not.toContainText` on a
  // detached element passes for the wrong reason (element not found), which is
  // exactly what it did before this was fixed.
  await input.fill('');
  await page.keyboard.press('/');
  const reopened = page.locator(RECIPES_MENU);
  await expect(reopened).toBeVisible();
  await expect(reopened).not.toContainText('Release decisions');
});

test('follow-up conversation composer also supports slash recipes', async ({ launchApp }) => {
  const { page } = await launchApp(LAUNCH_OPTS);

  await page.evaluate(() => {
    window.location.hash = '#/chat';
  });

  // Submit initial question to enter conversation view
  const input = page.locator(CHAT_INPUT).first();
  await input.click();
  await input.fill('What is on the agenda?');
  await page.keyboard.press('Enter');

  // Wait for conversation view
  await expect(page).toHaveURL(/#\/chat\/s-/);

  const convoInput = page.locator('form input[type="text"]').first();
  await expect(convoInput).toBeVisible();

  // Press '/' in conversation composer
  await convoInput.click();
  await page.keyboard.press('/');

  const menu = page.locator(RECIPES_MENU);
  await expect(menu).toBeVisible();
  await expect(menu).toContainText('List recent todos');

  // Select a preset
  const firstPreset = page.locator('[data-testid="recipe-item-builtin-0"]');
  await firstPreset.click();

  await expect(menu).toBeHidden();
  await expect(convoInput).toHaveValue('List my action items from the last week.');
});
