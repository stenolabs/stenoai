import { test, expect } from '../fixtures/electron';
import { writeUserConfig } from '../fixtures/user-config';
import type { ElectronApplication, Page } from '@playwright/test';

/**
 * T2 — Auto-record detected meetings (#463), end to end in the real app: a
 * detected call starts recording without asking, a "Recording started" toast
 * says so, and that toast acts on its own recording only.
 *
 * Seams:
 *  - STENOAI_E2E_MIC_EVENTS=1 exposes globalThis.__stenoE2EMicEvent in main,
 *    which feeds one mic-monitor line to handleMicEvent (app/main.js). The
 *    events are what mic-monitor prints for a phone or FaceTime call.
 *  - fakeAudio gives the renderer a microphone to capture, so the recording
 *    really starts; Whisper and no summary keep the post-stop work local.
 */

test.skip(process.platform !== 'darwin', 'meeting detection is macOS-only');

const CALL = { event: 'start', app_id: 'com.apple.avconferenced', app_name: 'avconferenced', pid: 4242 };
const FACETIME = { event: 'start', app_id: 'com.apple.FaceTime', app_name: 'FaceTime', pid: 5151 };

function configure(userDataDir: string) {
  writeUserConfig(userDataDir, {
    ai_provider: 'local',
    transcription_engine: 'whisper',
    system_audio_enabled: false,
    auto_summarize_enabled: false,
    privacy_notice_seen: true,
    auto_record_meetings_enabled: true,
  });
}

const detect = (app: ElectronApplication, evt: object) =>
  app.evaluate((_electron, e) => (globalThis as any).__stenoE2EMicEvent(e), evt);

const hasRecording = (page: Page) =>
  page.evaluate(async () => Boolean((await window.stenoai.recording.getQueue()).hasRecording));

const startedToasts = async (app: ElectronApplication): Promise<Page[]> => {
  const toasts = app.windows().filter((w) => !w.isClosed() && w.url().includes('#/notification'));
  const texts = await Promise.all(toasts.map((w) => w.locator('body').innerText().catch(() => '')));
  return toasts.filter((_w, i) => texts[i].includes('Recording started'));
};

test('a detected call records without asking, leaves the view alone, and its toast opens the live note', async ({
  launchApp,
  userDataDir,
}) => {
  configure(userDataDir);
  const { app, page } = await launchApp({ fakeAudio: true, env: { STENOAI_E2E_MIC_EVENTS: '1' } });
  const routeBefore = await page.evaluate(() => window.location.hash);

  await detect(app, CALL);
  await expect.poll(() => hasRecording(page)).toBe(true);
  await expect.poll(async () => (await startedToasts(app)).length, { timeout: 15_000 }).toBe(1);
  const toast = (await startedToasts(app))[0];
  await expect(toast.locator('body')).toContainText('Call');

  // An unattended start does not take over the window (#579 review).
  expect(await page.evaluate(() => window.location.hash)).toBe(routeBefore);

  // A second call while this one records starts nothing and announces nothing.
  await detect(app, FACETIME);
  await page.waitForTimeout(1500);
  expect(await startedToasts(app)).toHaveLength(1);
  expect(await hasRecording(page)).toBe(true);

  // Tapping the toast is the request to see the live note.
  await toast.getByText('Recording started').click();
  await expect.poll(() => page.evaluate(() => window.location.hash)).toBe('#/recording');

  await page.evaluate(() => window.stenoai.recording.stop());
  await expect.poll(() => hasRecording(page)).toBe(false);
});

test("a refused second start leaves the recording alone, the toast's Stop ends it, and a later recording by hand gets no toast", async ({
  launchApp,
  userDataDir,
}) => {
  configure(userDataDir);
  const { app, page } = await launchApp({ fakeAudio: true, env: { STENOAI_E2E_MIC_EVENTS: '1' } });
  await app.evaluate(({ ipcMain }) => {
    ipcMain.on('system-audio-recording-state', (_event: unknown, active: boolean) => {
      (globalThis as any).__captureActive = active;
    });
    (globalThis as any).__capturePhases = [];
    ipcMain.on('recording-capture-error', (_event: unknown, _message: string, _name: string, phase: string) => {
      (globalThis as any).__capturePhases.push(phase);
    });
  });

  await detect(app, CALL);
  await expect.poll(async () => (await startedToasts(app)).length, { timeout: 15_000 }).toBe(1);
  const sessionName = await page.evaluate(async () => (await window.stenoai.recording.getQueue()).sessionName);

  // A second start reaching the renderer during the recording, as a Shortcuts
  // start racing main's status check delivers it, is refused by main. It
  // reports as 'request' and leaves the running recording's state alone (#579
  // review).
  await app.evaluate(({ BrowserWindow }) => {
    const main = BrowserWindow.getAllWindows().find((w) => !w.webContents.getURL().includes('#/notification'));
    main!.webContents.send('shortcut-start-recording', { sessionName: 'Second start' });
  });
  await expect.poll(() => app.evaluate(() => (globalThis as any).__capturePhases)).toEqual(['request']);
  expect(await hasRecording(page)).toBe(true);
  expect(await page.evaluate(async () => (await window.stenoai.recording.getQueue()).sessionName)).toBe(sessionName);

  await (await startedToasts(app))[0].getByRole('button', { name: 'Stop' }).click();
  await expect.poll(() => hasRecording(page)).toBe(false);

  // Wait for the stopped capture to finish shutting down (its last state
  // report) before starting another, as a user would.
  await expect.poll(() => app.evaluate(() => (globalThis as any).__captureActive)).toBe(false);
  await page.evaluate(() => window.stenoai.recording.start('By hand', 'manual'));
  await expect.poll(() => hasRecording(page)).toBe(true);
  await page.waitForTimeout(1500);
  expect(await startedToasts(app)).toHaveLength(0);
  await page.evaluate(() => window.stenoai.recording.stop());
});
