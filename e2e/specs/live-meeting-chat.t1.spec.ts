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

test("live stream: multi-turn follow-up carries prior conversation history to IPC", async ({
  launchApp,
}) => {
  const { app, page } = await launchApp({ mockIpc: true, env: PILL_ENV });

  await startInBackground(page, "Multi Turn Session");

  const q1 = "What decision did the team reach on shipping Friday?";
  const input = page.getByPlaceholder(LIVE_PLACEHOLDER);
  await input.click();
  await input.fill(q1);
  await page.keyboard.press("Enter");

  // Wait for first answer to finish streaming and render.
  const body = () =>
    page.locator(MESSAGES_TESTID).evaluate((el) => el.textContent ?? "");
  await expect.poll(body, { timeout: 10_000 }).toContain(q1);
  await expect.poll(body, { timeout: 10_000 }).toContain("ship on Friday");
  await expect(page.getByRole("button", { name: "Send", exact: true })).toBeVisible();

  // Ask a follow-up turn.
  const q2 = "Who is responsible for the release notes?";
  await input.fill(q2);
  await page.keyboard.press("Enter");

  await expect.poll(body, { timeout: 10_000 }).toContain(q2);
  await expect.poll(body, { timeout: 10_000 }).toContain("ship on Friday");
  await expect(page.getByRole("button", { name: "Send", exact: true })).toBeVisible();

  // Inspect the captured live queries in main process
  const queries = await app.evaluate(() => {
    return (
      globalThis as unknown as {
        __stenoai_e2e_live_queries: Array<{
          queryId: string;
          sessionName: string;
          question: string;
          history?: Array<{ role: string; content: string }>;
        }>;
      }
    ).__stenoai_e2e_live_queries;
  });

  expect(queries.length).toBeGreaterThanOrEqual(2);
  const secondQuery = queries[queries.length - 1];
  expect(secondQuery.question).toBe(q2);
  expect(Array.isArray(secondQuery.history)).toBe(true);
  expect(secondQuery.history!.length).toBe(2);
  expect(secondQuery.history![0]).toMatchObject({ role: "user", content: q1 });
  expect(secondQuery.history![1]).toMatchObject({ role: "assistant" });
  expect(secondQuery.history![1].content).toContain("ship on Friday");
});

test("live stream: composer is disabled when live transcript is not ready, then enabled when ready", async ({
  launchApp,
}) => {
  const { app, page } = await launchApp({
    mockIpc: true,
    env: {
      ...PILL_ENV,
      STENOAI_E2E_MOCK_LIVE_TRANSCRIPT_NOT_READY: "1",
    },
  });

  await startInBackground(page, "Gating Session");
  // When live transcript sidecar is not ready, composer is disabled with placeholder.
  const unavailableInput = page.getByPlaceholder(/Live transcript unavailable/);
  await expect(unavailableInput).toBeVisible();
  await expect(unavailableInput).toBeDisabled();

  // Becoming ready on the same session flips the status-derived input state.
  await app.evaluate(({ BrowserWindow }, sessionName: string) => {
    const win = BrowserWindow.getAllWindows()[0];
    if (!win) throw new Error("no BrowserWindow to emit into");
    win.webContents.send("live-transcript-ready", { sessionName });
  }, "Gating Session");

  const liveInput = page.getByPlaceholder(LIVE_PLACEHOLDER);
  await expect(liveInput).toBeVisible();
  await expect(liveInput).toBeEnabled();
});

test("live stream: a resumed recording with prior segments streams an answer", async ({
  launchApp,
}) => {
  const { page } = await launchApp({
    mockIpc: true,
    env: {
      ...PILL_ENV,
      STENOAI_E2E_SEED_PRIOR_SEGMENTS: "1",
    },
  });

  await startInBackground(page, "Resumed Session");

  const question = "What was discussed earlier in the meeting?";
  const input = page.getByPlaceholder(LIVE_PLACEHOLDER);
  await input.click();
  await input.fill(question);
  await page.keyboard.press("Enter");

  const body = () =>
    page.locator(MESSAGES_TESTID).evaluate((el) => el.textContent ?? "");
  await expect.poll(body, { timeout: 10_000 }).toContain(question);
  await expect.poll(body, { timeout: 10_000 }).toContain("ship on Friday");
});
