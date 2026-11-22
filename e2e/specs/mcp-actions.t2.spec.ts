import { test, expect } from '../fixtures/electron';
import { writeUserConfig, writeMeetingSummary } from '../fixtures/user-config';
import { startMockOllama } from '../fixtures/mock-ollama';
import { startMockMcpServer, NOTION_LIKE_TOOLS } from '../fixtures/mock-mcp-server';
import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from 'fs';
import path from 'path';

/**
 * T2 — Suggested actions end to end through the real main process and the
 * real bundled backend, with no real model and no real vendor:
 *   - a custom endpoint (bearer token) on the mock MCP server
 *     (e2e/fixtures/mock-mcp-server.js) is connected through the preload
 *     bridge and its tools listed over Streamable HTTP;
 *   - suggestions come from the real `suggest-actions` CLI via the capturing
 *     mock Ollama, so the prompt contract (note data only, no transcript) is
 *     asserted deterministically;
 *   - Approve sends exactly the edited arguments, Dismiss sends nothing, and
 *     the local audit log records a hash, not the content;
 *   - the OAuth 2.1 flow (discovery, DCR, PKCE, loopback) completes against the
 *     mock authorization server, with the browser step stood in for by
 *     STENOAI_E2E_MCP_OAUTH_AUTOFOLLOW.
 * Model-free: runs in the t2 lanes.
 */

type Card = {
  id: string;
  tool: string;
  toolTitle?: string | null;
  sendTemplate?: unknown;
  arguments: Record<string, unknown>;
  status: string;
  validationErrors: unknown[];
  actionItem?: string;
  result?: { status: string; link: string | null; detail?: string };
};
type Res<T> = { success: true } & T;
type Bridge = {
  actions: {
    addCustom: (i: Record<string, unknown>) => Promise<Res<{ connection: { id: string; status: string; tools: { name: string }[] } }>>;
    refreshTools: (id: string) => Promise<Res<{ connection: { id: string; status: string; tools: { name: string }[] } }>>;
    suggest: (f: string) => Promise<Res<{ cards: Card[] }>>;
    approve: (f: string, id: string, args: Record<string, unknown>) => Promise<Res<{ card: Card }>>;
    dismiss: (f: string, id: string) => Promise<Res<{ cards: Card[] }>>;
    getCards: (f: string) => Promise<Res<{ cards: Card[]; available: boolean }>>;
    recent: () => Promise<Res<{ entries: { tool: string; status: string; argumentsSha256: string }[] }>>;
  };
};

// Steno's own files under the user-data dir (not Chromium's profile, which
// holds sockets and caches).
const stenoFiles = (dir: string): string[] => {
  const roots = ['config.json', 'mcp-connections.json', 'mcp-credentials', 'mcp-actions', 'mcp-actions-audit.jsonl', 'tmp'];
  const out: string[] = [];
  for (const r of roots) {
    const p = path.join(dir, r);
    if (!existsSync(p)) continue;
    if (statSync(p).isFile()) out.push(p);
    else for (const f of readdirSync(p)) out.push(path.join(p, f));
  }
  return out;
};

