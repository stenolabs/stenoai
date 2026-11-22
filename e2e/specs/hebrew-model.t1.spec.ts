import { test, expect } from '../fixtures/electron';

/**
 * T1 — renderer-only, mock IPC, no backend. Settings → Transcribe offers the
 * ivrit.ai Hebrew model download on the Whisper engine only (Parakeet can't
 * transcribe Hebrew, and the cloud engine never runs a local model), and the
 * Whisper language picker can pin Hebrew. The row only shows while the language
 * is Auto or Hebrew, or once the model is installed. The stateful mock starts the model
 * uninstalled and installs it on pull, so both the Download action and the
 * on/off switch are exercised. The list shape and the switch persisting to
 * config are covered against the real backend in model-management.t2.
 */

test('Whisper shows the Hebrew model download and can pin Hebrew', async ({ launchApp }) => {
  const { page } = await launchApp({
    mockIpc: true,
    env: { STENOAI_E2E_MOCK_ENGINE: 'whisper' },
  });
  await page.evaluate(() => {
    window.location.hash = '#/settings?tab=transcription';
  });

  const row = page.locator('[data-settings-tab="transcription"]').getByText('Hebrew model', { exact: true });
  await expect(row).toBeVisible();
  await expect(page.getByText(/ivrit\.ai's Hebrew-trained Whisper/)).toBeVisible();
  await expect(page.getByText(/Downloads 1\.6 GB\./)).toBeVisible();
  await expect(page.getByRole('button', { name: 'Download', exact: true })).toBeVisible();

  await page.getByTestId('transcription-language-select').click();
  await page.getByRole('option', { name: 'Hebrew', exact: true }).click();
  await expect
    .poll(() => page.evaluate(() => window.stenoai.settings.getLanguage()))
    .toMatchObject({ success: true, language: 'he' });
});

test('downloading the Hebrew model turns on a switch that can be turned off', async ({
  launchApp,
}) => {
  const { page } = await launchApp({
    mockIpc: true,
    env: { STENOAI_E2E_MOCK_ENGINE: 'whisper' },
  });
  await page.evaluate(() => {
    window.location.hash = '#/settings?tab=transcription';
  });

  await page.getByRole('button', { name: 'Download', exact: true }).click();
  const toggle = page.getByRole('switch', { name: 'Hebrew model' });
  await expect(toggle).toBeVisible();
  await expect(toggle).toBeChecked();
  await expect(page.getByRole('button', { name: 'Download', exact: true })).toHaveCount(0);

  await toggle.click();
  await expect(toggle).not.toBeChecked();
  await expect
    .poll(async () =>
      (await page.evaluate(() => window.stenoai.whisperModels.list())).language_models_enabled,
    )
    .toBe(false);
});

test('Parakeet hides the Hebrew model row', async ({ launchApp }) => {
  const { page } = await launchApp({ mockIpc: true });
  await page.evaluate(() => {
    window.location.hash = '#/settings?tab=transcription';
  });

  await expect(page.getByTestId('transcription-model-select')).toBeVisible();
  await expect(page.getByText('Hebrew model', { exact: true })).toHaveCount(0);
});

test('the Hebrew model row follows the language until it is installed', async ({ launchApp }) => {
  const { page } = await launchApp({
    mockIpc: true,
    env: { STENOAI_E2E_MOCK_ENGINE: 'whisper' },
  });
  await page.evaluate(() => {
    window.location.hash = '#/settings?tab=transcription';
  });
  const row = page.locator('[data-settings-tab="transcription"]').getByText('Hebrew model', { exact: true });
  const pick = async (name: string) => {
    await page.getByTestId('transcription-language-select').click();
    await page.getByRole('option', { name, exact: true }).click();
  };

  // Auto (the default) can detect Hebrew, so the download is offered.
  await expect(row).toBeVisible();
  // Pinned to another language, the Hebrew model can never run: hidden.
  await pick('English');
  await expect(row).toHaveCount(0);
  await pick('Hebrew');
  await expect(row).toBeVisible();

  // Once installed, the switch stays reachable whatever the language.
  await page.getByRole('button', { name: 'Download', exact: true }).click();
  await expect(page.getByRole('switch', { name: 'Hebrew model' })).toBeVisible();
  await pick('English');
  await expect(page.getByRole('switch', { name: 'Hebrew model' })).toBeVisible();
});
