import { test, expect } from '../fixtures/electron';

/**
 * T1 — Suggested actions in the renderer, with mock IPC (app/e2e-mock-ipc.js
 * actions-*): the Connect page's "Actions" section
 * (connector cards, Coming soon, adding a custom endpoint, the enable toggle,
 * the tool preview, disconnect) and the action cards under a note (editable
 * arguments, no JSON anywhere, Approve sends the edited arguments, Dismiss
 * sends nothing, "Always allow for <app>" runs the app's later suggestions
 * without a card until the Settings switch turns it off, Recent actions).
 * The real service, OAuth and the MCP wire are covered by mcp-actions.t2 and
 * the node unit tests.
 */

type Approved = { cardId: string; args: Record<string, unknown>; alwaysAllow?: boolean };
const approvedOf = (app: import('@playwright/test').ElectronApplication) =>
  app.evaluate(() => (globalThis as unknown as { __actionsApproved: Approved[] }).__actionsApproved);
const dismissedOf = (app: import('@playwright/test').ElectronApplication) =>
  app.evaluate(() => (globalThis as unknown as { __actionsDismissed: string[] }).__actionsDismissed);
const addedOf = (app: import('@playwright/test').ElectronApplication) =>
  app.evaluate(() => (globalThis as unknown as { __actionsAdded: unknown[] }).__actionsAdded);

