import { test, type ElectronApplication } from '@playwright/test';

/**
 * Skip, loudly, when the runner has no OS secure storage (a headless Linux
 * runner has no keyring). Steno refuses to store connection tokens without
 * it, so the token-bearing MCP specs cannot run there. Mirrors the org-lock
 * keystone skip: warn + annotate so the skip shows in the CI summary.
 */
export async function skipWithoutSecureStorage(app: ElectronApplication) {
  const available = await app.evaluate(({ safeStorage }) => safeStorage.isEncryptionAvailable());
  if (!available) {
    // eslint-disable-next-line no-console
    console.warn('[t2] SKIPPED: safeStorage unavailable on this runner, so MCP tokens cannot be stored.');
    test.info().annotations.push({ type: 'skip-reason', description: 'safeStorage unavailable on this runner' });
  }
  test.skip(!available, 'safeStorage unavailable on this runner');
}
