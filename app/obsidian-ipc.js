'use strict';

/**
 * Obsidian vault sync IPC (#413) — the config get/set for the toggle + vault
 * path, a native vault-folder picker, and a conflicts read for the Settings UI.
 * Mirrors the folders-ipc extraction (RFC #327): a single `registerObsidianIpc`
 * main.js calls once. Unlike the pure settings-ipc toggles, the set handlers
 * have a side effect — they refresh the obsidian-sync engine's cached config and
 * kick a one-time backfill when sync goes live — so they live in their own
 * module rather than settings-ipc.js.
 *
 * Injected seams:
 *   - runPythonScript   bundled-backend invoker
 *   - dialog / getMainWindow  native folder picker
 *   - obsidianSync      the engine (registerObsidianSync) for cache + backfill
 */

function registerObsidianIpc({
  ipcMain, runPythonScript, dialog, getMainWindow, obsidianSync, sendDebugLog = () => {},
}) {
  // Read both config values and push them into the engine's cache so the
  // per-note sync hooks never shell Python. Returns the fresh config.
  async function refreshCache() {
    const [s, v] = await Promise.all([
      runPythonScript('simple_recorder.py', ['get-obsidian-sync'], true),
      runPythonScript('simple_recorder.py', ['get-obsidian-vault-path'], true),
    ]);
    const enabled = !!JSON.parse(s.trim()).obsidian_sync_enabled;
    const vaultPath = JSON.parse(v.trim()).obsidian_vault_path || '';
    obsidianSync.setCachedConfig({ enabled, vaultPath });
    return { enabled, vaultPath };
  }

  function maybeBackfill(cfg) {
    if (cfg.enabled && cfg.vaultPath) {
      Promise.resolve(obsidianSync.backfillAll()).catch(() => {});
    }
  }

  ipcMain.handle('get-obsidian-sync', async () => {
    try {
      const r = await runPythonScript('simple_recorder.py', ['get-obsidian-sync'], true);
      return { success: true, ...JSON.parse(r.trim()) };
    } catch (e) { return { success: false, error: e.message }; }
  });

  ipcMain.handle('set-obsidian-sync', async (event, enabled) => {
    try {
      const r = await runPythonScript('simple_recorder.py', ['set-obsidian-sync', enabled.toString()]);
      const data = JSON.parse(r.trim());
      maybeBackfill(await refreshCache());
      return { success: true, ...data };
    } catch (e) { return { success: false, error: e.message }; }
  });

  ipcMain.handle('get-obsidian-vault-path', async () => {
    try {
      const r = await runPythonScript('simple_recorder.py', ['get-obsidian-vault-path'], true);
      return { success: true, ...JSON.parse(r.trim()) };
    } catch (e) { return { success: false, error: e.message }; }
  });

  ipcMain.handle('set-obsidian-vault-path', async (event, vaultPath) => {
    try {
      const args = ['set-obsidian-vault-path'];
      if (vaultPath) args.push(vaultPath); // empty = clear (CLI default '')
      const r = await runPythonScript('simple_recorder.py', args);
      const data = JSON.parse(r.trim());
      maybeBackfill(await refreshCache());
      return { success: true, ...data };
    } catch (e) { return { success: false, error: e.message }; }
  });

  ipcMain.handle('select-obsidian-vault-folder', async () => {
    try {
      const result = await dialog.showOpenDialog(getMainWindow(), {
        properties: ['openDirectory', 'createDirectory'],
        title: 'Choose your Obsidian vault folder',
        buttonLabel: 'Select Folder',
      });
      if (!result.canceled && result.filePaths.length > 0) {
        return { success: true, folderPath: result.filePaths[0] };
      }
      return { success: false, error: 'No folder selected' };
    } catch (e) { return { success: false, error: e.message }; }
  });

  ipcMain.handle('get-obsidian-conflicts', async () => {
    try {
      const idx = obsidianSync.loadIndex();
      return { success: true, conflicts: idx.conflicts || {} };
    } catch (e) { return { success: false, error: e.message }; }
  });
}

module.exports = { registerObsidianIpc };