test('Connect: connector cards, add a custom endpoint, toggle and disconnect', async ({ launchApp }, testInfo) => {
  const { page, app } = await launchApp({ mockIpc: true });
  await page.evaluate(() => {
    window.location.hash = '#/connect';
  });
  await expect(page.getByRole('heading', { name: 'Actions', exact: true })).toBeVisible();

  for (const name of ['Linear', 'Notion', 'Jira and Confluence']) {
    await expect(
      page.getByRole('region', { name, exact: true }).getByRole('button', { name: `Connect ${name}` }),
    ).toBeVisible();
  }
  for (const name of ['HubSpot', 'Asana']) {
    const card = page.getByRole('region', { name, exact: true });
    await expect(card.getByText('Coming soon')).toBeVisible();
    await expect(card.getByRole('button')).toHaveCount(0);
  }

  // Add a custom endpoint (n8n, bearer token).
  await page.getByRole('region', { name: 'Custom MCP server', exact: true }).getByRole('button', { name: 'Add' }).click();
  const dialog = page.getByRole('dialog');
  await expect(dialog.getByRole('heading', { name: 'Add an MCP server' })).toBeVisible();
  const connect = dialog.getByRole('button', { name: 'Connect', exact: true });
  await expect(connect).toBeDisabled();
  await dialog.getByLabel('Name').fill('Team n8n');
  await dialog.getByLabel('Server URL').fill('https://n8n.example.com/mcp/steno');
  await expect(dialog.getByText('so that data leaves your device')).toBeVisible();
  await dialog.getByLabel('Token').fill('secret-token');
  await connect.click();
  await expect(dialog).toHaveCount(0);
  await expect.poll(() => addedOf(app)).toEqual([
    { name: 'Team n8n', url: 'https://n8n.example.com/mcp/steno', auth: 'bearer', token: '<set>' },
  ]);

  // Connections are managed in Settings → Connectors, reached from Connect.
  await page.getByRole('button', { name: 'Manage connections in Settings' }).click();
  await expect(page.getByRole('heading', { name: 'Your connections' })).toBeVisible();
  const card = page.getByRole('region', { name: 'Team n8n', exact: true });
  // Brief status: count · locality, without the long data-leaves note.
  await expect(card.getByText('2 actions available · Runs on this computer')).toBeVisible();
  await expect(card.getByText('so that data leaves your device')).toHaveCount(0);
  // The action list is a hover away, not a wall of chips.
  await expect(card.getByRole('list', { name: 'Actions offered by Team n8n' })).toHaveCount(0);
  await card.getByText('2 actions available').hover();
  const tools = page.getByRole('tooltip').getByRole('list', { name: 'Actions offered by Team n8n' });
  await expect(tools.getByText('Create issue')).toBeVisible();
  await expect(tools.getByText('Search issues')).toHaveCount(0); // read-only tools are not actions
  const toggle = card.getByRole('switch', { name: 'Use Team n8n for suggestions' });
  await expect(toggle).toBeChecked();
  await toggle.click();
  await expect(toggle).not.toBeChecked();
  await expect(page.getByRole('switch', { name: 'Suggest actions after each note' })).toBeChecked();
  await page.screenshot({ path: testInfo.outputPath('settings-connectors.png'), fullPage: true });
  await page.evaluate(() => {
    window.location.hash = '#/connect';
  });
  await page.screenshot({ path: testInfo.outputPath('connect-actions.png'), fullPage: true });

  // A vendor connector (OAuth is mocked) shows as connected with its account.
  await page.getByRole('button', { name: 'Connect Linear' }).click();
  await expect(page.getByRole('region', { name: 'Linear', exact: true }).getByText('Connected')).toBeVisible();

  // An Atlassian account with no Jira/Confluence site gets a specific message
  // on that card, not the generic failure.
  await app.evaluate(() => {
    (globalThis as unknown as { __connectConnectorError: Record<string, string> }).__connectConnectorError = {
      atlassian: 'atlassian-no-site',
    };
  });
  await page.getByRole('button', { name: 'Connect Jira and Confluence' }).click();
  await expect(page.getByRole('region', { name: 'Jira and Confluence', exact: true }).getByRole('alert')).toHaveText(
    'This Atlassian account has no Jira or Confluence site. Sign in with your work account, or ask your admin to allow Rovo MCP.',
  );

  await page.evaluate(() => {
    window.location.hash = '#/settings?tab=connectors';
  });
  await card.getByRole('button', { name: 'Disconnect' }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Disconnect' }).click();
  await expect(page.getByRole('region', { name: 'Team n8n', exact: true })).toHaveCount(0);
});

test('Note: approve sends the edited arguments, dismiss sends nothing', async ({ launchApp }, testInfo) => {
  const { page, app } = await launchApp({
    mockIpc: true,
    env: { STENOAI_E2E_SEED_MEETING: '1', STENOAI_E2E_SEED_ACTIONS: '1' },
  });
  await page.evaluate(() => {
    window.location.hash = `#/meetings/${encodeURIComponent('epsilon_summary.json')}`;
  });
  const section = page.getByTestId('suggested-actions');
  await expect(section.getByRole('heading', { name: 'Suggested actions' })).toBeVisible();

  const issue = section.getByRole('article', { name: 'Create issue via Team n8n' });
  const message = section.getByRole('article', { name: 'Send message via Team n8n' });
  await expect(issue).toBeVisible();
  await expect(issue.getByText('Bob owns the release notes')).toBeVisible();
  await expect(issue.getByText('From: Bob to prep the release notes')).toBeVisible();

  // The card reads as a sentence; only the important fields are inline, and
  // there is no JSON anywhere: no payload preview, no raw editor.
  await expect(issue.getByRole('heading', { name: 'Create issue in Team n8n · Prep the release notes' })).toBeVisible();
  await expect(issue.getByLabel('Priority')).toHaveCount(0);
  await expect(issue.getByText('Show what will be sent')).toHaveCount(0);
  await expect(issue.getByTestId('action-payload')).toHaveCount(0);
  await expect(issue.getByRole('button', { name: 'Edit as JSON' })).toHaveCount(0);
  await expect(issue.getByText('{', { exact: false })).toHaveCount(0);
  await expect(issue.getByRole('button', { name: 'Always allow for Team n8n' })).toBeVisible();

  // Edit the title; the headline follows.
  const title = issue.getByLabel('Title (required)');
  await expect(title).toHaveValue('Prep the release notes');
  await title.fill('Prep release notes for v0.9.0');
  await expect(issue.getByRole('heading', { name: 'Create issue in Team n8n · Prep release notes for v0.9.0' })).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath('action-cards.png'), fullPage: true });
  // Send message: text and its required channel are inline.
  await expect(message.getByLabel('Channel (required)')).toHaveValue('#release');
  await expect(message.getByText('Sent to Team n8n on this computer.')).toBeVisible();

  expect(await approvedOf(app)).toEqual([]);
  await message.getByRole('button', { name: 'Dismiss' }).click();
  await expect(message).toHaveCount(0);
  expect(await approvedOf(app)).toEqual([]);
  expect((await dismissedOf(app)).length).toBe(1);

  await issue.getByRole('button', { name: 'Approve' }).click();
  await expect(issue.getByText('Done')).toBeVisible();
  await expect(issue.getByRole('button', { name: 'Open' })).toBeVisible();
  // A finished action is one line: no "From:" or reason, no form.
  await expect(issue.getByText('From: Bob to prep the release notes')).toHaveCount(0);
  await expect(issue.getByRole('button', { name: 'Approve' })).toHaveCount(0);
  const approved = await approvedOf(app);
  expect(approved).toHaveLength(1);
  // A plain Approve: the edited fields plus the ones not shown, and no "always allow".
  expect(approved[0]).toEqual({ cardId: expect.any(String), args: { title: 'Prep release notes for v0.9.0', priority: 'high' } });

  // The audit entry shows in Settings → Connectors; a plain approve is not "ran automatically".
  await page.evaluate(() => {
    window.location.hash = '#/settings?tab=connectors';
  });
  const recent = page.getByRole('list', { name: 'Recent actions' });
  await expect(recent.getByText('create_issue')).toBeVisible();
  await expect(recent.getByText('Sent', { exact: true })).toBeVisible();
  await expect(recent.getByText('ran automatically')).toHaveCount(0);
  // Nothing was trusted: the switch is off.
  const card = page.getByRole('region', { name: 'Team n8n', exact: true });
  await expect(card.getByRole('switch', { name: 'Run Team n8n actions without asking' })).not.toBeChecked();
});

