import { test, expect } from '../fixtures/electron';

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
    const before = await page.evaluate((file) => window.stenoai.meetings.get(file), summaryFile);
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
    await expect(page.getByRole('button', { name: 'Copy transcript' })).toBeVisible();
    await expect(alert.getByRole('button', { name: 'Generate notes', exact: true })).toBeEnabled();
    await expect(page.getByText('Unfinished synthetic summary', { exact: true })).toHaveCount(0);
    await expect(page.locator('body')).not.toContainText('internal.invalid');
    await expect(page.locator('body')).not.toContainText('unexpected-server-code');
    expect(await page.evaluate((file) => window.stenoai.meetings.get(file), summaryFile)).toEqual(before);

    await alert.getByRole('button', { name: 'Generate notes', exact: true }).click();
    await expect.poll(() => app.evaluate(() => (globalThis as any).__reprocessTest.calls)).toBe(2);
    await app.evaluate(({ BrowserWindow }, file) => {
      BrowserWindow.getAllWindows()[0].webContents.send('processing-complete', { success: true, summaryFile: file, sessionName: 'New note', notesGenerated: false });
      (globalThis as any).__reprocessTest.finish({ success: true });
    }, summaryFile);
    await expect(alert).toHaveCount(0);
    await expect(page.getByTestId('generate-notes-dock-button')).toBeEnabled();
    await expect(page.getByRole('button', { name: 'Copy transcript' })).toBeVisible();
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
