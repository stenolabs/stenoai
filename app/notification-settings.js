/**
 * Read the persisted post-processing notification preference without a backend
 * request. Completion delivery must not wait for a potentially stuck
 * `get-notifications` subprocess: an unreadable config preserves the historic
 * enabled-by-default behavior and lets the renderer own the fallback.
 */
function notificationsEnabledFromDisk(configPath, fileSystem = require('fs')) {
  try {
    if (fileSystem.existsSync(configPath)) {
      const config = JSON.parse(fileSystem.readFileSync(configPath, 'utf-8'));
      return config.notifications_enabled !== false;
    }
  } catch (_) {}
  return true;
}

module.exports = { notificationsEnabledFromDisk };