test('Note: "Always allow" approves once; later suggestions run without a card until the Settings switch turns it off', async ({
  launchApp,
}, testInfo) => {
  const { page, app } = await launchApp({
    mockIpc: true,
    env: { STENOAI_E2E_SEED_MEETING: '1', STENOAI_E2E_SEED_ACTIONS: '1' },
  });
  const openNote = () =>
    page.evaluate(() => {
      window.location.hash = `#/meetings/${encodeURIComponent('epsilon_summary.json')}`;
    });
  await openNote();
  const section = page.getByTestId('suggested-actions');
  const issue = section.getByRole('article', { name: 'Create issue via Team n8n' });
  const message = section.getByRole('article', { name: 'Send message via Team n8n' });
  await message.getByRole('button', { name: 'Dismiss' }).click();
  await expect(message).toHaveCount(0);

  // "Always allow for Team n8n" approves this action AND trusts the app.
  await issue.getByRole('button', { name: 'Always allow for Team n8n' }).click();
  await expect(issue.getByText('Done')).toBeVisible();
  await expect(issue.getByRole('button', { name: 'Open' })).toBeVisible();
  await expect.poll(() => approvedOf(app)).toEqual([
    { cardId: expect.any(String), args: { title: 'Prep the release notes', priority: 'high' }, alwaysAllow: true },
  ]);

  // The next suggestions arrive already done: no Approve, no card to fill in.
  await section.getByRole('button', { name: 'Suggest actions' }).click();
  const issue2 = section.getByRole('article', { name: 'Create issue via Team n8n' }).last();
  const message2 = section.getByRole('article', { name: 'Send message via Team n8n' });
  await expect(message2.getByText('Done')).toBeVisible();
  await expect(issue2.getByText('Done')).toBeVisible();
  await expect(section.getByRole('button', { name: 'Approve' })).toHaveCount(0);
  await expect(section.getByRole('button', { name: 'Always allow for Team n8n' })).toHaveCount(0);
  await expect(section.getByLabel('Title (required)')).toHaveCount(0);
  await expect(message2.getByRole('button', { name: 'Open' })).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath('action-cards-auto.png'), fullPage: true });

  // The audit log still records every run, and says these ran on their own.
  await page.evaluate(() => {
    window.location.hash = '#/settings?tab=connectors';
  });
  const recent = page.getByRole('list', { name: 'Recent actions' });
  await expect(recent.getByText('Sent · ran automatically')).toHaveCount(2);
  await expect(recent.getByText('Sent', { exact: true })).toHaveCount(1);

  // Turn it off on the connection card: the next suggestion asks again.
  const card = page.getByRole('region', { name: 'Team n8n', exact: true });
  await expect(card.getByText('Run actions without asking')).toBeVisible();
  const toggle = card.getByRole('switch', { name: 'Run Team n8n actions without asking' });
  await expect(toggle).toBeChecked();
  await toggle.click();
  await expect(toggle).not.toBeChecked();
  await openNote();
  await section.getByRole('button', { name: 'Suggest actions' }).click();
  const issue3 = section.getByRole('article', { name: 'Create issue via Team n8n' }).last();
  await expect(issue3.getByRole('button', { name: 'Approve' })).toBeVisible();
  await expect(issue3.getByRole('button', { name: 'Always allow for Team n8n' })).toBeVisible();
  await expect(issue3.getByLabel('Title (required)')).toHaveValue('Prep the release notes');
});

