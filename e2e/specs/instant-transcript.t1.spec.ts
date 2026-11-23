import { test, expect } from '../fixtures/electron';

/**
 * T1 — instant transcript, renderer behaviour (mock IPC). After Stop the
 * pipeline first writes notes from the live transcript (`refining: true`) and
 * then refines them in the background. That early note must read like a
 * normal note — summary, speaker-labelled transcript, chat — with only a small
 * "Refining transcript" marker, NOT the blocking "Finishing up" card. The
 * rewrite paths (edit, regenerate) stay off until the refined note lands.
 * Seeded via STENOAI_E2E_SEED_REFINING_NOTE in app/e2e-mock-ipc.js; the
 * backend half (early save before the batch pass) is instant-transcript.t2.
 */

const ENV = {
  STENOAI_E2E_MOCK_PARAKEET_INSTALLED: '1',
  STENOAI_E2E_SEED_REFINING_NOTE: '1',
};

test('a refining note shows its summary and a small refining marker, not "Finishing up"', async ({
  launchApp,
}) => {
  const { page } = await launchApp({ mockIpc: true, env: ENV });
  await page.evaluate(() => {
    window.location.hash = '#/meetings/refining_summary.md';
  });

  await expect(page.getByTestId('tab-summary-content')).toContainText(
    'Early summary written from the live transcript.',
  );
  await expect(page.getByTestId('note-refining')).toContainText('Refining transcript');
  await expect(page.getByTestId('note-processing')).toHaveCount(0);
  // Notes exist, so no Generate-notes CTA either.
  await expect(page.getByTestId('no-notes-yet')).toHaveCount(0);
  await expect(page.getByTestId('generate-notes-dock-button')).toHaveCount(0);

  // The background writer still owns the note: rewrites stay off.
  await expect(page.getByRole('button', { name: 'Edit note' })).toBeDisabled();
  await expect(page.getByRole('button', { name: 'Generate notes' }).first()).toBeDisabled();
});

test('a refining note is readable and chat-able: labelled transcript + Ask bar', async ({
  launchApp,
}) => {
  const { page } = await launchApp({ mockIpc: true, env: ENV });
  await page.evaluate(() => {
    window.location.hash = '#/meetings/refining_summary.md';
  });
  await expect(page.getByTestId('note-refining')).toBeVisible();

  await page.getByRole('button', { name: 'Show transcript' }).click();
  const transcript = page.locator('.mv-transcript.open');
  // Live You/Others labels + timestamps survive into the note: it parses as a
  // diarised transcript (timestamped speaker rows), not one unlabelled block.
  await expect(transcript.getByText('00:06', { exact: true })).toBeVisible();
  await expect(transcript.getByText('Q3 came in under plan.')).toBeVisible();
  // Searchable while refining.
  await transcript.getByPlaceholder('Search transcript').fill('budget');
  await expect(transcript).toContainText("Let's review the budget.");
  await expect(transcript.getByText('Q3 came in under plan.')).toHaveCount(0);

  // The Ask bar is available on the note.
  await expect(page.locator('[data-ask-bar]').getByPlaceholder('Ask anything…')).toBeEditable();
});
