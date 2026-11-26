import { test, expect } from '../fixtures/electron';

/**
 * T1 — chat as an agent, renderer side (mock IPC, STENOAI_E2E_CHAT_AGENT=1 in
 * app/e2e-mock-ipc.js): a read step shows as "Searched Linear", a write tool
 * pauses the turn on an action card in the chat, Approve sends the edited
 * arguments through chat-action-approve and the reply finishes; Dismiss
 * declines; "Always allow for Linear" makes the next write run without a
 * card until Settings turns it off. The real loop, provider and MCP wire are
 * covered by chat-agent.test.js and chat-tools.t2.
 */

type Approved = { cardId: string; args: Record<string, unknown>; alwaysAllow?: boolean; auto?: boolean };
const approvedOf = (app: import('@playwright/test').ElectronApplication) =>
  app.evaluate(() => (globalThis as unknown as { __chatActionApproved: Approved[] }).__chatActionApproved);

async function ask(page: import('@playwright/test').Page, question: string) {
  await page.evaluate(() => {
    window.location.hash = '#/chat';
  });
  const input = page.getByRole('textbox').first();
  await input.fill(question);
  await input.press('Enter');
}

test('chat agent: approval card in the chat, Approve sends the edited args', async ({ launchApp }, testInfo) => {
  const { page, app } = await launchApp({ mockIpc: true, env: { STENOAI_E2E_CHAT_AGENT: '1' } });
  await ask(page, 'Create a Linear issue for the release notes');

  // A curated connector's read shows the connection only; a read on a custom
  // endpoint also shows the tool and what it asked for.
  await expect(page.getByTestId('chat-tool-step')).toHaveText([
    'Searched Linear',
    'Searched TrackerSearch issues: query: "release notes", limit: "5"',
  ]);
  await expect(page.getByTestId('chat-tool-step-detail')).toHaveText('Search issues: query: "release notes", limit: "5"');
  const card = page.getByRole('article', { name: 'Create issue via Linear' });
  await expect(card.getByRole('heading', { name: 'Create issue in Linear · Prep the release notes' })).toBeVisible();
  await expect(card.getByText('Leaves your device for Linear.')).toBeVisible();
  await expect(card.getByText('Show what will be sent')).toHaveCount(0);
  // Nothing ran yet.
  expect(await approvedOf(app)).toEqual([]);
  await card.getByLabel('Title (required)').fill('Prep release notes for v0.9.0');
  await page.screenshot({ path: testInfo.outputPath('chat-approval-card.png') });

  await card.getByRole('button', { name: 'Approve' }).click();
  await expect.poll(() => approvedOf(app)).toEqual([
    { cardId: expect.any(String), args: { title: 'Prep release notes for v0.9.0', priority: 'high' } },
  ]);
  await expect(page.getByText('Done: I created REL-2, "Prep release notes for v0.9.0", in Linear.')).toBeVisible();
  // The finished turn keeps a compact record of the step and the action.
  await expect(page.getByText('Create issue in Linear · Prep release notes for v0.9.0', { exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Open' })).toBeVisible();
  await expect(page.getByRole('article', { name: 'Create issue via Linear' })).toHaveCount(0);
});

test('chat agent: "Always allow for Linear" runs the next write without a card; the Settings switch turns it off', async ({
  launchApp,
}, testInfo) => {
  const { page, app } = await launchApp({ mockIpc: true, env: { STENOAI_E2E_CHAT_AGENT: '1' } });
  await ask(page, 'Create a Linear issue for the release notes');
  const card = page.getByRole('article', { name: 'Create issue via Linear' });
  await card.getByRole('button', { name: 'Always allow for Linear' }).click();
  await expect.poll(() => approvedOf(app)).toEqual([
    { cardId: expect.any(String), args: { title: 'Prep the release notes', priority: 'high' }, alwaysAllow: true },
  ]);
  await expect(page.getByText('Done: I created REL-2, "Prep the release notes", in Linear.')).toBeVisible();

  // The next write (a new conversation) runs at once: no card to approve, a
  // done line with its Open link in the trail.
  await ask(page, 'Create another Linear issue for the release notes');
  await expect(page.getByText('Done: I created REL-3, "Prep the release notes", in Linear.')).toBeVisible();
  expect((await approvedOf(app)).at(-1)).toEqual({ cardId: expect.any(String), args: { title: 'Prep the release notes', priority: 'high' }, auto: true });
  await expect(page.getByRole('button', { name: 'Approve' })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Always allow for Linear' })).toHaveCount(0);
  await expect(page.getByText('Create issue in Linear · Prep the release notes', { exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Open' })).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath('chat-auto-run.png') });

  // Settings → Connectors: the switch reflects it, and turning it off brings the card back.
  await page.evaluate(() => {
    window.location.hash = '#/settings?tab=connectors';
  });
  const linear = page.getByRole('region', { name: 'Linear', exact: true });
  const toggle = linear.getByRole('switch', { name: 'Run Linear actions without asking' });
  await expect(toggle).toBeChecked();
  await toggle.click();
  await expect(toggle).not.toBeChecked();
  await ask(page, 'Create a Linear issue for the release notes');
  await expect(page.getByRole('article', { name: 'Create issue via Linear' }).getByRole('button', { name: 'Approve' })).toBeVisible();
});

test('chat agent: Dismiss declines and nothing is sent', async ({ launchApp }) => {
  const { page, app } = await launchApp({ mockIpc: true, env: { STENOAI_E2E_CHAT_AGENT: '1' } });
  await ask(page, 'Create a Linear issue for the release notes');
  const card = page.getByRole('article', { name: 'Create issue via Linear' });
  await card.getByRole('button', { name: 'Dismiss' }).click();
  await expect(page.getByText("OK, I won't create it.")).toBeVisible();
  await expect(page.getByText('Dismissed: Create issue in Linear · Prep the release notes')).toBeVisible();
  expect(await approvedOf(app)).toEqual([]);
});