test('Note: a tool the form cannot edit shows a short read-only summary, never JSON', async ({ launchApp }, testInfo) => {
  const { page, app } = await launchApp({
    mockIpc: true,
    env: { STENOAI_E2E_SEED_MEETING: '1', STENOAI_E2E_SEED_ACTIONS: 'nested' },
  });
  await page.evaluate(() => {
    window.location.hash = `#/meetings/${encodeURIComponent('epsilon_summary.json')}`;
  });
  const card = page.getByTestId('suggested-actions').getByRole('article', { name: 'Create record via Team n8n' });
  await expect(card.getByRole('heading', { name: 'Create record in Team n8n' })).toBeVisible();
  const summary = card.getByTestId('action-summary');
  const line = (key: string) => summary.locator('div').filter({ has: page.getByText(key, { exact: true }) });
  await expect(line('record › name:')).toContainText('Acme renewal');
  await expect(line('record › amount:')).toContainText('1200');
  await expect(line('record › owner:')).toContainText('dana@acme.co');
  await expect(line('tags:')).toContainText('q3, renewal');
  await expect(line('notify:')).toContainText('true');
  await expect(card.getByText('{', { exact: false })).toHaveCount(0);
  await expect(card.getByLabel('Arguments (JSON)')).toHaveCount(0);
  await expect(card.getByRole('textbox')).toHaveCount(0);
  await expect(card.getByText('Sent to Team n8n on this computer.')).toBeVisible();
  await card.screenshot({ path: testInfo.outputPath('action-card-summary.png') });
  // Approve sends the arguments exactly as proposed.
  await card.getByRole('button', { name: 'Approve' }).click();
  await expect(card.getByText('Done')).toBeVisible();
  expect((await approvedOf(app))[0]!.args).toEqual({
    record: { name: 'Acme renewal', amount: 1200, owner: 'dana@acme.co' },
    tags: ['q3', 'renewal'],
    notify: true,
  });
});

test('Org policy: approving each action required — no "Always allow", no switch', async ({ launchApp }) => {
  const { page } = await launchApp({
    mockIpc: true,
    env: { STENOAI_E2E_SEED_MEETING: '1', STENOAI_E2E_SEED_ACTIONS: '1', STENOAI_E2E_ACTIONS_NO_AUTO_APPROVE: '1' },
  });
  await page.evaluate(() => {
    window.location.hash = `#/meetings/${encodeURIComponent('epsilon_summary.json')}`;
  });
  const issue = page.getByTestId('suggested-actions').getByRole('article', { name: 'Create issue via Team n8n' });
  await expect(issue.getByRole('button', { name: 'Approve' })).toBeVisible();
  await expect(issue.getByRole('button', { name: 'Always allow for Team n8n' })).toHaveCount(0);
  await page.evaluate(() => {
    window.location.hash = '#/settings?tab=connectors';
  });
  const card = page.getByRole('region', { name: 'Team n8n', exact: true });
  await expect(card.getByRole('switch', { name: 'Use Team n8n for suggestions' })).toBeVisible();
  await expect(card.getByText('Run actions without asking')).toHaveCount(0);
});

