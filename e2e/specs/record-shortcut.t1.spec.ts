import { test, expect } from '../fixtures/electron';

/**
 * T1 — the Settings → Preferences "Record shortcut" capture control, under
 * mock IPC: pressing a combination saves it and every hint shows the new
 * keys; a combination without a modifier is refused in the UI; one "another
 * app" owns (STENOAI_E2E_MOCK_HOTKEY_IN_USE) shows the in-use warning and
 * keeps the old shortcut; Reset to default restores ⌃⌥R / Ctrl+Alt+R. The
 * real globalShortcut registration is covered by record-hotkey.t2.
 */
test('record shortcut: capture, refuse, in-use warning, reset', async ({ launchApp }) => {
  const { page } = await launchApp({
    mockIpc: true,
    env: { STENOAI_E2E_MOCK_HOTKEY_IN_USE: 'Control+Alt+K' },
  });
  await page.evaluate(() => {
    window.location.hash = '#/settings?tab=general';
  });
  const section = page.locator('[data-settings-tab="general"]');
  await expect(section.getByText('Record shortcut', { exact: true })).toBeVisible();

  const isMac = await page.evaluate(() => window.stenoai.app.platform === 'darwin');
  const capture = section.getByTestId('record-shortcut-capture');
  await expect(capture).toHaveAccessibleName(`Change record shortcut, currently ${isMac ? '⌃⌥R' : 'Ctrl+Alt+R'}`);
  await expect(section.getByRole('button', { name: 'Reset to default' })).toHaveCount(0);

  // A key with no modifier is refused and nothing is saved.
  await capture.click();
  await expect(capture).toHaveAccessibleName('Press keys…');
  await page.keyboard.press('KeyJ');
  await expect(section.getByRole('alert')).toHaveText('Include Control, Alt or another modifier key.');

  // A real combination is saved.
  await page.keyboard.press('Control+Alt+J');
  await expect(capture).toHaveAccessibleName(`Change record shortcut, currently ${isMac ? '⌃⌥J' : 'Ctrl+Alt+J'}`);
  await expect(section.getByText(`Start or stop recording from anywhere with ${isMac ? '⌃⌥J' : 'Ctrl+Alt+J'}.`, { exact: false })).toBeVisible();

  // One another app owns: warning, old shortcut kept.
  await capture.click();
  await page.keyboard.press('Control+Alt+K');
  await expect(section.getByRole('alert')).toContainText('is already in use by another app');
  await expect(capture).toHaveAccessibleName(`Change record shortcut, currently ${isMac ? '⌃⌥J' : 'Ctrl+Alt+J'}`);

  await section.getByRole('button', { name: 'Reset to default' }).click();
  await expect(capture).toHaveAccessibleName(`Change record shortcut, currently ${isMac ? '⌃⌥R' : 'Ctrl+Alt+R'}`);
  await expect(section.getByRole('button', { name: 'Reset to default' })).toHaveCount(0);
});
