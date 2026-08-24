import { test, expect } from "../fixtures/electron";
import type { Page } from "@playwright/test";

/**
 * T1 — renderer-only, mock IPC, no backend. Proves the Settings → Transcribe
 * language picker exposes the European languages on the Parakeet engine, so a
 * French/German/… user can pin their language (which drives the summary/title/
 * chat output language even though Parakeet's decoder is language-agnostic).
 * Before #264's fix the Parakeet picker offered only Auto/English, leaving
 * non-English European users stuck with English notes.
 *
 * The picker list is engine-gated in the renderer (LANGUAGES_PARAKEET in
 * Settings.tsx, mirrored by PARAKEET_LANGUAGES in hooks/useModels.ts for the
 * engine-switch coercion). Mock IPC seeds engine=parakeet + language=auto (see
 * app/e2e-mock-ipc.js) so the picker renders enabled on first paint.
 */

const EUROPEAN = [
  "English",
  "Spanish",
  "French",
  "German",
  "Dutch",
  "Portuguese",
];
// Non-European: Whisper-only, must NOT appear on Parakeet (it can't transcribe them).
const NON_EUROPEAN = ["Japanese", "Chinese", "Korean", "Hindi", "Arabic"];

async function openTranscribeLanguagePicker(page: Page) {
  await page.evaluate(() => {
    window.location.hash = "#/settings?tab=transcription";
  });
  // The Transcribe section now has two comboboxes (Language, and the
  // Parakeet/Whisper Model picker) — target the Language trigger by testid
  // rather than relying on it being the only one.
  const trigger = page.getByTestId("transcription-language-select");
  await expect(trigger).toBeVisible();
  await trigger.click();
}

test("Parakeet language picker offers European languages and hides non-European ones", async ({
  launchApp,
}) => {
  const { page } = await launchApp({ mockIpc: true });

  await openTranscribeLanguagePicker(page);

  // Auto + the six European languages are pinnable on Parakeet.
  await expect(
    page.getByRole("option", { name: "Auto (detect)" }),
  ).toBeVisible();
  for (const lang of EUROPEAN) {
    await expect(
      page.getByRole("option", { name: lang, exact: true }),
    ).toBeVisible();
  }
  // Languages Parakeet cannot transcribe stay Whisper-only.
  for (const lang of NON_EUROPEAN) {
    await expect(
      page.getByRole("option", { name: lang, exact: true }),
    ).toHaveCount(0);
  }
});

test("Apple on-device model exposes Apple-supported languages without a download", async ({
  launchApp,
}) => {
  const { page } = await launchApp({
    mockIpc: true,
    env: {
      STENOAI_E2E_MOCK_ENGINE: "apple",
      STENOAI_E2E_MOCK_APPLE_INSTALLED: "1",
      STENOAI_E2E_RENDERER_PLATFORM: "darwin",
    },
  });

  await page.evaluate(() => {
    window.location.hash = "#/settings?tab=transcription";
  });

  const modelTrigger = page.getByTestId("transcription-model-select");
  await expect(modelTrigger).toContainText("Apple On-Device");
  await modelTrigger.click();
  await expect(
    page.getByRole("option", { name: /Apple On-Device/ }),
  ).toBeVisible();
  await page.keyboard.press("Escape");

  await page.getByTestId("transcription-language-select").click();
  await expect(
    page.getByRole("option", { name: "Auto (system language)" }),
  ).toBeVisible();
  await expect(page.getByRole("option", { name: "Japanese" })).toBeVisible();
  await expect(
    page.getByRole("option", { name: "Chinese (Traditional)" }),
  ).toBeVisible();
  await expect(page.getByRole("option", { name: "Dutch" })).toHaveCount(0);
  await expect(page.getByRole("option", { name: "Arabic" })).toHaveCount(0);
});