test('custom endpoint: suggest, approve the edited args, dismiss sends nothing, audit written', async ({
  launchApp,
  userDataDir,
}) => {
  writeUserConfig(userDataDir, { ai_provider: 'local' });
  const summaryFile = writeMeetingSummary(userDataDir, 'release', {
    name: 'Release sync',
    summary: 'The team agreed to ship on Friday.',
    action_items: ['Bob to prep the release notes', 'Alice to tell the support team'],
    transcript: 'TRANSCRIPT-ONLY-SENTENCE that must never reach the model',
  });
  const mcp = await startMockMcpServer({ auth: 'bearer', token: 'e2e-bearer-token' });
  let ollama: Awaited<ReturnType<typeof startMockOllama>> | null = null;
  try {
    const { page } = await launchApp();

    const added = await page.evaluate(
      (url) => (window as unknown as { stenoai: Bridge }).stenoai.actions.addCustom({ name: 'Team n8n', url, auth: 'bearer', token: 'e2e-bearer-token' }),
      mcp.url,
    );
    expect(added.success).toBe(true);
    expect(added.connection.status).toBe('ok');
    expect(added.connection.tools.map((t) => t.name).sort()).toEqual(['create_issue', 'search_issues', 'send_message']);
    const connectionId = added.connection.id;

    // The token is only in the encrypted credential store.
    const config = readFileSync(path.join(userDataDir, 'mcp-connections.json'), 'utf8');
    expect(config).toContain(mcp.url);
    for (const f of stenoFiles(userDataDir)) {
      expect(readFileSync(f).includes('e2e-bearer-token'), f).toBe(false);
    }

    ollama = await startMockOllama({
      chatReply: JSON.stringify({
        actions: [
          { connection_id: connectionId, tool: 'create_issue', arguments: { title: 'Prep the release notes', priority: 'high' }, reason: 'Bob', action_item: 1 },
          { connection_id: connectionId, tool: 'send_message', arguments: { channel: '#support', text: 'We ship Friday' }, action_item: 2 },
          { connection_id: connectionId, tool: 'drop_database', arguments: {}, action_item: 1 },
          // Placeholder and uncited proposals never become cards.
          { connection_id: connectionId, tool: 'send_message', arguments: { channel: 'not_specified', text: 'Hi' }, action_item: 2 },
          { connection_id: connectionId, tool: 'create_issue', arguments: { title: 'Uncited' } },
        ],
      }),
    });
    const suggested = await page.evaluate((f) => (window as unknown as { stenoai: Bridge }).stenoai.actions.suggest(f), summaryFile);
    expect(suggested.success).toBe(true);
    expect(suggested.cards.map((c) => c.tool)).toEqual(['create_issue', 'send_message']);
    expect(suggested.cards.every((c) => c.validationErrors.length === 0)).toBe(true);
    expect(suggested.cards.map((c) => c.actionItem)).toEqual(['Bob to prep the release notes', 'Alice to tell the support team']);
    expect(JSON.stringify(suggested.cards)).not.toContain('not_specified');

    const prompt = ollama.lastChatPrompt();
    expect(prompt).toContain('Bob to prep the release notes');
    expect(prompt).toContain('ship on Friday');
    expect(prompt).toContain('untrusted');
    expect(prompt).not.toContain('TRANSCRIPT-ONLY-SENTENCE');
    expect(prompt).not.toContain('search_issues'); // read-only tools are not offered
    expect(mcp.calls()).toEqual([]); // suggesting runs nothing

    const [issue, message] = suggested.cards as [Card, Card];
    const dismissed = await page.evaluate(([f, id]) => (window as unknown as { stenoai: Bridge }).stenoai.actions.dismiss(f, id), [summaryFile, message.id] as const);
    expect(dismissed.success).toBe(true);
    expect(mcp.calls()).toEqual([]);

    const edited = { title: 'Prep release notes for v0.9.0', priority: 'medium' };
    const approved = await page.evaluate(
      ([f, id, args]) => (window as unknown as { stenoai: Bridge }).stenoai.actions.approve(f, id, args),
      [summaryFile, issue.id, edited] as const,
    );
    expect(approved.success).toBe(true);
    expect(approved.card.status).toBe('done');
    expect(approved.card.result?.link).toBe('https://mock.example/items/1');
    expect(mcp.calls()).toEqual([{ name: 'create_issue', args: edited }]);

    // Cards persist per note.
    const cards = await page.evaluate((f) => (window as unknown as { stenoai: Bridge }).stenoai.actions.getCards(f), summaryFile);
    expect(cards.cards.map((c) => c.status)).toEqual(['done', 'dismissed']);

    // Audit log: one line, a hash, no argument content.
    const auditPath = path.join(userDataDir, 'mcp-actions-audit.jsonl');
    expect(existsSync(auditPath)).toBe(true);
    const lines = readFileSync(auditPath, 'utf8').trim().split('\n');
    expect(lines).toHaveLength(1);
    const entry = JSON.parse(lines[0]!);
    expect(entry).toMatchObject({ tool: 'create_issue', status: 'ok', connectionName: 'Team n8n', link: 'https://mock.example/items/1' });
    expect(entry.argumentsSha256).toMatch(/^[0-9a-f]{64}$/);
    expect(lines[0]).not.toContain('Prep release notes');
    const recent = await page.evaluate(() => (window as unknown as { stenoai: Bridge }).stenoai.actions.recent());
    expect(recent.entries[0]!.argumentsSha256).toBe(entry.argumentsSha256);
  } finally {
    await ollama?.close();
    await mcp.close();
  }
});

