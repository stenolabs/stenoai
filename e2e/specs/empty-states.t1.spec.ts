import { test, expect } from '../fixtures/electron';

/**
 * T1 — empty states each offer one clear next step: a space with no notes,
 * a search with no results, and a Chat page with no past chats.
 */

const SHOTS = process.env.STENOAI_E2E_SHOTS_DIR;

test('Home with no notes welcomes you with one primary action and ways to start', async ({ launchApp }) => {
  const { page } = await launchApp({ mockIpc: true, env: { STENOAI_E2E_MOCK_PARAKEET_INSTALLED: '1' } });
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.evaluate(() => { window.location.hash = '#/'; });
  const welcome = page.getByTestId('home-welcome');
  await expect(welcome.getByRole('heading', { name: 'Welcome to Steno.' })).toBeVisible();
  await expect(welcome.getByText('Always get consent when transcribing others.')).toBeVisible();
  await expect(welcome.getByRole('button', { name: 'New note', exact: true })).toBeVisible();
  for (const id of ['record', 'import', 'cookbooks']) await expect(page.getByTestId(`home-start-${id}`)).toBeVisible();
  if (SHOTS) {
    await page.emulateMedia({ colorScheme: 'light', reducedMotion: 'reduce' });
    await page.screenshot({ path: `${SHOTS}/polish-home-empty-light.png` });
    await page.emulateMedia({ colorScheme: 'dark', reducedMotion: 'reduce' });
    await expect(page.locator('html')).toHaveClass(/dark/);
    await page.waitForTimeout(600); // let colour transitions settle
    await page.screenshot({ path: `${SHOTS}/polish-home-empty-dark.png` });
  }

  // Each way to start leads somewhere real.
  await page.getByTestId('home-start-cookbooks').getByRole('button', { name: 'Browse cookbooks' }).click();
  await expect.poll(() => page.evaluate(() => window.location.hash)).toBe('#/cookbooks');
});

test('an empty space offers a way back to all notes', async ({ launchApp }) => {
  const { page } = await launchApp({ mockIpc: true, env: { STENOAI_E2E_SEED_FOLDERS: '1', STENOAI_E2E_SEED_MEETINGS: '1' } });
  await page.evaluate(() => { window.location.hash = '#/folders/f-eng'; });
  const empty = page.getByTestId('folder-empty');
  await expect(empty.getByText('Nothing here yet')).toBeVisible();
  if (SHOTS) await page.screenshot({ path: `${SHOTS}/polish-empty-space.png` });
  await empty.getByRole('button', { name: 'Browse all notes' }).click();
  await expect.poll(() => page.evaluate(() => window.location.hash)).toBe('#/meetings');
});

test('a search with no results can be cleared in one click', async ({ launchApp }) => {
  const { page } = await launchApp({ mockIpc: true, env: { STENOAI_E2E_SEED_MEETINGS: '1' } });
  await page.evaluate(() => { window.location.hash = '#/meetings'; });
  const search = page.getByRole('textbox', { name: 'Search notes' });
  await search.fill('zzqx no such meeting');
  const empty = page.getByTestId('search-empty');
  await expect(empty.getByText('No meetings match “zzqx no such meeting”.')).toBeVisible();
  if (SHOTS) await page.screenshot({ path: `${SHOTS}/polish-empty-search.png` });
  await empty.getByRole('button', { name: 'Clear search' }).click();
  await expect(search).toHaveValue('');
  await expect(empty).toHaveCount(0);
});

test('Chat with no history suggests a first question', async ({ launchApp }) => {
  const { page } = await launchApp({ mockIpc: true });
  await page.evaluate(() => { window.location.hash = '#/chat'; });
  await expect(page.getByText('Your past chats will show up here.')).toBeVisible();
  await page.getByRole('button', { name: /^Try “/ }).click();
  await expect(page.getByRole('textbox', { name: 'Ask about your notes' })).not.toHaveValue('');
  await expect(page.getByRole('textbox', { name: 'Ask about your notes' })).toBeFocused();
});
