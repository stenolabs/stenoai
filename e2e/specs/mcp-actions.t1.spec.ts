import { test, expect } from '../fixtures/electron';

/**
 * T1 — Suggested actions in the renderer, with mock IPC (app/e2e-mock-ipc.js
 * actions-*): the Connect page's "Actions" section
 * (connector cards, Coming soon, adding a custom endpoint, the enable toggle,
 * the tool preview, disconnect) and the action cards under a note (editable
 * arguments, the exact-payload preview, Approve sends the edited arguments,
 * Dismiss sends nothing, Recent actions). The real service, OAuth and the
 * MCP wire are covered by mcp-actions.t2 and the node unit tests.
 */

type Approved = { cardId: string; args: Record<string, unknown> };
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
  await page.getByRole('region', { name: 'Custom endpoint', exact: true }).getByRole('button', { name: 'Add' }).click();
  const dialog = page.getByRole('dialog');
  await expect(dialog.getByRole('heading', { name: 'Add an endpoint' })).toBeVisible();
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

  const card = page.getByRole('region', { name: 'Team n8n', exact: true });
  await expect(card.getByText('2 actions available')).toBeVisible();
  const tools = card.getByRole('list', { name: 'Actions offered by Team n8n' });
  await expect(tools.getByText('Create issue')).toBeVisible();
  await expect(tools.getByText('Search issues')).toHaveCount(0); // read-only tools are not actions
  const toggle = card.getByRole('switch', { name: 'Use Team n8n for suggestions' });
  await expect(toggle).toBeChecked();
  await toggle.click();
  await expect(toggle).not.toBeChecked();
  await expect(page.getByRole('switch', { name: 'Suggest actions after each note' })).toBeChecked();
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

  // The card reads as a sentence; only the important fields are inline.
  await expect(issue.getByRole('heading', { name: 'Create issue in Team n8n · Prep the release notes' })).toBeVisible();
  await expect(issue.getByLabel('Priority')).toHaveCount(0);
  const payload = issue.getByTestId('action-payload');
  await expect(payload).toBeHidden();

  // Edit the title, then check the exact payload preview before approving.
  const title = issue.getByLabel('Title (required)');
  await expect(title).toHaveValue('Prep the release notes');
  await title.fill('Prep release notes for v0.9.0');
  await expect(issue.getByRole('heading', { name: 'Create issue in Team n8n · Prep release notes for v0.9.0' })).toBeVisible();
  await issue.getByText('Show what will be sent').click();
  await expect(payload).toContainText('"tool": "create_issue"');
  await expect(payload).toContainText('"title": "Prep release notes for v0.9.0"');
  await expect(payload).toContainText('"priority": "high"');
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
  const approved = await approvedOf(app);
  expect(approved).toHaveLength(1);
  expect(approved[0]!.args).toEqual({ title: 'Prep release notes for v0.9.0', priority: 'high' });

  // The audit entry shows on the Connect page.
  await page.evaluate(() => {
    window.location.hash = '#/connect';
  });
  const recent = page.getByRole('list', { name: 'Recent actions' });
  await expect(recent.getByText('create_issue')).toBeVisible();
  await expect(recent.getByText('Sent')).toBeVisible();
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
  await expect(page.getByRole('region', { name: 'Custom endpoint', exact: true })).toHaveCount(0);
});

test('Note: a Notion page card reads as a sentence, payload behind the disclosure', async ({ launchApp }, testInfo) => {
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
  await expect(card.getByLabel('Title (required)')).toHaveValue('Website content cleanup');
  await expect(card.getByLabel('Content')).toBeVisible();
  await expect(card.getByLabel('Parent page')).toHaveCount(0);
  await expect(card.getByText('Leaves your device for Notion.')).toBeVisible();
  await card.scrollIntoViewIfNeeded();
  await card.screenshot({ path: testInfo.outputPath('action-card-collapsed.png') });
  await card.getByText('Show what will be sent').click();
  // The flat fields translate to Notion's own nested call, edits included.
  const payload = card.getByTestId('action-payload');
  await expect(payload).toContainText('"tool": "notion-create-pages"');
  await expect(payload).toContainText('"title": "Website content cleanup"');
  await card.getByLabel('Title (required)').fill('Website cleanup');
  await expect(payload).toContainText('"title": "Website cleanup"');
  expect(JSON.parse((await payload.textContent()) ?? '{}')).toEqual({
    tool: 'notion-create-pages',
    arguments: { pages: [{ properties: { title: 'Website cleanup' }, content: 'Pages to trim:\n- Defence\n- Law enforcement' }] },
  });
  await card.getByRole('button', { name: 'Edit as JSON' }).click();
  await expect(card.getByLabel('Arguments (JSON)')).toBeVisible();
  await card.screenshot({ path: testInfo.outputPath('action-card-expanded.png') });
});
