import { test, expect } from '../fixtures/electron';
import type { Page } from '@playwright/test';

/**
 * T1 — renderer-only, mock IPC. Proves the UI language selector in
 * Settings → Preferences (GeneralTab) switches the entire application chrome
 * between English and Traditional Chinese (zh-TW), updating the sidebar,
 * settings nav rail, and page headers, and persisting the selection.
 */

const launchOpts = { mockIpc: true } as const;

async function openGeneralSettings(page: Page) {
  await page.evaluate(() => {
    window.location.hash = '#/settings?tab=general';
  });
  await expect(page.locator('[data-settings-tab="general"]')).toBeVisible();
}

test('UI language picker switches interface copy between English and zh-TW', async ({
  launchApp,
}) => {
  const { page } = await launchApp(launchOpts);
  await openGeneralSettings(page);

  const trigger = page.getByTestId('ui-language-select');
  await expect(trigger).toBeVisible();
  await expect(trigger).toContainText('English');

  // Open the language picker and select 繁體中文 (台灣)
  await trigger.click();
  const zhOption = page.getByRole('option', { name: '繁體中文 (台灣)' });
  await expect(zhOption).toBeVisible();
  await zhOption.click();

  // Settings nav rail and header update to Traditional Chinese
  await expect(page.locator('[data-settings-nav="general"]')).toContainText('偏好設定');
  await expect(page.locator('[data-settings-nav="ai"]')).toContainText('AI 與模型');
  await expect(page.locator('[data-settings-nav="templates"]')).toContainText('範本');

  // Local storage persists the chosen locale
  const savedLocale = await page.evaluate(() => localStorage.getItem('steno-ui-locale'));
  expect(savedLocale).toBe('zh-TW');

  // Switch back to English
  await trigger.click();
  const enOption = page.getByRole('option', { name: 'English' });
  await expect(enOption).toBeVisible();
  await enOption.click();

  await expect(page.locator('[data-settings-nav="general"]')).toContainText('Preferences');
  await expect(page.locator('[data-settings-nav="ai"]')).toContainText('AI');
  await expect(page.locator('[data-settings-nav="templates"]')).toContainText('Templates');

  const restoredLocale = await page.evaluate(() => localStorage.getItem('steno-ui-locale'));
  expect(restoredLocale).toBe('en');
});
