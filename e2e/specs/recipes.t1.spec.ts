import { test, expect } from '../fixtures/electron';

/**
 * T1 — Recipes: the tab on Cookbooks (built-ins, create / edit / delete your
 * own, Run opens chat with the prompt filled in) and the `/` menu in chat,
 * which lists your recipes first. Mock store: app/e2e-mock-ipc.js
 * (recipes-*); the real store is covered by recipes.t2.
 */
test('Recipes: create one on Cookbooks, run it, and pick it from / in chat', async ({ launchApp }, testInfo) => {
  const { page } = await launchApp({ mockIpc: true, releaseHighlightsSeen: true });
  await page.evaluate(() => { window.location.hash = '#/chat'; });
  await page.getByRole('button', { name: /^Cookbooks/ }).click();
  // The intro carousel's second slide explains recipes and opens the tab.
  await page.getByRole('button', { name: 'Show “What\'s a recipe?”' }).click();
  const slide = page.getByRole('region', { name: "What's a recipe?" });
  await expect(slide).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath('recipe-slide.png') });
  await slide.getByRole('button', { name: 'See recipes' }).click();
  await expect(page.getByRole('tab', { name: 'Recipes' })).toHaveAttribute('aria-selected', 'true');

  const builtin = page.getByRole('region', { name: 'Built-in' });
  for (const name of ['Write weekly recap', 'What do I owe people', 'Draft the follow-up', 'Write a PRD']) {
    await expect(builtin.getByRole('region', { name, exact: true })).toBeVisible();
  }
  // Built-ins run but are not editable.
  await expect(builtin.getByRole('button', { name: /^Edit / })).toHaveCount(0);

  // The page's Create button makes a recipe while the Recipes tab is open.
  await page.getByRole('button', { name: 'Create' }).click();
  const dialog = page.getByRole('dialog', { name: 'New recipe' });
  await dialog.getByLabel('Name').fill('Standup digest');
  await dialog.getByLabel('Prompt').fill('Summarise this week\'s standups: blockers first.');
  await dialog.getByRole('button', { name: 'Save recipe' }).click();
  await expect(dialog).toHaveCount(0);
  const mine = page.getByRole('region', { name: 'My recipes' });
  await expect(mine.getByRole('region', { name: 'Standup digest' })).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath('recipes.png'), fullPage: true });

  // Run opens chat with the prompt filled in, not sent.
  await page.getByRole('button', { name: 'Run Standup digest' }).click();
  const input = page.getByRole('textbox', { name: 'Ask about your notes' });
  await expect(input).toHaveValue("Summarise this week's standups: blockers first.");

  // `/` lists your recipes first, marked Yours, then the built-ins.
  await input.fill('');
  await input.press('/');
  const menu = page.getByRole('menu', { name: 'Recipes' });
  const items = menu.getByRole('menuitem');
  await expect(items.first()).toContainText('Standup digest');
  await expect(items.first()).toContainText('Yours');
  await page.screenshot({ path: testInfo.outputPath('recipe-menu.png') });
  await expect(menu.getByRole('menuitem', { name: /Decision log/ })).toBeVisible();
  await menu.getByRole('menuitem', { name: /Decision log/ }).click();
  await expect(input).toHaveValue(/^List the decisions made across my recent meetings/);

  // Manage recipes goes back to the Recipes tab; edit, then delete.
  await input.fill('');
  await input.press('/');
  await page.getByRole('button', { name: 'Manage recipes' }).click();
  await expect(page.getByRole('tab', { name: 'Recipes' })).toHaveAttribute('aria-selected', 'true');
  await page.getByRole('button', { name: 'Edit Standup digest' }).click();
  const edit = page.getByRole('dialog', { name: 'Edit recipe' });
  await edit.getByRole('button', { name: 'Delete' }).click();
  const confirm = page.getByRole('dialog', { name: 'Delete recipe "Standup digest"?' });
  await confirm.getByRole('button', { name: 'Delete', exact: true }).click();
  await expect(page.getByRole('region', { name: 'Standup digest' })).toHaveCount(0);
});
