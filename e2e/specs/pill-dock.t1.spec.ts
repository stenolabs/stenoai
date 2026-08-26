import { test, expect } from '../fixtures/electron';
import type { Page } from '@playwright/test';

/**
 * T1 — renderer-only, mock IPC. The coexisting transcription pill dock: a
 * BACKGROUND start (hotkey/tray/auto) does not navigate — it docks the compact
 * Granola-style pill (components/LiveDock.tsx: wave + elapsed +
 * expand chevron + stop glyph) docks LEFT of the Ask bar in the primary
 * bottom-dock row (components/PrimaryDock.tsx), the Ask bar stays enabled for
 * live-transcript questions, and (Parakeet) the pill expands into the
 * LiveTranscriptBar panel.
 *
 * There is NO manual pause anywhere — stop ends the segment ("stop is the
 * new pause"; a note can be continued later, appending to it). Resume
 * appears only when the SYSTEM auto-paused (sleep / meeting-app mic drop).
 *
 * The recording state machine is the stateful mock in app/e2e-mock-ipc.js
 * (start/pause/resume/stop mutate in-memory state; get-queue-status reflects
 * it), so the renderer's queue poll drives the same status transitions the
 * real backend would. STENOAI_E2E_MOCK_ENGINE=whisper drives the Whisper
 * variant (no expand).
 */

const PILL_ENV = { STENOAI_E2E_MOCK_PARAKEET_INSTALLED: '1' };

/**
 * Start a recording in the BACKGROUND (the IPC directly, as a hotkey/tray/
 * auto-detect trigger does) so the spec tests dock coexistence without the
 * New-note navigation — a background start must stay on the current route and
 * dock the pill there. (The explicit toolbar New-note button navigates to the
 * live-note editor; that's covered separately below.)
 */
async function startInBackground(page: Page) {
  await page.evaluate(() => window.stenoai.recording.start('Test note'));
  const pill = page.getByTestId('transcription-pill');
  await expect(pill).toBeVisible();
  return pill;
}

test('recording coexists: pill docks next to an enabled live Ask bar, expands, stops to processing', async ({
  launchApp,
}) => {
  const { page } = await launchApp({ mockIpc: true, env: PILL_ENV });

  const pill = await startInBackground(page);

  // A background start does NOT navigate — the pill docks on the current route.
  const hash = await page.evaluate(() => window.location.hash);
  expect(hash).not.toContain('/recording');
  expect(hash).not.toContain('/meetings/processing');

  // Adjacent row: pill + Ask bar share the primary dock row, and the Ask bar
  // is visible and enabled with the live transcript placeholder.
  await expect(page.getByTestId('primary-dock-row')).toBeVisible();
  const askInput = page.getByPlaceholder('Ask about the live transcript…');
  await expect(askInput).toBeVisible();
  await expect(askInput).toBeEnabled();

  // Compact pill = wave + elapsed + expand + stop glyph. NO pause control —
  // stop is the new pause.
  await expect(pill.getByRole('button', { name: 'Show transcript' })).toBeVisible();
  await expect(pill.getByRole('button', { name: 'Stop recording' })).toBeVisible();
  await expect(pill.getByRole('button', { name: 'Pause recording' })).toHaveCount(0);

  // Collision invariant: the saved-meeting 72-band panels never render for
  // the unsaved recording (no active saved meeting on Home).
  await expect(page.getByTestId('generate-notes-dock-button')).toHaveCount(0);
  await expect(page.locator('[data-transcript-bar]')).toHaveCount(0);

  // Chrome routes (settings): the pill docks ALONE — no live composer
  // floating over the Settings page.
  await page.evaluate(() => {
    window.location.hash = '#/settings';
  });
  await expect(page.getByTestId('transcription-pill')).toBeVisible();
  await expect(page.getByPlaceholder('Ask about the live transcript…')).toHaveCount(0);

  // Processing route: recording wins the slot (back-to-back notes) — the
  // pill + Stop stay reachable instead of being displaced by ProcessingDock.
  await page.evaluate(() => {
    window.location.hash = '#/meetings/processing';
  });
  await expect(page.getByTestId('transcription-pill')).toBeVisible();

  await page.evaluate(() => {
    window.location.hash = '#/';
  });
  await expect(page.getByTestId('transcription-pill')).toBeVisible();

  // Expand: the live transcript panel replaces the row; its footer owns Stop
  // (and language) — and has NO pause either. Collapse returns to the pill.
  await pill.getByRole('button', { name: 'Show transcript' }).click();
  const panel = page.getByTestId('live-transcript-panel');
  await expect(panel).toBeVisible();
  await expect(page.getByTestId('primary-dock-row')).toHaveCount(0);
  await expect(panel.getByRole('button', { name: 'Stop recording' })).toBeVisible();
  await expect(panel.getByRole('button', { name: 'Pause recording' })).toHaveCount(0);
  await panel.getByRole('button', { name: 'Minimize transcript' }).click();
  await expect(page.getByTestId('transcription-pill')).toBeVisible();

  // Stop from the pill → the renderer transitions to the processing dock
  // (processing still owns the screen; only recording coexists).
  await page
    .getByTestId('transcription-pill')
    .getByRole('button', { name: 'Stop recording' })
    .click();
  await expect
    .poll(() => page.evaluate(() => window.location.hash), { timeout: 10_000 })
    .toContain('/meetings/processing');
});

