import { test, expect } from '../fixtures/electron';

/**
 * T1 — the two on-device kinds of action, with mock IPC (app/e2e-mock-ipc.js):
 *
 *   - Email drafts: the built-in card on Connect (on by default, can be
 *     turned off), a suggested draft_email card on a note, and Approve opening
 *     a mailto: URL built by the real app/mcp-email.js through the real
 *     shell.openExternal (stubbed here): parts percent-encoded, no header
 *     injection, nothing opened for an invalid recipient.
 *   - Command on this computer: the add dialog's mode switch, the warning,
 *     and the command line + environment handed to actions-add-local.
 *
 * The real service (policy, native confirmation, stdio process) is covered by
 * mcp-actions-local.test.js and mcp-stdio-client.test.js.
 */

type OpenedState = { openedUrls: string[] };
const openedOf = (app: import('@playwright/test').ElectronApplication) =>
  app.evaluate(() => (globalThis as unknown as OpenedState).openedUrls);

test('Connect: Email drafts are built in and on by default', async ({ launchApp }) => {
  const { page } = await launchApp({ mockIpc: true });
  await page.evaluate(() => {
    window.location.hash = '#/connect';
  });
  const card = page.getByRole('region', { name: 'Email', exact: true });
  await expect(card.getByText('Drafts open in your mail app')).toBeVisible();
  await expect(card.locator('[data-glyph="icon"] svg')).toHaveCount(1);
  const toggle = card.getByRole('switch', { name: 'Suggest email drafts' });
  await expect(toggle).toBeChecked();
  await toggle.click();
  await expect(toggle).not.toBeChecked();
  // Nothing to manage: Email is not listed as a connection in Settings.
  await page.evaluate(() => {
    window.location.hash = '#/settings?tab=connectors';
  });
  await expect(page.getByText('Apps Steno can send approved actions to.')).toBeVisible();
  await expect(page.getByRole('region', { name: 'Email', exact: true })).toHaveCount(0);
});

test('Note: approving a suggested email opens a safe mailto draft', async ({ launchApp }, testInfo) => {
  const { page, app } = await launchApp({
    mockIpc: true,
    env: { STENOAI_E2E_SEED_MEETING: '1', STENOAI_E2E_SEED_ACTIONS: 'email' },
  });
  await app.evaluate(({ shell }) => {
    const state = globalThis as unknown as OpenedState;
    state.openedUrls = [];
    shell.openExternal = async (url) => {
      state.openedUrls.push(url);
    };
  });
  await page.evaluate(() => {
    window.location.hash = `#/meetings/${encodeURIComponent('epsilon_summary.json')}`;
  });
  const card = page.getByTestId('suggested-actions').getByRole('article', { name: 'Draft email via Email' });
  await expect(card.getByRole('heading', { name: 'Draft email · Follow-up: release plan' })).toBeVisible();
  // The mail icon leads the card.
  await expect(card.locator('header [data-glyph="icon"] svg')).toHaveCount(1);
  await expect(card.getByText('Opens a draft in your mail app. Nothing is sent until you press Send.')).toBeVisible();
  const to = card.getByLabel('To');
  await expect(to).toHaveValue('dana@acme.co');
  await expect(card.getByLabel('Subject (required)')).toHaveValue('Follow-up: release plan');
  await card.scrollIntoViewIfNeeded();
  await card.screenshot({ path: testInfo.outputPath('email-card.png') });

  // A second "recipient" line that tries to add a header is refused; nothing opens.
  await to.fill('dana@acme.co\nBcc: spy@evil.co');
  await card.getByRole('button', { name: 'Approve' }).click();
  await expect(card.getByRole('status')).toContainText('Some fields need fixing');
  expect(await openedOf(app)).toEqual([]);

  await to.fill('dana@acme.co\nbob@acme.co');
  await card.getByLabel('Subject (required)').fill('Q3 & next? #1');
  await card.getByRole('button', { name: 'Approve' }).click();
  await expect(card.getByText('Draft opened in your mail app')).toBeVisible();
  await expect(card.getByRole('button', { name: 'Approve' })).toHaveCount(0);

  const opened = await openedOf(app);
  expect(opened).toHaveLength(1);
  const url = opened[0]!;
  expect(url).toBe(
    'mailto:dana@acme.co,bob@acme.co?subject=Q3%20%26%20next%3F%20%231' +
      '&body=Hi%20Dana%2C%0D%0A%0D%0AThanks%20for%20today.%20We%20ship%20Friday%20%26%20Bob%20preps%20the%20notes.%0D%0A%0D%0ABest',
  );
  const head = url.split('&body=')[0]!;
  expect(head).not.toMatch(/%0[DA]|[\r\n]/i);
  const parsed = new URL(url);
  expect(parsed.protocol).toBe('mailto:');
  expect([...parsed.searchParams.keys()]).toEqual(['subject', 'body']);
  expect(parsed.searchParams.get('subject')).toBe('Q3 & next? #1');
});

