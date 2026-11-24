'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const install = require('./steno-mcp-install');

const MAC = {
  command: '/Users/ada/Library/Application Support/stenoai/bin/steno-mcp',
  args: [],
  env: {},
};
const WIN = {
  command: 'C:\\Users\\Ada Lovelace\\AppData\\Roaming\\stenoai\\bin\\steno-mcp.cmd',
  args: [],
  env: {},
};

test('packaged launch spec points into resources, dev at the source, clients at the launcher', () => {
  const packaged = install.getLaunchSpec({
    isPackaged: true, execPath: '/x/Steno', resourcesPath: '/x/Resources', appDir: '/src/app', userDataDir: '/data',
    platform: 'darwin',
  });
  assert.equal(packaged.command, '/x/Steno');
  assert.deepEqual(packaged.args, [path.join('/x/Resources', 'steno-mcp', 'server', 'index.mjs')]);
  assert.equal(packaged.mcpbPath, path.join('/x/Resources', 'steno-mcp', 'Steno.mcpb'));
  assert.deepEqual(packaged.env, { ELECTRON_RUN_AS_NODE: '1' });
  assert.equal(packaged.launcherPath, path.join('/data', 'bin', 'steno-mcp'));
  assert.deepEqual(install.clientSpec(packaged), { command: path.join('/data', 'bin', 'steno-mcp'), args: [], env: {} });
  const dev = install.getLaunchSpec({ isPackaged: false, execPath: '/e', resourcesPath: '/r', appDir: '/src/app', userDataDir: '/data', platform: 'win32' });
  assert.deepEqual(dev.args, [path.join('/src/app', 'steno-mcp', 'index.mjs')]);
  assert.equal(dev.launcherPath, path.join('/data', 'bin', 'steno-mcp.cmd'));
});

test('Claude Code command runs the launcher, quoted per platform', () => {
  assert.equal(
    install.claudeCodeCommand(MAC, 'darwin'),
    "claude mcp add --scope user steno -- '/Users/ada/Library/Application Support/stenoai/bin/steno-mcp'",
  );
  const plain = { ...MAC, command: '/home/ada/.local/share/stenoai/bin/steno-mcp' };
  assert.equal(install.claudeCodeCommand(plain, 'linux'), `claude mcp add --scope user steno -- ${plain.command}`);
  const quoted = { ...MAC, command: "/Users/o'neil/Library/Application Support/stenoai/bin/steno-mcp" };
  assert.match(install.claudeCodeCommand(quoted, 'darwin'), / -- '\/Users\/o'\\''neil\/Library\/Application Support\/stenoai\/bin\/steno-mcp'$/);
  assert.equal(
    install.claudeCodeCommand(WIN, 'win32'),
    'claude mcp add --scope user steno -- "C:\\Users\\Ada Lovelace\\AppData\\Roaming\\stenoai\\bin\\steno-mcp.cmd"',
  );
  // The direct (pre-launcher) spec still renders, env first.
  const direct = { command: '/A/Steno', args: ['/A/index.mjs'], env: { ELECTRON_RUN_AS_NODE: '1' } };
  assert.equal(install.claudeCodeCommand(direct, 'darwin'), 'claude mcp add --scope user steno --env ELECTRON_RUN_AS_NODE=1 -- /A/Steno /A/index.mjs');
});

test('Codex TOML is just the launcher command, escaped for Windows', () => {
  assert.equal(install.codexToml(MAC), '[mcp_servers.steno]\ncommand = "/Users/ada/Library/Application Support/stenoai/bin/steno-mcp"');
  const toml = install.codexToml(WIN);
  assert.match(toml, /^\[mcp_servers\.steno\]$/m);
  assert.match(toml, /^command = "C:\\\\Users\\\\Ada Lovelace\\\\AppData\\\\Roaming\\\\stenoai\\\\bin\\\\steno-mcp\.cmd"$/m);
  assert.doesNotMatch(toml, /^(args|env) =/m);
});

test('Cursor link carries the bare launcher entry, base64 encoded', () => {
  const link = new URL(install.cursorDeepLink(MAC));
  assert.equal(link.protocol, 'cursor:');
  assert.equal(link.host, 'anysphere.cursor-deeplink');
  assert.equal(link.pathname, '/mcp/install');
  assert.equal(link.searchParams.get('name'), 'steno');
  const config = JSON.parse(Buffer.from(link.searchParams.get('config'), 'base64').toString('utf8'));
  assert.deepEqual(config, { command: MAC.command, args: [] });
  assert.deepEqual(JSON.parse(install.cursorMcpJson(MAC)).mcpServers.steno, config);
});

test('last-used stamps map client names to assistants, newest wins', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'steno-last-used-'));
  assert.deepEqual(await install.readLastUsed(dir), { any: null, claudeDesktop: null, claudeCode: null, codex: null, cursor: null });
  fs.writeFileSync(path.join(dir, install.LAST_USED_FILE), JSON.stringify({
    last_used_at: '2026-11-22T10:00:00.000Z',
    clients: {
      'claude-code': '2026-11-22T09:00:00.000Z',
      'codex-mcp-client': '2026-11-22T10:00:00.000Z',
      'cursor-vscode': 'not a date',
      'claude-ai': '2026-11-21T08:00:00.000Z',
      'some-other-client': '2026-11-22T10:00:00.000Z',
    },
  }));
  assert.deepEqual(await install.readLastUsed(dir), {
    any: '2026-11-22T10:00:00.000Z',
    claudeDesktop: '2026-11-21T08:00:00.000Z',
    claudeCode: '2026-11-22T09:00:00.000Z',
    codex: '2026-11-22T10:00:00.000Z',
    cursor: null,
  });
  fs.writeFileSync(path.join(dir, install.LAST_USED_FILE), '{ broken');
  assert.equal((await install.readLastUsed(dir)).any, null);
  assert.equal(install.clientIdForName('Claude Code'), 'claudeCode');
  assert.equal(install.clientIdForName('claude'), 'claudeDesktop');
  assert.equal(install.clientIdForName(''), null);
});

