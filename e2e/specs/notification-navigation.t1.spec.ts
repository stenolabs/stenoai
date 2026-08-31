import { test, expect } from '../fixtures/electron';
import { emitMainEvent } from '../fixtures/notifications';

/**
 * T1 - renderer-only, mock IPC. The navigation contract for the notification
 * flows, driven through the REAL main→renderer channels that main.js's
 * Notification click/action handlers emit on (`auto-record-requested`,
 * `navigate-to-meeting`). The native click itself is a macOS behavior the
 * harness can't script, but everything downstream of it - which is where the
 * "lands on the wrong screen" bugs lived - is pinned here.
 *
 *   - "Take Notes" (auto-record-requested) lands on the recording page from ANY
 *     route and STAYS there (the route-dependent bounce-home regression that
 *     read as "click twice"),
 *   - a notification click (navigate-to-meeting) opens that note.
 */

const PILL_ENV = { STENOAI_E2E_MOCK_PARAKEET_INSTALLED: '1' };

test('Take Notes lands on the recording page from a non-Home route and stays', async ({
  launchApp,
}) => {
  const { app, page } = await launchApp({ mockIpc: true, fakeAudio: true, env: PILL_ENV });

  // Start away from Home - this is the case that used to need a second click:
  // the just-started recording got bounced back off /recording during warm-up.
  await page.evaluate(() => {
    window.location.hash = '/settings';
  });
  await expect(page).toHaveURL(/#\/settings/);

  // One "Take Notes" (a single auto-record-requested event, as one native click
  // sends).
  await emitMainEvent(app, 'auto-record-requested', { sessionName: 'Note', appName: 'DevMeeting' });

  const recordingPage = page.getByTestId('recording-page');
  await expect(recordingPage).toBeVisible();

  // And it STAYS - past the 500ms bounce-home window - instead of being kicked
  // back to Home (which is what made it look like nothing happened).
  await page.waitForTimeout(700);
  await expect(recordingPage).toBeVisible();
  await expect(page).toHaveURL(/#\/recording/);
});

test('a notification click opens the target note', async ({ launchApp }) => {
  const { app, page } = await launchApp({ mockIpc: true, fakeAudio: true, env: PILL_ENV });

  const summaryFile = 'rec_20260803_demo_summary.md';
  await emitMainEvent(app, 'navigate-to-meeting', { summaryFile });

  await expect(page).toHaveURL(new RegExp(`#/meetings/${encodeURIComponent(summaryFile)}`));
});

test('an Obsidian preservation notification opens Integrations', async ({
  launchApp,
}) => {
  const { app, page } = await launchApp({ mockIpc: true, env: PILL_ENV });

  await emitMainEvent(app, 'tray-open-settings', { tab: 'integrations' });

  await expect(page).toHaveURL(/#\/settings\?tab=integrations/);
  await expect(
    page.locator('[data-settings-tab="integrations"]'),
  ).toBeVisible();
});
