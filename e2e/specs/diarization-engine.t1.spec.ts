import { test, expect } from '../fixtures/electron';

/**
 * T1 -- the engine picker in the Individual speakers row, and its
 * download-then-save interaction. The backend contract (a non-default engine
 * is refused while its models are missing) is diarization-engine.t2; the
 * row's own Download/progress/Installed flow is onboarding-download-progress.
 * This pins what the picker adds: picking Nemotron 3 prepares its models and
 * then shows it as saved, a failed download says so and leaves Standard
 * selected, and an upgraded install whose models are missing can download
 * them again. macOS-only UI.
 */

async function openAiSettings(page: import('@playwright/test').Page) {
  await page.evaluate(() => {
    window.location.hash = '#/settings?tab=ai';
  });
  await expect(page.getByTestId('diarization-engine-select')).toBeVisible();
}

async function chooseNemotron(page: import('@playwright/test').Page) {
  await page.getByTestId('diarization-engine-select').click();
  await page.getByRole('option', { name: /nemotron 3/i }).click();
}

test('picking Nemotron 3 prepares its models and saves it', async ({ launchApp }) => {
  test.skip(process.platform !== 'darwin', 'speaker detection engines are macOS-only');
  const { page } = await launchApp({ mockIpc: true });
  await openAiSettings(page);

  const trigger = page.getByTestId('diarization-engine-select');
  await expect(trigger).toContainText('Standard');
  await chooseNemotron(page);

  await expect(trigger).toContainText('Nemotron 3');
  await expect(trigger).toBeEnabled();
  const saved = await page.evaluate(() =>
    (window as unknown as {
      stenoai: { diarizationEngine: { get: () => Promise<{ engine: string }> } };
    }).stenoai.diarizationEngine.get(),
  );
  expect(saved.engine).toBe('nemotron3');
});

test('a failed Nemotron 3 download keeps Standard and says so', async ({ launchApp }) => {
  test.skip(process.platform !== 'darwin', 'speaker detection engines are macOS-only');
  const { page } = await launchApp({
    mockIpc: true,
    env: { STENOAI_E2E_SPEAKER_MODEL_FAILURE: '1' },
  });
  await openAiSettings(page);
  const status = await page.evaluate(() =>
    (window as unknown as {
      stenoai: { setup: { speakerModelsStatus: (engine: string) => Promise<unknown> } };
    }).stenoai.setup.speakerModelsStatus('nemotron3'),
  );
  expect(status).toMatchObject({ success: false, ready: false, error: 'synthetic model status failure' });
  expect(status).not.toHaveProperty('missing_models');
  await chooseNemotron(page);

  const trigger = page.getByTestId('diarization-engine-select');
  const row = page.locator('[data-settings-speaker-models]');
  await expect(row.getByRole('alert')).toContainText('previous model is still active');
  await expect(trigger).toContainText('Standard');
  await expect(trigger).toBeEnabled();
});

test('a failed speaker detection setting read offers a retry', async ({ launchApp }) => {
  test.skip(process.platform !== 'darwin', 'speaker detection engines are macOS-only');
  const { app, page } = await launchApp({
    mockIpc: true,
    env: { STENOAI_E2E_DIARIZATION_ENGINE_READ_FAILURE: '1' },
  });
  await openAiSettings(page);

  const trigger = page.getByTestId('diarization-engine-select');
  const row = page.locator('[data-settings-speaker-models]');
  await expect(trigger).toBeDisabled();
  await expect(row.getByRole('alert')).toContainText('Could not load the speaker detection setting');
  const retry = page.getByTestId('diarization-engine-retry');
  await expect(retry).toBeVisible();

  await app.evaluate(() => {
    process.env.STENOAI_E2E_DIARIZATION_ENGINE_READ_FAILURE = '0';
  });
  await retry.click();
  await expect(trigger).toBeEnabled();
  await expect(trigger).toContainText('Standard');
  await expect(row.getByRole('alert')).toHaveCount(0);
  await expect(retry).toHaveCount(0);
});

test('an upgraded install can download its missing Standard models again', async ({
  launchApp,
}) => {
  test.skip(process.platform !== 'darwin', 'speaker detection engines are macOS-only');
  // FluidAudio 0.17 moved the Sortformer cache to sortformer/v3/fp16/, so a
  // pre-upgrade install reads as missing until it downloads again. Meeting
  // processing never downloads, so the row's Download is the way back.
  const { app, page } = await launchApp({
    mockIpc: true,
    env: { STENOAI_E2E_SPEAKER_MODELS_MISSING: '1' },
  });
  await openAiSettings(page);

  const row = page.locator('[data-settings-speaker-models]');
  const trigger = page.getByTestId('diarization-engine-select');
  await expect(row.getByText('Installed')).toHaveCount(0);
  await row.getByRole('button', { name: 'Download' }).click();
  await expect(trigger).toBeDisabled();
  await app.evaluate(() =>
    (global as { __speakerModels?: { finish: () => void } }).__speakerModels!.finish(),
  );

  await expect(row.getByText('Installed')).toBeVisible();
  await expect(trigger).toBeEnabled();
  await expect(trigger).toContainText('Standard');
});
