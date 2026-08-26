import { test, expect } from '../fixtures/electron';

test('keeps the Electron window hidden while the renderer remains testable', async ({
  launchApp,
}) => {
  const { app, page } = await launchApp({ mockIpc: true });

  await expect(page.locator('[data-app-ready]')).toBeVisible();
  const visible = await app.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows().some((window) => window.isVisible()),
  );
  expect(visible).toBe(false);
});
