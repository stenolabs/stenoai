import { defineConfig } from '@playwright/test';

/**
 * Tiered e2e config (PR1 of the e2e plan).
 *
 *  - T1 (`*.t1.spec.ts`): renderer-only, mock IPC, no Python bundle. Runs on
 *    Ubuntu in CI under xvfb.
 *  - T2 (`*.t2.spec.ts`): real bundled backend + mock adapter / Ollama. Needs
 *    `dist/stenoai/` built; runs on macOS + Windows.
 *  - T3 (`*.t3.spec.ts`): heavy, nightly-only (the long-meeting chunking smoke).
 *    Real backend like T2 but minutes-long, so it's split into its own project
 *    and run by the scheduled e2e-nightly workflow, never per-PR.
 *
 * Tiers are selected by spec filename so CI can fan them into separate jobs.
 * `workers: 1` because every test launches a real Electron app and T2/T3 bind the
 * fixed Ollama port 11434 — serialising avoids port and resource collisions.
 */
export default defineConfig({
  testDir: './specs',
  // CI-only: kill a stray Ollama + wait for a clean 11434 before the run (no-op
  // locally so a dev's own Ollama is left alone).
  globalSetup: './fixtures/global-setup.ts',
  fullyParallel: false,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  workers: 1,
  reporter: process.env.CI ? [['list'], ['html', { open: 'never' }]] : 'list',
  use: {
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    video: 'retain-on-failure',
  },
  projects: [
    // T1 is renderer-only with mock IPC — instant, so it keeps Playwright's 5s
    // default expect timeout (a slow T1 assertion is a real UI regression to
    // catch fast, not to hide behind a wider budget).
    // The per-test budget is wider on CI only: the shared xvfb runner is
    // roughly ten times slower than a dev Mac, and the longest multi-step
    // specs (Connect, Cookbooks, Recipes) cross 30s there while passing in a
    // few seconds locally. The 5s expect timeout above is unchanged, so a
    // slow assertion still fails fast; this only lets a long spec finish.
    { name: 't1', testMatch: /.*\.t1\.spec\.ts$/, timeout: process.env.CI ? 90_000 : 30_000 },
    // T2/T3 assertions poll IPC calls that each spawn a fresh `stenoai`
    // subprocess; under CI-runner load a single call can spike past 5s and
    // flake an otherwise-correct poll (the same reason ai-provider.t2's
    // blob-file poll already carries an explicit 10s). Give these projects a
    // wider default poll budget — applied local + CI alike so a borderline
    // spec can't pass locally yet flake on CI; a passing poll resolves as soon
    // as its predicate is true, so this never slows a green run. A genuinely
    // stuck poll still fails at 15s, well under the 30s per-test timeout, and
    // `retries: 2` stays the backstop.
    { name: 't2', testMatch: /.*\.t2\.spec\.ts$/, expect: { timeout: 15_000 } },
    { name: 't3', testMatch: /.*\.t3\.spec\.ts$/, expect: { timeout: 15_000 } },
  ],
});
