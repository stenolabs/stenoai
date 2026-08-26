import { test, expect } from '../fixtures/electron';
import { realUserDataDir, fileSig } from '../fixtures/real-user-data';
import { readUserConfig, writeUserConfig } from '../fixtures/user-config';

/**
 * T2 — one-time privacy consent modal for upgraders. Model-free + deterministic:
 * seed a config.json that EXISTS but has no `privacy_notice_seen` key (an
 * existing install predating the marker). The backend migration
 * (Config._migrate_privacy_notice_seen) then resolves the marker to false, so
 * `privacy.getNoticeSeen()` returns false and App.tsx renders the modal.
 *
 * The app auto-redirects to /setup once when no ASR model is installed (the
 * model-free T2 bundle has none). The consent modal deliberately hides on
 * /setup (onboarding discloses the same toggles), so the tests force a neutral
 * route and wait for it — the setup gate only redirects once, so '#/' sticks.
 */

const MODAL = '[data-privacy-consent]';
const ACK = '[data-privacy-ack]';
const TELEMETRY_SWITCH = '[data-privacy-telemetry]';
const LAUNCH_SWITCH = '[data-privacy-launch]';

/**
 * Simulate an upgrader: a pre-existing config.json with no privacy marker.
 *
 * The marker must be genuinely ABSENT so the backend migration is the thing
 * under test. `writeUserConfig` seeds it true by default (so specs that click
 * the UI don't race this modal); an explicit `undefined` drops the key back
 * out of the written JSON.
 */
function seedUpgraderConfig(userDataDir: string): void {
  writeUserConfig(userDataDir, { user_name: 'Upgrader', privacy_notice_seen: undefined });
}

/**
 * Drive the app to a neutral route and wait for the consent modal. Re-forces
 * '#/' each poll iteration to out-race the one-shot setup-gate redirect to
 * /setup (which would otherwise hide the modal on a model-free bundle).
 */
async function waitForConsentModal(page: import('@playwright/test').Page) {
  await expect
    .poll(
      async () => {
        await page.evaluate(() => {
          window.location.hash = '#/';
        });
        return page.locator(MODAL).isVisible();
      },
      {
        message: 'privacy consent modal should appear for an upgrader on a neutral route',
        // App launch + the config migration + the privacy gate query can race
        // the one-shot /setup redirect on a loaded CI runner; the default 5s
        // poll was occasionally too tight (flaky, green on retry). Give it more
        // wall-clock — the assertion (modal must appear) is unchanged.
        timeout: 20_000,
      },
    )
    .toBe(true);
}

test('upgrader sees the consent modal; acknowledging marks it seen and it does not return', async ({
  launchApp,
  userDataDir,
}) => {
  const realDirBefore = fileSig(realUserDataDir());
  seedUpgraderConfig(userDataDir);

  const { page } = await launchApp();
  await waitForConsentModal(page);

  // The backend migration flipped the absent marker to false on first load.
  expect(readUserConfig(userDataDir).privacy_notice_seen).toBe(false);

  // Both disclosed toggles reflect the persisted default (ON).
  await expect(page.locator(TELEMETRY_SWITCH)).toHaveAttribute('data-state', 'checked');
  await expect(page.locator(LAUNCH_SWITCH)).toHaveAttribute('data-state', 'checked');

  // Acknowledge via the primary button.
  await page.locator(ACK).click();

  // Backend truth: the marker is now true, forever.
  await expect
    .poll(() => readUserConfig(userDataDir).privacy_notice_seen, {
      message: 'acknowledging flips privacy_notice_seen to true on disk',
    })
    .toBe(true);

  // UI truth: the modal is gone and stays gone even after re-forcing the
  // neutral route (the gate query refetched true, so it can never reopen).
  await expect(page.locator(MODAL)).toBeHidden();
  await page.evaluate(() => {
    window.location.hash = '#/meetings';
  });
  await page.evaluate(() => {
    window.location.hash = '#/';
  });
  await expect(page.locator(MODAL)).toBeHidden();

  // Keystone: the real user-data dir is byte-for-byte untouched.
  expect(fileSig(realUserDataDir())).toBe(realDirBefore);
});

// Show-once across a restart is proven compositionally, without an in-test
// relaunch (the single-launch fixture doesn't support one): the test above
// proves acknowledging persists privacy_notice_seen: true on disk, and the test
// below proves a config that already carries the marker never renders the modal.
// The pair is non-vacuous by construction — the test above fails if the gate
// ever fails to SHOW on a false marker, and the test below fails if it ever
// SHOWS on a true marker — so neither a stuck-hidden nor a stuck-shown gate can
// slip through.
test('a config that already has the marker never shows the modal', async ({
  launchApp,
  userDataDir,
}) => {
  // Fresh installs are seeded privacy_notice_seen: true by the backend
  // migration; simulate that (and any already-acknowledged install) directly.
  writeUserConfig(userDataDir, { user_name: 'Seen', privacy_notice_seen: true });

  const { page } = await launchApp();
  // A model-free bundle auto-redirects to /setup once; the gate is one-shot so
  // forcing #/ then sticks on the neutral route the modal would appear on.
  await page.evaluate(() => {
    window.location.hash = '#/';
  });

  // Deterministic sync: wait until the privacy query has actually RESOLVED to
  // true (App mirrors the settled gate value onto data-privacy-gate). This is
  // what makes the "hidden" assertion below non-vacuous — it can no longer pass
  // simply because the query is still pending and the modal hasn't mounted yet.
  await expect(page.locator('html')).toHaveAttribute('data-privacy-gate', 'true');
  // Sanity: the gate read exactly the marker we seeded.
  expect(readUserConfig(userDataDir).privacy_notice_seen).toBe(true);

  // Prove the modal stays hidden ON the neutral route across several ticks —
  // re-forcing #/ each time so a late one-shot /setup redirect can't make the
  // assertion pass for the wrong reason (hidden because of the route, not the
  // marker). If the gate ever wrongly showed on a true marker, this catches it.
  for (let i = 0; i < 3; i++) {
    await page.evaluate(() => {
      window.location.hash = '#/';
    });
    await expect(page).toHaveURL(/#\/$/);
    await expect(page.locator(MODAL)).toBeHidden();
    await page.waitForTimeout(150);
  }
});

test('consent modal toggles persist telemetry_enabled and launch_on_login', async ({
  launchApp,
  userDataDir,
}) => {
  const realDirBefore = fileSig(realUserDataDir());
  seedUpgraderConfig(userDataDir);

  const { page } = await launchApp();
  await waitForConsentModal(page);

  // Both default ON; a single click flips each off — flipping the default gives
  // the assertions teeth (a no-op toggle would leave them unset/true).
  await page.locator(TELEMETRY_SWITCH).click();
  await expect
    .poll(() => readUserConfig(userDataDir).telemetry_enabled, {
      message: 'telemetry toggle -> config.telemetry_enabled',
    })
    .toBe(false);

  await page.locator(LAUNCH_SWITCH).click();
  await expect
    .poll(() => readUserConfig(userDataDir).launch_on_login, {
      message: 'launch-on-login toggle -> config.launch_on_login',
    })
    .toBe(false);

  // Keystone: the real user-data dir is byte-for-byte untouched.
  expect(fileSig(realUserDataDir())).toBe(realDirBefore);
});
