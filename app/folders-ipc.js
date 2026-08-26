'use strict';

/**
 * Folders + storage-layout IPC handlers — the folder CRUD/ordering surface plus
 * the three storage-path handlers that own where user data lives (RFC #327
 * groups them as one "storage layout" module). The pilot extraction that
 * establishes the handler-group pattern: a single `registerFoldersIpc(deps)`
 * entry point that main.js calls once, in place, so registration timing and
 * behavior are identical to the inline handlers it replaces (ZERO behavior
 * change).
 *
 * Cross-cutting seams are injected — main.js stays the only place that wires
 * them:
 *   - runPythonScript          the bundled-backend invoker (backend-cli seam)
 *   - dialog                   electron dialog (native folder picker)
 *   - getMainWindow            accessor for the modal parent window
 *   - getUserDataDir           per-OS default data dir (storage-path display)
 *   - validateMeetingFilePath  symlink-safe containment check for meeting paths
 *   - setCachedCustomStoragePath  updates main.js's storage-path cache that the
 *                              file-validation readers consult
 */

function registerFoldersIpc({
  ipcMain,
  runPythonScript,
  dialog,
  getMainWindow,
  getUserDataDir,
  validateMeetingFilePath,
  setCachedCustomStoragePath,
  // Optional (#413): notified with the canonical summary path after a note's
  // folder membership changes, so a downstream mirror (Obsidian sync) can react.
  onNoteFoldersChanged = () => {},
}) {
  // Storage path handlers
  ipcMain.handle('get-storage-path', async () => {
    try {
      const result = await runPythonScript('simple_recorder.py', ['get-storage-path'], true);
      const jsonData = JSON.parse(result.trim());
      // Python only returns the user's custom path (empty string when not set).
      // Augment with the platform default so the renderer can show "where your
      // data actually lives" without hardcoding the path. custom_path mirrors
      // storage_path but is null when empty for cleaner conditionals.
      const customPath = jsonData.storage_path && jsonData.storage_path.trim()
        ? jsonData.storage_path
        : null;
      // getUserDataDir() so the "where your data lives" path shown in Settings is
      // correct on Windows (%APPDATA%/stenoai), not a macOS literal. It already
      // resolves to the per-OS .../stenoai dir.
      const defaultPath = getUserDataDir();
      return {
        success: true,
        storage_path: customPath || defaultPath,
        custom_path: customPath,
        default_path: defaultPath,
      };
    } catch (error) {
      return { success: false, error: error.message };
    }
  });

  ipcMain.handle('set-storage-path', async (event, storagePath) => {
    try {
      const args = ['set-storage-path'];
      if (storagePath) {
        args.push(storagePath);
      }
      const result = await runPythonScript('simple_recorder.py', args);
      // Update cached custom path for file validation
      setCachedCustomStoragePath(storagePath || null);
      const jsonMatch = result.match(/\{.*\}/s);
      if (jsonMatch) {
        return JSON.parse(jsonMatch[0]);
      }
      return { success: true, storage_path: storagePath };
    } catch (error) {
      return { success: false, error: error.message };
    }
  });

  ipcMain.handle('select-storage-folder', async () => {
    try {
      const result = await dialog.showOpenDialog(getMainWindow(), {
        properties: ['openDirectory', 'createDirectory'],
        title: 'Choose storage location for Steno data',
        buttonLabel: 'Select Folder'
      });

      if (!result.canceled && result.filePaths.length > 0) {
        return { success: true, folderPath: result.filePaths[0] };
      }
      return { success: false, error: 'No folder selected' };
    } catch (error) {
      return { success: false, error: error.message };
    }
  });

  // Folder management handlers
  ipcMain.handle('list-folders', async () => {
    try {
      const result = await runPythonScript('simple_recorder.py', ['list-folders'], true);
      return { success: true, ...JSON.parse(result.trim()) };
    } catch (error) {
      return { success: false, error: error.message };
    }
  });

  ipcMain.handle('create-folder', async (event, name, color) => {
    try {
      const args = ['create-folder', name];
      if (color) args.push('--color', color);
      const result = await runPythonScript('simple_recorder.py', args);
      const jsonMatch = result.match(/\{.*\}/s);
      return jsonMatch ? JSON.parse(jsonMatch[0]) : { success: true };
    } catch (error) {
      return { success: false, error: error.message };
    }
  });

  ipcMain.handle('rename-folder', async (event, folderId, name) => {
    try {
      const result = await runPythonScript('simple_recorder.py', ['rename-folder', folderId, name]);
      const jsonMatch = result.match(/\{.*\}/s);
      return jsonMatch ? JSON.parse(jsonMatch[0]) : { success: true };
    } catch (error) {
      return { success: false, error: error.message };
    }
  });

  ipcMain.handle('update-folder-icon', async (event, folderId, icon) => {
    try {
      const result = await runPythonScript('simple_recorder.py', ['update-folder-icon', folderId, icon]);
      const jsonMatch = result.match(/\{.*\}/s);
      return jsonMatch ? JSON.parse(jsonMatch[0]) : { success: true };
    } catch (error) {
      return { success: false, error: error.message };
    }
  });

  ipcMain.handle('delete-folder', async (event, folderId) => {
    try {
      const result = await runPythonScript('simple_recorder.py', ['delete-folder', folderId]);
      const jsonMatch = result.match(/\{.*\}/s);
      return jsonMatch ? JSON.parse(jsonMatch[0]) : { success: true };
    } catch (error) {
      return { success: false, error: error.message };
    }
  });

  ipcMain.handle('reorder-folders', async (event, folderIds) => {
    try {
      const args = ['reorder-folders', ...folderIds];
      const result = await runPythonScript('simple_recorder.py', args);
      const jsonMatch = result.match(/\{.*\}/s);
      return jsonMatch ? JSON.parse(jsonMatch[0]) : { success: true };
    } catch (error) {
      return { success: false, error: error.message };
    }
  });

  ipcMain.handle('add-meeting-to-folder', async (event, summaryFile, folderId) => {
    try {
      // Security: the renderer is untrusted, so containment-check the summary path
      // (symlink-safe, output/ only) and pass the canonical realPath to the backend.
      const validated = await validateMeetingFilePath(summaryFile);
      if (validated.error) {
        return { success: false, error: validated.error };
      }
      const result = await runPythonScript('simple_recorder.py', ['add-meeting-to-folder', validated.realPath, folderId]);
      const jsonMatch = result.match(/\{.*\}/s);
      const parsed = jsonMatch ? JSON.parse(jsonMatch[0]) : { success: true };
      if (parsed.success !== false) onNoteFoldersChanged(validated.realPath);
      return parsed;
    } catch (error) {
      return { success: false, error: error.message };
    }
  });

  ipcMain.handle('remove-meeting-from-folder', async (event, summaryFile, folderId) => {
    try {
      // Security: the renderer is untrusted, so containment-check the summary path
      // (symlink-safe, output/ only) and pass the canonical realPath to the backend.
      const validated = await validateMeetingFilePath(summaryFile);
      if (validated.error) {
        return { success: false, error: validated.error };
      }
      const result = await runPythonScript('simple_recorder.py', ['remove-meeting-from-folder', validated.realPath, folderId]);
      const jsonMatch = result.match(/\{.*\}/s);
      const parsed = jsonMatch ? JSON.parse(jsonMatch[0]) : { success: true };
      if (parsed.success !== false) onNoteFoldersChanged(validated.realPath);
      return parsed;
    } catch (error) {
      return { success: false, error: error.message };
    }
  });

  ipcMain.handle('set-folder-template', async (event, folderId, templateId) => {
    try {
      if (!folderId || typeof folderId !== 'string' || !folderId.trim()) {
        return { success: false, error: 'Invalid folder ID' };
      }
      if (templateId !== null && templateId !== undefined && typeof templateId !== 'string') {
        return { success: false, error: 'Invalid template ID' };
      }
      const trimmedTemplate = typeof templateId === 'string' ? templateId.trim() : '';
      const templateArg = trimmedTemplate && trimmedTemplate !== 'none' ? trimmedTemplate : 'none';
      const result = await runPythonScript('simple_recorder.py', ['set-folder-template', folderId.trim(), templateArg]);
      const jsonMatch = result.match(/\{.*\}/s);
      return jsonMatch ? JSON.parse(jsonMatch[0]) : { success: true };
    } catch (error) {
      return { success: false, error: error.message };
    }
  });

  ipcMain.handle('set-folder-recurring', async (event, folderId, titles) => {
    try {
      if (!folderId || typeof folderId !== 'string' || !folderId.trim()) {
        return { success: false, error: 'Invalid folder ID' };
      }
      if (!Array.isArray(titles)) {
        return { success: false, error: 'Invalid titles: expected array' };
      }
      for (const t of titles) {
        if (typeof t !== 'string') {
          return { success: false, error: 'Invalid titles: expected array of strings' };
        }
      }
      const cleanTitles = titles.map((t) => t.trim()).filter(Boolean);
      const args = ['set-folder-recurring', folderId.trim()];
      if (cleanTitles.length === 0) {
        args.push('--clear');
      } else {
        for (const title of cleanTitles) {
          args.push('--title', title);
        }
      }
      const result = await runPythonScript('simple_recorder.py', args);
      const jsonMatch = result.match(/\{.*\}/s);
      return jsonMatch ? JSON.parse(jsonMatch[0]) : { success: true };
    } catch (error) {
      return { success: false, error: error.message };
    }
  });
}

module.exports = { registerFoldersIpc };
