import { existsSync, readdirSync, statSync } from 'fs';
import path from 'path';
import { test, expect } from '../fixtures/electron';
import { realUserDataDir, fileSig } from '../fixtures/real-user-data';
import { writeUserConfig } from '../fixtures/user-config';

type RecordingResult = { success: boolean; recordingId?: string; error?: string };
type QueueStatus = { hasRecording: boolean; isPaused: boolean; recordingId: string | null; sessionName: string | null; pendingRecordingStarts?: number };
type StenoWindow = Window & {
  stenoai: {
    recording: {
      start: (name: string) => Promise<RecordingResult>;
      stop: () => Promise<RecordingResult>;
      pause: () => Promise<RecordingResult>;
      resume: () => Promise<RecordingResult>;
      getQueue: () => Promise<QueueStatus>;
      reportSystemAudioState: (active: boolean, recordingId: string) => void;
      openSystemAudioFile: (name: string, recordingId: string) => Promise<RecordingResult>;
      appendSystemAudioChunk: (bytes: Uint8Array, recordingId: string) => Promise<RecordingResult>;
      closeSystemAudioFile: (recordingId: string) => Promise<RecordingResult>;
    };
  };
};

const captureOnlyEnv = { STENOAI_E2E_CAPTURE_ONLY: '1' };

async function installSyntheticMic(page: import('@playwright/test').Page) {
  await page.evaluate(() => {
    const audio = new AudioContext();
    const source = audio.createOscillator();
    source.frequency.value = 440;
    source.start();
    // A fresh stream per call: the hook stops the previous one's track on
    // teardown, and an ended track would let a restart record silence.
    navigator.mediaDevices.getUserMedia = async () => {
      const destination = audio.createMediaStreamDestination();
      source.connect(destination);
      return destination.stream;
    };
    navigator.mediaDevices.getDisplayMedia = async () => {
      throw new DOMException('Synthetic mic-only test', 'NotAllowedError');
    };
  });
}

function recordedBytes(userDataDir: string, name: string): number {
  const recordingsDir = path.join(userDataDir, 'recordings');
  if (!existsSync(recordingsDir)) return 0;
  const file = readdirSync(recordingsDir).find((entry) => entry.endsWith(`-${name}.webm`));
  return file ? statSync(path.join(recordingsDir, file)).size : 0;
}

test('immediate stop and restart keeps the second capture alive after a late first-session inactive report', async ({
  launchApp,
  userDataDir,
}) => {
  const realDirBefore = fileSig(realUserDataDir());
  // Whisper post-processing, no model or network assertion. Capture uses a
  // synthetic WebAudio microphone so no physical device or speech is read.
  writeUserConfig(userDataDir, { system_audio_enabled: false, transcription_engine: 'whisper' });
  const { app, page } = await launchApp({ env: captureOnlyEnv });
  await installSyntheticMic(page);
  const bytes = (name: string) => recordedBytes(userDataDir, name);

  const first = await page.evaluate(() =>
    (window as StenoWindow).stenoai.recording.start('Restart_A'),
  );
  expect(first.success).toBe(true);
  expect(first.recordingId).toBeTruthy();
  await expect.poll(() => bytes('Restart_A')).toBeGreaterThan(0);
  expect(await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.isVisible())).toBe(false);
  // A normal SPA hash route must not count as a renderer navigation/reload.
  await page.evaluate(() => { window.location.hash = '#/settings'; });
  expect((await page.evaluate(() => (window as StenoWindow).stenoai.recording.getQueue())).recordingId).toBe(first.recordingId);

  // The original bug accepted B before A's MediaRecorder onstop completed.
  // B then looked active in main but its capture never started.
  const restarted = await page.evaluate(async () => {
    const recording = (window as StenoWindow).stenoai.recording;
    const began = performance.now();
    const stopped = await recording.stop();
    const stopMs = performance.now() - began;
    const started = await recording.start('Restart_B');
    return { stopped, started, stopMs };
  });
  expect(restarted.stopped.success).toBe(true);
  expect(restarted.started.success).toBe(true);
  expect(restarted.stopMs).toBeLessThan(7000);
  expect(restarted.started.recordingId).not.toBe(first.recordingId);
  await expect.poll(() => bytes('Restart_B')).toBeGreaterThan(0);

  await page.evaluate((oldId) =>
    (window as StenoWindow).stenoai.recording.reportSystemAudioState(false, oldId),
    first.recordingId!,
  );
  const afterLateReport = await page.evaluate(() =>
    (window as StenoWindow).stenoai.recording.getQueue(),
  );
  expect(afterLateReport.hasRecording).toBe(true);
  expect(afterLateReport.recordingId).toBe(restarted.started.recordingId);
  expect(afterLateReport.sessionName).toBe('Restart_B');
  // Delayed file IPC from A cannot rotate, write, or close B's live WebM.
  const lateFileCalls = await page.evaluate(async (oldId) => {
    const recording = (window as StenoWindow).stenoai.recording;
    return {
      open: await recording.openSystemAudioFile('Late_A', oldId),
      append: await recording.appendSystemAudioChunk(new Uint8Array([1, 2, 3]), oldId),
      close: await recording.closeSystemAudioFile(oldId),
    };
  }, first.recordingId!);
  expect(lateFileCalls.open.success).toBe(false);
  expect(lateFileCalls.append.success).toBe(false);
  expect(lateFileCalls.close.success).toBe(false);

  expect((await page.evaluate(() => (window as StenoWindow).stenoai.recording.pause())).success).toBe(true);
  await expect.poll(async () => (await page.evaluate(() => (window as StenoWindow).stenoai.recording.getQueue())).isPaused).toBe(true);
  expect((await page.evaluate(() => (window as StenoWindow).stenoai.recording.resume())).success).toBe(true);
  await expect.poll(async () => (await page.evaluate(() => (window as StenoWindow).stenoai.recording.getQueue())).isPaused).toBe(false);

  const beforeMoreAudio = bytes('Restart_B');
  await expect.poll(() => bytes('Restart_B')).toBeGreaterThan(beforeMoreAudio);
  expect((await page.evaluate(() => (window as StenoWindow).stenoai.recording.stop())).success).toBe(true);
  expect(fileSig(realUserDataDir())).toBe(realDirBefore);
});

