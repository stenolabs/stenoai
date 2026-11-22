import { test, expect } from '../fixtures/electron';
import { writeUserConfig, writeMeetingSummary } from '../fixtures/user-config';
import { startMockOllama } from '../fixtures/mock-ollama';
import { startMockMcpServer } from '../fixtures/mock-mcp-server';
import { existsSync, readFileSync } from 'fs';
import path from 'path';

/**
 * T2 — chat as an agent, end to end through the real main process
 * (chat-agent.js), the real bundled backend (`chat-agent-step` with a
 * tool-capable local model) and the mock MCP server, with the capturing mock
 * Ollama scripting the model's tool calls:
 *   1. the model searches the tracker (read-only: runs automatically, shows
 *      "Searched Team n8n");
 *   2. it calls create_issue: the turn pauses on an action card in the chat
 *      and nothing is sent;
 *   3. Approve sends the edited arguments, the audit log records it, and the
 *      result goes back to the model, whose reply mentions it.
 * Model-free (no real LLM, no network): runs in the t2 lanes.
 */

type Bridge = {
  actions: {
    addCustom: (i: Record<string, unknown>) => Promise<{ success: boolean; connection: { id: string; status: string } }>;
  };
};

test('chat asks to create an issue: approval card in chat, approve sends the edited args, reply mentions the result', async ({
  launchApp,
  userDataDir,
}) => {
  test.setTimeout(120_000);
  writeUserConfig(userDataDir, { ai_provider: 'local', model: 'qwen3.5:9b', privacy_notice_seen: true });
  writeMeetingSummary(userDataDir, 'release', {
    name: 'Release sync',
    summary: 'The team agreed to ship on Friday.',
    action_items: ['Bob to prep the release notes'],
  });
  const mcp = await startMockMcpServer({ auth: 'bearer', token: 'e2e-chat-token' });
  const ollama = await startMockOllama({
    installedModels: ['qwen3.5:9b'],
    chatMessageQueue: [
      { content: '', tool_calls: [{ function: { name: 'team_n8n__search_issues', arguments: { query: 'release notes' } } }] },
      { content: '', tool_calls: [{ function: { name: 'team_n8n__create_issue', arguments: { title: 'Prep the release notes', priority: 'high' } } }] },
      { content: 'Done: I created MOCK-2 (https://mock.example/items/2) for the release notes.' },
    ],
  });
  try {
    const { page } = await launchApp();
    const added = await page.evaluate(
      (url) => (window as unknown as { stenoai: Bridge }).stenoai.actions.addCustom({ name: 'Team n8n', url, auth: 'bearer', token: 'e2e-chat-token' }),
      mcp.url,
    );
    expect(added.connection.status).toBe('ok');

    await page.evaluate(() => {
      window.location.hash = '#/chat';
    });
    // A fresh profile opens "What's new" once; close it when it shows.
    const whatsNew = page.getByRole('dialog').filter({ hasText: 'What’s new in Steno' });
    if (await whatsNew.waitFor({ timeout: 5_000 }).then(() => true, () => false)) {
      await page.keyboard.press('Escape');
      await expect(whatsNew).toHaveCount(0);
    }
    const input = page.getByRole('textbox').first();
    await input.fill('Create an issue for the release notes');
    await input.press('Enter');

    // Read tool ran on its own; the write waits on a card.
    await expect(page.getByTestId('chat-tool-step')).toHaveText('Searched Team n8n');
    const card = page.getByRole('article', { name: 'Create issue via Team n8n' });
    await expect(card.getByRole('heading', { name: 'Create issue in Team n8n · Prep the release notes' })).toBeVisible({ timeout: 60_000 });
    expect(mcp.calls()).toEqual([{ name: 'search_issues', args: { query: 'release notes' } }]);

    // The model got the tools, namespaced, and the read result as untrusted data.
    const second = ollama.chatRequests()[1] as { tools: { function: { name: string } }[]; messages: { role: string; content: string }[] };
    expect(second.tools.map((t) => t.function.name)).toEqual(
      expect.arrayContaining(['steno__search_meetings', 'steno__get_note', 'team_n8n__search_issues', 'team_n8n__create_issue']),
    );
    const toolMsg = second.messages.find((m) => m.role === 'tool');
    expect(toolMsg?.content).toContain('untrusted data');
    expect(toolMsg?.content).toContain('Created MOCK-1');

    await card.getByLabel('Title (required)').fill('Prep release notes for v0.9.0');
    await card.getByRole('button', { name: 'Approve' }).click();

    await expect(page.getByText('Done: I created MOCK-2 (https://mock.example/items/2) for the release notes.')).toBeVisible({ timeout: 60_000 });
    expect(mcp.calls()).toEqual([
      { name: 'search_issues', args: { query: 'release notes' } },
      { name: 'create_issue', args: { title: 'Prep release notes for v0.9.0', priority: 'high' } },
    ]);
    // The approved result went back to the model.
    const third = ollama.chatRequests()[2] as { messages: { role: string; content: string }[] };
    expect(third.messages.filter((m) => m.role === 'tool').at(-1)?.content).toContain('The user approved this action and it ran');
    expect(third.messages.filter((m) => m.role === 'tool').at(-1)?.content).toContain('Created MOCK-2');

    // Same audit log as a note's cards: one write, hashed arguments.
    const auditPath = path.join(userDataDir, 'mcp-actions-audit.jsonl');
    expect(existsSync(auditPath)).toBe(true);
    const lines = readFileSync(auditPath, 'utf8').trim().split('\n');
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0]!)).toMatchObject({ tool: 'create_issue', status: 'ok', connectionName: 'Team n8n' });
    expect(lines[0]).not.toContain('Prep release notes');
  } finally {
    await ollama.close();
    await mcp.close();
  }
});
