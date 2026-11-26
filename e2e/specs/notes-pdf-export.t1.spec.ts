import { test, expect } from '../fixtures/electron';
import { openShareMenu } from '../fixtures/share-menu';
import type { Page } from '@playwright/test';
import { readFileSync, rmSync, mkdtempSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';

/**
 * T1 — renderer-only, mock IPC, no backend. Drives the REAL MeetingDetail
 * "Save notes as PDF…" action against a seeded meeting, proving the renderer
 * BUILDS the branded HTML document from meeting data and WIRES it to the
 * export-note-pdf channel. The T2 spec proves the real handler rasterises that
 * HTML into a valid PDF; the HTML *content* (sections, escaping, brand chrome)
 * is asserted here, where the mock writes the received HTML verbatim to the
 * STENOAI_E2E_EXPORT_PATH seam.
 */

const SUMMARY_FILE = 'epsilon_summary.json';

async function openDetail(page: Page, summaryFile = SUMMARY_FILE) {
  await page.evaluate((f) => {
    window.location.hash = `#/meetings/${encodeURIComponent(f)}`;
  }, summaryFile);
  await expect(page.getByRole('button', { name: 'Share', exact: true })).toBeVisible();
}

test('Save notes as PDF passes the renderer-built branded HTML to export-note-pdf', async ({
  launchApp,
}) => {
  const outDir = mkdtempSync(path.join(tmpdir(), 'steno-pdf-t1-'));
  const outFile = path.join(outDir, 'notes.html');
  const { page } = await launchApp({
    mockIpc: true,
    env: { STENOAI_E2E_SEED_MEETING: '1', STENOAI_E2E_EXPORT_PATH: outFile },
  });

  try {
    await openDetail(page);

    const menu = await openShareMenu(page);
    await menu.getByRole('button', { name: /Save notes as PDF/ }).click();

    await expect
      .poll(
        () => {
          try {
            return readFileSync(outFile, 'utf8');
          } catch {
            return '';
          }
        },
        { timeout: 10_000, intervals: [200] },
      )
      .toContain('<!doctype html>');

    const html = readFileSync(outFile, 'utf8');

    // It's a complete, self-contained HTML document with the brand chrome.
    expect(html.startsWith('<!doctype html>')).toBe(true);
    expect(html).toContain('<h1>Epsilon Planning</h1>');
    expect(html).toContain('@font-face');
    expect(html).toContain('data:image/svg+xml;base64,');
    expect(html).toContain('www.stenoai.co');
    // The seeded meeting's structured note carried through.
    expect(html).toContain('>Summary</h2>');
  } finally {
    rmSync(outDir, { recursive: true, force: true });
  }
});

test('Save notes as PDF is enabled for a note with structured content', async ({ launchApp }) => {
  const { page } = await launchApp({ mockIpc: true, env: { STENOAI_E2E_SEED_MEETING: '1' } });
  await openDetail(page);
  const menu = await openShareMenu(page);
  await expect(menu.getByRole('button', { name: /Save notes as PDF/ })).toBeEnabled();
});

test('Save notes as PDF is disabled for a transcript-only note (no structured content)', async ({
  launchApp,
}) => {
  // A transcript-only note (auto-summarise off) has no summary/topics/points/
  // actions, so there is nothing to render — the action must be disabled even
  // though "Save transcript as .md…" (which needs only a transcript) is enabled.
  const { page } = await launchApp({
    mockIpc: true,
    env: { STENOAI_E2E_SEED_PENDING_NOTE: '1' },
  });
  await openDetail(page, 'pending_summary.md');
  const menu = await openShareMenu(page);
  await expect(menu.getByRole('button', { name: /Save notes as PDF/ })).toBeDisabled();
  await expect(menu.getByRole('button', { name: /Save notes as \.md/ })).toBeDisabled();
  await expect(menu.getByRole('button', { name: /Save transcript as \.md/ })).toBeEnabled();
});

/**
 * The PDF must carry whichever note is on screen, exactly like "Copy notes"
 * (#318). Before this, Save-as-PDF always exported the Standard structured
 * note — with a generated report open, the file silently disagreed with the
 * screen.
 */
test('Save notes as PDF exports the open template report, not the Standard note', async ({
  launchApp,
}) => {
  const outDir = mkdtempSync(path.join(tmpdir(), 'steno-pdf-report-t1-'));
  const outFile = path.join(outDir, 'notes.html');
  const { page } = await launchApp({
    mockIpc: true,
    env: {
      STENOAI_E2E_SEED_MEETING: '1',
      STENOAI_E2E_SEED_REPORT: '1',
      STENOAI_E2E_EXPORT_PATH: outFile,
    },
  });

  try {
    await openDetail(page);

    // Open the seeded report from the view-toggle's template dropdown.
    const menu = page.getByTestId('note-view-menu');
    await page.getByTestId('note-view-menu-trigger').click();
    await menu.getByRole('button', { name: /^Status Report/ }).click();
    await expect(page.getByText('Pipeline healthy')).toBeVisible();

    // Same menu as the first case above: this branch moves the save entries out
    // of the "…" menu into Share, so reach them through the Share fixture.
    const shareMenu = await openShareMenu(page);
    await shareMenu.getByRole('button', { name: /Save notes as PDF/ }).click();

    await expect
      .poll(
        () => {
          try {
            return readFileSync(outFile, 'utf8');
          } catch {
            return '';
          }
        },
        { timeout: 10_000, intervals: [200] },
      )
      .toContain('<!doctype html>');

    const html = readFileSync(outFile, 'utf8');

    // The report's markdown arrives RENDERED, not as raw markdown — the same
    // react-markdown output the detail view shows.
    expect(html).toContain('<li>Pipeline healthy</li>');
    expect(html).toContain('<li>Next: open the reqs</li>');
    expect(html).not.toContain('- Pipeline healthy');
    expect(html).toContain('<table>');
    expect(html).toContain(`<td><code>${'M'.repeat(128)}</code></td>`);
    expect(html).toContain('<td>Passed</td>');
    // Labelled with the template it came from.
    expect(html).toContain('>Status Report</h2>');
    // The Standard note's sections did NOT ride along.
    expect(html).not.toContain('>Key Topics</h2>');
    expect(html).not.toContain('Alice, Bob');
    // Reasoning is stripped, exactly as in the rendered view and the clipboard.
    expect(html).not.toContain('secret chain of thought');
    // Brand chrome is unchanged.
    expect(html).toContain('<h1>Epsilon Planning</h1>');
    expect(html).toContain('@font-face');
  } finally {
    rmSync(outDir, { recursive: true, force: true });
  }
});
