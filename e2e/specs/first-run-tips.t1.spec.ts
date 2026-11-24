import { test, expect } from '../fixtures/electron';

/**
 * T1 — first-run tips (components/FirstRunTips.tsx, lib/tips.ts). Tips are off
 * for the rest of the suite; STENOAI_E2E_TIPS=1 turns them on here.
 */

const SHOTS = process.env.STENOAI_E2E_SHOTS_DIR;
const env = { STENOAI_E2E_TIPS: '1' };

test('a tip appears once, dismisses, and stays dismissed after a reload', async ({ launchApp }) => {
  const { page } = await launchApp({ mockIpc: true, env });
  await page.evaluate(() => { window.location.hash = '#/chat'; });

  const tip = page.getByTestId('first-run-tip');
  await expect(tip).toBeVisible();
  await expect(tip).toHaveAttribute('data-tip-id', 'chat-slash');
  await expect(tip.getByText('Type / for recipes')).toBeVisible();
  // Only ever one at a time.
  await expect(tip).toHaveCount(1);
  await expect(tip).toBeInViewport();
  if (SHOTS) await page.screenshot({ path: `${SHOTS}/polish-tip-chat.png` });

  await tip.getByRole('button', { name: 'Got it' }).click();
  await expect(tip).toHaveCount(0);

  await page.reload();
  await page.waitForSelector('[data-app-ready]');
  await page.evaluate(() => { window.location.hash = '#/chat'; });
  await expect(page.getByRole('textbox', { name: 'Ask about your notes' })).toBeVisible();
  // Give the tip's anchor poll (400 ms) time to have found the composer.
  await page.waitForTimeout(1200);
  await expect(tip).toHaveCount(0);
});

test('Connect shows its own tip once the actions heading is on screen', async ({ launchApp }) => {
  const { page } = await launchApp({ mockIpc: true, env });
  await page.evaluate(() => { window.location.hash = '#/connect'; });
  // Nothing is connected: the intro's one next step jumps to the actions.
  await page.getByRole('button', { name: 'Connect an app' }).click();
  const tip = page.getByTestId('first-run-tip');
  await expect(tip).toHaveAttribute('data-tip-id', 'connect-actions');
  await expect(tip).toBeVisible();
});

test('a tip steps aside while a dialog is open', async ({ launchApp }) => {
  const { page } = await launchApp({ mockIpc: true, env });
  await page.evaluate(() => { window.location.hash = '#/chat'; });
  const tip = page.getByTestId('first-run-tip');
  await expect(tip).toBeVisible();
  await page.keyboard.press('ControlOrMeta+k');
  await expect(page.getByRole('dialog').first()).toBeVisible();
  await expect(tip).toBeHidden();
  await page.keyboard.press('Escape');
  await expect(tip).toBeVisible();
});
