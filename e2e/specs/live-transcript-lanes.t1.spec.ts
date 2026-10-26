import { test, expect } from '../fixtures/electron';
import { emitLiveSegments, emitLiveRevoke, type LiveSegmentInput } from '../fixtures/live-transcript';

/**
 * T1 - renderer-only, mock IPC. The live transcript panel's rendering contract,
 * driven through the real `live-transcript-chunk` channel.
 *
 * The panel renders in three lanes (carried-over prior segments, finalised
 * segments, in-progress partials) so a partial tick doesn't invalidate the
 * finalised rows above it. The lanes are an implementation detail; what a user
 * sees is not, and that is what this pins down:
 *
 *   - a partial is REPLACED in place, never appended, so a long utterance
 *     doesn't stack up duplicate half-sentences,
 *   - one in-progress bubble per speaker, both channels at once,
 *   - partials render dimmed and below the finalised text,
 *   - a final retires the partial it closes,
 *   - a final that arrives late (the bleed-dedup hold) still sorts into place.
 */

const PILL_ENV = { STENOAI_E2E_MOCK_PARAKEET_INSTALLED: '1' };
const SESSION = 'Lane note';

const seg = (
  text: string,
  start: number,
  isFinal: boolean,
  speaker: 'You' | 'Others' = 'You',
): LiveSegmentInput => ({ text, start, end: start + 4, isFinal, speaker });

/** Visible bubble texts, top to bottom. */
async function bubbles(page: import('@playwright/test').Page) {
  return page
    .getByTestId('live-transcript-panel')
    .locator('li')
    .allTextContents()
    .then((rows) => rows.map((r) => r.replace(/^\d+:\d+/, '').trim()));
}

test('a partial is replaced in place, then retired by its final', async ({ launchApp }) => {
  const { app, page } = await launchApp({ mockIpc: true, fakeAudio: true, env: PILL_ENV });
  await page.evaluate((name) => window.stenoai.recording.start(name), SESSION);
  await page.getByTestId('transcription-pill').getByRole('button', { name: 'Show transcript' }).click();
  const panel = page.getByTestId('live-transcript-panel');
  await expect(panel).toBeVisible();

  await emitLiveSegments(app, SESSION, [seg('Good morning everyone', 0, true)]);
  await expect(panel.getByText('Good morning everyone')).toBeVisible();

  // The same utterance growing across three ticks occupies ONE row.
  await emitLiveSegments(app, SESSION, [seg('so the', 6, false)]);
  await expect(panel.getByText('so the')).toBeVisible();
  await emitLiveSegments(app, SESSION, [seg('so the plan for', 6, false)]);
  await emitLiveSegments(app, SESSION, [seg('so the plan for today', 6, false)]);
  await expect(panel.getByText('so the plan for today')).toBeVisible();
  expect(await bubbles(page)).toEqual(['Good morning everyone', 'so the plan for today']);

  // Its final replaces the partial rather than adding a second row.
  await emitLiveSegments(app, SESSION, [seg('So the plan for today is this.', 6, true)]);
  await expect(panel.getByText('So the plan for today is this.')).toBeVisible();
  expect(await bubbles(page)).toEqual(['Good morning everyone', 'So the plan for today is this.']);
});

test('a revoked volatile Apple partial disappears without deleting finals or the other channel', async ({ launchApp }) => {
  const { app, page } = await launchApp({ mockIpc: true, fakeAudio: true, env: PILL_ENV });
  await page.evaluate((name) => window.stenoai.recording.start(name), SESSION);
  await page.getByTestId('transcription-pill').getByRole('button', { name: 'Show transcript' }).click();
  const panel = page.getByTestId('live-transcript-panel');
  await emitLiveSegments(app, SESSION, [
    seg('Settled', 0, true, 'You'),
    seg('Withdraw me', 5, false, 'You'),
    seg('Other partial', 6, false, 'Others'),
  ]);
  await expect(panel.getByText('Withdraw me')).toBeVisible();
  await emitLiveRevoke(app, SESSION, 'You');
  await expect(panel.getByText('Withdraw me')).toHaveCount(0);
  expect(await bubbles(page)).toEqual(['Settled', 'Other partial']);
  await emitLiveSegments(app, SESSION, [seg('New final', 8, true, 'You')]);
  await expect(panel.getByText('New final')).toBeVisible();
  expect(await bubbles(page)).toEqual(['Settled', 'New final', 'Other partial']);
});

