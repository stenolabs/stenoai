'use strict';

/**
 * Delivers a custom toast payload only after its renderer has installed the
 * show-notification subscription. `did-finish-load` and BrowserWindow's
 * ready-to-show event can both happen before React commits its layout effects,
 * especially on slower Windows runners.
 */
function registerNotificationIpc({ ipcMain, BrowserWindow, getNotificationWindow }) {
  ipcMain.on('notification-renderer-ready', (event) => {
    const sender = event.sender;
    if (!sender || sender.isDestroyed()) return;

    // Bind the ready signal to the sender's own window. A stale toast can finish
    // mounting after a newer one supersedes it, and the main renderer must never
    // be able to request a notification payload.
    const win = BrowserWindow.fromWebContents(sender);
    const notificationWindow = getNotificationWindow();
    if (!win || win !== notificationWindow || win.isDestroyed()) return;

    const notification = win._activeCustomNotification;
    if (!notification) return;

    sender.send('show-notification', notification.payload);
  });
}

module.exports = { registerNotificationIpc };
