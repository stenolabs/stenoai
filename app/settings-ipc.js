'use strict';

/**
 * Settings-toggle IPC handlers (RFC #327 Phase 2.2) — the self-contained config
 * get/set toggles that are pure backend passthrough: each handler just shells a
 * `simple_recorder.py` config subcommand and returns the parsed result. Like the
 * Folders pilot, a single `registerSettingsIpc(deps)` entry point that main.js
 * calls once, in place, so registration timing + behavior are identical to the
 * inline handlers this replaces (ZERO behavior change).
 *
 * Scope is deliberately the pure toggles only. Settings-shaped handlers that
 * reach into another domain stay in main.js until that domain's own extraction:
 *   - notifications / launch-on-login  → telemetry identity (Phase 2.5)
 *   - transcription-engine / whisper-model → trackEvent + models (Phase 2.3)
 *   - auto-detect-meetings → mic-monitor (Phase 2.7)
 *   - premeeting-notifications → calendar scheduler (Phase 2.8)
 *   - dock-icon / menu-bar-icon → tray/window composition root (stay in main.js)
 *
 * Cross-cutting seams are injected — main.js stays the only place that wires
 * them:
 *   - runPythonScript  the bundled-backend invoker (backend-cli seam)
 *   - sendDebugLog     the debug-panel log sink (debug-log seam)
 *   - onLanguageChanged  post-persistence live ASR restart hook (main owns sidecars)
 */

