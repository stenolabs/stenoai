import { test, expect } from '../fixtures/electron';

/**
 * T1 — chat as an agent, renderer side (mock IPC, STENOAI_E2E_CHAT_AGENT=1 in
 * app/e2e-mock-ipc.js): a read step shows as "Searched Linear", a write tool
 * pauses the turn on an action card in the chat, Approve sends the edited
 * arguments through chat-action-approve and the reply finishes; Dismiss
 * declines. The real loop, provider and MCP wire are covered by
 * chat-agent.test.js and chat-tools.t2.
 */

type Approved = { cardId: string; args: Record<string, unknown> };
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

  await expect(page.getByTestId('chat-tool-step')).toHaveText('Searched Linear');
  const card = page.getByRole('article', { name: 'Create issue via Linear' });
  await expect(card.getByRole('heading', { name: 'Create issue in Linear · Prep the release notes' })).toBeVisible();
  await expect(card.getByText('Leaves your device for Linear.')).toBeVisible();
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

test('chat agent: Dismiss declines and nothing is sent', async ({ launchApp }) => {
  const { page, app } = await launchApp({ mockIpc: true, env: { STENOAI_E2E_CHAT_AGENT: '1' } });
  await ask(page, 'Create a Linear issue for the release notes');
  const card = page.getByRole('article', { name: 'Create issue via Linear' });
  await card.getByRole('button', { name: 'Dismiss' }).click();
  await expect(page.getByText("OK, I won't create it.")).toBeVisible();
  await expect(page.getByText('Dismissed: Create issue in Linear · Prep the release notes')).toBeVisible();
  expect(await approvedOf(app)).toEqual([]);
});