test('Stop cancels a second Start waiting for the first capture handoff', async ({
  launchApp, userDataDir,
}) => {
  writeUserConfig(userDataDir, { system_audio_enabled: false, transcription_engine: 'whisper' });
  const { app, page } = await launchApp({
    env: { ...captureOnlyEnv, STENOAI_E2E_HOLD_CAPTURE_ACK: '1' },
  });
  await installSyntheticMic(page);
  const first = await page.evaluate(() => (window as StenoWindow).stenoai.recording.start('Queued_A'));
  expect(first.success).toBe(true);
  await expect.poll(() => recordedBytes(userDataDir, 'Queued_A')).toBeGreaterThan(0);

  const stopA = page.evaluate(() => (window as StenoWindow).stenoai.recording.stop());
  await expect.poll(async () => (await page.evaluate(() =>
    (window as StenoWindow).stenoai.recording.getQueue())).hasRecording).toBe(false);
  const startB = page.evaluate(() => (window as StenoWindow).stenoai.recording.start('Queued_B'));
  await expect.poll(async () => (await page.evaluate(() =>
    (window as StenoWindow).stenoai.recording.getQueue())).pendingRecordingStarts).toBe(1);

  expect((await page.evaluate(() => (window as StenoWindow).stenoai.recording.stop())).success).toBe(true);
  await app.evaluate(() => { process.env.STENOAI_E2E_HOLD_CAPTURE_ACK = '0'; });
  await page.evaluate((id) =>
    (window as StenoWindow).stenoai.recording.reportSystemAudioState(false, id), first.recordingId!);
  expect((await stopA).success).toBe(true);
  expect(await startB).toMatchObject({ success: false, cancelled: true });
  expect((await page.evaluate(() => (window as StenoWindow).stenoai.recording.getQueue())).hasRecording).toBe(false);
  expect(recordedBytes(userDataDir, 'Queued_B')).toBe(0);

  const next = await page.evaluate(() => (window as StenoWindow).stenoai.recording.start('Queued_C'));
  expect(next.success).toBe(true);
  await expect.poll(() => recordedBytes(userDataDir, 'Queued_C')).toBeGreaterThan(0);
  expect((await page.evaluate(() => (window as StenoWindow).stenoai.recording.stop())).success).toBe(true);
});

test('Stop before any renderer capture claim leaves no permanent waiter', async ({
  launchApp, userDataDir,
}) => {
  writeUserConfig(userDataDir, { system_audio_enabled: false, transcription_engine: 'whisper' });
  const { app, page } = await launchApp({
    env: { ...captureOnlyEnv, STENOAI_E2E_REJECT_CAPTURE_CLAIM: '1' },
  });
  const first = await page.evaluate(async () => {
    const recording = (window as StenoWindow).stenoai.recording;
    return { started: await recording.start('Unclaimed_A'), stopped: await recording.stop() };
  });
  expect(first.started.success).toBe(true);
  expect(first.stopped.success).toBe(true);
  expect(recordedBytes(userDataDir, 'Unclaimed_A')).toBe(0);

  await app.evaluate(() => { process.env.STENOAI_E2E_REJECT_CAPTURE_CLAIM = '0'; });
  await installSyntheticMic(page);
  const second = await page.evaluate(() => (window as StenoWindow).stenoai.recording.start('Unclaimed_B'));
  expect(second.success).toBe(true);
  await expect.poll(() => recordedBytes(userDataDir, 'Unclaimed_B')).toBeGreaterThan(0);
  expect((await page.evaluate(() => (window as StenoWindow).stenoai.recording.stop())).success).toBe(true);
});

test('renderer reload abandons only its claimed capture and permits a new start', async ({
  launchApp, userDataDir,
}) => {
  writeUserConfig(userDataDir, { system_audio_enabled: false, transcription_engine: 'whisper' });
  const { page } = await launchApp({ env: captureOnlyEnv });
  await installSyntheticMic(page);
  expect((await page.evaluate(() => (window as StenoWindow).stenoai.recording.start('Reload_A'))).success).toBe(true);
  await expect.poll(() => recordedBytes(userDataDir, 'Reload_A')).toBeGreaterThan(0);
  await page.reload();
  await page.waitForSelector('[data-app-ready]');
  await expect.poll(async () => (await page.evaluate(() =>
    (window as StenoWindow).stenoai.recording.getQueue())).hasRecording).toBe(false);
  await installSyntheticMic(page);
  expect((await page.evaluate(() => (window as StenoWindow).stenoai.recording.start('Reload_B'))).success).toBe(true);
  await expect.poll(() => recordedBytes(userDataDir, 'Reload_B')).toBeGreaterThan(0);
  expect((await page.evaluate(() => (window as StenoWindow).stenoai.recording.stop())).success).toBe(true);
});
