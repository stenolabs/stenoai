import { test, expect } from '../fixtures/electron';

/**
 * T1 — the Connect page, renderer-only with mock IPC: the sidebar entry, the
 * three sections (Coding agents, AI apps, Actions), the Steno skill install
 * sheet (formerly the Agents page), the MCP install sheets, the Connected
 * state from skill/MCP detection, the old /agents redirect, and the scope
 * controls writing through the `connect` bridge. Mocks: app/e2e-mock-ipc.js (connect-*). The server itself
 * and the real handlers are covered by steno-mcp.t2 and the node unit tests.
 */

type ConnectState = { folderAllowlist: string[] | null; excludeTranscripts: boolean };
const settingsOf = (app: import('@playwright/test').ElectronApplication) =>
  app.evaluate(() => (globalThis as unknown as { __connectSettings: ConnectState }).__connectSettings);

test('Connect: coding agents install the skill by default, with MCP as the alternative', async ({
  launchApp,
}, testInfo) => {
  const { page, app } = await launchApp({
    mockIpc: true,
    env: { STENOAI_E2E_OPEN_EXTERNAL: '1', STENOAI_E2E_SEED_FOLDERS: '1' },
  });
  await app.evaluate(({ shell }) => {
    const state = globalThis as unknown as { openedUrls: string[] };
    state.openedUrls = [];
    shell.openExternal = async (url) => {
      state.openedUrls.push(url);
    };
  });

  // The old Agents route lands on Connect; the sidebar has no Agents entry.
  await page.evaluate(() => {
    window.location.hash = '#/agents';
  });
  await expect(page.getByRole('heading', { name: 'Connect', exact: true })).toBeVisible();
  await expect.poll(() => page.evaluate(() => window.location.hash)).toBe('#/connect');
  await expect(page.getByRole('button', { name: 'Agents', exact: true })).toHaveCount(0);
  await page.evaluate(() => {
    window.location.hash = '#/chat';
  });
  const nav = page.getByRole('button', { name: /^Connect/ });
  await expect(nav).toContainText('New');
  await nav.click();
  await expect(page.getByText('Bring your meetings to your AI tools')).toBeVisible();
  await expect(page.getByText('Prefer a skill instead of a connection?')).toHaveCount(0);

  const coding = page.getByRole('region', { name: 'Coding agents' });
  const apps = page.getByRole('region', { name: 'AI apps' });
  await expect(page.getByRole('region', { name: 'Actions', exact: true })).toBeVisible();
  for (const name of ['Claude Code', 'Codex']) {
    await expect(coding.getByRole('region', { name, exact: true })).toBeVisible();
  }
  for (const name of ['Claude', 'Cursor', 'ChatGPT']) {
    await expect(apps.getByRole('region', { name, exact: true })).toBeVisible();
  }

  // Connected state: the mock has Claude Code over MCP and Codex via the skill.
  const claudeCode = coding.getByRole('region', { name: 'Claude Code', exact: true });
  const codex = coding.getByRole('region', { name: 'Codex', exact: true });
  await expect(claudeCode.getByText('Connected')).toBeVisible();
  await expect(claudeCode.getByText('via MCP')).toBeVisible();
  await expect(codex.getByText('via skill')).toBeVisible();
  await expect(apps.getByRole('region', { name: 'Cursor', exact: true }).getByText('Connected')).toHaveCount(0);

  // ChatGPT: a short description and a Coming soon badge, no action.
  const chatgpt = apps.getByRole('region', { name: 'ChatGPT', exact: true });
  await expect(chatgpt.getByText("OpenAI's assistant.")).toBeVisible();
  await expect(chatgpt.getByText('Coming soon')).toBeVisible();
  await expect(chatgpt.getByRole('button')).toHaveCount(0);
  await expect(chatgpt.getByText(/tunnel/)).toHaveCount(0);

  // Install skill: the prompts and setup guides the Agents page used to hold.
  for (const name of ['Claude Code', 'Codex']) {
    await page.getByRole('button', { name: `Install the Steno skill in ${name}` }).click();
    const sheet = page.getByRole('dialog');
    await expect(sheet.getByRole('heading', { name: `Install the Steno skill in ${name}` })).toBeVisible();
    await sheet.getByRole('button', { name: 'Copy install prompt' }).click();
    await expect(sheet.getByRole('button', { name: 'Copied', exact: true })).toBeVisible();
    const text = await app.evaluate(({ clipboard }) => clipboard.readText());
    expect(text).toContain('https://github.com/stenolabs/stenoai/tree/main/skills/steno');
    expect(text).toContain(name === 'Codex' ? '$skill-installer' : '~/.claude/skills/steno');
    await sheet.getByRole('button', { name: 'Setup instructions' }).click();
    await page.keyboard.press('Escape');
    await expect(sheet).toHaveCount(0);
  }
  await expect
    .poll(() => app.evaluate(() => (globalThis as unknown as { openedUrls: string[] }).openedUrls))
    .toEqual([
      'https://github.com/stenolabs/stenoai/blob/main/docs/features/agents.mdx#claude-code',
      'https://github.com/stenolabs/stenoai/blob/main/docs/features/agents.mdx#codex',
    ]);

  // Clipboard and browser failures keep the prompt reachable and say why.
  await app.evaluate(({ shell }) => {
    shell.openExternal = async () => {
      throw new Error('Browser unavailable');
    };
  });
  await page.evaluate(() => {
    navigator.clipboard.writeText = async () => {
      throw new Error('Clipboard unavailable');
    };
  });
  await page.getByRole('button', { name: 'Install the Steno skill in Codex' }).click();
  const skillSheet = page.getByRole('dialog');
  await skillSheet.getByRole('button', { name: 'Copy install prompt' }).click();
  await expect(skillSheet.locator('details')).toHaveAttribute('open', '');
  await expect(skillSheet.getByRole('status')).toHaveText('Could not copy. Select and copy the prompt below.');
  await skillSheet.getByRole('button', { name: 'Setup instructions' }).click();
  await expect(skillSheet.getByRole('status')).toHaveText('Could not open the instructions. Try again.');
  await page.keyboard.press('Escape');

  // Use MCP instead: the existing MCP command sheet.
  await page.getByRole('button', { name: 'Connect Claude Code over MCP' }).click();
  const sheet = page.getByRole('dialog');
  await expect(sheet.getByRole('heading', { name: 'Connect Claude Code' })).toBeVisible();
  await page.keyboard.press('Escape');
  await page.getByRole('button', { name: 'Connect Codex over MCP' }).click();
  await expect(page.getByRole('dialog').getByText('[mcp_servers.steno]')).toBeVisible();
  await page.keyboard.press('Escape');
  await page.screenshot({ path: testInfo.outputPath('connect-coding-agents.png'), fullPage: true });
});

