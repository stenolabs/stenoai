import { test, expect } from '../fixtures/electron';

/**
 * T1 — renderer-only, mock IPC. Drives the global ⌘K command palette (#213):
 * opens from the shortcut + the sidebar trigger, searches note title/summary,
 * keyboard-navigates, and opens a note. Meetings are seeded via the mock
 * (STENOAI_E2E_SEED_MEETINGS=1 in app/e2e-mock-ipc.js).
 */

const palette = '[data-testid="command-palette"]';
const input = '[data-testid="command-palette-input"]';
const result = '[data-testid="command-palette-result"]';

const launchOpts = { mockIpc: true, env: { STENOAI_E2E_SEED_MEETINGS: '1' } } as const;

test('⌘K opens the palette and searches note content', async ({ launchApp }) => {
  const { page } = await launchApp(launchOpts);

  await page.keyboard.press('ControlOrMeta+k');
  await expect(page.locator(palette)).toBeVisible();

  // Empty query shows recent notes (all 3 seeds), newest-first. The seeds are
  // inserted oldest-first, so this order proves the recency sort runs (not just
  // insertion order).
  await expect(page.locator(result)).toHaveCount(3);
  await expect(page.locator(result).nth(0)).toContainText('Q3 Budget review');
  await expect(page.locator(result).nth(2)).toContainText('Standup notes');

  // "budget" matches a title (Q3 Budget review) + a summary (Marketing sync).
  await page.locator(input).fill('budget');
  await expect(page.locator(result)).toHaveCount(2);
  await expect(page.locator(palette)).toContainText('Q3 Budget review');
  await expect(page.locator(palette)).toContainText('Marketing sync');
});

test('arrow + enter opens the selected note; esc closes', async ({ launchApp }) => {
  const { page } = await launchApp(launchOpts);

  await page.keyboard.press('ControlOrMeta+k');
  // "budget" matches two notes (Q3 Budget review title, Marketing sync summary),
  // newest-first. ArrowDown moves selection from the first to the second.
  await page.locator(input).fill('budget');
  await expect(page.locator(result)).toHaveCount(2);
  await expect(page.locator('[data-index="0"]')).toHaveAttribute('aria-selected', 'true');

  await page.keyboard.press('ArrowDown');
  await expect(page.locator('[data-index="1"]')).toHaveAttribute('aria-selected', 'true');

  await page.keyboard.press('Enter');
  await expect(page.locator(palette)).toBeHidden();
  await expect
    .poll(() => page.evaluate(() => window.location.hash))
    .toContain('/meetings/marketing.json');
});

test('esc closes the palette', async ({ launchApp }) => {
  const { page } = await launchApp(launchOpts);

  await page.keyboard.press('ControlOrMeta+k');
  await expect(page.locator(palette)).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.locator(palette)).toBeHidden();
});

test('sidebar search box opens the palette', async ({ launchApp }) => {
  const { page } = await launchApp(launchOpts);

  // Under mock IPC the app lands on the setup wizard (no model installed),
  // which has no sidebar. Go to Home, which renders it. The one-shot setup
  // gate already fired on launch, so it won't redirect us back.
  await page.evaluate(() => {
    window.location.hash = '#/';
  });

  await page.locator('[data-testid="sidebar-search-trigger"]').click();
  await expect(page.locator(palette)).toBeVisible();

  await page.keyboard.press('Escape');
  await expect(page.locator(palette)).toBeHidden();
});

test('finds transcript-only match and labels it as a Transcript hit', async ({ launchApp }) => {
  const { page } = await launchApp({
    mockIpc: true,
    env: { STENOAI_E2E_SEED_MEETING: '1' },
  });

  await page.keyboard.press('ControlOrMeta+k');
  await expect(page.locator(palette)).toBeVisible();

  // "prep the release notes" only appears in SEED_MEETING's transcript
  // (title is "Epsilon Planning", no summary).
  await page.locator(input).fill('prep the release notes');
  await expect(page.locator(result)).toHaveCount(1);
  await expect(page.locator(result).nth(0)).toContainText('Epsilon Planning');
  await expect(page.locator(result).nth(0)).toContainText('Transcript');
  await expect(page.locator(result).nth(0)).toContainText('prep the release notes');
});
