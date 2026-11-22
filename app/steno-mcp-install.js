'use strict';

// Install surfaces for the Steno MCP server (the Connect page): how an AI
// assistant launches the server, the copyable setup snippets for each client,
// and a cheap "is it already installed?" check that only reads each client's
// own config file and reports a boolean.
//
// Launch: Claude Desktop installs Steno.mcpb and runs it with its own Node.
// Every other client runs the server with Steno's own executable in Node mode
// (ELECTRON_RUN_AS_NODE=1), so nothing else needs to be installed. Packaged, the
// server lives outside the asar in resources/steno-mcp (extraResources); in
// development it runs from source.

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const SERVER_KEY = 'steno';
const CURSOR_DEEPLINK = 'cursor://anysphere.cursor-deeplink/mcp/install';
// ~/.claude.json grows with project history; never parse an absurd one.
const MAX_CLIENT_CONFIG_BYTES = 32 * 1024 * 1024;

function getLaunchSpec({ isPackaged, execPath, resourcesPath, appDir }) {
  const script = isPackaged
    ? path.join(resourcesPath, 'steno-mcp', 'server', 'index.mjs')
    : path.join(appDir, 'steno-mcp', 'index.mjs');
  const mcpbPath = isPackaged
    ? path.join(resourcesPath, 'steno-mcp', 'Steno.mcpb')
    : path.join(appDir, 'steno-mcp', 'dist', 'Steno.mcpb');
  return {
    command: execPath,
    args: [script],
    env: { ELECTRON_RUN_AS_NODE: '1' },
    mcpbPath,
  };
}

