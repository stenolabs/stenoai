import { test, expect } from '../fixtures/electron';
import type { ElectronApplication } from '@playwright/test';

/**
 * T1 — renderer-only, mock IPC. Pre-recording template choice and live-dock display:
 * 1. Pre-recording dock offers template selection sourced from templates.list(),
 *    defaulting to the global default and showing it by name without interaction.
 * 2. Starting recording passes the chosen templateId as the 4th argument of
 *    stenoai.recording.start; starting without choosing passes no 4th argument (byte-identical 3-arg call).
 * 3. While recording, the live dock quietly shows the template name.
 * 4. The choice applies to one recording and resets to global default for subsequent recordings.
 * 5. Continue/append recordings never force a template override onto the note, even if a template was picked.
 * 6. Existing transcription-pill controls and layout (pill-dock.t1.spec.ts) are unaffected.
 */

const PILL_ENV = { STENOAI_E2E_MOCK_PARAKEET_INSTALLED: '1' };

interface RecordedStartCall {
  name?: string;
  trigger?: string;
  appendTo?: string;
  templateId?: string;
  argsLength: number;
}

function getStartCalls(app: ElectronApplication): Promise<RecordedStartCall[]> {
  return app.evaluate(() => {
    return (
      globalThis as unknown as {
        __stenoai_e2e_recording_start_calls: RecordedStartCall[];
      }
    ).__stenoai_e2e_recording_start_calls ?? [];
  });
}

test('default template name is shown on pre-recording dock without interaction', async ({
  launchApp,
}) => {
  const { page } = await launchApp({ mockIpc: true, env: PILL_ENV });

  const picker = page.getByTestId('record-template-picker');
  await expect(picker).toBeVisible();
  await expect(picker).toContainText('Standard Summary');
});

test('starting recording without choosing sends no templateId, shows default in live dock, preserves pill controls', async ({
  launchApp,
}) => {
  const { app, page } = await launchApp({ mockIpc: true, env: PILL_ENV });

  await page.locator('.record-btn').click();
  const pill = page.getByTestId('transcription-pill');
  await expect(pill).toBeVisible();

  const calls = await getStartCalls(app);
  expect(calls).toHaveLength(1);
  expect(calls[0].templateId).toBeUndefined();
  expect(calls[0].argsLength).toBe(3);

  await expect(page.getByTestId('live-dock-template-label')).toHaveText('Standard Summary');

  // Existing pill controls from pill-dock.t1.spec.ts remain unaffected
  await expect(pill.getByRole('button', { name: 'Show transcript' })).toBeVisible();
  await expect(pill.getByRole('button', { name: 'Stop recording' })).toBeVisible();
  await expect(pill.getByRole('button', { name: 'Pause recording' })).toHaveCount(0);
});

test('choosing a template before recording passes chosen id as 4th argument and displays in live dock', async ({
  launchApp,
}) => {
  const { app, page } = await launchApp({ mockIpc: true, env: PILL_ENV });

  const picker = page.getByTestId('record-template-picker');
  await expect(picker).toBeVisible();
  await picker.click();

  const menu = page.getByTestId('record-template-menu');
  await expect(menu).toBeVisible();

  const option = page.getByTestId('record-template-option-action-items');
  await expect(option).toBeVisible();
  await option.click();

  // Trigger button updates with chosen template name
  await expect(picker).toContainText('Action Items');

  // Start recording
  await page.locator('.record-btn').click();
  await expect(page.getByTestId('transcription-pill')).toBeVisible();

  const calls = await getStartCalls(app);
  expect(calls).toHaveLength(1);
  expect(calls[0].templateId).toBe('action-items');
  expect(calls[0].argsLength).toBe(4);

  // Live dock reflects the chosen template
  await expect(page.getByTestId('live-dock-template-label')).toHaveText('Action Items');
});

test('chosen template resets for subsequent recording, defaulting back to global default', async ({
  launchApp,
}) => {
  const { app, page } = await launchApp({ mockIpc: true, env: PILL_ENV });

  // 1. Choose "Action Items" and start first recording
  await page.getByTestId('record-template-picker').click();
  await page.getByTestId('record-template-option-action-items').click();
  await page.locator('.record-btn').click();

  const pill = page.getByTestId('transcription-pill');
  await expect(pill).toBeVisible();

  let calls = await getStartCalls(app);
  expect(calls).toHaveLength(1);
  expect(calls[0].templateId).toBe('action-items');
  expect(calls[0].argsLength).toBe(4);

  // Stop first recording
  await pill.getByRole('button', { name: 'Stop recording' }).click();

  // Navigate back to home
  await page.evaluate(() => {
    window.location.hash = '#/';
  });

  // Picker has reset to the global default
  const picker = page.getByTestId('record-template-picker');
  await expect(picker).toBeVisible();
  await expect(picker).toContainText('Standard Summary');

  // 2. Start second recording without picking
  await page.locator('.record-btn').click();
  await expect(page.getByTestId('transcription-pill')).toBeVisible();

  calls = await getStartCalls(app);
  expect(calls).toHaveLength(2);
  expect(calls[1].templateId).toBeUndefined();
  expect(calls[1].argsLength).toBe(3);
  await expect(page.getByTestId('live-dock-template-label')).toHaveText('Standard Summary');
});

test('continue/append recording keeps note template and does not force a template override', async ({
  launchApp,
}) => {
  const { app, page } = await launchApp({ mockIpc: true, env: PILL_ENV });

  // Even if a template was picked in the pre-recording dock...
  const picker = page.getByTestId('record-template-picker');
  await expect(picker).toBeVisible();
  await picker.click();
  await page.getByTestId('record-template-option-action-items').click();
  await expect(picker).toContainText('Action Items');

  // ...an append/continue start never sends a templateId (3 arguments only)
  await page.evaluate(() => {
    void window.stenoai.recording.start('Continued note', 'manual', 'existing_summary.md');
  });

  const calls = await getStartCalls(app);
  expect(calls).toHaveLength(1);
  expect(calls[0].appendTo).toBe('existing_summary.md');
  expect(calls[0].templateId).toBeUndefined();
  expect(calls[0].argsLength).toBe(3);
});
