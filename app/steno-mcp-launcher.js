'use strict';

// A stable launcher for the Steno MCP server, written by the app at startup.
//
// The MCP configs Claude Code, Codex and Cursor store need a command that keeps
// working when Steno moves, updates or runs from a dev checkout. So instead of
// pointing them at the app's install path, they point at this small script in
// the user-data dir, which Steno rewrites (only when its content changes) to
// whatever executable + server script the running app has:
//
//   macOS / Linux: <userData>/bin/steno-mcp       (sh, mode 755)
//   Windows:       <userData>\bin\steno-mcp.cmd
//
// The script runs Steno's own executable in Node mode (ELECTRON_RUN_AS_NODE=1).
// STENOAI_USER_DATA_DIR passes through from the caller's environment; when the
// app itself runs with one (tests), that dir becomes the launcher's default.

const fs = require('node:fs');
const path = require('node:path');

const LAUNCHER_NAME = 'steno-mcp';

function launcherPath(userDataDir, platform = process.platform) {
  const file = platform === 'win32' ? `${LAUNCHER_NAME}.cmd` : LAUNCHER_NAME;
  return path.join(userDataDir, 'bin', file);
}

// Always single-quote: the only character that needs care inside is ' itself.
function shQuote(s) {
  return `'${String(s).replace(/'/g, `'\\''`)}'`;
}

// Batch files expand %VAR% even inside quotes, so a literal % is doubled.
// Windows paths cannot contain a double quote; strip one defensively.
function cmdQuote(s) {
  return `"${String(s).replace(/"/g, '').replace(/%/g, '%%')}"`;
}
function cmdSetValue(s) {
  return String(s).replace(/"/g, '').replace(/%/g, '%%');
}

/**
 * The launcher's text for one platform. `command` + `script` are the current
 * app's executable and MCP server entry; `defaultUserDataDir` is baked in only
 * when the app runs with STENOAI_USER_DATA_DIR set.
 */
function launcherContent({ command, script, defaultUserDataDir = null, platform = process.platform }) {
  if (platform === 'win32') {
    return [
      '@echo off',
      'rem Steno MCP launcher. Written by Steno; rewritten when Steno moves or updates.',
      'setlocal',
      'set "ELECTRON_RUN_AS_NODE=1"',
      ...(defaultUserDataDir
        ? [`if not defined STENOAI_USER_DATA_DIR set "STENOAI_USER_DATA_DIR=${cmdSetValue(defaultUserDataDir)}"`]
        : []),
      `${cmdQuote(command)} ${cmdQuote(script)} %*`,
      '',
    ].join('\r\n');
  }
  return [
    '#!/bin/sh',
    '# Steno MCP launcher. Written by Steno; rewritten when Steno moves or updates.',
    'ELECTRON_RUN_AS_NODE=1',
    'export ELECTRON_RUN_AS_NODE',
    ...(defaultUserDataDir
      ? [
        `if [ -z "\${STENOAI_USER_DATA_DIR:-}" ]; then STENOAI_USER_DATA_DIR=${shQuote(defaultUserDataDir)}; fi`,
        'export STENOAI_USER_DATA_DIR',
      ]
      : []),
    `exec ${shQuote(command)} ${shQuote(script)} "$@"`,
    '',
  ].join('\n');
}

/**
 * Write the launcher if it is missing or out of date. Idempotent: an
 * unchanged launcher is not rewritten. Returns { path, written }.
 */
function ensureLauncher({ userDataDir, command, script, defaultUserDataDir = null, platform = process.platform, fsImpl = fs }) {
  const file = launcherPath(userDataDir, platform);
  const content = launcherContent({ command, script, defaultUserDataDir, platform });
  let current = null;
  try {
    current = fsImpl.readFileSync(file, 'utf8');
  } catch {
    current = null;
  }
  const mode = 0o755;
  if (current === content) {
    if (platform !== 'win32') {
      try {
        if ((fsImpl.statSync(file).mode & 0o777) !== mode) fsImpl.chmodSync(file, mode);
      } catch {
        // Best effort: the content is right; the next start retries.
      }
    }
    return { path: file, written: false };
  }
  fsImpl.mkdirSync(path.dirname(file), { recursive: true });
  // Write beside, then rename, so a client launching mid-write never runs half a script.
  const tmp = `${file}.${process.pid}.tmp`;
  fsImpl.writeFileSync(tmp, content, { mode });
  if (platform !== 'win32') fsImpl.chmodSync(tmp, mode);
  fsImpl.renameSync(tmp, file);
  return { path: file, written: true };
}

module.exports = { LAUNCHER_NAME, launcherPath, launcherContent, ensureLauncher };