function registerSettingsIpc({
  ipcMain,
  runPythonScript,
  sendDebugLog,
  onLanguageChanged = null,
}) {
  ipcMain.handle('get-keep-recordings', async () => {
    try {
      const result = await runPythonScript('simple_recorder.py', ['get-keep-recordings'], true);
      const jsonData = JSON.parse(result.trim());
      return { success: true, ...jsonData };
    } catch (e) { return { success: false, error: e.message }; }
  });

  ipcMain.handle('set-keep-recordings', async (event, enabled) => {
    try {
      const result = await runPythonScript('simple_recorder.py', ['set-keep-recordings', enabled.toString()]);
      const jsonData = JSON.parse(result.trim());
      return { success: true, ...jsonData };
    } catch (e) { return { success: false, error: e.message }; }
  });

  ipcMain.handle('get-auto-summarize', async () => {
    try {
      const result = await runPythonScript('simple_recorder.py', ['get-auto-summarize'], true);
      const jsonData = JSON.parse(result.trim());
      return { success: true, ...jsonData };
    } catch (e) { return { success: false, error: e.message }; }
  });

  ipcMain.handle('set-auto-summarize', async (event, enabled) => {
    try {
      const result = await runPythonScript('simple_recorder.py', ['set-auto-summarize', enabled.toString()]);
      const jsonData = JSON.parse(result.trim());
      return { success: true, ...jsonData };
    } catch (e) { return { success: false, error: e.message }; }
  });

  ipcMain.handle('get-auto-install-when-idle', async () => {
    try {
      const result = await runPythonScript('simple_recorder.py', ['get-auto-install-when-idle'], true);
      const jsonData = JSON.parse(result.trim());
      return { success: true, ...jsonData };
    } catch (e) { return { success: false, error: e.message }; }
  });

  ipcMain.handle('set-auto-install-when-idle', async (event, enabled) => {
    try {
      const result = await runPythonScript('simple_recorder.py', ['set-auto-install-when-idle', enabled.toString()]);
      const jsonData = JSON.parse(result.trim());
      return { success: true, ...jsonData };
    } catch (e) { return { success: false, error: e.message }; }
  });

  ipcMain.handle('get-identity-matching-enabled', async () => {
    try {
      const result = await runPythonScript('simple_recorder.py', ['get-identity-matching-enabled'], true);
      const jsonData = JSON.parse(result.trim());
      return { success: true, ...jsonData };
    } catch (e) { return { success: false, error: e.message }; }
  });

  ipcMain.handle('set-identity-matching-enabled', async (event, enabled) => {
    try {
      const result = await runPythonScript('simple_recorder.py', ['set-identity-matching-enabled', enabled.toString()]);
      const jsonData = JSON.parse(result.trim());
      return { success: true, ...jsonData };
    } catch (e) { return { success: false, error: e.message }; }
  });

  ipcMain.handle('get-silence-auto-stop', async () => {
    try {
      const result = await runPythonScript('simple_recorder.py', ['get-silence-auto-stop'], true);
      const jsonData = JSON.parse(result.trim());
      return { success: true, ...jsonData };
    } catch (e) { return { success: false, error: e.message }; }
  });

  ipcMain.handle('set-silence-auto-stop-enabled', async (_event, enabled) => {
    try {
      const result = await runPythonScript(
        'simple_recorder.py',
        ['set-silence-auto-stop-enabled', enabled ? 'True' : 'False']
      );
      const jsonData = JSON.parse(result.trim());
      return jsonData;
    } catch (e) { return { success: false, error: e.message }; }
  });

  ipcMain.handle('set-silence-auto-stop-minutes', async (_event, minutes) => {
    try {
      const result = await runPythonScript(
        'simple_recorder.py',
        ['set-silence-auto-stop-minutes', String(minutes)]
      );
      const jsonData = JSON.parse(result.trim());
      return jsonData;
    } catch (e) { return { success: false, error: e.message }; }
  });

  ipcMain.handle('get-privacy-notice-seen', async () => {
    try {
      const result = await runPythonScript('simple_recorder.py', ['get-privacy-notice-seen']);
      const jsonData = JSON.parse(result);
      return {
        success: true,
        privacy_notice_seen: jsonData.privacy_notice_seen
      };
    } catch (error) {
      sendDebugLog(`Error getting privacy notice state: ${error.message}`);
      return { success: false, error: error.message };
    }
  });

  ipcMain.handle('set-privacy-notice-seen', async () => {
    try {
      const result = await runPythonScript('simple_recorder.py', ['set-privacy-notice-seen']);
      const jsonData = JSON.parse(result);
      return jsonData;
    } catch (error) {
      sendDebugLog(`Error marking privacy notice seen: ${error.message}`);
      return { success: false, error: error.message };
    }
  });

  ipcMain.handle('get-system-audio', async () => {
    try {
      const result = await runPythonScript('simple_recorder.py', ['get-system-audio'], true);
      const jsonData = JSON.parse(result);
      return { success: true, ...jsonData };
    } catch (error) {
      sendDebugLog(`Error getting system audio setting: ${error.message}`);
      return { success: false, error: error.message };
    }
  });

  ipcMain.handle('set-system-audio', async (event, enabled) => {
    try {
      sendDebugLog(`Setting system audio to: ${enabled}`);
      const result = await runPythonScript('simple_recorder.py', ['set-system-audio', enabled ? 'True' : 'False']);
      const jsonMatch = result.match(/\{.*\}/s);
      if (jsonMatch) {
        return JSON.parse(jsonMatch[0]);
      }
      return { success: true, system_audio_enabled: enabled };
    } catch (error) {
      sendDebugLog(`Error setting system audio: ${error.message}`);
      return { success: false, error: error.message };
    }
  });

  ipcMain.handle('get-language', async () => {
    try {
      const result = await runPythonScript('simple_recorder.py', ['get-language'], true);
      const jsonData = JSON.parse(result);
      return { success: true, ...jsonData };
    } catch (error) {
      sendDebugLog(`Error getting language setting: ${error.message}`);
      return { success: false, error: error.message };
    }
  });

  ipcMain.handle('set-language', async (event, languageCode) => {
    try {
      sendDebugLog(`Setting language to: ${languageCode}`);
      const result = await runPythonScript('simple_recorder.py', ['set-language', languageCode]);
      const jsonMatch = result.match(/\{.*\}/s);
      const parsed = jsonMatch
        ? JSON.parse(jsonMatch[0])
        : { success: true, language: languageCode };
      if (parsed.success !== false && typeof onLanguageChanged === 'function') {
        try {
          await onLanguageChanged(languageCode, parsed);
        } catch (callbackError) {
          sendDebugLog(`Error applying language change: ${callbackError.message}`);
        }
      }
      return parsed;
    } catch (error) {
      sendDebugLog(`Error setting language: ${error.message}`);
      return { success: false, error: error.message };
    }
  });

  // Microphone selection IPC handlers
  ipcMain.handle('get-microphone', async () => {
    try {
      const result = await runPythonScript('simple_recorder.py', ['get-microphone'], true);
      const jsonData = JSON.parse(result);
      return { success: true, ...jsonData };
    } catch (error) {
      sendDebugLog(`Error getting microphone setting: ${error.message}`);
      return { success: false, error: error.message };
    }
  });

  ipcMain.handle('set-microphone', async (event, deviceId, label) => {
    try {
      sendDebugLog(`Setting microphone to: ${deviceId ?? 'default'}`);
      // '--' ends Click's option parsing: without it, a device label starting
      // with '--' (e.g. "--help") is parsed as a flag, the subcommand prints
      // help and exits 0 without saving, and the fallback below would then
      // report a false success.
      const result = await runPythonScript('simple_recorder.py', [
        'set-microphone',
        '--',
        deviceId ?? '',
        label ?? '',
      ]);
      const jsonMatch = result.match(/\{.*\}/s);
      if (jsonMatch) {
        return JSON.parse(jsonMatch[0]);
      }
      const normalizedId = deviceId && deviceId !== 'default' ? deviceId : null;
      return { success: true, device_id: normalizedId, label: normalizedId ? label ?? null : null };
    } catch (error) {
      sendDebugLog(`Error setting microphone: ${error.message}`);
      return { success: false, error: error.message };
    }
  });

  ipcMain.handle('get-user-name', async () => {
    try {
      const result = await runPythonScript('simple_recorder.py', ['get-user-name'], true);
      const jsonData = JSON.parse(result.trim());
      return { success: true, ...jsonData };
    } catch (error) {
      return { success: false, error: error.message };
    }
  });

  ipcMain.handle('set-user-name', async (event, name) => {
    try {
      const result = await runPythonScript('simple_recorder.py', ['set-user-name', String(name ?? '')]);
      const jsonMatch = result.match(/\{.*\}/s);
      if (jsonMatch) return JSON.parse(jsonMatch[0]);
      return { success: true, user_name: String(name ?? '').trim() };
    } catch (error) {
      return { success: false, error: error.message };
    }
  });
}

module.exports = { registerSettingsIpc };