test('Note: a failed action keeps the generic headline and shows the endpoint message under Details', async ({
  launchApp,
}) => {
  const { page, app } = await launchApp({
    mockIpc: true,
    env: { STENOAI_E2E_SEED_MEETING: '1', STENOAI_E2E_SEED_ACTIONS: '1' },
  });
  await app.evaluate(() => {
    (globalThis as unknown as { __actionsFailDetail: string }).__actionsFailDetail =
      'Validation failed: channel #release not found';
  });
  await page.evaluate(() => {
    window.location.hash = `#/meetings/${encodeURIComponent('epsilon_summary.json')}`;
  });
  const message = page.getByTestId('suggested-actions').getByRole('article', { name: 'Send message via Team n8n' });
  await message.getByRole('button', { name: 'Approve' }).click();
  const alert = message.getByRole('alert');
  await expect(alert).toContainText('This action failed. Check the details and try again.');
  await expect(alert.getByText('Validation failed: channel #release not found')).toBeHidden();
  await alert.getByText('Details', { exact: true }).click();
  await expect(alert.getByText('Validation failed: channel #release not found')).toBeVisible();
});

test('Org policy off: no connect buttons, a notice instead', async ({ launchApp }) => {
  const { page } = await launchApp({ mockIpc: true, env: { STENOAI_E2E_ACTIONS_DISABLED: '1' } });
  await page.evaluate(() => {
    window.location.hash = '#/connect';
  });
  await expect(page.getByText('Your organisation has turned off actions.')).toBeVisible();
  await expect(page.getByRole('region', { name: 'Custom MCP server', exact: true })).toHaveCount(0);
});

test('Note: a Notion page card reads as a sentence with its flat fields and no payload', async ({ launchApp }, testInfo) => {
  const { page } = await launchApp({
    mockIpc: true,
    env: { STENOAI_E2E_SEED_MEETING: '1', STENOAI_E2E_SEED_ACTIONS: 'notion' },
  });
  await page.evaluate(() => {
    window.location.hash = `#/meetings/${encodeURIComponent('epsilon_summary.json')}`;
  });
  const card = page.getByTestId('suggested-actions').getByRole('article', { name: 'Create page via Notion' });
  await expect(card.getByRole('heading', { name: 'Create page in Notion · Website content cleanup' })).toBeVisible();
  await expect(card.getByText("From: Create a Notion page called 'Website content cleanup'", { exact: false })).toBeVisible();
  // The app's own logo leads the card (Notion's mark).
  await expect(card.locator('svg path').first()).toBeVisible();
  await expect(card.locator('header > span[aria-hidden] svg')).toHaveCount(1);
  await expect(card.getByLabel('Title (required)')).toHaveValue('Website content cleanup');
  await expect(card.getByLabel('Content')).toBeVisible();
  await expect(card.getByLabel('Parent page')).toHaveCount(0);
  await expect(card.getByText('Leaves your device for Notion.')).toBeVisible();
  await expect(card.getByRole('button', { name: 'Always allow for Notion' })).toBeVisible();
  // The vendor call Notion receives is the main process's business, not the card's.
  await expect(card.getByText('Show what will be sent')).toHaveCount(0);
  await expect(card.getByText('notion-create-pages')).toHaveCount(0);
  await expect(card.getByRole('button', { name: 'Edit as JSON' })).toHaveCount(0);
  await card.getByLabel('Title (required)').fill('Website cleanup');
  await expect(card.getByRole('heading', { name: 'Create page in Notion · Website cleanup' })).toBeVisible();
  await card.scrollIntoViewIfNeeded();
  await card.screenshot({ path: testInfo.outputPath('action-card.png') });
});
