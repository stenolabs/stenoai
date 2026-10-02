import { test, expect } from '../fixtures/electron';

/**
 * T1 — renderer-only, mock IPC. Regression guard for the phantom "Recording"
 * row.
 *
 * When a recording start fails inside the renderer — no microphone connected,
 * the mic held by another app, permission revoked — main.js has already
 * accepted `start-recording-ui` and stored the session name. Its capture-state
 * handler then clears `hasRecording` but deliberately KEEPS that name, on the
 * stated assumption that "a stale name while hasRecording is false is inert".
 *
 * It was not inert: useMeetings built the synthetic in-progress row from the
 * name alone, so the list grew a pulsing "Recording" entry that no queue poll
 * and no reload ever cleared, and clicking it routed to /recording — which
 * correctly saw no session and bounced the user back home half a second later.
 *
 * This is reachable only with STENOAI_E2E_STALE_SESSION_NAME, because the mock
 * otherwise nulls the session name the moment recording goes inactive — a more
 * correct contract than the app implements, and precisely why the whole T1
 * suite stayed green while the bug shipped.
 */

const STALE_ENV = {
  STENOAI_E2E_MOCK_PARAKEET_INSTALLED: '1',
  STENOAI_E2E_STALE_SESSION_NAME: 'Note',
};

const ipcCalls = (app: import('@playwright/test').ElectronApplication) =>
  app.evaluate(() => (global as unknown as { __mockIpcCalls: string[] }).__mockIpcCalls);

const countCalls = (calls: string[], channel: string) =>
  calls.filter((call) => call === channel).length;

test('a session name left behind by a failed start shows no recording row', async ({
  launchApp,
}) => {
  const { page } = await launchApp({ mockIpc: true, env: STALE_ENV });

  // The backend reports exactly what main does after the failure: a name, but
  // nothing running. Assert that first, so a mock drift fails here with a clear
  // message rather than making the real assertion below vacuously pass.
  const queue = await page.evaluate(() => window.stenoai.recording.getQueue());
  expect(queue.sessionName).toBe('Note');
  expect(queue.hasRecording).toBe(false);

  // Give the list a poll cycle plus room for the optimistic caches to settle;
  // the bug's signature was a row that appeared and then never went away.
  await page.waitForTimeout(2000);

  await expect(page.locator('[data-testid="previous-row"][data-recording="true"]')).toHaveCount(0);
  await expect(page.getByText('Recording', { exact: true })).toHaveCount(0);

  // The toolbar button is the other half of the same state: while a session is
  // believed to be live it reads "Stop recording", so a user cannot start a new
  // note at all. (Asserted as an absence — "New note" matches both the icon
  // button and the labelled one.)
  await expect(page.getByRole('button', { name: 'Stop recording' })).toHaveCount(0);
});

test('a genuinely running session still shows its recording row', async ({ launchApp }) => {
  // The guard above must not have been bought by suppressing the real row.
  const { page } = await launchApp({
    mockIpc: true,
    env: { STENOAI_E2E_MOCK_PARAKEET_INSTALLED: '1' },
  });

  await page.evaluate(() => window.stenoai.recording.start('Test note'));

  await expect(page.locator('[data-testid="previous-row"][data-recording="true"]')).toHaveCount(1, {
    timeout: 10_000,
  });
});

test('a cancelled start rejecting late cannot clean up its successor', async ({ launchApp }) => {
  const { app, page } = await launchApp({
    mockIpc: true,
    fakeAudio: true,
    env: { STENOAI_E2E_MOCK_PARAKEET_INSTALLED: '1' },
  });

  // Hold the first microphone request open. Its rejection is released only
  // after stopCapture has invalidated that attempt and a successor is live.
  await page.evaluate(() => {
    const race = {
      calls: 0,
      rejectFirst: null as ((reason?: unknown) => void) | null,
      successorStream: null as MediaStream | null,
    };
    (window as typeof window & { __captureStartRace: typeof race }).__captureStartRace = race;
    const originalGetUserMedia = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
    Object.defineProperty(navigator.mediaDevices, 'getUserMedia', {
      configurable: true,
      value: (constraints?: MediaStreamConstraints) => {
        const audio = constraints?.audio;
        const isCaptureRequest =
          typeof audio === 'object' &&
          audio !== null &&
          audio.echoCancellation === true &&
          audio.noiseSuppression === false;
        if (!isCaptureRequest) return originalGetUserMedia(constraints);
        race.calls += 1;
        if (race.calls === 1) {
          return new Promise<MediaStream>((_resolve, reject) => {
            race.rejectFirst = reject;
          });
        }
        return originalGetUserMedia(constraints).then((stream) => {
          race.successorStream = stream;
          return stream;
        });
      },
    });
  });

  await page.evaluate(() => window.stenoai.recording.start('Cancelled start'));
  await expect
    .poll(() =>
      page.evaluate(() =>
        Boolean(
          (
            window as typeof window & {
              __captureStartRace: {
                rejectFirst: ((reason?: unknown) => void) | null;
              };
            }
          ).__captureStartRace.rejectFirst
        )
      )
    )
    .toBe(true);
  const callsBeforeSuccessor = await page.evaluate(
    () =>
      (window as typeof window & { __captureStartRace: { calls: number } }).__captureStartRace.calls
  );

  await page.evaluate(() => window.stenoai.recording.stop());
  await expect
    .poll(async () => countCalls(await ipcCalls(app), 'disable-loopback-audio'))
    .toBeGreaterThan(0);

  await page.evaluate(() => window.stenoai.recording.start('Successor'));
  await expect
    .poll(() =>
      page.evaluate(
        () =>
          (window as typeof window & { __captureStartRace: { calls: number } }).__captureStartRace
            .calls
      )
    )
    .toBeGreaterThan(callsBeforeSuccessor);
  await expect
    .poll(() =>
      page.evaluate(
        () =>
          (
            window as typeof window & {
              __captureStartRace: { successorStream: MediaStream | null };
            }
          ).__captureStartRace.successorStream?.getAudioTracks()[0]?.readyState
      )
    )
    .toBe('live');

  const before = await ipcCalls(app);
  const closeBefore = countCalls(before, 'close-system-audio-file');
  const disableBefore = countCalls(before, 'disable-loopback-audio');

  await page.evaluate(() => {
    const race = (
      window as typeof window & {
        __captureStartRace: {
          rejectFirst: ((reason?: unknown) => void) | null;
        };
      }
    ).__captureStartRace;
    race.rejectFirst?.(new DOMException('first attempt rejected late', 'NotFoundError'));
  });
  await page.waitForTimeout(300);

  const after = await ipcCalls(app);
  expect(countCalls(after, 'close-system-audio-file')).toBe(closeBefore);
  expect(countCalls(after, 'disable-loopback-audio')).toBe(disableBefore);
  expect(
    await page.evaluate(
      () =>
        (
          window as typeof window & { __captureStartRace: { successorStream: MediaStream | null } }
        ).__captureStartRace.successorStream?.getAudioTracks()[0]?.readyState
    )
  ).toBe('live');

  const queue = await page.evaluate(() => window.stenoai.recording.getQueue());
  expect(queue.hasRecording).toBe(true);
  expect(queue.sessionName).toBe('Successor');
});
