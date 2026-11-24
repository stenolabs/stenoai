import { test, expect } from '../fixtures/electron';

/**
 * T1 — the note's transcript toggle (beside the Ask bar) opens the floating
 * transcript and a second click closes it. Regression: the Ask bar's
 * click-outside handler closed it on mousedown and the click reopened it.
 */
test('the transcript toggle opens and closes the transcript', async ({ launchApp }) => {
  const { page } = await launchApp({ mockIpc: true, env: { STENOAI_E2E_SEED_MEETING: '1' } });
  await page.evaluate(() => {
    window.location.hash = `#/meetings/${encodeURIComponent('epsilon_summary.json')}`;
  });
  const toggle = page.getByTestId('transcript-toggle');
  const panel = page.locator('[data-transcript-bar]');
  await toggle.click();
  await expect(panel).toBeVisible();
  await expect(toggle).toHaveAttribute('aria-pressed', 'true');
  await toggle.click();
  await expect(panel).toHaveCount(0);
  await expect(toggle).toHaveAttribute('aria-pressed', 'false');
});