function quotePosix(s) {
  return /^[\w@%+=:,./-]+$/.test(s) ? s : `'${s.replace(/'/g, `'\\''`)}'`;
}

// cmd.exe and PowerShell both accept a double-quoted path; Windows paths
// cannot contain a double quote, so no escaping is needed beyond the quotes.
function quoteWindows(s) {
  return /^[\w@%+=:,./\\-]+$/.test(s) ? s : `"${s}"`;
}

function claudeCodeCommand(spec, platform = process.platform) {
  const q = platform === 'win32' ? quoteWindows : quotePosix;
  const env = Object.entries(spec.env).map(([k, v]) => `--env ${k}=${v}`);
  return ['claude mcp add --scope user', ...env, SERVER_KEY, '--', q(spec.command), ...spec.args.map(q)].join(' ');
}

// JSON string escaping is valid TOML basic-string escaping for paths.
const tomlString = (s) => JSON.stringify(s);

function codexToml(spec) {
  const env = Object.entries(spec.env).map(([k, v]) => `${k} = ${tomlString(v)}`).join(', ');
  return [
    `[mcp_servers.${SERVER_KEY}]`,
    `command = ${tomlString(spec.command)}`,
    `args = [${spec.args.map(tomlString).join(', ')}]`,
    `env = { ${env} }`,
  ].join('\n');
}

function serverEntry(spec) {
  return { command: spec.command, args: spec.args, env: spec.env };
}

function cursorMcpJson(spec) {
  return JSON.stringify({ mcpServers: { [SERVER_KEY]: serverEntry(spec) } }, null, 2);
}

// Cursor's install link carries the bare server entry (no name wrapper),
// JSON-stringified then base64-encoded, with the name as its own parameter.
function cursorDeepLink(spec) {
  const config = Buffer.from(JSON.stringify(serverEntry(spec)), 'utf8').toString('base64');
  return `${CURSOR_DEEPLINK}?name=${encodeURIComponent(SERVER_KEY)}&config=${encodeURIComponent(config)}`;
}

function snippets(spec, platform = process.platform) {
  return {
    claudeCode: claudeCodeCommand(spec, platform),
    codexToml: codexToml(spec),
    cursorJson: cursorMcpJson(spec),
  };
}

// ---------------------------------------------------------------------------
// Installed-state detection. Each check reads one known file and answers
// "does it mention a steno server?"; any error reads as not installed.
// ---------------------------------------------------------------------------

function clientPaths({ platform = process.platform, home = os.homedir(), env = process.env } = {}) {
  let claudeDesktopDir;
  if (platform === 'darwin') claudeDesktopDir = path.join(home, 'Library', 'Application Support', 'Claude');
  else if (platform === 'win32') claudeDesktopDir = path.join(env.APPDATA || path.join(home, 'AppData', 'Roaming'), 'Claude');
  else claudeDesktopDir = path.join(env.XDG_CONFIG_HOME || path.join(home, '.config'), 'Claude');
  return {
    claudeDesktopConfig: path.join(claudeDesktopDir, 'claude_desktop_config.json'),
    claudeDesktopExtensions: path.join(claudeDesktopDir, 'Claude Extensions'),
    claudeCodeConfig: path.join(home, '.claude.json'),
    codexConfig: path.join(env.CODEX_HOME || path.join(home, '.codex'), 'config.toml'),
    cursorConfig: path.join(home, '.cursor', 'mcp.json'),
  };
}

async function readSmall(file) {
  const st = await fs.promises.stat(file);
  if (!st.isFile() || st.size > MAX_CLIENT_CONFIG_BYTES) return null;
  return fs.promises.readFile(file, 'utf8');
}

async function jsonHasServer(file) {
  try {
    const text = await readSmall(file);
    if (!text) return false;
    const servers = JSON.parse(text)?.mcpServers;
    return !!servers && typeof servers === 'object' && Object.hasOwn(servers, SERVER_KEY);
  } catch {
    return false;
  }
}

async function claudeExtensionInstalled(dir) {
  try {
    const entries = await fs.promises.readdir(dir);
    // Locally installed bundles are named after the manifest's author + name.
    return entries.some((name) => /(^|[.-])steno($|[.-])/i.test(name));
  } catch {
    return false;
  }
}

async function codexHasServer(file) {
  try {
    const text = await readSmall(file);
    return !!text && /^\s*\[mcp_servers\.(steno|"steno")\]\s*$/m.test(text);
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Steno skill detection (Connect → Coding agents). The install prompts in
// renderer/src/lib/agentSkills.ts (and docs/features/agents.mdx) put the
// skill folder at these paths; a SKILL.md file there counts as installed.
//   Claude Code: ~/.claude/skills/steno (or $CLAUDE_CONFIG_DIR/skills/steno)
//   Codex: ~/.agents/skills/steno (the documented personal location) or
//          $CODEX_HOME/skills/steno (~/.codex/skills, where $skill-installer
//          writes)
// One stat per path, no reads.
// ---------------------------------------------------------------------------

const SKILL_DIR = 'steno';

function skillPaths({ home = os.homedir(), env = process.env } = {}) {
  return {
    claudeCode: [path.join(env.CLAUDE_CONFIG_DIR || path.join(home, '.claude'), 'skills', SKILL_DIR, 'SKILL.md')],
    codex: [
      path.join(home, '.agents', 'skills', SKILL_DIR, 'SKILL.md'),
      path.join(env.CODEX_HOME || path.join(home, '.codex'), 'skills', SKILL_DIR, 'SKILL.md'),
    ],
  };
}

async function isFile(file) {
  try {
    return (await fs.promises.stat(file)).isFile();
  } catch {
    return false;
  }
}

async function anyFile(files) {
  const found = await Promise.all(files.map(isFile));
  return found.includes(true);
}

async function detectSkills(opts = {}) {
  const p = skillPaths(opts);
  const [claudeCode, codex] = await Promise.all([anyFile(p.claudeCode), anyFile(p.codex)]);
  return { claudeCode, codex };
}

async function detectClients(opts = {}) {
  const p = clientPaths(opts);
  const [desktopConfig, desktopExtension, claudeCode, codex, cursor] = await Promise.all([
    jsonHasServer(p.claudeDesktopConfig),
    claudeExtensionInstalled(p.claudeDesktopExtensions),
    jsonHasServer(p.claudeCodeConfig),
    codexHasServer(p.codexConfig),
    jsonHasServer(p.cursorConfig),
  ]);
  return { claudeDesktop: desktopConfig || desktopExtension, claudeCode, codex, cursor };
}

module.exports = {
  SERVER_KEY,
  getLaunchSpec,
  claudeCodeCommand,
  codexToml,
  cursorMcpJson,
  cursorDeepLink,
  snippets,
  clientPaths,
  detectClients,
  skillPaths,
  detectSkills,
};
