import { test, expect } from "../fixtures/electron";
import { realUserDataDir, fileSig } from "../fixtures/real-user-data";
import { writeUserConfig } from "../fixtures/user-config";
import {
  ensureMockAppleSidecarExecutable,
  readSidecarLogs,
} from "../fixtures/mock-apple-transcribe-fixture";
import { existsSync, writeFileSync } from "fs";
import path from "path";

/**
 * T2 — Apple Speech language-switch restart.
 *
 * Proves the live transcription sidecar restart lifecycle across the real
 * settings IPC bridge and Electron main process:
 * 1. Initial recording starts with `transcription_engine=apple` and `language=en`,
 *    spawning the sidecar with `stream en`.
 * 2. Changing language via the real settings bridge (`setLanguage('zh-Hant')`)
 *    persists the change, stops the active sidecar cleanly, and restarts it
 *    with `stream zh-Hant`.
 * 3. Model-free by construction: points STENOAI_TRANSCRIBE_SIDECAR_PATH at an
 *    executable fixture sidecar that records its argv and emits LIVE_READY without
 *    loading real SpeechTranscriber or ASR weights.
 */

const BACKEND = path.resolve(
  __dirname,
  "..",
  "..",
  "dist",
  "stenoai",
  process.platform === "win32" ? "stenoai.exe" : "stenoai",
);

type RecResult = { success: boolean; error?: string; sessionName?: string };
type LiveTranscriptSegment = {
  text: string;
  start: number;
  end: number;
  isFinal: boolean;
  speaker?: string;
};
type LiveTranscriptStateResult = {
  success: boolean;
  sessionName: string | null;
  segments: LiveTranscriptSegment[];
  priorSegments: LiveTranscriptSegment[];
  ready: boolean;
  error: unknown;
};
type StenoWindow = Window & {
  stenoai: {
    recording: {
      start: (
        name?: string,
        trigger?: string,
        appendTo?: string,
      ) => Promise<RecResult>;
      stop: () => Promise<RecResult>;
    };
    liveTranscript: {
      getState: () => Promise<LiveTranscriptStateResult>;
    };
    settings: {
      setLanguage: (
        code: string,
      ) => Promise<{ success: boolean; error?: string }>;
      getLanguage: () => Promise<unknown>;
    };
  };
};
test("switching language during Apple recording restarts live transcribe sidecar with new locale", async ({
  launchApp,
  userDataDir,
}) => {
  test.setTimeout(120_000);

  if (!existsSync(BACKEND)) {
    // eslint-disable-next-line no-console
    console.warn(
      `[t2] SKIPPED apple-language-restart: backend bundle missing at ${BACKEND}`,
    );
    test.info().annotations.push({
      type: "skip-reason",
      description: "backend bundle not built",
    });
  }
  test.skip(!existsSync(BACKEND), "backend bundle not built");
  test.skip(
    process.platform !== "darwin",
    "Apple SpeechTranscriber is macOS-only",
  );

  const realDirBefore = fileSig(realUserDataDir());

  const sidecarPath = ensureMockAppleSidecarExecutable();
  const logPath = path.join(userDataDir, "sidecar-launches.log");

  writeUserConfig(userDataDir, {
    transcription_engine: "apple",
    language: "en",
    system_audio_enabled: true,
  });

  const { page } = await launchApp({
    fakeAudio: true,
    env: {
      STENOAI_TRANSCRIBE_SIDECAR_PATH: sidecarPath,
      STENOAI_MOCK_SIDECAR_LOG: logPath,
      STENOAI_MOCK_SIDECAR_REJECT_LOCALE: 'ja',
    },
  });

  const startRes = await page.evaluate(() =>
    (window as StenoWindow).stenoai.recording.start(
      "Apple Language Restart E2E",
    ),
  );
  expect(startRes.success).toBe(true);

  await expect
    .poll(
      () =>
        readSidecarLogs(logPath)
          .map((log) => log.args)
          .filter((args) => args[0] === "stream"),
      {
        message: "initial sidecar launch with en",
        timeout: 15_000,
      },
    )
    .toEqual([["stream", "en"]]);

  // Wait for initial (en) live segment to be processed into liveTranscriptState
  await expect
    .poll(
      async () => {
        const state = await page.evaluate(() =>
          (window as StenoWindow).stenoai.liveTranscript.getState(),
        );
        return state.segments || [];
      },
      {
        message: "initial live segment before language restart",
        timeout: 15_000,
      },
    )
    .toEqual([
      expect.objectContaining({
        text: "Apple live utterance (en)",
        start: 0.0,
        end: 2.5,
        isFinal: true,
      }),
    ]);

  const rejected = await page.evaluate(() =>
    (window as StenoWindow).stenoai.settings.setLanguage('ja'),
  );
  expect(rejected.success).toBe(false);
  await expect.poll(() => page.evaluate(() =>
    (window as StenoWindow).stenoai.settings.getLanguage(),
  )).toMatchObject({ success: true, language: 'en' });

  const setLangRes = await page.evaluate(() =>
    (window as StenoWindow).stenoai.settings.setLanguage("zh-Hant"),
  );
  expect(setLangRes.success).toBe(true);

  await expect
    .poll(
      () =>
        readSidecarLogs(logPath)
          .map((log) => log.args)
          .filter((args) => args[0] === "stream"),
      {
        message: "restarted sidecar launch with zh-Hant",
        timeout: 15_000,
      },
    )
    .toEqual([
      ["stream", "en"],
      ["stream", "zh-Hant"],
    ]);

  // Assert retained pre-switch final precedes post-switch final and post-switch times are offset monotonically
  await expect.poll(async () => {
    const state = await page.evaluate(() =>
      (window as StenoWindow).stenoai.liveTranscript.getState(),
    );
    return state.segments?.map((segment) => segment.text) ?? [];
  }, {
    message: "retained pre-switch final and offset post-switch final",
    timeout: 15_000,
  }).toEqual(["Apple live utterance (en)", "Apple live utterance (zh-Hant)"]);

  const stateBeforeStop = await page.evaluate(() =>
    (window as StenoWindow).stenoai.liveTranscript.getState(),
  );
  expect(stateBeforeStop.segments).toHaveLength(2);
  expect(stateBeforeStop.segments[0].end).toBeLessThanOrEqual(
    stateBeforeStop.segments[1].start,
  );
  expect(stateBeforeStop.segments[0]).toMatchObject({ start: 0, end: 2.5, isFinal: true });
  expect(stateBeforeStop.segments[1].isFinal).toBe(true);
  expect(stateBeforeStop.segments[1].end - stateBeforeStop.segments[1].start).toBe(2.5);
  const stopRes = await page.evaluate(() =>
    (window as StenoWindow).stenoai.recording.stop(),
  );
  expect(stopRes.success).toBe(true);

  expect(fileSig(realUserDataDir())).toBe(realDirBefore);
});

