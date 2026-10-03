import { test, expect } from "../fixtures/electron";
import type { ElectronApplication } from "@playwright/test";
import { writeFileSync } from "fs";
import path from "path";
import { version } from "../../app/package.json";

const env = {
  STENOAI_E2E_APP_VERSION: version,
  STENOAI_E2E_MOCK_PARAKEET_INSTALLED: "1",
};
const title = "What’s new in Steno";
const seenKey = "steno-last-seen-release";

async function foreground(app: ElectronApplication) {
  await app.evaluate(({ BrowserWindow }) => {
    const win = BrowserWindow.getAllWindows().find((w) =>
      w.webContents.getURL().includes("index.html"),
    )!;
    win.show();
    win.focus();
  });
}

test("upgrade waits for foreground, dismisses across restarts, and reopens from About", async ({
  launchApp,
}, testInfo) => {
  const first = await launchApp({ mockIpc: true, env });
  // Playwright forces document focus by default, including hidden windows.
  const cdp = await first.page.context().newCDPSession(first.page);
  await cdp.send("Emulation.setFocusEmulationEnabled", { enabled: false });
  await first.page.evaluate(
    (key) => localStorage.setItem(key, "0.0.1"),
    seenKey,
  );
  await first.page.reload();
  await expect(
    first.page.locator('[role="dialog"][data-state="open"]'),
  ).toHaveCount(0);
  await foreground(first.app);
  const dialog = first.page.getByRole("dialog", { name: title });
  await expect(dialog).toBeVisible();
  await expect(
    dialog.getByRole("button", { name: "Try Agents" }),
  ).toBeVisible();
  await expect(dialog.getByRole("button", { name: "Open Chat" })).toBeVisible();
  await first.page.screenshot({
    path: testInfo.outputPath("whats-new-light.png"),
    animations: "disabled",
  });
  await dialog.getByRole("button", { name: "Done", exact: true }).click();
  expect(
    await first.page.evaluate((key) => localStorage.getItem(key), seenKey),
  ).toBe(version);
  await first.app.close();

  const second = await launchApp({ mockIpc: true, env });
  await foreground(second.app);
  await expect(second.page.getByRole("dialog", { name: title })).toHaveCount(0);
  await second.page.evaluate(() => {
    location.hash = "#/settings?tab=about";
  });
  await second.page.getByRole("button", { name: "View highlights" }).click();
  const reopened = second.page.getByRole("dialog", { name: title });
  await expect(reopened).toBeVisible();
  await second.page.evaluate(() =>
    document.documentElement.classList.add("dark"),
  );
  await second.page.screenshot({
    path: testInfo.outputPath("whats-new-dark.png"),
    animations: "disabled",
  });
  await reopened.getByRole("button", { name: "Try Agents" }).click();
  await expect(
    second.page.getByRole("heading", { name: "Your notes, in your agent." }),
  ).toBeVisible();
  await expect(reopened).toHaveCount(0);
});

test("fresh setup establishes a baseline without an announcement", async ({
  launchApp,
}) => {
  const { app, page } = await launchApp({
    mockIpc: true,
    env: { STENOAI_E2E_APP_VERSION: version },
  });
  await expect.poll(() => page.evaluate(() => location.hash)).toBe("#/setup");
  await foreground(app);
  await expect
    .poll(() => page.evaluate((key) => localStorage.getItem(key), seenKey))
    .toBe(version);
  await expect(page.getByRole("dialog", { name: title })).toHaveCount(0);
  await page.evaluate(() => {
    location.hash = "#/chat";
  });
  await expect(
    page.getByRole("heading", { name: "Ask anything" }),
  ).toBeVisible();
  await expect(page.getByRole("dialog", { name: title })).toHaveCount(0);
});

for (const state of ["recording", "paused", "processing"]) {
  test(`announcement waits until ${state} finishes`, async ({
    launchApp,
    userDataDir,
  }) => {
    const queuePath = path.join(userDataDir, "queue.json");
    writeFileSync(
      queuePath,
      JSON.stringify({
        hasRecording: state !== "processing",
        isPaused: state === "paused",
        isProcessing: state === "processing",
        sessionName: "Test note",
      }),
    );
    const { app, page } = await launchApp({
      mockIpc: true,
      env: { ...env, STENOAI_E2E_QUEUE_STATE_PATH: queuePath },
    });
    await foreground(app);
    await expect(page.getByRole("dialog", { name: title })).toHaveCount(0);
    expect(
      await page.evaluate((key) => localStorage.getItem(key), seenKey),
    ).toBeNull();
    writeFileSync(queuePath, "{}");
    await expect(page.getByRole("dialog", { name: title })).toBeVisible({
      timeout: 15000,
    });
  });
}

test("manually revisiting setup does not acknowledge an unseen release", async ({
  launchApp,
}) => {
  const { app, page } = await launchApp({ mockIpc: true, env });
  await page.evaluate(() => {
    location.hash = "#/setup";
  });
  await expect.poll(() => page.evaluate(() => location.hash)).toBe("#/setup");
  await expect(page.getByRole("dialog", { name: title })).toHaveCount(0);
  expect(
    await page.evaluate((key) => localStorage.getItem(key), seenKey),
  ).toBeNull();
  await page.evaluate(() => {
    location.hash = "#/chat";
  });
  await foreground(app);
  await expect(page.getByRole("dialog", { name: title })).toBeVisible();
});

test("an explicit About request opens highlights immediately during recording", async ({
  launchApp,
  userDataDir,
}) => {
  const queuePath = path.join(userDataDir, "queue.json");
  writeFileSync(
    queuePath,
    JSON.stringify({ hasRecording: true, sessionName: "Test note" }),
  );
  const { app, page } = await launchApp({
    mockIpc: true,
    env: { ...env, STENOAI_E2E_QUEUE_STATE_PATH: queuePath },
  });
  await foreground(app);
  await expect(page.getByRole("dialog", { name: title })).toHaveCount(0);
  await page.evaluate(() => {
    location.hash = "#/settings?tab=about";
  });
  await page.getByRole("button", { name: "View highlights" }).click();
  await expect(page.getByRole("dialog", { name: title })).toBeVisible();
});
