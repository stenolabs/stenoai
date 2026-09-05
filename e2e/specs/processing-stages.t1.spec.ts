import { test, expect } from '../fixtures/electron';
import type { ElectronApplication, Page } from '@playwright/test';

/**
 * T1 -- renderer-only, mock IPC, no backend. Processing.tsx had zero test
 * coverage of any kind before this spec (confirmed via a repo-wide search).
 * The multi-stage transition logic it drives -- transcribing -> diarizing
 * (per-channel, with a real embedding-extraction sub-progress on top) ->
 * summarizing -> finalizing/error, all sharing one `chunkProgress` sub-label
 * state across three different stages -- is exactly the kind of thing that's
 * easy to get a stale-label leak wrong, so it earns T1 coverage per
 * CLAUDE.md's "the interaction itself is the risk" carve-out.
 *
 * Drives the real PROGRESS:, summary-chunk/complete, and processing-complete
 * IPC events directly via ElectronApplication.evaluate (main-process webContents.send),
 * rather than adding any test-only production code to main.js/preload.js --
 * this is a one-way push protocol, so there's nothing for a renderer-side
 * mock invoke to intercept.
 */

async function openProcessing(page: Page) {
  // Reached in real usage only via an active recording (never a bare URL
  // hash) -- start one first so activeSession/recording.sessionName is
  // truthy, matching what canRetry (retryAudioFile && activeSession) needs
  // for the retry-button test below.
  await page.evaluate(() => window.stenoai.recording.start('test-session'));
  await page.evaluate(() => {
    window.location.hash = '/meetings/processing';
  });
  await expect(page.getByTestId('processing-stage-label')).toBeVisible();
  // The queue poll that first reports this recording bumps Processing's
  // `generation`, whose render-phase reset clears stage + retryAudioFile.
  // Wait until that has landed (the header switches from 'Note' to the
  // session name) so a later emit can't race the reset.
  await expect(page.getByRole('heading', { name: 'test-session' })).toBeVisible();
}

function emit(app: ElectronApplication, channel: string, payload: unknown) {
  return app.evaluate(
    ({ BrowserWindow }, arg) => {
      const win = BrowserWindow.getAllWindows()[0];
      win.webContents.send(arg.channel, arg.payload);
    },
    { channel, payload },
  );
}

test('walks transcribing -> diarizing (with embedding sub-progress) -> summarizing -> finalizing without leaking a stale sub-label', async ({ launchApp }) => {
  const { app, page } = await launchApp({ mockIpc: true, fakeAudio: true });
  await openProcessing(page);

  const label = page.getByTestId('processing-stage-label');
  await expect(label).toHaveText('Analyzing transcript');
  await expect(label).toHaveAttribute('data-stage', 'transcribing');

  // done/total here are raw ASR sample counts, not chunk counts -- real
  // production values run into the tens of millions (e.g.
  // "18960000/20480372"), which is exactly why only a percentage is
  // useful, not "part X of Y".
  await emit(app, 'processing-progress', { line: 'PROGRESS:transcribe:18960000/20480372' });
  await expect(label).toHaveText('Transcribing… 93%');
  await expect(label).toHaveAttribute('data-stage', 'transcribing');

  await emit(app, 'processing-progress', { line: 'PROGRESS:diarize:You:start' });
  await expect(label).toHaveText('Diarizing You channel…');
  await expect(label).toHaveAttribute('data-stage', 'diarizing');

  // The real gap this feature was built to close: on a multi-hour
  // recording, embedding extraction alone can take ~18 minutes per channel
  // -- this sub-progress is what keeps that stretch from looking hung.
  await emit(app, 'processing-progress', { line: 'PROGRESS:diarize:You:embedding:340/1300' });
  await expect(label).toHaveText('Diarizing You channel… 26%');
  await expect(label).toHaveAttribute('data-stage', 'diarizing');

  await emit(app, 'processing-progress', { line: 'PROGRESS:diarize:You:done' });
  await emit(app, 'processing-progress', { line: 'PROGRESS:diarize:Others:start' });
  await expect(label).toHaveText('Diarizing Others channel…');
  await emit(app, 'processing-progress', { line: 'PROGRESS:diarize:Others:done' });

  await emit(app, 'processing-progress', { line: 'PROGRESS:summarize:1/3' });
  await expect(label).toHaveText('Summarizing… 33%');
  await expect(label).toHaveAttribute('data-stage', 'summarizing');

  await emit(app, 'processing-progress', { line: 'PROGRESS:summarize:reducing' });
  await expect(label).toHaveText('Merging summaries…');

  // The bug this spec exists to catch: chunkProgress used to persist
  // Finalizing always renders its own fixed label. The retry-path test below
  // covers stale dynamic sub-label cleanup where it is observable.
  await emit(app, 'summary-complete', { success: true, sessionName: 'test-session' });
  await expect(label).toHaveText('Almost done…');
  await expect(label).toHaveAttribute('data-stage', 'finalizing');
});