test('a failed action surfaces the endpoint error message, redacted', async ({ launchApp, userDataDir }) => {
  writeUserConfig(userDataDir, { ai_provider: 'local' });
  const summaryFile = writeMeetingSummary(userDataDir, 'pages', {
    name: 'Site review',
    summary: 'Trim the defence pages.',
    action_items: ['Reduce text on law enforcement/defense pages'],
  });
  const mcp = await startMockMcpServer({
    auth: 'none',
    tools: [{
      name: 'create_page',
      title: 'Create page',
      description: 'Create a page.',
      failText: 'Could not find parent page. token=e2e-secret-value',
      inputSchema: { type: 'object', properties: { title: { type: 'string' } }, required: ['title'] },
    }],
  });
  let ollama: Awaited<ReturnType<typeof startMockOllama>> | null = null;
  try {
    const { page } = await launchApp();
    const added = await page.evaluate(
      (url) => (window as unknown as { stenoai: Bridge }).stenoai.actions.addCustom({ name: 'Docs', url, auth: 'none' }),
      mcp.url,
    );
    ollama = await startMockOllama({
      chatReply: JSON.stringify({ actions: [
        { connection_id: added.connection.id, tool: 'create_page', arguments: { title: 'Shorter defence pages' }, action_item: 1 },
      ] }),
    });
    const suggested = await page.evaluate((f) => (window as unknown as { stenoai: Bridge }).stenoai.actions.suggest(f), summaryFile);
    const [card] = suggested.cards as [Card];
    expect(card.actionItem).toBe('Reduce text on law enforcement/defense pages');
    const approved = await page.evaluate(
      ([f, id]) => (window as unknown as { stenoai: Bridge }).stenoai.actions.approve(f, id, { title: 'Shorter defence pages' }),
      [summaryFile, card.id] as const,
    );
    expect(approved.card.status).toBe('failed');
    expect(approved.card.result?.detail).toContain('Could not find parent page.');
    expect(approved.card.result?.detail).not.toContain('e2e-secret-value');
  } finally {
    await ollama?.close();
    await mcp.close();
  }
});

test('OAuth endpoint: discovery, DCR, PKCE and loopback sign-in, tokens stay encrypted', async ({
  launchApp,
  userDataDir,
}) => {
  const mcp = await startMockMcpServer({ auth: 'oauth' });
  try {
    const { page } = await launchApp({ env: { STENOAI_E2E_MCP_OAUTH_AUTOFOLLOW: '1' } });
    const added = await page.evaluate(
      (url) => (window as unknown as { stenoai: Bridge }).stenoai.actions.addCustom({ name: 'Tracker', url, auth: 'oauth' }),
      mcp.url,
    );
    expect(added).toMatchObject({ success: true, connection: { status: 'ok' } });
    expect(added.connection.tools.length).toBe(3);

    expect(mcp.registrations()).toHaveLength(1);
    expect(mcp.registrations()[0]!.redirect_uris[0]).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/callback$/);
    const authorize = mcp.authorizeRequests()[0]!;
    expect(authorize.code_challenge_method).toBe('S256');
    expect(authorize.resource).toBe(mcp.url);
    expect(mcp.tokenRequests().every((r) => r.resource === mcp.url)).toBe(true);

    for (const f of stenoFiles(userDataDir)) {
      expect(/\b(at|rt)-[A-Za-z0-9_-]{10,}/.test(readFileSync(f, 'utf8')), f).toBe(false);
    }
  } finally {
    await mcp.close();
  }
});

