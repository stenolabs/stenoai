import { test, expect } from '../fixtures/electron';
import { enableDeterministicRecording } from '../fixtures/user-config';

/**
 * T2 — the menu bar recording indicator. The native tray is skipped under E2E,
 * so STENOAI_E2E_TRAY=1 gives the indicator a stand-in and
 * globalThis.__stenoE2ETray() reports what the menu bar would show.
 *
 * macOS: red dot + elapsed time while recording, a pause mark and the frozen
 * time while paused, nothing when stopped, and the 1 s timer only runs while
 * actively recording. Other platforms have no tray title, so only the tooltip
 * is checked there.
 *
 * Model-free: the renderer-driven recording path from enableDeterministicRecording.
 * fakeAudio keeps capture alive for the whole test: without a device the
 * renderer reports capture as stopped, main resets the recording, and the
 * indicator rightly goes back to idle mid-test.
 */

type TrayState = { title: string; tooltip: string; ticking: boolean };
type RecResult = { success: boolean; error?: string };
type StenoWindow = Window & {
  stenoai: {
    recording: {
      start: (name?: string) => Promise<RecResult>;
      stop: () => Promise<RecResult>;
      pause: () => Promise<RecResult>;
      resume: () => Promise<RecResult>;
      getSystemAudioSupport: () => Promise<{ success: boolean; supported?: boolean }>;
    };
  };
};

const RED_DOT = '\x1b[31m•\x1b[0m';
const PAUSE_MARK = '❚❚';
const isMac = process.platform === 'darwin';

// The stand-in tray is an unpackaged-only seam, like the other main-process
// hooks, so a run against a packaged app (STENOAI_E2E_APP_PATH) can't see it.
test.skip(!!process.env.STENOAI_E2E_APP_PATH, 'tray stand-in only exists in unpackaged builds');

test('menu bar indicator follows start, pause, resume and stop', async ({
  launchApp,
  userDataDir,
}) => {
  enableDeterministicRecording(userDataDir);
  const { app, page } = await launchApp({ fakeAudio: true, env: { STENOAI_E2E_TRAY: '1' } });

  const support = await page.evaluate(() =>
    (window as StenoWindow).stenoai.recording.getSystemAudioSupport(),
  );
  test.skip(!support?.supported, 'system-audio path unsupported on this runner');

  const tray = () => app.evaluate(() => (globalThis as any).__stenoE2ETray() as TrayState);
  const recording = (action: 'start' | 'pause' | 'resume' | 'stop') =>
    page.evaluate(
      (a) => (window as StenoWindow).stenoai.recording[a](a === 'start' ? 'E2E Tray' : undefined),
      action,
    );

  // Idle: no title, no timer.
  expect(await tray()).toMatchObject({ title: '', ticking: false });

  // Recording: red dot + time, ticking.
  expect((await recording('start')).success).toBe(true);
  await expect.poll(async () => (await tray()).tooltip).toBe('Steno - Recording');
  if (isMac) {
    await expect.poll(async () => (await tray()).title).toMatch(/^\x1b\[31m•\x1b\[0m \d+:\d\d$/);
    expect((await tray()).ticking).toBe(true);
    const first = (await tray()).title;
    // The timer moves on its own while recording.
    await expect.poll(async () => (await tray()).title, { timeout: 5000 }).not.toBe(first);
  }

  // Paused: pause mark, frozen time, no timer.
  expect((await recording('pause')).success).toBe(true);
  await expect.poll(async () => (await tray()).tooltip).toBe('Steno - Recording paused');
  if (isMac) {
    await expect.poll(async () => (await tray()).title.startsWith(`${PAUSE_MARK} `)).toBe(true);
    const frozen = await tray();
    expect(frozen.ticking).toBe(false);
    await page.waitForTimeout(1500);
    expect((await tray()).title).toBe(frozen.title);
  }

  // Resumed: red dot again, ticking.
  expect((await recording('resume')).success).toBe(true);
  await expect.poll(async () => (await tray()).tooltip).toBe('Steno - Recording');
  if (isMac) {
    await expect.poll(async () => (await tray()).title.startsWith(RED_DOT)).toBe(true);
    expect((await tray()).ticking).toBe(true);
  }

  // Stopped: back to idle and the timer is torn down.
  expect((await recording('stop')).success).toBe(true);
  await expect.poll(async () => tray()).toEqual({ title: '', tooltip: 'Steno', ticking: false });
});
