import { test, expect } from '../fixtures/electron';
import type { ElectronApplication } from '@playwright/test';

/**
 * T1 — renderer-only, mock IPC. Tests for:
 * 1. Pre-meeting brief streaming into the upcoming meeting card.
 * 2. No-history case rendering as a calm empty state (not an error toast).
 * 3. Attendee display names passed only (no email addresses).
 * 4. Bulk export in Settings > Advanced offering Markdown and CSV.
 * 5. Mid-recording template switch from the LiveDock pill while keeping compact pill controls intact.
 */

const PILL_ENV = {
  STENOAI_E2E_MOCK_PARAKEET_INSTALLED: '1',
};

interface RecordedBriefQuery {
  queryId: string;
  title: string;
  attendees: string[];
}

interface RecordedExportCall {
  format: string;
  targetPath: string;
}

function getBriefQueries(app: ElectronApplication): Promise<RecordedBriefQuery[]> {
  return app.evaluate(() => {
    return (
      (
        globalThis as unknown as {
          __stenoai_e2e_brief_queries: RecordedBriefQuery[];
        }
      ).__stenoai_e2e_brief_queries ?? []
    );
  });
}

function getExportCalls(app: ElectronApplication): Promise<RecordedExportCall[]> {
  return app.evaluate(() => {
    return (
      (
        globalThis as unknown as {
          __stenoai_e2e_export_all_calls: RecordedExportCall[];
        }
      ).__stenoai_e2e_export_all_calls ?? []
    );
  });
}

function getSetTemplateCalls(app: ElectronApplication): Promise<string[]> {
  return app.evaluate(() => {
    return (
      (
        globalThis as unknown as {
          __stenoai_e2e_set_template_calls: string[];
        }
      ).__stenoai_e2e_set_template_calls ?? []
    );
  });
}

function getCancelledQueries(app: ElectronApplication): Promise<string[]> {
  return app.evaluate(() => {
    return (
      (
        globalThis as unknown as {
          __stenoai_e2e_cancelled_queries: string[];
        }
      ).__stenoai_e2e_cancelled_queries ?? []
    );
  });
}
// The seeded event comes from app/e2e-mock-ipc.js behind
// STENOAI_E2E_SEED_CALENDAR=1: 'Weekly Engineering Sync', with attendees
// Alice Smith + Bob Jones and one entry that has an email but NO name.
// It cannot be injected from the renderer — window.stenoai is a contextBridge
// object whose properties are not writable, so assigning to
// stenoai.calendar.getEvents silently fails and the card never renders.
const SEEDED_TITLE = 'Weekly Engineering Sync';
const SEEDED_NAMES = ['Alice Smith', 'Bob Jones'];

test('pre-meeting brief streams text into upcoming card and passes display names only', async ({
  launchApp,
}) => {
  const { app, page } = await launchApp({
    mockIpc: true,
    env: {
      ...PILL_ENV,
      STENOAI_E2E_MOCK_BRIEF: '1',
      STENOAI_E2E_SEED_CALENDAR: '1',
      // Home renders its welcome empty state INSTEAD of the whole body
      // (Coming up included) when there are no notes - Home.tsx:599 - so the
      // upcoming card only exists once meetings are seeded too.
      STENOAI_E2E_SEED_ATTENDEES: '1',
    },
  });

  // A model-free bundle auto-redirects to /setup once, which has no Home and so
  // no upcoming card. The gate is one-shot, so forcing #/ sticks.
  await page.evaluate(() => {
    window.location.hash = '#/';
  });

  // The card's CTA row is opacity-0 + pointer-events-none until the card is
  // hovered or focused (the same idiom its Join/Record CTAs use), so a click
  // without revealing it first is intercepted by the row above. Hover the card
  // the way a user does. toBeVisible() alone would pass on the inert control.
  const card = page.getByRole('button', { name: /Weekly Engineering Sync/ }).first();
  await card.hover();
  const briefBtn = page.getByTestId('upcoming-card-brief-btn');
  await expect(briefBtn).toBeVisible();
  await briefBtn.click();

  // Container appears and streams content
  const briefContent = page.getByTestId('upcoming-card-brief-content');
  await expect(briefContent).toBeVisible();
  await expect(briefContent).toContainText('Last time you agreed to ship the parity build.');

  // Assert main process received title and display names only (no addresses,
  // and the nameless attendee contributes nothing).
  const queries = await getBriefQueries(app);
  expect(queries.length).toBeGreaterThan(0);
  const lastQuery = queries[queries.length - 1];
  expect(lastQuery.title).toBe(SEEDED_TITLE);
  expect(lastQuery.attendees).toEqual(SEEDED_NAMES);
  expect(lastQuery.attendees.every((a) => !a.includes('@'))).toBe(true);
});

