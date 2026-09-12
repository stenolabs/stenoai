import { test, expect } from '../fixtures/electron';

const TRANSFER_ENV = {
  STENOAI_E2E_MEETING_TRANSFER: '1',
  STENOAI_E2E_RENDERER_PLATFORM: 'darwin',
  STENOAI_E2E_MOCK_PARAKEET_INSTALLED: '1',
};

const mockCalls = (app: import('@playwright/test').ElectronApplication) =>
  app.evaluate(
    () => (global as unknown as { __mockIpcCalls: string[] }).__mockIpcCalls,
  );

test('Import Steno package opens the imported Swift note on My notes', async ({
  launchApp,
}) => {
  const { app, page } = await launchApp({ mockIpc: true, env: TRANSFER_ENV });

  await page.getByRole('button', { name: 'Recording options' }).click();
  await page.getByRole('button', { name: 'Import Steno package…' }).click();

  await expect(page).toHaveURL(/#\/meetings\/imported-swift-note_summary\.md/);
  await expect(page.getByTestId('tab-notes')).toHaveAttribute('aria-selected', 'true');
  await expect(page.getByTestId('my-notes-input')).toHaveValue(
    'Notes written on iPhone and transferred to this Mac.',
  );

  await expect.poll(() => mockCalls(app)).toContain('import-meeting-package');
});

test('Share Steno package is disabled while the note is processing', async ({ launchApp }) => {
  const { page } = await launchApp({
    mockIpc: true,
    env: {
      ...TRANSFER_ENV,
      STENOAI_E2E_MEETING_TRANSFER: '0',
      STENOAI_E2E_SEED_PROCESSING_NOTE: '1',
    },
  });

  await page.evaluate(() => {
    window.location.hash = '#/meetings/processing_summary.md';
  });
  await expect(page.getByTestId('meeting-detail')).toBeVisible();
  await page.getByRole('button', { name: 'More options' }).click();
  await expect(page.getByRole('button', { name: 'Share Steno package…' })).toBeDisabled();
});
