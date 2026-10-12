import { test, expect } from '../fixtures/electron';
import { openShareMenu } from '../fixtures/share-menu';

const summaryFile = 'pending_summary.md';

for (const scenario of [
  { name: 'connection', code: 'generation_connection_failed', message: 'Could not reach the AI service.' },
  { name: 'missing model', code: 'generation_model_unavailable', message: 'The selected AI model is unavailable.' },
  { name: 'unknown diagnostics', code: 'unexpected-server-code', message: 'Notes could not be generated.' },
  { name: 'stream then generic exit', code: 'generation_connection_failed', message: 'Could not reach the AI service.', stream: true },
]) {
  test(`${scenario.name}: stable detail, safe cause and working retry`, async ({ launchApp }) => {
    const { app, page } = await launchApp({
      mockIpc: true,
      env: { STENOAI_E2E_SEED_PENDING_NOTE: '1', STENOAI_E2E_REPROCESS_PENDING: '1' },
    });

    await page.evaluate((file) => { window.location.hash = `#/meetings/${encodeURIComponent(file)}`; }, summaryFile);
    await page.getByTestId('generate-notes-dock-button').click();
    await expect.poll(() => app.evaluate(() => (globalThis as any).__reprocessTest.calls)).toBe(1);
    await app.evaluate(({ BrowserWindow }, { code, stream, file }) => {
      const contents = BrowserWindow.getAllWindows()[0].webContents;
      if (stream) {
        contents.send('summary-chunk', { summaryFile: file, sessionName: 'New note', chunk: 'Unfinished synthetic summary' });
        contents.send('summary-complete', { success: false, summaryFile: file, sessionName: 'New note', error_code: code });
        contents.send('processing-complete', { success: false, summaryFile: file, sessionName: 'New note' });
      }
      (globalThis as any).__reprocessTest.finish({ success: false, error: 'Synthetic private detail https://internal.invalid/token=secret', error_code: stream ? undefined : code });
    }, { code: scenario.code, stream: Boolean(scenario.stream), file: summaryFile });
    const alert = page.getByRole('alert');
    await expect(alert).toContainText(scenario.message);
    // The transcript stays reachable from the Share menu while notes failed.
    const failedMenu = await openShareMenu(page);
    await expect(failedMenu.getByRole('button', { name: 'Copy transcript' })).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(failedMenu).toBeHidden();
    await expect(alert.getByRole('button', { name: 'Generate notes', exact: true })).toBeEnabled();
    await expect(page.getByText('Unfinished synthetic summary', { exact: true })).toHaveCount(0);
    await expect(page.locator('body')).not.toContainText('internal.invalid');
    await expect(page.locator('body')).not.toContainText('unexpected-server-code');
    // Disk preservation is verified by note-generation-error.t2; this mock returns static data.

    await alert.getByRole('button', { name: 'Generate notes', exact: true }).click();
    await expect.poll(() => app.evaluate(() => (globalThis as any).__reprocessTest.calls)).toBe(2);
    await app.evaluate(({ BrowserWindow }, file) => {
      BrowserWindow.getAllWindows()[0].webContents.send('processing-complete', { success: true, summaryFile: file, sessionName: 'New note', notesGenerated: false });
      (globalThis as any).__reprocessTest.finish({ success: true });
    }, summaryFile);
    await expect(alert).toHaveCount(0);
    await expect(page.getByTestId('generate-notes-dock-button')).toBeEnabled();
    const menu = await openShareMenu(page);
    await expect(menu.getByRole('button', { name: 'Copy transcript' })).toBeVisible();
  });
}

