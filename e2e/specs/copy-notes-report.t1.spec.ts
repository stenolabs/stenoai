import { test, expect } from '../fixtures/electron';
import { openShareMenu } from '../fixtures/share-menu';
import type { Page } from '@playwright/test';

/**
 * T1 — renderer-only, mock IPC, no backend. "Copy notes" must copy whichever
 * note is on screen: with a generated template report open it copies THAT
 * report's markdown, not the Standard structured note (the regression: the
 * clipboard silently disagreed with the displayed report).
 *
 * Seams (mirrors of the real ones, see app/e2e-mock-ipc.js):
 *  - STENOAI_E2E_SEED_MEETING=1 + STENOAI_E2E_SEED_REPORT=1 seed one known
 *    meeting carrying one generated report (rep_e2e_1, "Status Report").
 *  - the clipboard is captured by replacing navigator.clipboard in-page (no OS
 *    clipboard dependency in CI), same recorder as transcript-export.t1.
 */

const SUMMARY_FILE = 'epsilon_summary.json';

async function installClipboardRecorder(page: Page) {
  await page.evaluate(() => {
    const w = window as unknown as { __clipboardWrites: string[] };
    w.__clipboardWrites = [];
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: {
        writeText: (text: string) => {
          w.__clipboardWrites.push(text);
          return Promise.resolve();
        },
      },
    });
  });
}

const clipboardWrites = (page: Page) =>
  page.evaluate(() => (window as unknown as { __clipboardWrites: string[] }).__clipboardWrites);

test('Copy notes copies the open report, and the Standard note when none is open', async ({
  launchApp,
}) => {
  const { page } = await launchApp({
    mockIpc: true,
    env: { STENOAI_E2E_SEED_MEETING: '1', STENOAI_E2E_SEED_REPORT: '1' },
  });
  await installClipboardRecorder(page);

  await page.evaluate((f) => {
    window.location.hash = `#/meetings/${encodeURIComponent(f)}`;
  }, SUMMARY_FILE);
  await expect(page.getByRole('button', { name: 'Share', exact: true })).toBeVisible();

  // The seeded report lives in the view-toggle's template dropdown (opened
  // from the right side of the split pill).
  const menu = page.getByTestId('note-view-menu');
  await page.getByTestId('note-view-menu-trigger').click();
  await expect(menu.getByRole('button', { name: /^Status Report/ })).toBeVisible();
  // Close the menu without changing the view (default = Summary/Standard).
  await page.keyboard.press('Escape');

  // Standard note open (active_report is null) → the structured-note copy.
  await (await openShareMenu(page)).getByRole('button', { name: 'Copy notes' }).click();
  let writes = await clipboardWrites(page);
  expect(writes).toHaveLength(1);
  expect(writes[0]).toContain('Epsilon Planning');
  expect(writes[0]).toContain('PARTICIPANTS');
  expect(writes[0]).toContain('Alice, Bob');
  expect(writes[0]).not.toContain('## Status Report');

  // Open the generated report from the dropdown, then copy → the report's md.
  await page.getByTestId('note-view-menu-trigger').click();
  await menu.getByRole('button', { name: /^Status Report/ }).click();
  await expect(page.getByText('Pipeline healthy')).toBeVisible();
  await (await openShareMenu(page)).getByRole('button', { name: 'Copy notes' }).click();
  writes = await clipboardWrites(page);
  expect(writes).toHaveLength(2);
  expect(writes[1]).toContain('Epsilon Planning');
  expect(writes[1]).toContain('- Pipeline healthy');
  expect(writes[1]).toContain('- Next: open the reqs');
  expect(writes[1]).not.toContain('PARTICIPANTS');
  // The seeded report starts with a <think> block; the copy must strip
  // reasoning like the rendered view does.
  expect(writes[1]).not.toContain('secret chain of thought');

  // Switching back to Summary (Standard) restores the structured-note copy.
  await page.getByTestId('note-view-menu-trigger').click();
  await menu.getByRole('button', { name: 'Summary', exact: true }).click();
  await (await openShareMenu(page)).getByRole('button', { name: 'Copy notes' }).click();
  writes = await clipboardWrites(page);
  expect(writes).toHaveLength(3);
  expect(writes[2]).toContain('PARTICIPANTS');
  expect(writes[2]).not.toContain('Pipeline healthy');
});