test('Add dialog: "Command on this computer" warns and adds a local server', async ({ launchApp }, testInfo) => {
  const { page, app } = await launchApp({ mockIpc: true });
  await page.evaluate(() => {
    window.location.hash = '#/connect';
  });
  await page.getByRole('region', { name: 'Custom MCP server', exact: true }).getByRole('button', { name: 'Add' }).click();
  const dialog = page.getByRole('dialog');
  const modes = dialog.getByRole('radiogroup', { name: 'Server type' });
  await expect(modes.getByRole('radio', { name: 'Server URL' })).toHaveAttribute('aria-checked', 'true');
  await expect(dialog.getByLabel('Server URL')).toBeVisible();
  await expect(dialog.getByText('This runs a program on this computer')).toHaveCount(0);

  await modes.getByRole('radio', { name: 'Command on this computer' }).click();
  await expect(modes.getByRole('radio', { name: 'Command on this computer' })).toHaveAttribute('aria-checked', 'true');
  await expect(dialog.getByLabel('Server URL')).toHaveCount(0);
  await expect(dialog.getByRole('note')).toHaveText(
    'This runs a program on this computer with your permissions. Only add commands you trust. Steno asks you to confirm before saving it.',
  );
  const add = dialog.getByRole('button', { name: 'Add', exact: true });
  await expect(add).toBeDisabled();
  await dialog.getByLabel('Name').fill('Notes server');
  await dialog.getByLabel('Command', { exact: true }).fill('npx -y @scope/notes-mcp "/Users/me/My Notes"');
  await dialog.getByLabel('Environment variables (optional)').fill('API_KEY=abc123\nnot a pair');
  await dialog.screenshot({ path: testInfo.outputPath('add-local-dialog.png') });
  await add.click();
  await expect(dialog.getByRole('status')).toHaveText("Line 2 isn't KEY=value.");
  expect(await app.evaluate(() => (globalThis as unknown as { __actionsAddedLocal: unknown[] }).__actionsAddedLocal)).toEqual([]);

  await dialog.getByLabel('Environment variables (optional)').fill('# token\nAPI_KEY=abc123');
  await add.click();
  await expect(dialog).toHaveCount(0);
  expect(await app.evaluate(() => (globalThis as unknown as { __actionsAddedLocal: unknown[] }).__actionsAddedLocal)).toEqual([
    { name: 'Notes server', command: 'npx', args: ['-y', '@scope/notes-mcp', '/Users/me/My Notes'], env: ['API_KEY'] },
  ]);

  await page.getByRole('button', { name: 'Manage connections in Settings' }).click();
  const card = page.getByRole('region', { name: 'Notes server', exact: true });
  await expect(card.getByText('npx -y @scope/notes-mcp /Users/me/My Notes')).toBeVisible();
  await expect(card.getByText('Runs on this computer', { exact: false })).toBeVisible();
});