test('Apple volatile withdrawal removes only its partial from main state', async ({
  launchApp,
  userDataDir,
}) => {
  test.setTimeout(120_000);
  test.skip(!existsSync(BACKEND), 'backend bundle not built');
  test.skip(process.platform !== 'darwin', 'Apple SpeechTranscriber is macOS-only');
  const realDirBefore = fileSig(realUserDataDir());
  const control = path.join(userDataDir, 'revoke-control');
  const sidecarPath = ensureMockAppleSidecarExecutable();
  const logPath = path.join(userDataDir, 'sidecar-revoke-launches.log');
  writeUserConfig(userDataDir, {
    transcription_engine: 'apple', language: 'en', system_audio_enabled: true,
  });
  const { page } = await launchApp({
    fakeAudio: true,
    env: {
      STENOAI_TRANSCRIBE_SIDECAR_PATH: sidecarPath,
      STENOAI_MOCK_SIDECAR_LOG: logPath,
      STENOAI_MOCK_SIDECAR_REVOKE_CONTROL: control,
    },
  });
  const started = await page.evaluate(() =>
    (window as StenoWindow).stenoai.recording.start('Apple Revoke E2E'),
  );
  expect(started.success).toBe(true);
  await expect.poll(async () => (await page.evaluate(() =>
    (window as StenoWindow).stenoai.liveTranscript.getState(),
  )).segments.map((segment) => segment.text), { timeout: 15_000 })
    .toEqual(['Retained final (en)', 'Withdraw me (en)', 'Other channel (en)']);

  writeFileSync(`${control}.withdraw`, 'withdraw');
  await expect.poll(async () => (await page.evaluate(() =>
    (window as StenoWindow).stenoai.liveTranscript.getState(),
  )).segments.map((segment) => segment.text), { timeout: 15_000 })
    .toEqual(['Retained final (en)', 'Other channel (en)']);

  writeFileSync(`${control}.final`, 'final');
  await expect.poll(async () => (await page.evaluate(() =>
    (window as StenoWindow).stenoai.liveTranscript.getState(),
  )).segments.map((segment) => segment.text), { timeout: 15_000 })
    .toEqual(['Retained final (en)', 'Final after revoke (en)', 'Other channel (en)']);
  const changed = await page.evaluate(() =>
    (window as StenoWindow).stenoai.settings.setLanguage('zh-Hant'),
  );
  expect(changed.success).toBe(true);
  await expect.poll(() => readSidecarLogs(logPath)
    .map((log) => log.args)
    .filter((args) => args[0] === 'stream'), {
    message: 'sidecar restarted after revocation and final', timeout: 15_000,
  }).toEqual([['stream', 'en'], ['stream', 'zh-Hant']]);
  await expect.poll(async () => (await page.evaluate(() =>
    (window as StenoWindow).stenoai.liveTranscript.getState(),
  )).segments.map((segment) => segment.text), { timeout: 15_000 })
    .toEqual(['Retained final (en)', 'Final after revoke (en)', 'Apple live utterance (zh-Hant)']);
  const afterRestart = await page.evaluate(() =>
    (window as StenoWindow).stenoai.liveTranscript.getState(),
  );
  expect(afterRestart.segments.every((segment) => segment.isFinal)).toBe(true);
  expect(afterRestart.segments[1].end).toBeLessThanOrEqual(afterRestart.segments[2].start);
  expect((await page.evaluate(() =>
    (window as StenoWindow).stenoai.recording.stop(),
  )).success).toBe(true);
  expect(fileSig(realUserDataDir())).toBe(realDirBefore);
});