test('completion failures from another note do not affect the open detail', async ({ launchApp }) => {
  const { app, page } = await launchApp({ mockIpc: true, env: { STENOAI_E2E_SEED_PENDING_NOTE: '1' } });
  await page.evaluate((file) => { window.location.hash = `#/meetings/${encodeURIComponent(file)}`; }, summaryFile);
  await expect(page.getByTestId('generate-notes-dock-button')).toBeEnabled();
  await app.evaluate(({ BrowserWindow }) => {
    const contents = BrowserWindow.getAllWindows()[0].webContents;
    for (const channel of ['summary-complete', 'processing-complete']) {
      contents.send(channel, { success: false, sessionName: 'New note', summaryFile: 'other_summary.md', error_code: 'generation_model_unavailable' });
    }
  });
  await expect(page.getByTestId('generate-notes-dock-button')).toBeEnabled();
  await expect(page.getByRole('alert')).toHaveCount(0);
});

test('failed regeneration keeps the existing summary visible and My notes usable', async ({ launchApp }) => {
  const { app, page } = await launchApp({
    mockIpc: true,
    env: { STENOAI_E2E_SEED_STALE_NOTE: '1', STENOAI_E2E_REPROCESS_PENDING: '1' },
  });
  await page.evaluate(() => { window.location.hash = '#/meetings/stale_summary.md'; });
  await expect(page.getByText('Covers only the first segment.', { exact: true })).toBeVisible();
  await page.getByTestId('generate-notes-dock-button').click();
  await expect.poll(() => app.evaluate(() => (globalThis as any).__reprocessTest.calls)).toBe(1);
  await app.evaluate(() => (globalThis as any).__reprocessTest.finish({ success: false, error: 'Synthetic failure', error_code: 'generation_model_unavailable' }));
  await expect(page.getByRole('alert')).toContainText('The selected AI model is unavailable.');
  await expect(page.getByText('Covers only the first segment.', { exact: true })).toBeVisible();
  await page.getByRole('tab', { name: 'My notes', exact: true }).click();
  await expect(page.getByRole('tab', { name: 'My notes', exact: true })).toHaveAttribute('aria-selected', 'true');
});

for (const scenario of [
  { code: 'retranscribe_unlinked_segments', message: 'This note was continued in an earlier version of StenoAI' },
  { code: 'retranscribe_no_audio', message: 'is no longer on this computer, so it cannot be transcribed again' },
]) {
  test(`a re-transcribe refusal (${scenario.code}) explains itself and offers no regenerate`, async ({ launchApp }) => {
    const { app, page } = await launchApp({
      mockIpc: true,
      env: {
        STENOAI_E2E_SEED_STALE_NOTE: '1',
        STENOAI_E2E_REPROCESS_PENDING: '1',
        STENOAI_E2E_RECORDING_AVAILABLE: '1',
      },
    });
    await page.evaluate(() => { window.location.hash = '#/meetings/stale_summary.md'; });
    await expect(page.getByText('Covers only the first segment.', { exact: true })).toBeVisible();

    await page.getByRole('button', { name: 'More options' }).click();
    await page.getByTestId('retranscribe-action').click();
    await page.getByRole('button', { name: 'Re-transcribe', exact: true }).click();
    await expect.poll(() => app.evaluate(() => (globalThis as any).__reprocessTest.calls)).toBe(1);
    // It must be a re-transcribe, not an ordinary regenerate.
    expect(await app.evaluate(() => (globalThis as any).__stenoaiE2eReprocessCalls.map((c: any) => c.retranscribe)))
      .toEqual([true]);
    await app.evaluate((_electron, code) => {
      (globalThis as any).__reprocessTest.finish({ success: false, error: 'Synthetic failure', error_code: code });
    }, scenario.code);

    const alert = page.getByRole('alert');
    await expect(alert).toContainText('Note wasn’t transcribed again');
    await expect(alert).toContainText(scenario.message);
    await expect(alert).not.toContainText('Notes weren’t generated');
    // The note was not touched, so regenerating its notes is no remedy.
    await expect(alert.getByRole('button', { name: 'Generate notes', exact: true })).toHaveCount(0);
    await expect(page.getByText('Covers only the first segment.', { exact: true })).toBeVisible();
  });
}
