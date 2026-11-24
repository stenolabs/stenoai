import { test, expect } from '../fixtures/electron';

/**
 * T1 — the Chat page's dragonfly mascot: shown under the greeting, flapping
 * (float animation) while idle, and settled while the user types.
 */
test('the dragonfly sits under the greeting and settles while typing', async ({ launchApp }, testInfo) => {
  const { page } = await launchApp({ mockIpc: true });
  await page.evaluate(() => { window.location.hash = '#/chat'; });
  const mascot = page.getByTestId('chat-mascot').locator('.steno-mascot');
  await expect(mascot).toBeVisible();
  await expect(mascot).toHaveClass(/steno-mascot-float/);
  await page.screenshot({ path: testInfo.outputPath('chat-mascot.png') });

  await page.getByRole('textbox', { name: 'Ask about your notes' }).focus();
  await expect(mascot).not.toHaveClass(/steno-mascot-float/);
});