for (const finalOrder of ['late', 'duplicate'] as const) {
  test(`Apple ${finalOrder} earlier final keeps the newer partial revocable`, async ({
    launchApp,
    userDataDir,
  }) => {
    test.setTimeout(120_000);
    test.skip(!existsSync(BACKEND), 'backend bundle not built');
    test.skip(process.platform !== 'darwin', 'Apple SpeechTranscriber is macOS-only');
    const control = path.join(userDataDir, `${finalOrder}-final-revoke`);
    writeUserConfig(userDataDir, {
      transcription_engine: 'apple', language: 'en', system_audio_enabled: true,
    });
    const { page } = await launchApp({
      fakeAudio: true,
      env: {
        STENOAI_TRANSCRIBE_SIDECAR_PATH: ensureMockAppleSidecarExecutable(),
        STENOAI_MOCK_SIDECAR_REVOKE_CONTROL: control,
        STENOAI_MOCK_SIDECAR_FINAL_ORDER: finalOrder,
      },
    });
    expect((await page.evaluate(() =>
      (window as StenoWindow).stenoai.recording.start('Apple Late Final E2E'),
    )).success).toBe(true);
    await expect.poll(async () => (await page.evaluate(() =>
      (window as StenoWindow).stenoai.liveTranscript.getState(),
    )).segments.map((segment) => segment.text), { timeout: 15_000 })
      .toEqual(['Earlier final (en)', 'Newer partial (en)']);
    writeFileSync(`${control}.withdraw`, 'withdraw');
    await expect.poll(async () => (await page.evaluate(() =>
      (window as StenoWindow).stenoai.liveTranscript.getState(),
    )).segments.map((segment) => segment.text), { timeout: 15_000 })
      .toEqual(['Earlier final (en)']);
    expect((await page.evaluate(() =>
      (window as StenoWindow).stenoai.recording.stop(),
    )).success).toBe(true);
  });
}

test('restarting Apple live cancels a pending withdrawal from the previous sidecar', async ({
  launchApp,
  userDataDir,
}) => {
  test.setTimeout(120_000);
  test.skip(!existsSync(BACKEND), 'backend bundle not built');
  test.skip(process.platform !== 'darwin', 'Apple SpeechTranscriber is macOS-only');
  const control = path.join(userDataDir, 'cancel-revoke-control');
  const sidecarPath = ensureMockAppleSidecarExecutable();
  writeUserConfig(userDataDir, {
    transcription_engine: 'apple', language: 'en', system_audio_enabled: true,
  });
  const { page } = await launchApp({
    fakeAudio: true,
    env: {
      STENOAI_TRANSCRIBE_SIDECAR_PATH: sidecarPath,
      STENOAI_MOCK_SIDECAR_REVOKE_CONTROL: control,
    },
  });
  expect((await page.evaluate(() =>
    (window as StenoWindow).stenoai.recording.start('Apple Cancel Revoke E2E'),
  )).success).toBe(true);
  await expect.poll(async () => (await page.evaluate(() =>
    (window as StenoWindow).stenoai.liveTranscript.getState(),
  )).segments.map((segment) => segment.text), { timeout: 15_000 })
    .toEqual(['Retained final (en)', 'Withdraw me (en)', 'Other channel (en)']);
  expect((await page.evaluate(() =>
    (window as StenoWindow).stenoai.settings.setLanguage('zh-Hant'),
  )).success).toBe(true);
  await expect.poll(async () => (await page.evaluate(() =>
    (window as StenoWindow).stenoai.liveTranscript.getState(),
  )).segments.map((segment) => segment.text), { timeout: 15_000 })
    .toEqual(['Retained final (en)', 'Apple live utterance (zh-Hant)']);
  writeFileSync(`${control}.withdraw`, 'withdraw old process');
  await page.waitForTimeout(100);
  const state = await page.evaluate(() =>
    (window as StenoWindow).stenoai.liveTranscript.getState(),
  );
  expect(state.segments.map((segment) => segment.text)).toEqual([
    'Retained final (en)', 'Apple live utterance (zh-Hant)',
  ]);
  expect(state.segments[0].end).toBeLessThanOrEqual(state.segments[1].start);
  expect((await page.evaluate(() =>
    (window as StenoWindow).stenoai.recording.stop(),
  )).success).toBe(true);
});