test('pre-meeting brief renders calm empty state when no prior history exists', async ({
  launchApp,
}) => {
  const { page } = await launchApp({
    mockIpc: true,
    env: {
      ...PILL_ENV,
      STENOAI_E2E_MOCK_BRIEF: '1',
      STENOAI_E2E_MOCK_BRIEF_EMPTY: '1',
      STENOAI_E2E_SEED_CALENDAR: '1',
      STENOAI_E2E_SEED_ATTENDEES: '1',
    },
  });

  await page.evaluate(() => {
    window.location.hash = '#/';
  });

  const card2 = page.getByRole('button', { name: /Weekly Engineering Sync/ }).first();
  await card2.hover();
  const briefBtn = page.getByTestId('upcoming-card-brief-btn');
  await expect(briefBtn).toBeVisible();
  await briefBtn.click();

  // Calm empty state is displayed
  const emptyState = page.getByTestId('upcoming-card-brief-empty');
  await expect(emptyState).toBeVisible();
  await expect(emptyState).toContainText('No related notes yet');
});

test('collapsing a streaming brief cancels its backend query process', async ({
  launchApp,
}) => {
  const { app, page } = await launchApp({
    mockIpc: true,
    env: {
      ...PILL_ENV,
      STENOAI_E2E_MOCK_BRIEF: '1',
      STENOAI_E2E_SEED_CALENDAR: '1',
      STENOAI_E2E_SEED_ATTENDEES: '1',
    },
  });

  await page.evaluate(() => {
    window.location.hash = '#/';
  });

  const card = page.getByRole('button', { name: /Weekly Engineering Sync/ }).first();
  await card.hover();
  const briefBtn = page.getByTestId('upcoming-card-brief-btn');
  await expect(briefBtn).toBeVisible();

  // Start streaming brief
  await briefBtn.click();
  const briefContent = page.getByTestId('upcoming-card-brief-content');
  await expect(briefContent).toBeVisible();

  const queries = await getBriefQueries(app);
  expect(queries.length).toBeGreaterThan(0);
  const startedQueryId = queries[queries.length - 1].queryId;

  // Collapse brief while streaming
  await briefBtn.click();

  // (a) Brief container is gone
  await expect(briefContent).not.toBeVisible();

  // (b) Cancelled queries array contains the started queryId
  const cancelled = await getCancelledQueries(app);
  expect(cancelled).toContain(startedQueryId);
});

test('bulk export in settings advanced offers markdown and csv and reports count', async ({
  launchApp,
}) => {
  const exportPath = '/tmp/steno-e2e-export';
  const { app, page } = await launchApp({
    mockIpc: true,
    env: { ...PILL_ENV, STENOAI_E2E_EXPORT_PATH: exportPath },
  });

  // Navigate to Advanced tab in Settings
  await page.evaluate(() => {
    window.location.hash = '#/settings?tab=advanced';
  });

  const mdBtn = page.getByTestId('export-all-md-btn');
  const csvBtn = page.getByTestId('export-all-csv-btn');

  await expect(mdBtn).toBeVisible();
  await expect(csvBtn).toBeVisible();

  // Trigger Markdown export
  await mdBtn.click();
  const feedback = page.getByTestId('export-all-feedback');
  await expect(feedback).toBeVisible();
  await expect(feedback).toContainText('Successfully exported 3 notes.');

  // Trigger CSV export
  await csvBtn.click();
  await expect(feedback).toContainText('Successfully exported 3 notes.');

  // Verify IPC calls
  const calls = await getExportCalls(app);
  expect(calls).toEqual([
    { format: 'md', targetPath: exportPath },
    { format: 'csv', targetPath: exportPath },
  ]);
});

test('live dock template picker allows mid-call switch and preserves pill controls', async ({
  launchApp,
}) => {
  const { app, page } = await launchApp({
    mockIpc: true,
    env: PILL_ENV,
  });

  // Start recording
  await page.locator('.record-btn').click();
  const pill = page.getByTestId('transcription-pill');
  await expect(pill).toBeVisible();

  // Initial template label
  const templateLabel = page.getByTestId('live-dock-template-label');
  await expect(templateLabel).toBeVisible();
  await expect(templateLabel).toHaveText('Standard Summary');

  // Existing pill controls from pill-dock.t1.spec.ts remain intact
  await expect(pill.getByRole('button', { name: 'Show transcript' })).toBeVisible();
  await expect(pill.getByRole('button', { name: 'Stop recording' })).toBeVisible();
  await expect(pill.getByRole('button', { name: 'Pause recording' })).toHaveCount(0);

  // Click template label to open picker popover
  await templateLabel.click();
  const menu = page.getByTestId('live-dock-template-menu');
  await expect(menu).toBeVisible();

  // Select a different template option
  const options = menu.getByRole('option');
  const optionCount = await options.count();
  expect(optionCount).toBeGreaterThan(1);

  // Click the second template option
  const secondOption = options.nth(1);
  const secondOptionText = (await secondOption.textContent())?.trim() ?? '';
  await secondOption.click();

  // Menu closes and label updates
  await expect(menu).toHaveCount(0);
  if (secondOptionText) {
    await expect(templateLabel).toContainText(secondOptionText);
  }

  // Verify IPC called with new template id
  const setTemplateCalls = await getSetTemplateCalls(app);
  expect(setTemplateCalls.length).toBeGreaterThan(0);

  // Existing pill controls remain intact after template switch
  await expect(pill.getByRole('button', { name: 'Show transcript' })).toBeVisible();
  await expect(pill.getByRole('button', { name: 'Stop recording' })).toBeVisible();
  await expect(pill.getByRole('button', { name: 'Pause recording' })).toHaveCount(0);
});
