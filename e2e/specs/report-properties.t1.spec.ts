import { test, expect } from '../fixtures/electron';

/**
 * T1 — renderer-only, mock IPC. A report that opens with YAML frontmatter
 * shows it as properties, folded away until asked for: "Properties" sits at the
 * right end of the view-switch row and opens all of them, in order, except
 * those the note's header already shows.
 *
 * Seams: STENOAI_E2E_SEED_MEETING=1 + STENOAI_E2E_SEED_REPORT=frontmatter seed
 * one meeting carrying one such report (app/e2e-mock-ipc.js).
 */

const SUMMARY_FILE = 'epsilon_summary.json';

test("a report's frontmatter is folded away until asked for", async ({ launchApp }) => {
  const { page } = await launchApp({
    mockIpc: true,
    env: { STENOAI_E2E_SEED_MEETING: '1', STENOAI_E2E_SEED_REPORT: 'frontmatter' },
  });
  await page.evaluate((f) => {
    window.location.hash = `#/meetings/${encodeURIComponent(f)}`;
  }, SUMMARY_FILE);

  const toggle = page.getByTestId('report-properties-toggle');
  // The Standard note has no frontmatter, so no toggle.
  await expect(page.getByTestId('note-view-toggle')).toBeVisible();
  await expect(toggle).toHaveCount(0);

  await page.getByTestId('note-view-menu-trigger').click();
  await page.getByTestId('note-view-menu').getByRole('button', { name: /^Client Call/ }).click();
  const report = page.getByTestId('report-content');
  await expect(report).toContainText('The Bcc field stayed empty');
  // The frontmatter no longer leaks into the prose.
  await expect(report).not.toContainText('organisation');

  // Closed by default, with the number of properties on the toggle.
  await expect(toggle).toHaveAttribute('aria-expanded', 'false');
  await expect(toggle).toHaveText('Properties5');
  await expect(page.getByTestId('report-properties')).toHaveCount(0);

  await toggle.click();
  await expect(toggle).toHaveAttribute('aria-expanded', 'true');
  const table = page.getByTestId('report-properties');
  await expect(table.locator('dt')).toHaveText(['client', 'organisation', 'issue', 'symptoms', 'resolved']);
  await expect(table).toContainText('Erika Mustermann');
  await expect(table).toContainText('yes');

  // My notes has no properties to show.
  await page.getByTestId('tab-notes').click();
  await expect(toggle).toHaveCount(0);
});
