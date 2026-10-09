import { test, expect } from '../fixtures/electron';

/**
 * T1 — renderer-only, mock IPC. A machine with no audio input device (#517).
 *
 * Chromium rejects getUserMedia with NotFoundError when nothing matches. That
 * is a routine state on a Windows desktop, and it used to kill the whole
 * recording even when system audio was there to be captured. The contract now:
 *
 *  - no input device + system audio available: record system audio only, and
 *    say so;
 *  - no input device + no system audio: fail the start with the NotFoundError
 *    name intact (main turns that into "couldn't find a microphone") and tear
 *    the live-transcribe sidecar down;
 *  - any OTHER microphone failure (busy, denied) still fails the start — the
 *    fallback is for a missing device, not for a microphone the user can fix.
 *
 * `STENOAI_E2E_RENDERER_PLATFORM=win32` puts useSystemAudioCapture on the
 * getDisplayMedia loopback branch on any host. The media APIs are stubbed in
 * the page: no runner has a real loopback device, and the point here is the
 * hook's branching, not Chromium's capture.
 */

const WIN_ENV = {
  STENOAI_E2E_MOCK_PARAKEET_INSTALLED: '1',
  STENOAI_E2E_RENDERER_PLATFORM: 'win32',
};

type Send = { channel: string; args: unknown[] };

const ipcCalls = (app: import('@playwright/test').ElectronApplication) =>
  app.evaluate(() => (global as unknown as { __mockIpcCalls: unknown[] }).__mockIpcCalls);

const ipcSends = (app: import('@playwright/test').ElectronApplication) =>
  app.evaluate(() => (global as unknown as { __mockIpcSends: Send[] }).__mockIpcSends);

const sendsOn = (sends: Send[], channel: string) => sends.filter((s) => s.channel === channel);

/**
 * Replace the capture getUserMedia with one that rejects with `micError`, and
 * getDisplayMedia with either a synthetic loopback stream or a rejection.
 * Non-capture getUserMedia calls (if any) pass through untouched.
 */
async function stubMedia(
  page: import('@playwright/test').Page,
  opts: { micError: string; loopback: 'available' | 'denied'; pinnedError?: string }
) {
  await page.evaluate(({ micError, loopback, pinnedError }) => {
    const original = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
    Object.defineProperty(navigator.mediaDevices, 'getUserMedia', {
      configurable: true,
      value: (constraints?: MediaStreamConstraints) => {
        const audio = constraints?.audio;
        const isCaptureRequest =
          typeof audio === 'object' &&
          audio !== null &&
          audio.echoCancellation === true &&
          audio.noiseSuppression === false;
        if (!isCaptureRequest) return original(constraints);
        const log = ((window as typeof window & { __micRequests?: boolean[] }).__micRequests ??= []);
        log.push('deviceId' in audio);
        // A request for the pinned device (exact deviceId) can fail
        // differently from the system-default retry that follows it.
        const name = pinnedError && 'deviceId' in audio ? pinnedError : micError;
        return Promise.reject(new DOMException('Requested device not found', name));
      },
    });
    Object.defineProperty(navigator.mediaDevices, 'getDisplayMedia', {
      configurable: true,
      value: async () => {
        if (loopback === 'denied') {
          throw new DOMException('Permission denied', 'NotAllowedError');
        }
        // A live audio track (what the loopback contributes) plus the video
        // track the API always carries and the hook drops.
        const ctx = new AudioContext();
        const osc = ctx.createOscillator();
        const dest = ctx.createMediaStreamDestination();
        osc.connect(dest);
        osc.start();
        const canvas = document.createElement('canvas');
        const video = canvas.captureStream(1).getVideoTracks();
        return new MediaStream([...dest.stream.getAudioTracks(), ...video]);
      },
    });
  }, opts);
}

