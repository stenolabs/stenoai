import { test, expect } from '../fixtures/electron';
import { realUserDataDir, fileSig } from '../fixtures/real-user-data';
import { readUserConfig } from '../fixtures/user-config';
import { existsSync } from 'fs';
import path from 'path';

/**
 * T2 — settings get/set round-trip. Drives the real backend's settings IPC and
 * asserts each value persists to the right config.json key in the temp user-data
 * dir. Model-free + deterministic (pure config writes via the Python CLI). The
 * side-effecting settings (storage-path, which creates dirs) get their own test;
 * the network/model ones (model pulls, test-cloud-api) are out of scope here.
 */

type SettingKind =
  | 'language'
  | 'userName'
  | 'keepRecordings'
  | 'autoSummarize'
  | 'autoInstallWhenIdle'
  | 'identityMatching'
  | 'silenceEnabled'
  | 'silenceMinutes'
  | 'systemAudio'
  | 'telemetry'
  | 'transcriptionEngine'
  | 'dockIcon'
  | 'launchOnLogin'
  | 'menuBarIcon'
  | 'premeetingNotifications';

type SettingsBridge = {
  settings: {
    setLanguage: (v: string) => Promise<unknown>;
    setUserName: (v: string) => Promise<unknown>;
    setKeepRecordings: (v: boolean) => Promise<unknown>;
    setAutoSummarize: (v: boolean) => Promise<unknown>;
    setAutoInstallWhenIdle: (v: boolean) => Promise<unknown>;
    getIdentityMatchingEnabled: () => Promise<{
      success?: boolean;
      identity_matching_enabled?: boolean;
    }>;
    setIdentityMatchingEnabled: (v: boolean) => Promise<unknown>;
    setSilenceAutoStopEnabled: (v: boolean) => Promise<unknown>;
    setSilenceAutoStopMinutes: (v: number) => Promise<unknown>;
    setSystemAudio: (v: boolean) => Promise<unknown>;
    setTelemetry: (v: boolean) => Promise<unknown>;
    setDockIcon: (v: boolean) => Promise<unknown>;
    setLaunchOnLogin: (v: boolean) => Promise<unknown>;
    setMenuBarIcon: (v: boolean) => Promise<unknown>;
    setPremeetingNotifications: (v: boolean) => Promise<unknown>;
    setStoragePath: (p: string) => Promise<{ success?: boolean; error?: string }>;
    setMicrophone: (
      deviceId: string,
      label: string,
    ) => Promise<{ success?: boolean; device_id?: string | null; label?: string | null }>;
  };
  transcriptionEngine: { set: (v: string) => Promise<unknown> };
};
type StenoWindow = Window & { stenoai: SettingsBridge };

type Case = { kind: SettingKind; value: string | boolean | number; configKey: string };

// Each case: drive the setter, then assert the persisted config.json key. The
// expected value IS what we set, so this catches a setter writing the wrong key,
// dropping the value, or coercing it.
const CASES: Case[] = [
  { kind: 'language', value: 'fr', configKey: 'language' },
  { kind: 'userName', value: 'E2E Tester', configKey: 'user_name' },
  { kind: 'keepRecordings', value: true, configKey: 'keep_recordings' },
  // false flips the default (true) so the assertion has teeth — a no-op setter
  // would leave the key unset/true and fail this case.
  { kind: 'autoSummarize', value: false, configKey: 'auto_summarize_enabled' },
  // false flips the default (true) so the assertion has teeth — a no-op setter
  // would leave the key unset/true and fail this case.
  { kind: 'autoInstallWhenIdle', value: false, configKey: 'auto_install_when_idle' },
  // Speaker identification stores biometric voice profiles, so its fresh
  // default is asserted separately below before this explicit opt-in.
  { kind: 'identityMatching', value: true, configKey: 'identity_matching_enabled' },
  { kind: 'silenceEnabled', value: false, configKey: 'silence_auto_stop_enabled' },
  { kind: 'silenceMinutes', value: 15, configKey: 'silence_auto_stop_minutes' },
  // false flips the macOS default (true) so this has teeth on the primary signed
  // platform — asserting `true` there would pass even if the setter no-oped.
  { kind: 'systemAudio', value: false, configKey: 'system_audio_enabled' },
  { kind: 'telemetry', value: false, configKey: 'telemetry_enabled' },
  { kind: 'transcriptionEngine', value: 'whisper', configKey: 'transcription_engine' },
  { kind: 'dockIcon', value: true, configKey: 'hide_dock_icon' },
  // false flips the default (true) so the assertion has teeth — a no-op setter
  // would leave the key unset/true and fail this case.
  { kind: 'launchOnLogin', value: false, configKey: 'launch_on_login' },
  // Both default true — false flips the default so a no-op setter fails
  // the case. Persistence only: the live Tray create/destroy this setter
  // also does is IS_E2E-gated (main.js), so there's no window here.
  { kind: 'menuBarIcon', value: false, configKey: 'show_menu_bar_icon' },
  { kind: 'premeetingNotifications', value: false, configKey: 'premeeting_notifications_enabled' },
];