test('Connect: AI apps install over MCP and scope controls save', async ({ launchApp }, testInfo) => {
  const { page, app } = await launchApp({ mockIpc: true, env: { STENOAI_E2E_SEED_FOLDERS: '1' } });
  await page.evaluate(() => {
    window.location.hash = '#/connect';
  });
  const apps = page.getByRole('region', { name: 'AI apps' });
  await expect(apps).toBeVisible();

  // Claude desktop: the .mcpb "Add to Claude" sheet.
  await apps.getByRole('button', { name: 'Connect Claude' }).click();
  await expect(page.getByRole('dialog').getByRole('button', { name: 'Add to Claude' })).toBeVisible();
  await page.keyboard.press('Escape');
  await apps.getByRole('button', { name: 'Connect Cursor' }).click();
  await expect(page.getByRole('dialog').getByRole('button', { name: 'Add to Cursor' })).toBeVisible();
  await page.keyboard.press('Escape');

  // Claude Code's MCP command copies exactly.
  await page.getByRole('button', { name: 'Connect Claude Code over MCP' }).click();
  const sheet = page.getByRole('dialog');
  await sheet.getByRole('button', { name: 'Copy', exact: true }).click();
  await expect(sheet.getByRole('button', { name: 'Copied', exact: true })).toBeVisible();
  expect(await app.evaluate(({ clipboard }) => clipboard.readText())).toBe(
    'claude mcp add --scope user --env ELECTRON_RUN_AS_NODE=1 steno -- /Applications/Steno.app/Contents/MacOS/Steno /Applications/Steno.app/Contents/Resources/steno-mcp/server/index.mjs',
  );
  await page.keyboard.press('Escape');

  // Scope sits with AI apps and says it governs MCP connections.
  await expect(apps.getByRole('heading', { name: 'What assistants can see' })).toBeVisible();
  await expect(apps.getByText('These apply to MCP connections.', { exact: false })).toBeVisible();
  const allMeetings = page.getByRole('switch', { name: 'All meetings' });
  await expect(allMeetings).toBeChecked();
  await allMeetings.click();
  await expect.poll(() => settingsOf(app)).toEqual({ folderAllowlist: [], excludeTranscripts: false });
  await expect(page.getByText('Assistants can read only meetings in the spaces you choose.')).toBeVisible();
  const spaces = page.getByRole('group', { name: 'Spaces assistants can read' });
  await spaces.getByRole('checkbox', { name: 'Engineering' }).click();
  await expect(spaces.getByRole('checkbox', { name: 'Engineering' })).toBeChecked();
  await expect(spaces.getByRole('checkbox', { name: 'Sales' })).not.toBeChecked();
  await expect.poll(() => settingsOf(app)).toEqual({ folderAllowlist: ['f-eng'], excludeTranscripts: false });
  await page.getByRole('switch', { name: 'Notes only' }).click();
  await expect.poll(() => settingsOf(app)).toEqual({ folderAllowlist: ['f-eng'], excludeTranscripts: true });
  await page.screenshot({ path: testInfo.outputPath('connect.png'), fullPage: true });
  await allMeetings.click();
  await expect.poll(() => settingsOf(app)).toEqual({ folderAllowlist: null, excludeTranscripts: true });
  await expect(spaces).toHaveCount(0);

  // Actions section (covered in depth by mcp-actions.t1), with Slack's mark.
  const actions = page.getByRole('region', { name: 'Actions', exact: true });
  await expect(actions.getByText('Connect your tools and Steno will suggest follow-ups')).toBeVisible();
  await expect(actions.getByRole('region', { name: 'Custom endpoint', exact: true })).toBeVisible();
  await expect(actions.getByRole('region', { name: 'Slack', exact: true }).locator('path[fill="#E01E5A"]')).toHaveCount(1);
});
