import { test, expect } from '../fixtures/electron';

test('folder creation blocks repeated clicks and Enter, recovers after failure and permits later creation', async ({ launchApp }) => {
  const { app, page } = await launchApp({ mockIpc: true, env: { STENOAI_E2E_FOLDER_CREATE_PENDING: '1' } });
  await page.evaluate(() => { window.location.hash = '#/'; });
  await page.getByRole('button', { name: 'New folder', exact: true }).click();
  const dialog = page.getByRole('dialog');
  const input = dialog.getByPlaceholder('e.g. Acme Corp');
  await input.fill('Synthetic folder');
  // Same renderer turn: includes the interval before React paints disabled.
  await input.evaluate((element) => {
    element.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    element.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    const button = [...element.closest('[role="dialog"]')!.querySelectorAll('button')]
      .find(button => button.textContent === 'Create folder')!;
    button.click();
  });
  await expect(dialog.getByRole('button', { name: 'Creating folder…' })).toBeDisabled();
  await expect(input).toBeDisabled();
  await expect(dialog.getByRole('button', { name: 'Close', exact: true })).toBeDisabled();
  await page.keyboard.press('Escape');
  await expect(dialog).toBeVisible();
  expect(await app.evaluate(() => (globalThis as any).__folderCreateTest.calls)).toBe(1);
  await app.evaluate(() => (globalThis as any).__folderCreateTest.finish({ success: false, error: 'Synthetic failure' }));
  await expect(dialog.getByRole('alert')).toContainText('Could not create folder');
  await expect(input).toHaveValue('Synthetic folder');
  await expect(dialog.getByRole('button', { name: 'Close', exact: true })).toBeEnabled();
  await dialog.getByRole('button', { name: 'Create folder', exact: true }).click();
  await expect.poll(() => app.evaluate(() => (globalThis as any).__folderCreateTest.calls)).toBe(2);
  await app.evaluate(() => (globalThis as any).__folderCreateTest.finish({ success: true, folder: { id: 'one', name: 'Synthetic folder' } }));
  await expect(dialog).not.toBeVisible();
  await page.getByRole('button', { name: 'New folder', exact: true }).click();
  await input.fill('Another synthetic folder');
  await dialog.getByRole('button', { name: 'Create folder', exact: true }).click();
  await expect.poll(() => app.evaluate(() => (globalThis as any).__folderCreateTest.calls)).toBe(3);
  await app.evaluate(() => (globalThis as any).__folderCreateTest.finish({ success: true, folder: { id: 'two' } }));
  await expect(dialog).not.toBeVisible();
});
