import { expect, type Page } from '@playwright/test';

/**
 * Settle App.tsx's first-run setup gate before a spec touches the home UI.
 *
 * On a bundle with no ASR model installed (every model-free T2 lane) the app
 * redirects a neutral route ('#/', '#/meetings') to '#/setup' exactly once per
 * renderer load, after two backend round-trips (parakeet-status +
 * list-whisper-models). That lands a second or more after `[data-app-ready]`,
 * so a spec that clicks the meetings list straight after launch races it: the
 * click resolves the row, the redirect unmounts it, and Playwright reports
 * "element was detached from the DOM". Which side wins depends on how fast
 * the bundled backend cold-starts on that runner — the serial lanes happened
 * to win, the sharded ones lost. The modal and list specs below pay for that.
 *
 * App.tsx mirrors the gate's decision onto `<html data-setup-gate>`
 * ("installed" | "setup" | "error", unset while pending). Wait for it, then if
 * the redirect fired, return to '#/': the gate is one-shot, so the neutral
 * route sticks for the rest of this renderer load. Call it again after any
 * `page.reload()` or relaunch — each new renderer runs the gate afresh.
 */
export async function settleSetupGate(page: Page): Promise<void> {
  const html = page.locator('html');
  await expect(html, 'setup gate should resolve (data-setup-gate)').toHaveAttribute(
    'data-setup-gate',
    /^(installed|setup|error)$/,
    // Two PyInstaller cold starts on a loaded Windows runner can take a while;
    // the attribute lands as soon as the backend answers, so this never slows
    // a fast machine down.
    { timeout: 30_000 },
  );
  if ((await html.getAttribute('data-setup-gate')) === 'setup') {
    await page.evaluate(() => {
      window.location.hash = '#/';
    });
    await expect(page).toHaveURL(/#\/$/);
  }
}