test('detects installs from each client config, and tolerates junk', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'steno-mcp-home-'));
  const opts = { platform: 'darwin', home, env: {} };
  assert.deepEqual(await install.detectClients(opts), {
    claudeDesktop: false, claudeCode: false, codex: false, cursor: false,
  });
  const p = install.clientPaths(opts);
  fs.mkdirSync(path.dirname(p.claudeDesktopConfig), { recursive: true });
  fs.writeFileSync(p.claudeDesktopConfig, '{ broken');
  // An old install-path entry and a new launcher entry both count: the name is what matters.
  fs.writeFileSync(p.claudeCodeConfig, JSON.stringify({
    mcpServers: { steno: { command: '/Applications/Steno.app/Contents/MacOS/Steno', args: ['/x/index.mjs'] } },
  }));
  fs.mkdirSync(path.dirname(p.codexConfig), { recursive: true });
  fs.writeFileSync(p.codexConfig, `model = "x"\n\n[mcp_servers.steno]\ncommand = ${JSON.stringify(MAC.command)}\n`);
  fs.mkdirSync(path.dirname(p.cursorConfig), { recursive: true });
  fs.writeFileSync(p.cursorConfig, JSON.stringify({ mcpServers: { stenography: {} } }));
  assert.deepEqual(await install.detectClients(opts), {
    claudeDesktop: false, claudeCode: true, codex: true, cursor: false,
  });
  fs.writeFileSync(p.cursorConfig, install.cursorMcpJson(MAC));
  assert.equal((await install.detectClients(opts)).cursor, true);
  fs.mkdirSync(path.join(p.claudeDesktopExtensions, 'local.mcpb.steno.steno'), { recursive: true });
  assert.equal((await install.detectClients(opts)).claudeDesktop, true);
});

test('detects the Steno skill at each documented install path', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'steno-skill-home-'));
  const opts = { home, env: {} };
  assert.deepEqual(await install.detectSkills(opts), { claudeCode: false, codex: false });
  const p = install.skillPaths(opts);
  // A folder without SKILL.md (a half-finished copy) is not an install.
  fs.mkdirSync(path.dirname(p.claudeCode[0]), { recursive: true });
  assert.equal((await install.detectSkills(opts)).claudeCode, false);
  fs.writeFileSync(p.claudeCode[0], '---\nname: steno\n---\n');
  assert.deepEqual(await install.detectSkills(opts), { claudeCode: true, codex: false });
  // Codex: either ~/.agents/skills or $CODEX_HOME/skills counts.
  const codexHome = path.join(home, 'codex-home');
  const withCodexHome = { home, env: { CODEX_HOME: codexHome } };
  const codexSkill = install.skillPaths(withCodexHome).codex[1];
  assert.equal(codexSkill, path.join(codexHome, 'skills', 'steno', 'SKILL.md'));
  fs.mkdirSync(path.dirname(codexSkill), { recursive: true });
  fs.writeFileSync(codexSkill, 'x');
  assert.equal((await install.detectSkills(withCodexHome)).codex, true);
  assert.equal((await install.detectSkills(opts)).codex, false);
  fs.mkdirSync(path.dirname(p.codex[0]), { recursive: true });
  fs.writeFileSync(p.codex[0], 'x');
  assert.equal((await install.detectSkills(opts)).codex, true);
  // CLAUDE_CONFIG_DIR moves the Claude Code skills root.
  const moved = { home, env: { CLAUDE_CONFIG_DIR: path.join(home, 'cfg') } };
  assert.equal((await install.detectSkills(moved)).claudeCode, false);
});
