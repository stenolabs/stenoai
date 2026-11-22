'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const install = require('./steno-mcp-install');

const MAC = {
  command: '/Applications/Steno.app/Contents/MacOS/Steno',
  args: ['/Applications/Steno.app/Contents/Resources/steno-mcp/server/index.mjs'],
  env: { ELECTRON_RUN_AS_NODE: '1' },
};
const WIN = {
  command: 'C:\\Users\\Ada Lovelace\\AppData\\Local\\Programs\\Steno\\Steno.exe',
  args: ['C:\\Users\\Ada Lovelace\\AppData\\Local\\Programs\\Steno\\resources\\steno-mcp\\server\\index.mjs'],
  env: { ELECTRON_RUN_AS_NODE: '1' },
};

test('packaged launch spec points into resources, dev at the source', () => {
  const packaged = install.getLaunchSpec({
    isPackaged: true, execPath: '/x/Steno', resourcesPath: '/x/Resources', appDir: '/src/app',
  });
  assert.equal(packaged.command, '/x/Steno');
  assert.deepEqual(packaged.args, [path.join('/x/Resources', 'steno-mcp', 'server', 'index.mjs')]);
  assert.equal(packaged.mcpbPath, path.join('/x/Resources', 'steno-mcp', 'Steno.mcpb'));
  assert.deepEqual(packaged.env, { ELECTRON_RUN_AS_NODE: '1' });
  const dev = install.getLaunchSpec({ isPackaged: false, execPath: '/e', resourcesPath: '/r', appDir: '/src/app' });
  assert.deepEqual(dev.args, [path.join('/src/app', 'steno-mcp', 'index.mjs')]);
});

test('Claude Code command quotes per platform', () => {
  assert.equal(
    install.claudeCodeCommand(MAC, 'darwin'),
    'claude mcp add --scope user --env ELECTRON_RUN_AS_NODE=1 steno -- /Applications/Steno.app/Contents/MacOS/Steno /Applications/Steno.app/Contents/Resources/steno-mcp/server/index.mjs',
  );
  const spaced = { ...MAC, command: "/Users/o'neil/Apps/Steno.app/Contents/MacOS/Steno" };
  assert.match(install.claudeCodeCommand(spaced, 'darwin'), / -- '\/Users\/o'\\''neil\/Apps\/Steno.app\/Contents\/MacOS\/Steno' /);
  assert.match(install.claudeCodeCommand(WIN, 'win32'), / -- "C:\\Users\\Ada Lovelace\\.*Steno\.exe" "C:\\Users\\Ada Lovelace\\.*index\.mjs"$/);
});

test('Codex TOML escapes Windows paths', () => {
  const toml = install.codexToml(WIN);
  assert.match(toml, /^\[mcp_servers\.steno\]$/m);
  assert.match(toml, /^command = "C:\\\\Users\\\\Ada Lovelace\\\\AppData/m);
  assert.match(toml, /^env = \{ ELECTRON_RUN_AS_NODE = "1" \}$/m);
});

test('Cursor link carries the bare server entry, base64 encoded', () => {
  const link = new URL(install.cursorDeepLink(MAC));
  assert.equal(link.protocol, 'cursor:');
  assert.equal(link.host, 'anysphere.cursor-deeplink');
  assert.equal(link.pathname, '/mcp/install');
  assert.equal(link.searchParams.get('name'), 'steno');
  const config = JSON.parse(Buffer.from(link.searchParams.get('config'), 'base64').toString('utf8'));
  assert.deepEqual(config, { command: MAC.command, args: MAC.args, env: MAC.env });
  assert.deepEqual(JSON.parse(install.cursorMcpJson(MAC)).mcpServers.steno, config);
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
  fs.writeFileSync(p.claudeCodeConfig, JSON.stringify({ mcpServers: { steno: {} } }));
  fs.mkdirSync(path.dirname(p.codexConfig), { recursive: true });
  fs.writeFileSync(p.codexConfig, 'model = "x"\n\n[mcp_servers.steno]\ncommand = "a"\n');
  fs.mkdirSync(path.dirname(p.cursorConfig), { recursive: true });
  fs.writeFileSync(p.cursorConfig, JSON.stringify({ mcpServers: { stenography: {} } }));
  assert.deepEqual(await install.detectClients(opts), {
    claudeDesktop: false, claudeCode: true, codex: true, cursor: false,
  });
  fs.mkdirSync(path.join(p.claudeDesktopExtensions, 'local.mcpb.steno.steno'), { recursive: true });
  assert.equal((await install.detectClients(opts)).claudeDesktop, true);
});