test('both channels can have an in-progress bubble at once, below the finalised text', async ({
  launchApp,
}) => {
  const { app, page } = await launchApp({ mockIpc: true, fakeAudio: true, env: PILL_ENV });
  await page.evaluate((name) => window.stenoai.recording.start(name), SESSION);
  await page.getByTestId('transcription-pill').getByRole('button', { name: 'Show transcript' }).click();
  const panel = page.getByTestId('live-transcript-panel');
  await expect(panel).toBeVisible();

  await emitLiveSegments(app, SESSION, [
    seg('Settled sentence', 0, true, 'You'),
    seg('mine still going', 10, false, 'You'),
    seg('and theirs too', 11, false, 'Others'),
  ]);
  await expect(panel.getByText('and theirs too')).toBeVisible();

  // Finalised first, both partials trailing - the order the merged list had.
  expect(await bubbles(page)).toEqual(['Settled sentence', 'mine still going', 'and theirs too']);

  // Partials are dimmed so they don't read as finalised text.
  const dim = await panel
    .locator('li')
    .last()
    .evaluate((el) => (el as HTMLElement).style.opacity);
  expect(dim).toBe('0.55');

  // One channel's tick must not clobber the other's in-progress bubble.
  await emitLiveSegments(app, SESSION, [seg('mine still going on', 10, false, 'You')]);
  await expect(panel.getByText('mine still going on')).toBeVisible();
  expect(await bubbles(page)).toEqual(['Settled sentence', 'mine still going on', 'and theirs too']);
});

test('a late final sorts into place instead of landing at the end', async ({ launchApp }) => {
  // The live path can release a final well after a later one (the per-segment
  // bleed-dedup hold). It has to sort by start time, or the transcript reads
  // out of order.
  const { app, page } = await launchApp({ mockIpc: true, fakeAudio: true, env: PILL_ENV });
  await page.evaluate((name) => window.stenoai.recording.start(name), SESSION);
  await page.getByTestId('transcription-pill').getByRole('button', { name: 'Show transcript' }).click();
  const panel = page.getByTestId('live-transcript-panel');
  await expect(panel).toBeVisible();

  await emitLiveSegments(app, SESSION, [
    seg('First thing said', 0, true, 'You'),
    seg('Third thing said', 20, true, 'You'),
  ]);
  await expect(panel.getByText('Third thing said')).toBeVisible();

  await emitLiveSegments(app, SESSION, [seg('Second thing said', 10, true, 'Others')]);
  await expect(panel.getByText('Second thing said')).toBeVisible();
  expect(await bubbles(page)).toEqual([
    'First thing said',
    'Second thing said',
    'Third thing said',
  ]);
});

test('a note continued twice renders every carried-over line, in order', async ({ launchApp }) => {
  // main.js prepends the existing priors on every continue (`carryPrior`), and
  // each recording numbers its segments from its own start - so the carried-over
  // list legitimately repeats (start, speaker) pairs. That is why the prior lane
  // keys rows by position while the finals lane keys them by content.
  //
  // What this test can and cannot show: it pins that all four carried-over lines
  // render, in order, ahead of the new tail. It does NOT catch a key collision
  // on its own - the renderer under test is a production React build, which
  // neither warns about duplicate keys nor misreconciles a list that is written
  // once and never reordered. The collision is a latent hazard, established by
  // reading main.js's carryPrior, not by this assertion.
  const { app, page } = await launchApp({
    mockIpc: true,
    fakeAudio: true,
    env: { ...PILL_ENV, STENOAI_E2E_SEED_PRIOR_SEGMENTS: 'twice' },
  });

  await page.evaluate((name) => window.stenoai.recording.start(name), SESSION);
  await page.getByTestId('transcription-pill').getByRole('button', { name: 'Show transcript' }).click();
  const panel = page.getByTestId('live-transcript-panel');
  await expect(panel).toBeVisible();
  await expect(panel.getByText('second session bit two')).toBeVisible();

  await emitLiveSegments(app, SESSION, [seg('and the third session starts here', 3, true)]);
  await expect(panel.getByText('and the third session starts here')).toBeVisible();

  expect(await bubbles(page)).toEqual([
    'earlier bit one',
    'earlier bit two',
    'second session bit one',
    'second session bit two',
    'Resumed',
    'and the third session starts here',
  ]);
});

test('resumed note: the divider sits between the carried-over text and the new tail', async ({
  launchApp,
}) => {
  // STENOAI_E2E_SEED_PRIOR_SEGMENTS seeds two prior segments through the mock
  // get-live-transcript-state backfill (see pill-dock.t1).
  const { app, page } = await launchApp({
    mockIpc: true,
    fakeAudio: true,
    env: { ...PILL_ENV, STENOAI_E2E_SEED_PRIOR_SEGMENTS: '1' },
  });
  await page.evaluate((name) => window.stenoai.recording.start(name), SESSION);
  await page.getByTestId('transcription-pill').getByRole('button', { name: 'Show transcript' }).click();
  const panel = page.getByTestId('live-transcript-panel');
  await expect(panel).toBeVisible();
  await expect(panel.getByText('earlier bit one')).toBeVisible();

  // Carried-over text alone gets NO divider - there is nothing to divide from.
  await expect(page.getByTestId('live-transcript-resume-divider')).toHaveCount(0);

  await emitLiveSegments(app, SESSION, [seg('and now the new bit', 0, true)]);
  await expect(panel.getByText('and now the new bit')).toBeVisible();
  await expect(page.getByTestId('live-transcript-resume-divider')).toHaveCount(1);
  expect(await bubbles(page)).toEqual([
    'earlier bit one',
    'earlier bit two',
    'Resumed',
    'and now the new bit',
  ]);
});
