'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const launcher = require('./steno-mcp-launcher');

const tmp = (prefix) => fs.mkdtempSync(path.join(os.tmpdir(), prefix));

test('launcher lives in <userData>/bin, .cmd on Windows', () => {
  assert.equal(launcher.launcherPath('/data', 'darwin'), path.join('/data', 'bin', 'steno-mcp'));
  assert.equal(launcher.launcherPath('/data', 'linux'), path.join('/data', 'bin', 'steno-mcp'));
  assert.equal(launcher.launcherPath('/data', 'win32'), path.join('/data', 'bin', 'steno-mcp.cmd'));
});

test('sh launcher quotes paths with spaces and quotes, and execs in Node mode', () => {
  const text = launcher.launcherContent({
    command: "/Users/o'neil/Apps/Steno.app/Contents/MacOS/Steno",
    script: '/Users/o\'neil/Library/Application Support/x/index.mjs',
    platform: 'darwin',
  });
  assert.match(text, /^#!\/bin\/sh\n/);
  assert.match(text, /^ELECTRON_RUN_AS_NODE=1\nexport ELECTRON_RUN_AS_NODE$/m);
  assert.match(
    text,
    /^exec '\/Users\/o'\\''neil\/Apps\/Steno\.app\/Contents\/MacOS\/Steno' '\/Users\/o'\\''neil\/Library\/Application Support\/x\/index\.mjs' "\$@"$/m,
  );
  assert.doesNotMatch(text, /STENOAI_USER_DATA_DIR/);
  const withDir = launcher.launcherContent({ command: '/a', script: '/b', defaultUserDataDir: '/t/My Data', platform: 'linux' });
  assert.match(withDir, /^if \[ -z "\$\{STENOAI_USER_DATA_DIR:-\}" \]; then STENOAI_USER_DATA_DIR='\/t\/My Data'; fi$/m);
});

test('Windows launcher quotes paths, doubles %, and keeps a caller STENOAI_USER_DATA_DIR', () => {
  const text = launcher.launcherContent({
    command: 'C:\\Users\\Ada Lovelace\\AppData\\Local\\Programs\\Steno\\Steno.exe',
    script: 'C:\\Users\\Ada Lovelace\\100%\\resources\\steno-mcp\\server\\index.mjs',
    defaultUserDataDir: 'C:\\Temp\\e2e data',
    platform: 'win32',
  });
  const lines = text.split('\r\n');
  assert.equal(lines[0], '@echo off');
  assert.ok(lines.includes('set "ELECTRON_RUN_AS_NODE=1"'));
  assert.ok(lines.includes('if not defined STENOAI_USER_DATA_DIR set "STENOAI_USER_DATA_DIR=C:\\Temp\\e2e data"'));
  assert.ok(lines.includes(
    '"C:\\Users\\Ada Lovelace\\AppData\\Local\\Programs\\Steno\\Steno.exe" "C:\\Users\\Ada Lovelace\\100%%\\resources\\steno-mcp\\server\\index.mjs" %*',
  ));
  assert.doesNotMatch(text, /[^\r]\n/, 'batch files use CRLF line endings');
});

test('Windows launcher switches to UTF-8 before any line that carries a path', () => {
  const text = launcher.launcherContent({
    command: 'C:\\Users\\Zoë Müller\\AppData\\Local\\Programs\\Steno\\Steno.exe',
    script: 'C:\\Users\\Zoë Müller\\AppData\\Local\\Programs\\Steno\\resources\\steno-mcp\\server\\index.mjs',
    defaultUserDataDir: 'C:\\Users\\Zoë Müller\\データ',
    platform: 'win32',
  });
  const lines = text.split('\r\n');
  assert.equal(lines[0], '@echo off');
  // Quiet on stdout and stderr: the MCP client reads the server's stdio.
  assert.equal(lines[1], 'chcp 65001 >nul 2>nul');
  const firstPathLine = lines.findIndex((l) => /Zoë/.test(l));
  assert.ok(firstPathLine > 1, 'every path line comes after the code-page switch');
  assert.ok(lines.includes('if not defined STENOAI_USER_DATA_DIR set "STENOAI_USER_DATA_DIR=C:\\Users\\Zoë Müller\\データ"'));
  assert.ok(lines.includes(
    '"C:\\Users\\Zoë Müller\\AppData\\Local\\Programs\\Steno\\Steno.exe" "C:\\Users\\Zoë Müller\\AppData\\Local\\Programs\\Steno\\resources\\steno-mcp\\server\\index.mjs" %*',
  ));
  // The bytes on disk are UTF-8, which is what chcp 65001 makes cmd.exe read.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'steno-launcher-utf8-'));
  launcher.ensureLauncher({ userDataDir: dir, command: 'C:\\Zoë\\Steno.exe', script: 'C:\\Zoë\\index.mjs', platform: 'win32' });
  const bytes = fs.readFileSync(path.join(dir, 'bin', 'steno-mcp.cmd'));
  assert.ok(bytes.includes(Buffer.from('Zoë', 'utf8')));
});

test('ensureLauncher writes once, is idempotent, and rewrites when the app moves', () => {
  const dir = tmp('steno-launcher-');
  const first = launcher.ensureLauncher({ userDataDir: dir, command: '/a/Steno', script: '/a/index.mjs', platform: 'darwin' });
  assert.equal(first.written, true);
  assert.equal(first.path, path.join(dir, 'bin', 'steno-mcp'));
  if (process.platform !== 'win32') assert.equal(fs.statSync(first.path).mode & 0o777, 0o755);
  const mtime = fs.statSync(first.path).mtimeMs;
  const again = launcher.ensureLauncher({ userDataDir: dir, command: '/a/Steno', script: '/a/index.mjs', platform: 'darwin' });
  assert.equal(again.written, false);
  assert.equal(fs.statSync(first.path).mtimeMs, mtime);
  const moved = launcher.ensureLauncher({ userDataDir: dir, command: '/b/Steno', script: '/b/index.mjs', platform: 'darwin' });
  assert.equal(moved.written, true);
  assert.match(fs.readFileSync(first.path, 'utf8'), /exec '\/b\/Steno' '\/b\/index\.mjs'/);
  assert.deepEqual(fs.readdirSync(path.join(dir, 'bin')), ['steno-mcp']);
  const win = launcher.ensureLauncher({ userDataDir: dir, command: 'C:\\S.exe', script: 'C:\\i.mjs', platform: 'win32' });
  assert.equal(win.path, path.join(dir, 'bin', 'steno-mcp.cmd'));
  assert.equal(launcher.ensureLauncher({ userDataDir: dir, command: 'C:\\S.exe', script: 'C:\\i.mjs', platform: 'win32' }).written, false);
});

test('the sh launcher runs the recorded command with Node mode and passes args + data dir through', { skip: process.platform === 'win32' }, () => {
  const dir = tmp('steno launcher run ');
  const script = path.join(dir, 'echo env.js');
  fs.writeFileSync(script, 'console.log(JSON.stringify({ node: process.env.ELECTRON_RUN_AS_NODE, data: process.env.STENOAI_USER_DATA_DIR, args: process.argv.slice(2) }));');
  const { path: file } = launcher.ensureLauncher({
    userDataDir: dir, command: process.execPath, script, defaultUserDataDir: '/baked dir', platform: process.platform,
  });
  const env = { ...process.env };
  delete env.STENOAI_USER_DATA_DIR;
  const baked = JSON.parse(spawnSync(file, ['x y'], { env, encoding: 'utf8' }).stdout);
  assert.deepEqual(baked, { node: '1', data: '/baked dir', args: ['x y'] });
  const override = JSON.parse(spawnSync(file, [], { env: { ...env, STENOAI_USER_DATA_DIR: '/caller' }, encoding: 'utf8' }).stdout);
  assert.equal(override.data, '/caller');
});
