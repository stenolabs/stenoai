'use strict';

/**
 * Connect page IPC: install surfaces + scope settings for the Steno MCP server
 * (app/steno-mcp). Registered once from main.js, like obsidian-ipc.
 *
 * The scope settings (folder allowlist, exclude transcripts) live in
 * config.json behind the Python config (get/set-mcp-settings) so the truth
 * stays in one place; the server reads the same keys and enforces them.
 *
 * Nothing here takes a path or URL from the renderer: the .mcpb path and the
 * Cursor link are built in this process from the launch spec.
 */

const fs = require('node:fs');
const install = require('./steno-mcp-install');

function registerStenoMcpIpc({ ipcMain, runPythonScript, shell, launchSpec, platform = process.platform }) {
  const spec = () => launchSpec();

  ipcMain.handle('connect-get-info', async () => {
    try {
      const s = spec();
      const clients = await install.detectClients();
      return {
        success: true,
        serverAvailable: fs.existsSync(s.args[0]),
        claudeBundleAvailable: fs.existsSync(s.mcpbPath),
        snippets: install.snippets(s, platform),
        launch: { command: s.command, args: s.args, env: s.env },
        clients,
      };
    } catch (e) {
      return { success: false, error: e.message };
    }
  });

  ipcMain.handle('connect-get-settings', async () => {
    try {
      const r = await runPythonScript('simple_recorder.py', ['get-mcp-settings'], true);
      const data = JSON.parse(r.trim());
      return {
        success: true,
        folderAllowlist: Array.isArray(data.mcp_folder_allowlist) ? data.mcp_folder_allowlist : null,
        excludeTranscripts: data.mcp_exclude_transcripts === true,
      };
    } catch (e) {
      return { success: false, error: e.message };
    }
  });

  ipcMain.handle('connect-set-settings', async (_event, patch) => {
    try {
      if (!patch || typeof patch !== 'object') return { success: false, error: 'invalid settings' };
      const args = ['set-mcp-settings'];
      if (Object.hasOwn(patch, 'folderAllowlist')) {
        const list = patch.folderAllowlist;
        if (list !== null && !(Array.isArray(list) && list.every((id) => typeof id === 'string'))) {
          return { success: false, error: 'invalid folder list' };
        }
        args.push('--folders', list === null ? 'all' : JSON.stringify(list));
      }
      if (Object.hasOwn(patch, 'excludeTranscripts')) {
        if (typeof patch.excludeTranscripts !== 'boolean') {
          return { success: false, error: 'invalid transcripts setting' };
        }
        args.push('--exclude-transcripts', String(patch.excludeTranscripts));
      }
      if (args.length === 1) return { success: false, error: 'nothing to change' };
      const r = await runPythonScript('simple_recorder.py', args);
      const data = JSON.parse(r.trim());
      if (!data.success) return { success: false, error: data.error || 'Failed to save' };
      return {
        success: true,
        folderAllowlist: Array.isArray(data.mcp_folder_allowlist) ? data.mcp_folder_allowlist : null,
        excludeTranscripts: data.mcp_exclude_transcripts === true,
      };
    } catch (e) {
      return { success: false, error: e.message };
    }
  });

  // Opens Steno.mcpb with the OS handler; Claude Desktop registers the type
  // and shows its install dialog.
  ipcMain.handle('connect-open-claude-desktop', async () => {
    try {
      const { mcpbPath } = spec();
      if (!fs.existsSync(mcpbPath)) return { success: false, error: 'bundle-missing' };
      const err = await shell.openPath(mcpbPath);
      return err ? { success: false, error: err } : { success: true };
    } catch (e) {
      return { success: false, error: e.message };
    }
  });

  ipcMain.handle('connect-open-cursor', async () => {
    try {
      await shell.openExternal(install.cursorDeepLink(spec()));
      return { success: true };
    } catch (e) {
      return { success: false, error: e.message };
    }
  });
}

module.exports = { registerStenoMcpIpc };