test('a new processing generation cannot inherit the previous diarization timer', async ({ launchApp }) => {
  const { app, page } = await launchApp({ mockIpc: true, fakeAudio: true });
  await openProcessing(page);

  const label = page.getByTestId('processing-stage-label');
  await emit(app, 'processing-progress', { line: 'PROGRESS:diarize:You:start' });
  await expect(label).toHaveText('Diarizing You channel…');

  await page.evaluate(() => window.stenoai.recording.start('second-session'));
  await expect(page.getByRole('heading', { name: 'second-session' })).toBeVisible();
  await expect(label).toHaveText('Analyzing transcript');
  await page.waitForTimeout(1_200);
  await expect(label).toHaveText('Analyzing transcript');
});

test('shows a ticking elapsed-time counter during segmentation, before any embedding percentage arrives', async ({ launchApp }) => {
  // Real bug found via a live app test: on a real ~21-minute recording,
  // segmentation (the diarizer's own pass, before its embedding loop even
  // starts) took 100+ seconds with the label frozen on "Diarizing You
  // channel…" the whole time -- indistinguishable from actually being
  // stuck. The user quit the app twice before ever reaching the point
  // where a percentage would appear. This ticker is the fix.
  const { app, page } = await launchApp({ mockIpc: true, fakeAudio: true });
  await openProcessing(page);

  const label = page.getByTestId('processing-stage-label');
  await emit(app, 'processing-progress', { line: 'PROGRESS:diarize:You:start' });
  await expect(label).toHaveText('Diarizing You channel…');

  await expect(label).toHaveText(/Diarizing You channel… \(\d+s\)/, { timeout: 3000 });

  // Once a real percentage arrives, it must win over the ticker -- and the
  // ticker must actually stop, not race back in a second later.
  await emit(app, 'processing-progress', { line: 'PROGRESS:diarize:You:embedding:1/129' });
  await expect(label).toHaveText('Diarizing You channel… 1%');
  await page.waitForTimeout(1500);
  await expect(label).toHaveText('Diarizing You channel… 1%');
});

test('a processing failure swaps to the error panel, and retrying does not leak the stale sub-label back', async ({ launchApp }) => {
  const { app, page } = await launchApp({ mockIpc: true, fakeAudio: true });
  await openProcessing(page);

  const label = page.getByTestId('processing-stage-label');
  await emit(app, 'processing-progress', { line: 'PROGRESS:diarize:You:start' });
  await expect(label).toHaveText('Diarizing You channel…');

  // On failure, the stage card is replaced entirely by a distinct error
  // panel (retry button, no processing-stage-label) rather than the label
  // just changing text in place.
  await emit(app, 'processing-complete', {
    success: false,
    sessionName: 'test-session',
    audioFile: '/fake/audio.wav',
    message: 'boom',
  });
  await expect(label).toHaveCount(0);
  await expect(page.getByText('Couldn’t process this recording.')).toBeVisible();

  // The bug this half of the spec exists to catch: without clearing
  // chunkProgress on the failure transition, clicking "Try again" (which
  // resets the stage back to 'transcribing') would remount the stage card
  // still showing the stale "Diarizing You channel…" sub-label instead of
  // the correct fresh-start label.
  await page.getByRole('button', { name: 'Try again' }).click();
  await expect(label).toHaveText('Analyzing transcript');
  await expect(label).toHaveAttribute('data-stage', 'transcribing');
});
