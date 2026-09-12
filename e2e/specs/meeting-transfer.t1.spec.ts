import { test, expect } from "../fixtures/electron";
import { writeFileSync } from "fs";
import path from "path";

const TRANSFER_ENV = {
  STENOAI_E2E_MEETING_TRANSFER: "1",
  STENOAI_E2E_RENDERER_PLATFORM: "darwin",
  STENOAI_E2E_MOCK_PARAKEET_INSTALLED: "1",
};

const mockCalls = (app: import("@playwright/test").ElectronApplication) =>
  app.evaluate(
    () => (global as unknown as { __mockIpcCalls: string[] }).__mockIpcCalls,
  );

test("Import Steno package opens the imported Swift note on My notes", async ({
  launchApp,
}) => {
  const { app, page } = await launchApp({ mockIpc: true, env: TRANSFER_ENV });

  await page.getByRole("button", { name: "Recording options" }).click();
  await page.getByRole("button", { name: "Import Steno package…" }).click();

  await expect(page).toHaveURL(/#\/meetings\/imported-swift-note_summary\.md/);
  await expect(page.getByTestId("tab-notes")).toHaveAttribute(
    "aria-selected",
    "true",
  );
  await expect(page.getByTestId("my-notes-input")).toHaveValue(
    "Notes written on iPhone and transferred to this Mac.",
  );

  await expect.poll(() => mockCalls(app)).toContain("import-meeting-package");
});

test("dropping a .stenomeeting package imports it through the meeting-transfer path", async ({
  launchApp,
  userDataDir,
}) => {
  const packagePath = path.join(userDataDir, "dropped.stenomeeting");
  writeFileSync(packagePath, "synthetic T1 package bytes");
  const { app, page } = await launchApp({ mockIpc: true, env: TRANSFER_ENV });

  await page.evaluate(() => {
    const input = document.createElement("input");
    input.type = "file";
    input.id = "meeting-transfer-drop-fixture";
    document.body.appendChild(input);
  });
  await page.setInputFiles("#meeting-transfer-drop-fixture", packagePath);
  await page.evaluate(() => {
    const input = document.querySelector<HTMLInputElement>(
      "#meeting-transfer-drop-fixture",
    )!;
    const transfer = new DataTransfer();
    transfer.items.add(input.files![0]);
    window.dispatchEvent(
      new DragEvent("dragenter", {
        bubbles: true,
        cancelable: true,
        dataTransfer: transfer,
      }),
    );
    window.dispatchEvent(
      new DragEvent("drop", {
        bubbles: true,
        cancelable: true,
        dataTransfer: transfer,
      }),
    );
  });

  await expect(page).toHaveURL(/#\/meetings\/imported-swift-note_summary\.md/);
  await expect(page.getByTestId("my-notes-input")).toHaveValue(
    "Notes written on iPhone and transferred to this Mac.",
  );
  await expect.poll(() => mockCalls(app)).toContain("import-meeting-package");
});

test("meeting-transfer actions stay hidden on Windows", async ({
  launchApp,
}) => {
  const { page } = await launchApp({
    mockIpc: true,
    env: { ...TRANSFER_ENV, STENOAI_E2E_RENDERER_PLATFORM: "win32" },
  });

  await page.getByRole("button", { name: "Recording options" }).click();
  await expect(
    page.getByRole("button", { name: "Import Steno package…" }),
  ).toHaveCount(0);

  await page.evaluate(() => {
    window.location.hash = "#/meetings/imported-swift-note_summary.md";
  });
  await expect(page.getByTestId("meeting-detail")).toBeVisible();
  await page.getByRole("button", { name: "More options" }).click();
  await expect(
    page.getByRole("button", { name: "Share Steno package…" }),
  ).toHaveCount(0);
});

test("Share Steno package is disabled while the note is processing", async ({
  launchApp,
}) => {
  const { page } = await launchApp({
    mockIpc: true,
    env: {
      ...TRANSFER_ENV,
      STENOAI_E2E_MEETING_TRANSFER: "0",
      STENOAI_E2E_SEED_PROCESSING_NOTE: "1",
    },
  });

  await page.evaluate(() => {
    window.location.hash = "#/meetings/processing_summary.md";
  });
  await expect(page.getByTestId("meeting-detail")).toBeVisible();
  await page.getByRole("button", { name: "More options" }).click();
  await expect(
    page.getByRole("button", { name: "Share Steno package…" }),
  ).toBeDisabled();
});

test("package actions are disabled while another meeting is processing", async ({ launchApp, userDataDir }) => {
  const queue = path.join(userDataDir, "synthetic-queue.json");
  writeFileSync(queue, JSON.stringify({ isProcessing: true, currentJob: "Another meeting" }));
  const { page } = await launchApp({ mockIpc: true, env: {
    ...TRANSFER_ENV, STENOAI_E2E_QUEUE_STATE_PATH: queue,
  } });
  await page.getByRole("button", { name: "Recording options" }).click();
  await expect(page.getByRole("button", { name: "Import Steno package…" })).toBeDisabled();
  await page.keyboard.press("Escape");
  await page.evaluate(() => { window.location.hash = "#/meetings/imported-swift-note_summary.md"; });
  await expect(page.getByTestId("meeting-detail")).toBeVisible();
  await page.getByRole("button", { name: "More options" }).click();
  await expect(page.getByRole("button", { name: "Share Steno package…" })).toBeDisabled();
  writeFileSync(queue, JSON.stringify({ isProcessing: false }));
  await expect(page.getByRole("button", { name: "Share Steno package…" })).toBeEnabled();
});

test("package actions wait for the initial recording status", async ({ launchApp, userDataDir }) => {
  const queue = path.join(userDataDir, "held-queue.json");
  writeFileSync(queue, JSON.stringify({ holdForTransferTest: true }));
  const { app, page } = await launchApp({ mockIpc: true, env: {
    ...TRANSFER_ENV, STENOAI_E2E_QUEUE_STATE_PATH: queue,
  } });
  await page.getByRole("button", { name: "Recording options" }).click();
  await expect(page.getByRole("button", { name: "Import Steno package…" })).toBeDisabled();
  await page.keyboard.press("Escape");
  await page.evaluate(() => { window.location.hash = "#/meetings/imported-swift-note_summary.md"; });
  await expect(page.getByTestId("meeting-detail")).toBeVisible();
  await page.getByRole("button", { name: "More options" }).click();
  await expect(page.getByRole("button", { name: "Share Steno package…" })).toBeDisabled();
  await app.evaluate(() => {
    for (const resolve of (globalThis as any).__pendingTransferQueue) {
      resolve();
    }
  });
  await expect(page.getByRole("button", { name: "Share Steno package…" })).toBeEnabled();
});
