import { test, expect } from '../fixtures/electron';
import { emitLoopbackChunks, emitLoopbackEnded, pcmChunk } from '../fixtures/linux-loopback';

/**
 * T1 — renderer-only, mock IPC. The Linux loopback bridge's contract.
 *
 * Real system audio needs PipeWire and a live sink, which a CI runner has
 * neither of. The BRIDGE doesn't: PCM arrives over `linux-loopback-chunk` from
 * main, and everything after that (AudioData → MediaStreamTrackGenerator →
 * MediaStream) is ordinary renderer code. That is what this pins down —
 * including the frame-alignment contract, which is otherwise only exercised on
 * a developer's machine.
 *
 * `STENOAI_E2E_RENDERER_PLATFORM=linux` makes the preload report linux, so
 * useSystemAudioCapture takes the Linux branch on any host.
 */

const LINUX_ENV = { STENOAI_E2E_RENDERER_PLATFORM: 'linux' };
const SESSION = 'Loopback note';

/** Channels the renderer actually invoked (the contextBridge object is frozen,
 *  so main's mock-IPC log is the observable seam). */
const ipcCalls = (app: import('@playwright/test').ElectronApplication) =>
  app.evaluate(() => (global as unknown as { __mockIpcCalls: string[] }).__mockIpcCalls);

test('a Linux recording starts the pw-record bridge, not getDisplayMedia', async ({
  launchApp,
}) => {
  const { app, page } = await launchApp({ mockIpc: true, fakeAudio: true, env: LINUX_ENV });

  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));

  await page.evaluate((name) => window.stenoai.recording.start(name), SESSION);
  await expect.poll(() => ipcCalls(app)).toContain('start-linux-loopback');

  // getDisplayMedia's IPC precondition must never fire on Linux — that path
  // would surface a Wayland portal picker.
  expect(await ipcCalls(app)).not.toContain('enable-loopback-audio');

  // Chunks are accepted without throwing into the renderer.
  await emitLoopbackChunks(app, [pcmChunk(256), pcmChunk(256)]);
  await page.waitForTimeout(300);
  expect(errors).toEqual([]);
});

test('a frame-split chunk boundary does not break the bridge', async ({ launchApp }) => {
  const { app, page } = await launchApp({ mockIpc: true, fakeAudio: true, env: LINUX_ENV });
  await page.evaluate((name) => window.stenoai.recording.start(name), SESSION);
  await page.waitForTimeout(1500);

  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));

  // main.js's aligner only forwards whole frames, but the renderer must also
  // tolerate a ragged arrival: a chunk carrying a partial frame is floored, not
  // fatal. 6 bytes = one whole stereo s16 frame + half of the next.
  await emitLoopbackChunks(app, [
    [1, 2, 3, 4, 5, 6],
    pcmChunk(128),
    [7, 8],
    pcmChunk(128),
  ]);
  await page.waitForTimeout(300);
  expect(errors).toEqual([]);

  // Still recording — a ragged chunk must not tear the session down.
  const queue = await page.evaluate(() => window.stenoai.recording.getQueue());
  expect(queue.hasRecording).toBe(true);
});

test('pw-record dying mid-recording warns mic-only and keeps recording', async ({
  launchApp,
}) => {
  const { app, page } = await launchApp({ mockIpc: true, fakeAudio: true, env: LINUX_ENV });
  await page.evaluate((name) => window.stenoai.recording.start(name), SESSION);
  await expect.poll(() => ipcCalls(app)).toContain('start-linux-loopback');

  // Healthy capture warns about nothing.
  expect(await ipcCalls(app)).not.toContain('show-system-audio-mic-only-notification');

  await emitLoopbackEnded(app, { code: 1, signal: null });

  // The loss is surfaced as "Recording mic-only" rather than the system channel
  // just going quiet. Deliberately NOT reportCaptureError, whose notification
  // reads "Recording couldn't start" — untrue once a recording is under way.
  await expect.poll(() => ipcCalls(app)).toContain('show-system-audio-mic-only-notification');

  // The recording itself survives — losing system audio degrades to mic-only
  // rather than tearing the session down.
  const queue = await page.evaluate(() => window.stenoai.recording.getQueue());
  expect(queue.hasRecording).toBe(true);
});
