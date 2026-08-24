import { test, expect } from "../fixtures/electron";
import { realUserDataDir, fileSig } from "../fixtures/real-user-data";
import { writeUserConfig } from "../fixtures/user-config";
import {
  ensureMockAppleSidecarExecutable,
  readSidecarLogs,
} from "../fixtures/mock-apple-transcribe-fixture";
import { existsSync } from "fs";
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

  const setLangRes = await page.evaluate(() =>
    (window as StenoWindow).stenoai.settings.setLanguage("zh-Hant"),
  );
  expect(setLangRes.success).not.toBe(false);

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
  await expect
    .poll(
      async () => {
        const state = await page.evaluate(() =>
          (window as StenoWindow).stenoai.liveTranscript.getState(),
        );
        return state.segments || [];
      },
      {
        message: "retained pre-switch final and offset post-switch final",
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
      expect.objectContaining({
        text: "Apple live utterance (zh-Hant)",
        start: 2.5,
        end: 5.0,
        isFinal: true,
      }),
    ]);

  const stateBeforeStop = await page.evaluate(() =>
    (window as StenoWindow).stenoai.liveTranscript.getState(),
  );
  expect(stateBeforeStop.segments).toHaveLength(2);
  expect(stateBeforeStop.segments[0].end).toBeLessThanOrEqual(
    stateBeforeStop.segments[1].start,
  );
  expect(stateBeforeStop.segments[1].start).toBe(2.5);
  expect(stateBeforeStop.segments[1].end).toBe(5.0);
  const stopRes = await page.evaluate(() =>
    (window as StenoWindow).stenoai.recording.stop(),
  );
  expect(stopRes.success).toBe(true);

  expect(fileSig(realUserDataDir())).toBe(realDirBefore);
});
