import { test, expect } from '../fixtures/electron';
import { existsSync, readFileSync, writeFileSync } from 'fs';
import path from 'path';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { writeMeetingMarkdown, writeTranscriptFile, readUserConfig } from '../fixtures/user-config';

/**
 * T2 — the Steno MCP server, end to end. Seeds meetings in the per-test
 * STENOAI_USER_DATA_DIR, asks the real app (connect bridge) how assistants
 * launch the server, then spawns exactly that command over stdio with the MCP
 * client SDK — the stable launcher the app writes to <userData>/bin, which
 * execs Steno's own Electron in Node mode, as Claude Code / Codex / Cursor
 * would — and calls search_meetings / get_note against the seeded data. It
 * also checks the server's diagnostics: the last-used stamp and an error log
 * that holds no meeting content.
 *
 * The second test drives the scope settings through the bridge (real handler ->
 * bundled backend -> config.json) and proves the running server enforces them.
 * It needs the backend bundle; it skips loudly when dist/stenoai is absent.
 * Model-free: no ASR, no LLM, no network.
 */

type ConnectInfo = {
  success: boolean;
  serverAvailable: boolean;
  launch: { command: string; args: string[]; env: Record<string, string> };
  snippets: { claudeCode: string; codexToml: string; cursorJson: string };
  lastUsed?: Record<string, string | null> | null;
};
type StenoWin = Window & {
  stenoai: {
    connect: {
      getInfo: () => Promise<ConnectInfo>;
      setSettings: (patch: {
        folderAllowlist?: string[] | null;
        excludeTranscripts?: boolean;
      }) => Promise<{ success: boolean; error?: string }>;
    };
  };
};

const BACKEND = path.resolve(
  __dirname, '..', '..', 'dist', 'stenoai',
  process.platform === 'win32' ? 'stenoai.exe' : 'stenoai',
);

function seed(userDataDir: string) {
  writeFileSync(
    path.join(userDataDir, 'folders.json'),
    JSON.stringify({ folders: [{ id: 'f-sales', name: 'Sales', color: '#000', icon: 'folder', order: 0 }] }),
  );
  writeMeetingMarkdown(userDataDir, 'acme-kickoff', {
    name: 'Acme kickoff',
    summaryMarkdown: '## Summary\n\nPricing agreed at the team tier.\n\n## Action Items\n\n- [ ] Alice to send the order form',
    transcript: '[00:01] [You] inline',
    folders: ['f-sales'],
  });
  writeTranscriptFile(userDataDir, 'acme-kickoff', '[00:01] [You] The budget is approved.');
  writeMeetingMarkdown(userDataDir, 'private-1on1', {
    name: 'Private 1:1',
    summaryMarkdown: '## Summary\n\nCareer chat about pricing strategy.',
    transcript: '[00:01] [You] private',
  });
}

async function connectServer(info: ConnectInfo, userDataDir: string | null) {
  // Without an explicit dir the launcher's own default applies (the app ran
  // with STENOAI_USER_DATA_DIR, so it baked that dir in).
  const env = { ...(process.env as Record<string, string>), ...info.launch.env };
  delete env.STENOAI_USER_DATA_DIR;
  delete env.ELECTRON_RUN_AS_NODE;
  if (userDataDir) env.STENOAI_USER_DATA_DIR = userDataDir;
  const transport = new StdioClientTransport({
    command: info.launch.command,
    args: info.launch.args,
    env,
    stderr: 'pipe',
  });
  const client = new Client({ name: 'steno-mcp-t2', version: '1.0.0' }, { capabilities: {} });
  await client.connect(transport);
  return client;
}

const text = (r: { content?: unknown }) =>
  ((r.content ?? []) as { type: string; text?: string }[]).map((c) => c.text ?? '').join('');

