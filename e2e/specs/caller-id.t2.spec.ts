import path from 'path';
import type { Page } from '@playwright/test';
import { test, expect } from '../fixtures/electron';
import { realUserDataDir, fileSig } from '../fixtures/real-user-data';
import { readUserConfig, writeUserConfig } from '../fixtures/user-config';

/**
 * T2 — caller recognition (macOS): the "Identify call participants" setting persists
 * to config.json, and with it on, Steno connects to iMCP and reports what is
 * missing there. iMCP is replaced by e2e/fixtures/mock-imcp-server.js through
 * STENOAI_IMCP_SERVER, so nothing reads a real call history or Contacts.
 * Deterministic and model-free.
 *
 * The lookup itself (call audio -> call -> note) is not driven here: the mic
 * monitor that notices a call does not run under E2E. It is covered by
 * app/caller-id.test.js, app/call-matching.test.js and tests/test_call_info.py.
 */

type CallerIdSettings = {
  success: boolean;
  supported?: boolean;
  caller_id_enabled?: boolean;
  status?: { state: string; contacts: boolean };
  error?: string;
};

type StenoWindow = Window & {
  stenoai: {
    settings: {
      getCallerId: () => Promise<CallerIdSettings>;
      setCallerId: (v: boolean) => Promise<CallerIdSettings>;
    };
  };
};

const MOCK_IMCP = path.resolve(__dirname, '..', 'fixtures', 'mock-imcp-server.js');

const getCallerId = (page: Page) =>
  page.evaluate(() => (window as StenoWindow).stenoai.settings.getCallerId());
const setCallerId = (page: Page, v: boolean) =>
  page.evaluate((on) => (window as StenoWindow).stenoai.settings.setCallerId(on), v);
const statusOf = async (page: Page) => (await getCallerId(page)).status;

test.skip(process.platform !== 'darwin', 'caller recognition is macOS-only');

test('off by default; on persists and connects to iMCP; off disconnects; real dir untouched', async ({
  launchApp,
  userDataDir,
}) => {
  const realDirBefore = fileSig(realUserDataDir());
  const { page } = await launchApp({ env: { STENOAI_IMCP_SERVER: MOCK_IMCP } });

  const initial = await getCallerId(page);
  expect(initial).toMatchObject({ success: true, supported: true, caller_id_enabled: false });
  expect(initial.status?.state).toBe('off');

  const on = await setCallerId(page, true);
  expect(on).toMatchObject({ success: true, caller_id_enabled: true });
  await expect.poll(() => readUserConfig(userDataDir).caller_id_enabled).toBe(true);
  await expect.poll(() => statusOf(page)).toEqual({ state: 'ready', contacts: true });

  const off = await setCallerId(page, false);
  expect(off).toMatchObject({ success: true, caller_id_enabled: false });
  await expect.poll(() => readUserConfig(userDataDir).caller_id_enabled).toBe(false);
  expect((await statusOf(page))?.state).toBe('off');

  expect(fileSig(realUserDataDir())).toBe(realDirBefore);
});

test('switched on in config, it connects at launch', async ({ launchApp, userDataDir }) => {
  writeUserConfig(userDataDir, { caller_id_enabled: true });
  const { page } = await launchApp({ env: { STENOAI_IMCP_SERVER: MOCK_IMCP } });
  await expect.poll(() => statusOf(page)).toEqual({ state: 'ready', contacts: true });
});

test('the status says what is missing in iMCP', async ({ launchApp, userDataDir }) => {
  writeUserConfig(userDataDir, { caller_id_enabled: true });
  // Phone switched off in iMCP: it offers Contacts only.
  const { page } = await launchApp({
    env: { STENOAI_IMCP_SERVER: MOCK_IMCP, MOCK_IMCP_TOOLS: 'contacts_search' },
  });
  await expect.poll(async () => (await statusOf(page))?.state).toBe('phone-off');
});

test('Contacts off in iMCP: ready, but numbers without names', async ({ launchApp, userDataDir }) => {
  writeUserConfig(userDataDir, { caller_id_enabled: true });
  const { page } = await launchApp({
    env: { STENOAI_IMCP_SERVER: MOCK_IMCP, MOCK_IMCP_TOOLS: 'phone_calls_fetch' },
  });
  await expect.poll(() => statusOf(page)).toEqual({ state: 'ready', contacts: false });
});

test('iMCP not installed', async ({ launchApp, userDataDir }) => {
  writeUserConfig(userDataDir, { caller_id_enabled: true });
  const { page } = await launchApp({
    env: { STENOAI_IMCP_SERVER: path.join(userDataDir, 'no-such-imcp-server') },
  });
  await expect.poll(async () => (await statusOf(page))?.state).toBe('not-installed');
});

test('iMCP refusing Steno twice reads as declined', async ({ launchApp, userDataDir }) => {
  writeUserConfig(userDataDir, { caller_id_enabled: true });
  const { page } = await launchApp({
    env: { STENOAI_IMCP_SERVER: MOCK_IMCP, MOCK_IMCP_REFUSE: '1' },
  });
  // The second attempt follows the first after the client's 5 s retry delay.
  await expect.poll(async () => (await statusOf(page))?.state, { timeout: 20_000 }).toBe('declined');
});