test('no microphone but system audio available records system audio only', async ({
  launchApp,
}) => {
  const { app, page } = await launchApp({ mockIpc: true, env: WIN_ENV });
  await stubMedia(page, { micError: 'NotFoundError', loopback: 'available' });

  await page.evaluate(() => window.stenoai.recording.start('No mic note'));

  // The recording got as far as opening its file and arming the recorder.
  await expect.poll(async () => ipcCalls(app)).toContain('open-system-audio-file');
  await expect
    .poll(async () =>
      sendsOn(await ipcSends(app), 'system-audio-recording-state').map((s) => s.args[0])
    )
    .toContain(true);
  // The user is told their own voice is not in it.
  expect(await ipcCalls(app)).toContain('show-system-audio-only-notification');

  // And it is NOT a failed start.
  await page.waitForTimeout(500);
  const sends = await ipcSends(app);
  expect(sendsOn(sends, 'recording-capture-error')).toEqual([]);
  expect(sendsOn(sends, 'live-transcribe-stop')).toEqual([]);
  expect(sendsOn(sends, 'system-audio-recording-state').map((s) => s.args[0])).not.toContain(
    false
  );
});

test('a pinned microphone that is gone, with no default either, also records system audio only', async ({
  launchApp,
}) => {
  const { app, page } = await launchApp({
    mockIpc: true,
    env: { ...WIN_ENV, STENOAI_E2E_PINNED_MIC_ID: 'pinned-mic-id' },
  });
  await stubMedia(page, {
    pinnedError: 'OverconstrainedError',
    micError: 'NotFoundError',
    loopback: 'available',
  });

  await page.evaluate(() => window.stenoai.recording.start('Pinned mic note'));

  await expect.poll(async () => ipcCalls(app)).toContain('show-system-audio-only-notification');
  const sends = await ipcSends(app);
  expect(sendsOn(sends, 'recording-capture-error')).toEqual([]);
  expect(sendsOn(sends, 'system-audio-recording-state').map((s) => s.args[0])).toEqual([true]);
  // Both requests happened: the pinned device first, then the system default.
  expect(
    await page.evaluate(
      () => (window as typeof window & { __micRequests?: boolean[] }).__micRequests
    )
  ).toEqual([true, false]);
});

test('no microphone and no system audio fails the start and stops live transcription', async ({
  launchApp,
}) => {
  const { app, page } = await launchApp({ mockIpc: true, env: WIN_ENV });
  await stubMedia(page, { micError: 'NotFoundError', loopback: 'denied' });

  await page.evaluate(() => window.stenoai.recording.start('No audio note'));

  await expect
    .poll(async () => sendsOn(await ipcSends(app), 'recording-capture-error').length)
    .toBe(1);
  const sends = await ipcSends(app);
  // The NAME survives to main, which maps it to "couldn't find a microphone".
  const [, name, phase] = sendsOn(sends, 'recording-capture-error')[0].args;
  expect(name).toBe('NotFoundError');
  expect(phase).toBe('start');
  // #517 part 2: the sidecar main spawned on start-recording-ui is torn down.
  expect(sendsOn(sends, 'live-transcribe-stop')).toHaveLength(1);
  expect(sendsOn(sends, 'system-audio-recording-state').map((s) => s.args[0])).toEqual([false]);
  // Neither the system-audio-only nor the mic-only notice: nothing is recording.
  const calls = await ipcCalls(app);
  expect(calls).not.toContain('show-system-audio-only-notification');
  expect(calls).not.toContain('show-system-audio-mic-only-notification');
  expect(calls).not.toContain('open-system-audio-file');
});

test('a microphone held by another app still fails the start', async ({ launchApp }) => {
  const { app, page } = await launchApp({ mockIpc: true, env: WIN_ENV });
  await stubMedia(page, { micError: 'NotReadableError', loopback: 'available' });

  await page.evaluate(() => window.stenoai.recording.start('Busy mic note'));

  await expect
    .poll(async () => sendsOn(await ipcSends(app), 'recording-capture-error').length)
    .toBe(1);
  const sends = await ipcSends(app);
  expect(sendsOn(sends, 'recording-capture-error')[0].args[1]).toBe('NotReadableError');
  expect(sendsOn(sends, 'live-transcribe-stop')).toHaveLength(1);
  expect(await ipcCalls(app)).not.toContain('show-system-audio-only-notification');
  // The fallback must not even try loopback for a mic the user can fix.
  expect(await ipcCalls(app)).not.toContain('enable-loopback-audio');
});
