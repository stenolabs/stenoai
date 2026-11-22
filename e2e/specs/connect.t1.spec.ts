import { test, expect } from '../fixtures/electron';

/**
 * T1 — the Connect page (Steno MCP server install surfaces), renderer-only with
 * mock IPC: the sidebar entry, the assistant cards and their install sheets,
 * the Claude Code copy button, and the scope controls writing through the
 * `connect` bridge. Mocks: app/e2e-mock-ipc.js (connect-*). The server itself
 * and the real handlers are covered by steno-mcp.t2 and the node unit tests.
 */

type ConnectState = { folderAllowlist: string[] | null; excludeTranscripts: boolean };
const settingsOf = (app: import('@playwright/test').ElectronApplication) =>
  app.evaluate(() => (globalThis as unknown as { __connectSettings: ConnectState }).__connectSettings);

test('Connect lists assistants, copies the Claude Code command and saves scope', async ({
  launchApp,
}, testInfo) => {
  const { page, app } = await launchApp({ mockIpc: true, env: { STENOAI_E2E_SEED_FOLDERS: '1' } });

  await page.evaluate(() => {
    window.location.hash = '#/chat';
  });
  const nav = page.getByRole('button', { name: /^Connect/ });
  await expect(nav).toContainText('New');
  await nav.click();
  await expect(page.getByRole('heading', { name: 'Connect', exact: true })).toBeVisible();
  await expect(page.getByText('Bring your meetings to your AI tools')).toBeVisible();

  for (const name of ['Claude', 'Claude Code', 'Codex', 'Cursor', 'ChatGPT']) {
    await expect(page.getByRole('region', { name, exact: true })).toBeVisible();
  }
  // ChatGPT has no install action yet.
  const chatgpt = page.getByRole('region', { name: 'ChatGPT', exact: true });
  await expect(chatgpt.getByText('Coming soon')).toBeVisible();
  await expect(chatgpt.getByRole('button')).toHaveCount(0);
  // Claude Code reads as installed in the mock.
  await expect(
    page.getByRole('region', { name: 'Claude Code', exact: true }).getByRole('button', { name: 'Connect Claude Code' }),
  ).toHaveText('Connected');

  // Claude Code sheet: copy the exact command.
  await page.getByRole('button', { name: 'Connect Claude Code' }).click();
  const sheet = page.getByRole('dialog');
  await expect(sheet.getByRole('heading', { name: 'Connect Claude Code' })).toBeVisible();
  await sheet.getByRole('button', { name: 'Copy', exact: true }).click();
  await expect(sheet.getByRole('button', { name: 'Copied', exact: true })).toBeVisible();
  const copied = await app.evaluate(({ clipboard }) => clipboard.readText());
  expect(copied).toBe(
    'claude mcp add --scope user --env ELECTRON_RUN_AS_NODE=1 steno -- /Applications/Steno.app/Contents/MacOS/Steno /Applications/Steno.app/Contents/Resources/steno-mcp/server/index.mjs',
  );
  await page.keyboard.press('Escape');
  await expect(sheet).toHaveCount(0);

  // Codex sheet shows the config.toml snippet.
  await page.getByRole('button', { name: 'Connect Codex' }).click();
  await expect(page.getByRole('dialog').getByText('[mcp_servers.steno]')).toBeVisible();
  await page.keyboard.press('Escape');

  // Actions section (covered in depth by mcp-actions.t1).
  await expect(page.getByRole('heading', { name: 'Turn meetings into actions' })).toBeVisible();
  await expect(page.getByRole('region', { name: 'Custom endpoint', exact: true })).toBeVisible();

  // Scope: narrow to one folder, then notes only, then back to all meetings.
  const allMeetings = page.getByRole('switch', { name: 'All meetings' });
  await expect(allMeetings).toBeChecked();
  await allMeetings.click();
  await expect.poll(() => settingsOf(app)).toEqual({ folderAllowlist: [], excludeTranscripts: false });
  const folders = page.getByRole('group', { name: 'Folders assistants can read' });
  await folders.getByRole('checkbox', { name: 'Engineering' }).click();
  await expect(folders.getByRole('checkbox', { name: 'Engineering' })).toBeChecked();
  await expect(folders.getByRole('checkbox', { name: 'Sales' })).not.toBeChecked();
  await expect.poll(() => settingsOf(app)).toEqual({ folderAllowlist: ['f-eng'], excludeTranscripts: false });
  await page.getByRole('switch', { name: 'Notes only' }).click();
  await expect.poll(() => settingsOf(app)).toEqual({ folderAllowlist: ['f-eng'], excludeTranscripts: true });
  await page.screenshot({ path: testInfo.outputPath('connect.png'), fullPage: true });
  await allMeetings.click();
  await expect.poll(() => settingsOf(app)).toEqual({ folderAllowlist: null, excludeTranscripts: true });
  await expect(folders).toHaveCount(0);

  // The skill page stays reachable from Connect, and links back.
  await page.getByRole('button', { name: 'Set up the Steno skill' }).click();
  await expect(page.getByRole('heading', { name: 'Your notes, in your agent.' })).toBeVisible();
  await page.getByRole('button', { name: 'Connect over MCP' }).click();
  await expect(page.getByRole('heading', { name: 'Connect', exact: true })).toBeVisible();
});
