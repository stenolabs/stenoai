import { test, expect } from '../fixtures/electron';
import type { Page } from '@playwright/test';

/**
 * T1 — renderer-only, mock IPC.
 * Verifies note metadata and search affordances:
 *  1. Attendees render as quiet metadata chips on notes that have them,
 *     collapsing gracefully for large meetings, and never as transcript speakers.
 *  2. Notes without attendees render no attendee chip at all.
 *  3. Search hits whose only match is in the transcript display the "Transcript"
 *     field label and snippet on the /meetings list rows.
 */

const ATTENDEES_ENV = { STENOAI_E2E_SEED_ATTENDEES: '1' };

async function openMeeting(page: Page, summaryFile: string) {
  await page.evaluate((f) => {
    window.location.hash = `#/meetings/${encodeURIComponent(f)}`;
  }, summaryFile);
}

test('meeting with single attendee displays the attendee name directly on the chip', async ({
  launchApp,
}) => {
  const { page } = await launchApp({ mockIpc: true, env: ATTENDEES_ENV });

  await openMeeting(page, 'single_attendee.json');

  const attendeeChip = page.getByTestId('attendees-chip');
  await expect(attendeeChip).toBeVisible();
  await expect(attendeeChip).toContainText('Dr. Audrey Tang');

  // Participants section only shows speakers, never calendar attendees
  const participantsSection = page.locator('section:has-text("Participants")');
  await expect(participantsSection).toBeVisible();
  await expect(participantsSection).toContainText('Audrey');
  await expect(participantsSection).not.toContainText('Dr. Audrey Tang');
});

test('meeting with multiple attendees shows count, and clicking opens popover with all names', async ({
  launchApp,
}) => {
  const { page } = await launchApp({ mockIpc: true, env: ATTENDEES_ENV });

  await openMeeting(page, 'team_sync.json');

  const attendeeChip = page.getByTestId('attendees-chip');
  await expect(attendeeChip).toBeVisible();
  await expect(attendeeChip).toContainText('3 invited');

  // Popover is initially closed
  await expect(page.getByTestId('attendees-popover')).toHaveCount(0);

  // Click to open popover
  await attendeeChip.click();
  const popover = page.getByTestId('attendees-popover');
  await expect(popover).toBeVisible();
  await expect(popover).toContainText('Attendees (3)');
  await expect(popover).toContainText('Alice Smith');
  await expect(popover).toContainText('Bob Jones');
  await expect(popover).toContainText('Charlie Brown');

  // Attendees are not added to speakers in Participants section
  const participantsSection = page.locator('section:has-text("Participants")');
  await expect(participantsSection).toContainText('Speaker 1');
  await expect(participantsSection).not.toContainText('Alice Smith');
});

test('meeting with 30 attendees collapses into compact chip without pushing content off screen', async ({
  launchApp,
}) => {
  const { page } = await launchApp({ mockIpc: true, env: ATTENDEES_ENV });

  await openMeeting(page, 'all_hands.json');

  const attendeeChip = page.getByTestId('attendees-chip');
  await expect(attendeeChip).toBeVisible();
  await expect(attendeeChip).toContainText('30 invited');

  // Structural assertion: chip stays compact in height and note body remains visible
  const chipBox = await attendeeChip.boundingBox();
  expect(chipBox).toBeTruthy();
  expect(chipBox!.height).toBeLessThanOrEqual(40);
  await expect(page.getByTestId('meeting-detail-title')).toBeVisible();
  await expect(page.getByText('Quarterly company review and updates.')).toBeVisible();

  // Click opens popover with all 30 scrollable items
  await attendeeChip.click();
  const popover = page.getByTestId('attendees-popover');
  await expect(popover).toBeVisible();
  await expect(popover.getByTestId('attendee-item')).toHaveCount(30);
});

test('meeting without attendees renders no attendee chip or affordance at all', async ({
  launchApp,
}) => {
  const { page } = await launchApp({ mockIpc: true, env: ATTENDEES_ENV });

  await openMeeting(page, 'solo_note.json');

  await expect(page.getByTestId('meeting-detail-title')).toBeVisible();
  await expect(page.getByTestId('attendees-chip')).toHaveCount(0);
  await expect(page.getByTestId('attendees-popover')).toHaveCount(0);
});

test('transcript-only search hit displays the Transcript field label and snippet in /meetings list', async ({
  launchApp,
}) => {
  const { page } = await launchApp({ mockIpc: true, env: ATTENDEES_ENV });

  // Navigate to /meetings list
  await page.evaluate(() => {
    window.location.hash = '#/meetings';
  });

  // Search input
  const searchInput = page.getByRole('textbox', { name: 'Search notes' });
  await expect(searchInput).toBeVisible();

  // Initially all seeded meetings are visible
  await expect(page.getByTestId('previous-row')).toHaveCount(6);

  // Search for the transcript-only term
  await searchInput.fill('secret_zeta_keyword');

  // Exactly 1 match
  const rows = page.getByTestId('previous-row');
  await expect(rows).toHaveCount(1);
  await expect(rows.nth(0)).toContainText('Sprint Planning');

  // Shows the "Transcript" badge label (matching CommandPalette vocabulary)
  await expect(rows.nth(0)).toContainText('Transcript');
  await expect(rows.nth(0)).toContainText('secret_zeta_keyword');
});
