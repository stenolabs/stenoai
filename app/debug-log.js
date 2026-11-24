'use strict';

/**
 * Debug-log seam — the `sendDebugLog` sink that streams backend command echoes,
 * stderr, and pipeline progress to the renderer's setup console + debug panel.
 * Carved out of app/main.js (RFC #327, Phase 0) with ZERO behavior change: the
 * body is verbatim; the only cross-cutting dependency (the main BrowserWindow)
 * is injected via a `getMainWindow` accessor so this module never closes over
 * main.js's mutable `mainWindow` binding directly. main.js stays the one place
 * that owns the window and wires it in.
 *
 * The accessor is read on every call (not captured once) so a window created,
 * destroyed, or recreated after wiring is always reflected — matching the old
 * behavior where `sendDebugLog` read the live module-scope `mainWindow`.
 */

/**
 * @param {object} deps
 * @param {() => (import('electron').BrowserWindow | null | undefined)} deps.getMainWindow
 * @returns {(message: string) => void}
 */
const { redactCredentials } = require('./diagnostics-filter');

function createDebugLog({ getMainWindow }) {
  return function sendDebugLog(message) {
    // Send to main window (both setup console and debug panel). Credential
    // shapes (Bearer tokens, OAuth parameters) are masked first.
    const mainWindow = getMainWindow();
    if (mainWindow) {
      mainWindow.webContents.send('debug-log', redactCredentials(message));
    }
  };
}

module.exports = { createDebugLog };
