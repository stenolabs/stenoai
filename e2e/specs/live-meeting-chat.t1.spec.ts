import { test, expect } from "../fixtures/electron";
import type { Page } from "@playwright/test";

/**
 * T1 — renderer-only, mock IPC. The Ask bar stays enabled while recording,
 * routes submissions to the live transcript stream, renders streamed chunks,
 * and exposes cancellation. app/e2e-mock-ipc.js supplies the stateful stream;
 * no backend or model runs.
 */

const PILL_ENV = {
  STENOAI_E2E_MOCK_PARAKEET_INSTALLED: "1",
  STENOAI_E2E_MOCK_LIVE_STREAM: "1",
};
const MESSAGES_TESTID = '[data-testid="chat-messages"]';
// Start a recording in the BACKGROUND (as a hotkey/tray/auto trigger does) so the
// Ask bar stays put with the composer enabled. Mirrors pill-dock.t1.
async function startInBackground(page: Page, name = "Epsilon Planning") {
  await page.evaluate((sessionName) => window.stenoai.recording.start(sessionName), name);
  await expect(page.getByTestId("transcription-pill")).toBeVisible();
}

const LIVE_PLACEHOLDER = "Ask about the live transcript…";
const OLD_DISABLED_HINT = "Chat available after recording";

test("recording enables the composer with the live placeholder (not the disabled hint)", async ({
  launchApp,
}) => {
  const { page } = await launchApp({
    mockIpc: true,
    env: { ...PILL_ENV, STENOAI_E2E_SEED_MEETING: "1" },
  });

  // On a meeting, idle: the composer is enabled with the normal hint.
  await page.evaluate(() => {
    window.location.hash = "#/meetings/epsilon_summary.json";
  });
  await expect(
    page.getByPlaceholder("Ask anything about this meeting…"),
  ).toBeVisible();

  // Start recording in the background — the Ask bar stays (disabled={recordingActive}
  // is only a layout signal on PrimaryDock); AskBar itself reads recording status.
  await startInBackground(page);
  // The recording coexists — home did not navigate to /recording.
  const hash = await page.evaluate(() => window.location.hash);
  expect(hash).not.toContain("/recording");

  // The composer is ENABLED now, with the live-transcript placeholder.
  const liveInput = page.getByPlaceholder(LIVE_PLACEHOLDER);
  await expect(liveInput).toBeVisible();
  await expect(liveInput).toBeEnabled();

  // The old disabled hint must NOT be present anywhere.
  await expect(page.getByPlaceholder(OLD_DISABLED_HINT)).toHaveCount(0);

  // Stopped recording on the meeting view returns to the meeting placeholder.
  await page.evaluate(() => window.stenoai.recording.stop());
  await expect(
    page.getByPlaceholder("Ask anything about this meeting…"),
  ).toBeVisible();
  await expect(page.getByPlaceholder(OLD_DISABLED_HINT)).toHaveCount(0);
});

test("live stream: submit routes to the live transcript and streamed answer renders", async ({
  launchApp,
}) => {
  const { page } = await launchApp({ mockIpc: true, env: PILL_ENV });

  await startInBackground(page);

  const question = "What decision did the team reach on shipping Friday?";

  // Type the question into the live-enabled composer and submit (Enter).
  const input = page.getByPlaceholder(LIVE_PLACEHOLDER);
  await input.click();
  await input.fill(question);
  await page.keyboard.press("Enter");

  // The stream is live: the composer now shows the Stop affordance.
  const stopButton = page.getByRole("button", { name: "Stop", exact: true });
  await expect(stopButton).toBeVisible();
  // The streamed answer appears alongside the user's question.
  const body = () =>
    page.locator(MESSAGES_TESTID).evaluate((el) => el.textContent ?? "");
  await expect.poll(body, { timeout: 10_000 }).toContain(question);
  await expect.poll(body, { timeout: 10_000 }).toContain("ship on Friday");
});

test("live stream: the stop/cancel button cancels an in-flight answer", async ({
  launchApp,
}) => {
  const { page } = await launchApp({ mockIpc: true, env: PILL_ENV });

  await startInBackground(page);

  const input = page.getByPlaceholder(LIVE_PLACEHOLDER);
  await input.click();
  await input.fill("What were the next steps?");
  await page.keyboard.press("Enter");

  // Stream active → stop button.
  const stopButton = page.getByRole("button", { name: "Stop", exact: true });
  await expect(stopButton).toBeVisible();

  // Click stop → cancels the stream. The composer returns to the Send affordance.
  await stopButton.click();
  await expect(
    page.getByRole("button", { name: "Send", exact: true }),
  ).toBeVisible();

  // Re-type and submit: a new in-flight stream exposes Stop again, proving the
  // cancel returned the bar to a reusable (not stuck-disabled) state.
  await input.fill("Any risks?");
  await page.keyboard.press("Enter");
  await expect(stopButton).toBeVisible();
});
