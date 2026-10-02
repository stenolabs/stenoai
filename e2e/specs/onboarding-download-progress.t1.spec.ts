import { test, expect } from '../fixtures/electron';

/**
 * T1 - renderer-only, mock IPC, no backend. Regression guard for #354: the
 * onboarding wizard used to send model-download progress only to the collapsed
 * debug console, so a fresh install showed a static "Downloading… (~2 GB)"
 * string with no visible bar. Setup.tsx now subscribes to the setup-specific
 * progress channels and renders progress on the step cards:
 *   - transcription (Parakeet): an INDETERMINATE bar (stages only, no byte %).
 *   - summarization (Ollama): a REAL bar + percent from setup-ollama-progress.
 *
 * The mock (app/e2e-mock-ipc.js, gated on STENOAI_E2E_SETUP_PROGRESS) emits the
 * same renderer events the real main.js handlers do, then holds the step in its
 * running state so the bar can be observed.
 */

test('summarization step renders a real progress bar + percent from setup-ollama-progress', async ({
  launchApp,
}) => {
  // Parakeet pre-installed so the transcription step is skipped and the wizard
  // goes straight to the Ollama download we want to observe.
  const { page } = await launchApp({
    mockIpc: true,
    env: {
      STENOAI_E2E_SETUP_PROGRESS: '1',
      STENOAI_E2E_MOCK_PARAKEET_INSTALLED: '1',
    },
  });

  await page.evaluate(() => {
    window.location.hash = '#/setup';
  });

  await page.getByRole('button', { name: 'Begin setup' }).click();

  const ollamaStep = page.locator('[data-setup-step="ollama"]');
  await expect(ollamaStep).toHaveAttribute('data-setup-status', 'running');

  // A real bar with the streamed percent + the current status label.
  const bar = ollamaStep.locator('[data-setup-ollama-progress]');
  await expect(bar).toBeVisible();
  await expect(bar.getByText('42%')).toBeVisible();
  await expect(bar.getByText('pulling sha256:abcd')).toBeVisible();

  const progressbar = ollamaStep.getByRole('progressbar');
  await expect(progressbar).toHaveAttribute('aria-valuenow', '42');
});

test('transcription step renders an indeterminate "preparing" bar (no fabricated percent)', async ({
  launchApp,
}) => {
  // Parakeet NOT installed → the transcription download runs. It only reports
  // coarse stages, so the UI shows an indeterminate bar, never a percentage.
  const { app, page } = await launchApp({
    mockIpc: true,
    env: { STENOAI_E2E_SETUP_PROGRESS: '1' },
  });

  await page.evaluate(() => {
    window.location.hash = '#/setup';
  });

  await page.getByRole('button', { name: 'Begin setup' }).click();

  const transcriptionStep = page.locator('[data-setup-step="transcription"]');
  await expect(transcriptionStep).toHaveAttribute('data-setup-status', 'running');

  const bar = transcriptionStep.locator('[data-setup-transcription-progress]');
  await expect(bar).toBeVisible();
  await expect(bar.getByText('Downloading model…')).toBeVisible();
  await expect(transcriptionStep.getByRole('progressbar')).toBeVisible();

  for (const [event, label] of [
    [{ stage: 'preparing' }, 'Preparing download…'],
    [{ stage: 'downloading', completed_files: 1, total_files: 2, file_bytes: 120000000 },
      'Downloading model… 1 of 2 files ready. Current file: 120.0 MB available.'],
    [{ stage: 'loading' }, 'Download complete. Preparing model…'],
    [{ stage: 'complete' }, 'Model ready'],
  ] as const) {
    await app.evaluate(({ BrowserWindow }, progress) => {
      BrowserWindow.getAllWindows()[0].webContents.send('parakeet-pull-progress', progress);
    }, event);
    await expect(bar.getByText(label, { exact: true })).toBeVisible();
  }
  // No fabricated percentage on the indeterminate bar.
  await expect(bar.getByText('%')).toHaveCount(0);
});

test('optional speaker model failure does not block the rest of onboarding', async ({
  launchApp,
}) => {
  const { page } = await launchApp({
    mockIpc: true,
    env: {
      STENOAI_E2E_MOCK_PARAKEET_INSTALLED: '1',
      STENOAI_E2E_SPEAKER_MODEL_FAILURE: '1',
      STENOAI_E2E_RENDERER_PLATFORM: 'darwin',
    },
  });

  await page.evaluate(() => {
    window.location.hash = '#/setup';
  });
  await page.getByRole('button', { name: 'Begin setup' }).click();

  const speakerStep = page.locator('[data-setup-step="speakers"]');
  await expect(speakerStep).toHaveAttribute('data-setup-status', 'failed');
  await expect(page.locator('[data-setup-step="ollama"]')).toHaveAttribute(
    'data-setup-status',
    'done',
  );
  await expect(page.getByRole('button', { name: 'Continue to app' })).toBeVisible();
});

test('speaker model setup is absent on non-macOS', async ({ launchApp }) => {
  const { page } = await launchApp({
    mockIpc: true,
    env: {
      STENOAI_E2E_MOCK_PARAKEET_INSTALLED: '1',
      STENOAI_E2E_RENDERER_PLATFORM: 'linux',
    },
  });

  await page.evaluate(() => {
    window.location.hash = '#/setup';
  });
  await page.getByRole('button', { name: 'Begin setup' }).click();

  await expect(page.locator('[data-setup-step="speakers"]')).toHaveCount(0);
  await expect(page.locator('[data-setup-step="ollama"]')).toHaveAttribute(
    'data-setup-status',
    'done',
  );
});

test('Settings displays Parakeet file progress next to the pending model selection', async ({ launchApp }) => {
  const { app, page } = await launchApp({ mockIpc: true, env: {
    STENOAI_E2E_SETUP_PROGRESS: '1', STENOAI_E2E_MOCK_ENGINE: 'whisper',
    STENOAI_E2E_MOCK_PARAKEET_INSTALLED: '0',
  } });
  await page.evaluate(() => { window.location.hash = '#/settings?tab=ai'; });
  await page.getByTestId('transcription-model-select').click();
  await page.getByRole('option', { name: /Parakeet TDT v3/ }).click();
  await expect(page.getByTestId('transcription-model-select')).toBeDisabled();
  await expect(page.getByRole('status')).toContainText('Current file: 120.0 MB available.');
  await app.evaluate(({ BrowserWindow }) => {
    const model = process.platform === 'darwin'
      ? 'mlx-community/parakeet-tdt-0.6b-v3' : 'istupakov/parakeet-tdt-0.6b-v3-onnx';
    BrowserWindow.getAllWindows()[0].webContents.send('parakeet-pull-progress', { model, stage: 'loading' });
  });
  await expect(page.getByRole('status')).toContainText('Download complete. Preparing model…');
});

for (const [platform, size] of [['darwin', '~2.5 GB'], ['win32', '~670 MB']] as const) {
  test(`Parakeet setup shows the download estimate on ${platform}`, async ({ launchApp }) => {
    const { page } = await launchApp({ mockIpc: true, env: {
      STENOAI_E2E_SETUP_PROGRESS: '1', STENOAI_E2E_RENDERER_PLATFORM: platform,
    } });
    await page.evaluate(() => { window.location.hash = '#/setup'; });
    await page.getByRole('button', { name: 'Begin setup' }).click();
    await expect(page.locator('[data-setup-step="transcription"]')).toContainText(`Downloading Parakeet TDT v3 (${size})...`);
  });
}