function applySetting(
  page: import('@playwright/test').Page,
  kind: SettingKind,
  value: string | boolean | number,
) {
  return page.evaluate(
    ({ kind, value }) => {
      const s = (window as StenoWindow).stenoai;
      switch (kind) {
        case 'language':
          return s.settings.setLanguage(value as string);
        case 'userName':
          return s.settings.setUserName(value as string);
        case 'keepRecordings':
          return s.settings.setKeepRecordings(value as boolean);
        case 'autoSummarize':
          return s.settings.setAutoSummarize(value as boolean);
        case 'autoInstallWhenIdle':
          return s.settings.setAutoInstallWhenIdle(value as boolean);
        case 'identityMatching':
          return s.settings.setIdentityMatchingEnabled(value as boolean);
        case 'silenceEnabled':
          return s.settings.setSilenceAutoStopEnabled(value as boolean);
        case 'silenceMinutes':
          return s.settings.setSilenceAutoStopMinutes(value as number);
        case 'systemAudio':
          return s.settings.setSystemAudio(value as boolean);
        case 'telemetry':
          return s.settings.setTelemetry(value as boolean);
        case 'dockIcon':
          return s.settings.setDockIcon(value as boolean);
        case 'launchOnLogin':
          return s.settings.setLaunchOnLogin(value as boolean);
        case 'menuBarIcon':
          return s.settings.setMenuBarIcon(value as boolean);
        case 'premeetingNotifications':
          return s.settings.setPremeetingNotifications(value as boolean);
        case 'transcriptionEngine':
          return s.transcriptionEngine.set(value as string);
        default:
          throw new Error(`unknown setting kind: ${kind}`);
      }
    },
    { kind, value },
  );
}

test('settings setters persist each value to the right config.json key; real dir untouched', async ({
  launchApp,
  userDataDir,
}) => {
  const realDirBefore = fileSig(realUserDataDir());
  const { page } = await launchApp();

  const identityMatchingDefault = await page.evaluate(() =>
    (window as StenoWindow).stenoai.settings.getIdentityMatchingEnabled(),
  );
  expect(identityMatchingDefault).toMatchObject({
    success: true,
    identity_matching_enabled: false,
  });

  for (const { kind, value, configKey } of CASES) {
    await applySetting(page, kind, value);
    await expect
      .poll(() => readUserConfig(userDataDir)[configKey], {
        message: `${kind} -> config.${configKey}`,
      })
      .toBe(value);
  }

  // Keystone: the real user-data dir is byte-for-byte untouched.
  expect(fileSig(realUserDataDir())).toBe(realDirBefore);
});

