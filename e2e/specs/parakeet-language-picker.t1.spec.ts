import { test, expect } from '../fixtures/electron';
import type { Page } from '@playwright/test';

/**
 * T1 — renderer-only, mock IPC, no backend. Proves the Settings → Transcribe
 * language picker exposes the European languages on the Parakeet engine, so a
 * French/German/… user can pin their language (which drives the summary/title/
 * chat output language even though Parakeet's decoder is language-agnostic).
 * Before #264's fix the Parakeet picker offered only Auto/English, leaving
 * non-English European users stuck with English notes.
 *
 * Settings and the live bar share PARAKEET_LANGUAGES with the engine-switch
 * coercion. Mock IPC seeds engine=parakeet + language=auto (see
 * app/e2e-mock-ipc.js) so the picker renders enabled on first paint.
 */

const EUROPEAN = [
  'English',
  'Spanish',
  'French',
  'German',
  'Italian',
  'Dutch',
  'Portuguese',
  'Russian',
];
// Non-European: Whisper-only, must NOT appear on Parakeet (it can't transcribe them).
const NON_EUROPEAN = ['Japanese', 'Chinese', 'Korean', 'Hindi', 'Arabic', 'Hebrew'];

async function openTranscribeLanguagePicker(page: Page) {
  await page.evaluate(() => {
    window.location.hash = '#/settings?tab=transcription';
  });
  // The Transcribe section now has two comboboxes (Language, and the
  // Parakeet/Whisper Model picker) — target the Language trigger by testid
  // rather than relying on it being the only one.
  const trigger = page.getByTestId('transcription-language-select');
  await expect(trigger).toBeVisible();
  await trigger.click();
}

test('Parakeet language picker offers European languages and hides non-European ones', async ({
  launchApp,
}) => {
  const { page } = await launchApp({ mockIpc: true });

  await openTranscribeLanguagePicker(page);

  // Auto + the curated European languages are pinnable on Parakeet.
  await expect(page.getByRole('option', { name: 'Auto (detect)' })).toBeVisible();
  for (const lang of EUROPEAN) {
    await expect(page.getByRole('option', { name: lang, exact: true })).toBeVisible();
  }
  // Languages Parakeet cannot transcribe stay Whisper-only.
  for (const lang of NON_EUROPEAN) {
    await expect(page.getByRole('option', { name: lang, exact: true })).toHaveCount(0);
  }
});

test('Italian can be selected on Whisper and Parakeet and survives the engine switch', async ({
  launchApp,
}) => {
  const { page } = await launchApp({
    mockIpc: true,
    env: { STENOAI_E2E_MOCK_ENGINE: 'whisper' },
  });

  await openTranscribeLanguagePicker(page);
  await page.getByRole('option', { name: 'Italian', exact: true }).click();
  const language = page.getByTestId('transcription-language-select');
  await expect(language).toHaveText('Italian');
  await expect
    .poll(() => page.evaluate(() => window.stenoai.settings.getLanguage()))
    .toMatchObject({ success: true, language: 'it' });

  const model = page.getByTestId('transcription-model-select');
  await model.click();
  await page.getByRole('option', { name: /Parakeet TDT v3/ }).click();
  await expect(model).toContainText('Parakeet TDT v3');
  await expect(language).toHaveText('Italian');
  await expect
    .poll(() => page.evaluate(() => window.stenoai.settings.getLanguage()))
    .toMatchObject({ success: true, language: 'it' });

  // Exercise selecting Italian on Parakeet too, not only retaining its value.
  await language.click();
  await page.getByRole('option', { name: 'Auto (detect)', exact: true }).click();
  await expect(language).toHaveText('Auto (detect)');
  await language.click();
  await page.getByRole('option', { name: 'Italian', exact: true }).click();
  await expect(language).toHaveText('Italian');
  await expect
    .poll(() => page.evaluate(() => window.stenoai.settings.getLanguage()))
    .toMatchObject({ success: true, language: 'it' });
});

test('the live transcript bar can select Italian and shares it with Settings', async ({
  launchApp,
}) => {
  const { page } = await launchApp({
    mockIpc: true,
    fakeAudio: true,
    env: { STENOAI_E2E_MOCK_PARAKEET_INSTALLED: '1' },
  });
  await page.evaluate(() => window.stenoai.recording.start('Italian language test'));
  await page
    .getByTestId('transcription-pill')
    .getByRole('button', { name: 'Show transcript' })
    .click();
  const panel = page.getByTestId('live-transcript-panel');
  await expect(panel).toBeVisible();
  await panel.getByRole('button', { name: 'Language: Multi', exact: true }).click();
  await page
    .getByRole('button', {
      name: 'Italian Transcribe and summarise in Italian',
      exact: true,
    })
    .click();
  await expect(panel.getByRole('button', { name: 'Language: Italian', exact: true })).toBeVisible();
  await expect
    .poll(() => page.evaluate(() => window.stenoai.settings.getLanguage()))
    .toMatchObject({ success: true, language: 'it' });

  await page.evaluate(() => {
    window.location.hash = '#/settings?tab=transcription';
  });
  await expect(page.getByTestId('transcription-language-select')).toHaveText('Italian');
});
