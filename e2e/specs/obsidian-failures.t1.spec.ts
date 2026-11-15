import { test, expect } from '../fixtures/electron';
import path from 'path';

test('cached Obsidian failures hide when sync is disabled or the vault is cleared', async ({
  launchApp,
  userDataDir,
}) => {
  // All IPCs are mocked; this synthetic vault path is never opened or written.
  const { app, page } = await launchApp({
    mockIpc: true,
    releaseHighlightsSeen: true,
    env: { STENOAI_E2E_OBSIDIAN_VAULT: path.join(userDataDir, 'synthetic-vault') },
  });
  expect(await app.evaluate(() => process.env.STENOAI_USER_DATA_DIR)).toBe(userDataDir);

  await page.evaluate(() => { window.location.hash = '#/settings?tab=integrations'; });
  const section = page.locator('[data-settings-tab="integrations"]');
  const alert = section.locator('[data-obsidian-failures]');
  const toggle = section.getByRole('switch', { name: 'Sync to Obsidian' });
  await expect(alert).toHaveText(
    '1 note failed to sync to your Obsidian vault. Latest error: EACCES. ' +
      'Check that the vault folder exists and is writable.',
  );

  await toggle.click();
  await expect(toggle).toHaveAttribute('aria-checked', 'false');
  await expect(alert).toHaveCount(0);
  await toggle.click();
  await expect(alert).toBeVisible();
  await section.getByRole('button', { name: 'Clear', exact: true }).click();
  await expect(alert).toHaveCount(0);
  await expect(section.getByText(/Sync is on but no vault folder is set yet/)).toBeVisible();
});