// set-microphone takes two args (device_id, label) and writes two config
// keys, so it doesn't fit the single-value CASES shape above — same reason
// set-storage-path gets its own test below.
test('set-microphone persists device id + label, and clears back to system default', async ({
  launchApp,
  userDataDir,
}) => {
  const realDirBefore = fileSig(realUserDataDir());
  const { page } = await launchApp();

  const setRes = await page.evaluate(
    () => (window as StenoWindow).stenoai.settings.setMicrophone('abc123', 'USB Microphone'),
  );
  expect(setRes.success).toBe(true);
  await expect
    .poll(() => readUserConfig(userDataDir).microphone_device_id)
    .toBe('abc123');
  expect(readUserConfig(userDataDir).microphone_device_label).toBe('USB Microphone');

  const clearRes = await page.evaluate(
    () => (window as StenoWindow).stenoai.settings.setMicrophone('default', ''),
  );
  expect(clearRes.success).toBe(true);
  await expect
    .poll(() => readUserConfig(userDataDir).microphone_device_id)
    .toBe(null);
  expect(readUserConfig(userDataDir).microphone_device_label).toBe(null);

  expect(fileSig(realUserDataDir())).toBe(realDirBefore);
});

test('set-storage-path persists the path and provisions its data subdirs', async ({
  launchApp,
  userDataDir,
}) => {
  const realDirBefore = fileSig(realUserDataDir());
  const { page } = await launchApp();

  // A fresh absolute path inside the temp dir (set-storage-path requires an
  // absolute, writable location and provisions recordings/transcripts/output).
  const target = path.join(userDataDir, 'custom-storage');
  const res = await page.evaluate(
    (p) => (window as StenoWindow).stenoai.settings.setStoragePath(p),
    target,
  );
  expect(res.success).toBe(true);

  await expect.poll(() => readUserConfig(userDataDir).storage_path).toBe(target);
  for (const sub of ['recordings', 'transcripts', 'output']) {
    expect(existsSync(path.join(target, sub))).toBe(true);
  }

  // Keystone: the real user-data dir is byte-for-byte untouched.
  expect(fileSig(realUserDataDir())).toBe(realDirBefore);
});

// Drives the REAL Advanced-tab "Reset" button through the rendered UI — not the
// settings bridge — because the #304 bug lived purely in the button's onClick
// (it passed the default *path* to setStoragePath, which the backend records as
// a fresh custom override, so Reset hid itself without resetting anything). The
// bridge itself was always correct, so a `setStoragePath('')` call can't catch
// this regression; only a real click can.
test('Advanced-tab Reset button clears the custom storage path (#304); real dir untouched', async ({
  launchApp,
  userDataDir,
}) => {
  const realDirBefore = fileSig(realUserDataDir());
  const { page } = await launchApp();

  // Setup (not under test): seed a custom path via the bridge so the Reset
  // button is rendered (it only shows when custom_path differs from default).
  const custom = path.join(userDataDir, 'custom-storage-reset');
  const res = await page.evaluate(
    (p) => (window as StenoWindow).stenoai.settings.setStoragePath(p),
    custom,
  );
  expect(res.success).toBe(true);
  await expect.poll(() => readUserConfig(userDataDir).storage_path).toBe(custom);

  // Navigate the UI to Settings > Advanced (hash-router deep link — same pattern
  // as org-lock-lifecycle.t2). A fresh mount refetches the storage path so the
  // Reset button reflects the seeded custom value.
  await page.evaluate(() => {
    window.location.hash = '#/settings?tab=advanced';
  });

  const resetButton = page.getByRole('button', { name: /^reset$/i });
  await expect(resetButton).toBeVisible();

  // The click under test: fixed handler sends '' (reset), not the default path.
  await resetButton.click();

  // Backend truth: the custom override is cleared to the empty sentinel — NOT
  // rewritten as the default path string (the exact shape of the #304 bug).
  await expect.poll(() => readUserConfig(userDataDir).storage_path).toBe('');

  // UI truth: with no custom override left, the Reset button hides itself.
  await expect(resetButton).toBeHidden();

  // Keystone: the real user-data dir is byte-for-byte untouched.
  expect(fileSig(realUserDataDir())).toBe(realDirBefore);
});
