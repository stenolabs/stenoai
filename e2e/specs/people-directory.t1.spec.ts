import { test, expect } from '../fixtures/electron';

/**
 * T1 — renderer-only, mock IPC. Validates the People directory:
 * - Lists attendees discovered across notes with accurate note counts.
 * - Selecting a person filters the view to that person's notes.
 * - The scoped ask form opens a new chat carrying exactly that person's summaryFiles.
 * - Meetings with no attendees contribute nobody to the directory.
 * - Empty state is clear and actionable when no notes have attendees.
 */

const ATTENDEES_ENV = {
  STENOAI_E2E_SEED_ATTENDEES: '1',
  STENOAI_E2E_MOCK_GLOBAL_CHAT: '1',
};

interface GlobalChatQuery {
  queryId: string;
  question: string;
  folderId: string | null;
  meetingFiles: string[] | null;
}

interface TestGlobal {
  __stenoai_e2e_global_chat_queries?: GlobalChatQuery[];
}

test('People directory lists attendees with correct counts from seeded meetings', async ({
  launchApp,
}) => {
  const { page } = await launchApp({ mockIpc: true, env: ATTENDEES_ENV });

  // A model-free bundle auto-redirects to /setup once, and /setup has no
  // sidebar. The gate is one-shot, so forcing #/ sticks (same pattern as
  // command-palette.t1 and meeting-delete-ux.t1).
  await page.evaluate(() => {
    window.location.hash = '#/';
  });

  // Navigate via sidebar nav button
  const sidebarNav = page.getByTestId('sidebar-nav-people');
  await expect(sidebarNav).toBeVisible();
  await expect(sidebarNav).toHaveText(/People directory/);
  await sidebarNav.click();

  await expect(page).toHaveURL(/#\/people/);
  await expect(page.getByRole('heading', { name: 'People', exact: true })).toBeVisible();

  // Seed has 1 (Audrey) + 3 (Alice, Bob, Charlie) + 30 (Colleagues) = 34 attendees
  await expect(page.getByText('34 people')).toBeVisible();

  // Check specific attendee rows
  const audreyRow = page.getByTestId('person-row-dr. audrey tang');
  await expect(audreyRow).toBeVisible();
  await expect(audreyRow).toContainText('Dr. Audrey Tang');
  await expect(audreyRow).toContainText('1 note');

  const aliceRow = page.getByTestId('person-row-alice smith');
  await expect(aliceRow).toBeVisible();
  await expect(aliceRow).toContainText('Alice Smith');
  await expect(aliceRow).toContainText('1 note');

  // Solo Brainstorming / Sprint Planning / Design Review have no attendees — ensure 'Self' does not appear
  await expect(page.getByTestId('person-row-self')).toHaveCount(0);
});

test('selecting an attendee shows their notes and back button returns to directory', async ({
  launchApp,
}) => {
  const { page } = await launchApp({ mockIpc: true, env: ATTENDEES_ENV });

  await page.evaluate(() => {
    window.location.hash = '#/people';
  });

  // Select Dr. Audrey Tang
  const audreyRow = page.getByTestId('person-row-dr. audrey tang');
  await audreyRow.click();

  await expect(page).toHaveURL(/#\/people\/dr\.\s*audrey\s*tang|#\/people\/dr\.%20audrey%20tang/i);
  await expect(page.getByTestId('person-detail-name')).toHaveText('Dr. Audrey Tang');

  // Audrey only attended 1-on-1 Catchup
  const notesList = page.getByTestId('person-notes-list');
  await expect(notesList).toContainText('1-on-1 Catchup');
  await expect(notesList).not.toContainText('Weekly Engineering Sync');

  // Navigate back
  const backBtn = page.getByTestId('people-back-button');
  await expect(backBtn).toBeVisible();
  await backBtn.click();

  await expect(page).toHaveURL(/#\/people$/);
  await expect(page.getByRole('heading', { name: 'People', exact: true })).toBeVisible();

  // Select Alice Smith
  const aliceRow = page.getByTestId('person-row-alice smith');
  await aliceRow.click();
  await expect(page.getByTestId('person-detail-name')).toHaveText('Alice Smith');

  // Alice attended Weekly Engineering Sync
  await expect(page.getByTestId('person-notes-list')).toContainText('Weekly Engineering Sync');
  await expect(page.getByTestId('person-notes-list')).not.toContainText('1-on-1 Catchup');
});

test('scoped ask from person view opens chat with exactly that person notes', async ({
  launchApp,
}) => {
  const { app, page } = await launchApp({ mockIpc: true, env: ATTENDEES_ENV });

  await page.evaluate(() => {
    window.location.hash = '#/people/alice%20smith';
  });

  await expect(page.getByTestId('person-detail-name')).toHaveText('Alice Smith');

  const askInput = page.getByTestId('person-ask-input');
  await expect(askInput).toBeVisible();
  await askInput.fill('What action items did Alice take?');

  const submitBtn = page.getByTestId('person-ask-submit');
  await submitBtn.click();

  // Should navigate to chat conversation
  await expect(page).toHaveURL(/#\/chat\/s-/);
  await expect(page.locator('text=Based on the selected notes')).toBeVisible({ timeout: 10_000 });

  // Verify IPC captured query scope
  const queries = await app.evaluate(() => {
    const g = globalThis as unknown as TestGlobal;
    return g.__stenoai_e2e_global_chat_queries ?? [];
  });

  expect(queries.length).toBeGreaterThanOrEqual(1);
  const q = queries[0];
  expect(q.question).toBe('What action items did Alice take?');
  expect(q.folderId).toBeNull();
  expect(q.meetingFiles).toEqual(['team_sync.json']);
});

test('empty state renders helpfully when no meetings have attendees', async ({
  launchApp,
}) => {
  const { page } = await launchApp({ mockIpc: true });

  await page.evaluate(() => {
    window.location.hash = '#/people';
  });

  await expect(page.getByRole('heading', { name: 'No attendees yet' })).toBeVisible();
  await expect(
    page.getByText('Attendees are automatically discovered from calendar-matched meetings.'),
  ).toBeVisible();
  await expect(page.getByRole('button', { name: 'Back to Home' })).toBeVisible();
});