test('the server the app advertises serves seeded meetings over stdio', async ({ launchApp, userDataDir }) => {
  seed(userDataDir);
  const { page } = await launchApp();
  const info = await page.evaluate(() => (window as unknown as StenoWin).stenoai.connect.getInfo());
  expect(info.success).toBe(true);
  expect(info.serverAvailable).toBe(true);
  const launcher = path.join(userDataDir, 'bin', process.platform === 'win32' ? 'steno-mcp.cmd' : 'steno-mcp');
  expect(info.launch).toEqual({ command: launcher, args: [], env: {} });
  expect(existsSync(launcher)).toBe(true);
  expect(info.snippets.claudeCode).toContain('claude mcp add --scope user steno -- ');
  expect(info.snippets.claudeCode).not.toContain('ELECTRON_RUN_AS_NODE');
  expect(info.snippets.codexToml).toContain(`command = ${JSON.stringify(launcher)}`);

  const client = await connectServer(info, null);
  try {
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual(
      ['get_note', 'get_transcript', 'list_action_items', 'list_folders', 'search_meetings'],
    );
    expect(tools.every((t) => t.annotations?.readOnlyHint === true)).toBe(true);

    const search = JSON.parse(text(await client.callTool({ name: 'search_meetings', arguments: { query: 'pricing' } })));
    expect(search.results.map((r: { id: string }) => r.id).sort()).toEqual(['acme-kickoff', 'private-1on1']);

    const note = await client.callTool({ name: 'get_note', arguments: { id: 'acme-kickoff' } });
    expect(note.isError).toBeFalsy();
    expect(text(note)).toContain('# Acme kickoff');
    expect(text(note)).toContain('Alice to send the order form');
    expect(text(note)).toContain('Folders: Sales');
    expect(text(note)).not.toContain('inline');

    const transcript = JSON.parse(text(await client.callTool({ name: 'get_transcript', arguments: { id: 'acme-kickoff' } })));
    expect(transcript.transcript).toContain('The budget is approved.');

    const escape = await client.callTool({ name: 'get_note', arguments: { id: '../config' } });
    expect(escape.isError).toBe(true);

    // Diagnostics: a last-used stamp under the client's name, which the app
    // reports back to the Connect page, and an error log without content.
    const stamp = JSON.parse(readFileSync(path.join(userDataDir, 'steno-mcp-last-used.json'), 'utf8'));
    expect(Date.parse(stamp.clients['steno-mcp-t2'])).toBeGreaterThan(0);
    const log = readFileSync(path.join(userDataDir, 'logs', 'steno-mcp.log'), 'utf8');
    expect(log).toContain('ERROR tool=get_note tool: ToolError');
    expect(log).not.toMatch(/config|Acme|pricing|budget/);
    const after = await page.evaluate(() => (window as unknown as StenoWin).stenoai.connect.getInfo());
    expect(after.lastUsed?.any).toBe(stamp.last_used_at);
  } finally {
    await client.close();
  }
});

test('scope settings saved in the app are enforced by a running server', async ({ launchApp, userDataDir }) => {
  test.skip(!existsSync(BACKEND), 'backend bundle not built (dist/stenoai) — settings round-trip needs it');
  seed(userDataDir);
  const { page } = await launchApp();
  const info = await page.evaluate(() => (window as unknown as StenoWin).stenoai.connect.getInfo());
  const client = await connectServer(info, userDataDir);
  try {
    const saved = await page.evaluate(() =>
      (window as unknown as StenoWin).stenoai.connect.setSettings({ folderAllowlist: ['f-sales'], excludeTranscripts: true }),
    );
    expect(saved.success).toBe(true);
    const cfg = readUserConfig(userDataDir);
    expect(cfg.mcp_folder_allowlist).toEqual(['f-sales']);
    expect(cfg.mcp_exclude_transcripts).toBe(true);

    // The same server process picks the change up on its next call.
    const search = JSON.parse(text(await client.callTool({ name: 'search_meetings', arguments: { query: 'pricing' } })));
    expect(search.results.map((r: { id: string }) => r.id)).toEqual(['acme-kickoff']);
    expect((await client.callTool({ name: 'get_note', arguments: { id: 'private-1on1' } })).isError).toBe(true);
    const transcript = await client.callTool({ name: 'get_transcript', arguments: { id: 'acme-kickoff' } });
    expect(transcript.isError).toBe(true);
    expect(text(transcript)).toContain('Transcripts are turned off');

    await page.evaluate(() =>
      (window as unknown as StenoWin).stenoai.connect.setSettings({ folderAllowlist: null, excludeTranscripts: false }),
    );
    expect(JSON.parse(readFileSync(path.join(userDataDir, 'config.json'), 'utf8')).mcp_folder_allowlist).toBeNull();
    const all = JSON.parse(text(await client.callTool({ name: 'search_meetings', arguments: {} })));
    expect(all.total_matches).toBe(2);
  } finally {
    await client.close();
  }
});