test('New note: the toolbar button starts recording AND opens the live-note editor', async ({
  launchApp,
}) => {
  const { page } = await launchApp({ mockIpc: true, env: PILL_ENV });

  // Coexistence means the pill FOLLOWS you, not that you start nowhere: the
  // explicit New-note action lands the user on the live-note editor so they
  // have somewhere to write notes while it records.
  await page.locator('.record-btn').click();
  await expect(page.getByTestId('transcription-pill')).toBeVisible();
  await expect
    .poll(() => page.evaluate(() => window.location.hash), { timeout: 10_000 })
    .toContain('/recording');
});

test('auto-pause rescue: Resume appears only when the system paused the recording', async ({
  launchApp,
}) => {
  const { page } = await launchApp({ mockIpc: true, env: PILL_ENV });
  const pill = await startInBackground(page);

  // No resume while recording normally.
  await expect(pill.getByRole('button', { name: 'Resume recording' })).toHaveCount(0);

  // Simulate a system auto-pause (sleep / meeting-app mic drop) via the same
  // IPC the auto-pause path calls. The pill must offer Resume so the user is
  // never stranded (there is no manual pause control to undo).
  await page.evaluate(() => window.stenoai.recording.pause());
  const resume = pill.getByRole('button', { name: 'Resume recording' });
  await expect(resume).toBeVisible();
  await resume.click();
  await expect(pill.getByRole('button', { name: 'Resume recording' })).toHaveCount(0);
  await expect(pill.getByRole('button', { name: 'Stop recording' })).toBeVisible();
});

test('resume: the live transcript panel shows the earlier bits carried over from before the stop', async ({
  launchApp,
}) => {
  // Regression guard: resuming/continuing a recording used to drop the earlier
  // transcript from the live bar (it reset to blank). main.js now carries the
  // previous session's finalised segments across as display-only priorSegments;
  // the bar renders them before the live tail. STENOAI_E2E_SEED_PRIOR_SEGMENTS
  // seeds them through the mock get-live-transcript-state (the real buffer is
  // model-populated — see live-transcript-fallback.t2).
  const { page } = await launchApp({
    mockIpc: true,
    env: { ...PILL_ENV, STENOAI_E2E_SEED_PRIOR_SEGMENTS: '1' },
  });
  const pill = await startInBackground(page);

  // Expand into the live transcript panel.
  await pill.getByRole('button', { name: 'Show transcript' }).click();
  const panel = page.getByTestId('live-transcript-panel');
  await expect(panel).toBeVisible();

  // The earlier speech renders instead of a blank "Listening…" — the user sees
  // continuity across the resume, not a transcript that starts over.
  await expect(panel.getByText('earlier bit one')).toBeVisible();
  await expect(panel.getByText('earlier bit two')).toBeVisible();
});

test('whisper variant: compact pill has no expand and no pause', async ({ launchApp }) => {
  const { page } = await launchApp({
    mockIpc: true,
    env: { ...PILL_ENV, STENOAI_E2E_MOCK_ENGINE: 'whisper' },
  });
  const pill = await startInBackground(page);

  // No live transcript on Whisper: no expand affordance; and no pause —
  // stop-only, like Parakeet.
  await expect(pill.getByRole('button', { name: 'Show transcript' })).toHaveCount(0);
  await expect(pill.getByRole('button', { name: 'Pause recording' })).toHaveCount(0);
  await expect(pill.getByRole('button', { name: 'Stop recording' })).toBeVisible();
});

test('continue-recording: the transcript panel footer offers Resume (Granola-style)', async ({
  launchApp,
}) => {
  // A summarised note. Resume lives in the transcript panel footer now — there
  // is no standalone dock mic.
  const { page } = await launchApp({
    mockIpc: true,
    env: { ...PILL_ENV, STENOAI_E2E_SEED_MEETING: '1' },
  });
  await page.evaluate(() => {
    window.location.hash = '#/meetings/epsilon_summary.json';
  });
  // The old standalone mic is gone.
  await expect(page.getByTestId('continue-recording-button')).toHaveCount(0);

  // Open the transcript (the Ask bar composer toggle) → the footer shows Resume.
  await page.getByRole('button', { name: 'Show transcript' }).click();
  const resume = page.getByTestId('resume-recording-button');
  await expect(resume).toBeVisible();

  // Resume starts a recording that appends to this note: the pill takes over
  // and the Ask bar switches to the live transcript.
  await resume.click();
  await expect(page.getByTestId('transcription-pill')).toBeVisible();
  await expect(page.getByTestId('resume-recording-button')).toHaveCount(0);
  await expect(page.getByPlaceholder('Ask about the live transcript…')).toBeEnabled();
});

test('stale note (continued): floating CTA reads Generate notes', async ({ launchApp }) => {
  // A continued note (notes_stale) surfaces the SAME "Generate notes" CTA as a
  // never-summarised one — there is no separate "Regenerate" wording. Every
  // record/continue → stop leaves this one button.
  const { page } = await launchApp({
    mockIpc: true,
    env: { ...PILL_ENV, STENOAI_E2E_SEED_STALE_NOTE: '1' },
  });
  await page.evaluate(() => {
    window.location.hash = '#/meetings/stale_summary.md';
  });
  const cta = page.getByTestId('generate-notes-dock-button');
  await expect(cta).toBeVisible();
  await expect(cta).toHaveText(/Generate notes/);
});
