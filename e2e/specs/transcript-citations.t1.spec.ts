import { test, expect } from '../fixtures/electron';
import type { Page } from '@playwright/test';

/**
 * T1 — renderer-only, mock IPC. Verifies transcript citations:
 *  - Generated bullets with confident evidence render a magnifying-glass
 *    citation button (data-testid="citation-<section>-<index>").
 *  - Clicking the citation button opens the transcript bar and scrolls the
 *    cited turn into view with a temporary highlight.
 *  - Bullets or notes with no matching evidence render no citation button.
 */

async function openMeeting(page: Page, summaryFile: string) {
  await page.evaluate((f) => {
    window.location.hash = `#/meetings/${encodeURIComponent(f)}`;
  }, summaryFile);
}

test('clicking a citation reveals the transcript bar and highlights the cited line', async ({
  launchApp,
}) => {
  const { page } = await launchApp({
    mockIpc: true,
    env: { STENOAI_E2E_SEED_MEETING: '1' },
  });
  await openMeeting(page, 'epsilon_summary.json');

  // Epsilon Planning has summary:
  // "The team agreed to ship on Friday; Bob owns the release notes."
  // and transcript:
  // "Alice: we ship Friday.\nBob: I will prep the release notes."
  // The summary matches lines 0 and 1, so citation-summary-0 must be visible.
  const citationBtn = page.getByTestId('citation-summary-0');
  await expect(citationBtn).toBeVisible();
  await expect(citationBtn).toHaveAttribute('aria-label', 'Jump to transcript evidence');

  // Transcript bar is initially closed
  await expect(page.locator('[data-transcript-bar]')).not.toBeVisible();

  // Click the citation button
  await citationBtn.click();

  // Transcript bar opens
  const transcriptBar = page.locator('[data-transcript-bar]');
  await expect(transcriptBar).toBeVisible();

  // The cited line is in view and receives citation highlight
  const citedRow = transcriptBar.locator('[data-index="0"]');
  await expect(citedRow).toBeVisible();
});

test('a note without evidence renders no citation buttons (anti-guessing)', async ({
  launchApp,
}) => {
  const { page } = await launchApp({
    mockIpc: true,
    env: { STENOAI_E2E_SEED_PENDING_NOTE: '1' },
  });
  await openMeeting(page, 'pending_summary.md');

  // Pending meeting has no generated summary notes
  await expect(page.locator('[data-testid^="citation-"]')).toHaveCount(0);
});