test('simple action: a Notion connection is offered create_page, a small-model reply is repaired, Approve sends notion-create-pages', async ({
  launchApp,
  userDataDir,
}) => {
  writeUserConfig(userDataDir, { ai_provider: 'local', model: 'gemma4:e2b-it-qat' });
  const summaryFile = writeMeetingSummary(userDataDir, 'website', {
    name: 'Website review',
    summary: 'The Defence and Law enforcement pages are too long.',
    action_items: [
      "Create a Notion page called 'Website content cleanup' listing the pages to trim: Defence, Law enforcement",
      'Ask the design team for a shorter hero section',
    ],
  });
  const mcp = await startMockMcpServer({ auth: 'none', tools: NOTION_LIKE_TOOLS });
  // A connection of the Notion kind pointed at the mock: connectConnector
  // would sign in to Notion itself.
  const connectionId = 'e2e-notion-connection';
  writeFileSync(path.join(userDataDir, 'mcp-connections.json'), JSON.stringify({
    version: 1,
    autoSuggest: true,
    connections: [{ id: connectionId, name: 'Notion', url: mcp.url, kind: 'notion', auth: 'none', enabled: true, tools: [], toolsFetchedAt: null, status: 'ok' }],
  }));
  let ollama: Awaited<ReturnType<typeof startMockOllama>> | null = null;
  try {
    const { page } = await launchApp();
    const refreshed = await page.evaluate((id) => (window as unknown as { stenoai: Bridge }).stenoai.actions.refreshTools(id), connectionId);
    expect(refreshed.connection.tools.map((t) => t.name)).toContain('notion-create-pages');

    // What gemma4:e2b answers: the tool's title for "tool", the prompt's
    // connection alias, a list for content and no team of its own to invent.
    ollama = await startMockOllama({
      chatReply: JSON.stringify({ actions: [
        { action_item: 1, connection_id: 'c1', tool: 'Create page', arguments: { title: 'Website content cleanup', content: ['Defence', 'Law enforcement'] } },
      ] }),
    });
    const suggested = await page.evaluate((f) => (window as unknown as { stenoai: Bridge }).stenoai.actions.suggest(f), summaryFile);
    expect(suggested.success).toBe(true);
    const prompt = ollama.lastChatPrompt();
    expect(prompt).toContain('tool "create_page"');
    expect(prompt).not.toContain('notion-create-pages'); // the raw vendor tools are not offered
    expect(prompt).not.toContain('notion-delete-pages');
    expect(prompt).not.toContain(connectionId); // connections are aliased
    expect(prompt.length).toBeLessThan(6000);

    expect(suggested.cards).toHaveLength(1);
    const [card] = suggested.cards as [Card];
    expect(card).toMatchObject({ tool: 'notion-create-pages', toolTitle: 'Create page', validationErrors: [] });
    expect(card.arguments).toEqual({ title: 'Website content cleanup', content: '- Defence\n- Law enforcement' });
    expect(card.sendTemplate).toBeTruthy();
    expect(mcp.calls()).toEqual([]);

    const approved = await page.evaluate(
      ([f, id]) => (window as unknown as { stenoai: Bridge }).stenoai.actions.approve(f, id, { title: 'Website cleanup', content: '- Defence' }),
      [summaryFile, card.id] as const,
    );
    expect(approved.card.status).toBe('done');
    expect(mcp.calls()).toEqual([
      { name: 'notion-create-pages', args: { pages: [{ properties: { title: 'Website cleanup' }, content: '- Defence' }] } },
    ]);
  } finally {
    await ollama?.close();
    await mcp.close();
  }
});
