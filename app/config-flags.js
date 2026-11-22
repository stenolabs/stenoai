// Synchronous reads of config.json for the Electron main process.
//
// The Python config (src/config.py) owns config.json; main reads a few values
// straight from the file so a startup gate or a hot path does not spawn Python
// just to read a boolean. Every such read goes through here, so the file is
// parsed one way and each flag's default lives in one table.
//
// Pure helpers (fs only, no Electron), so they are unit-testable; main.js passes
// the config path, resolved from getUserDataDir().

const fs = require('fs');

// Defaults mirror src/config.py (_get_default_config and the get_* accessors);
// config-flags.test.js checks the two stay in step. A default-on flag is off
// only for a literal false; a default-off flag is on only for a literal true,
// so a hand-edited "true"/"false" string reads as the default.
const CONFIG_FLAG_DEFAULTS = Object.freeze({
  auto_detect_meetings_enabled: true,
  auto_install_when_idle: true,
  launch_on_login: true,
  notifications_enabled: true,
  record_hotkey_enabled: true,
  show_menu_bar_icon: true,
  auto_record_meetings_enabled: false,
  caller_id_enabled: false,
});

// Non-boolean values main reads straight from config.json, with the default
// src/config.py writes. config-flags.test.js checks these against Python too.
// record_hotkey_accelerator: null = the platform default (record-hotkey.js).
const CONFIG_VALUE_DEFAULTS = Object.freeze({
  record_hotkey_accelerator: null,
});

/**
 * The parsed config object, or null when the file is missing, unreadable, not
 * JSON, or not a JSON object. Callers apply their own defaults for null.
 */
function readConfigFile(configPath) {
  try {
    if (!fs.existsSync(configPath)) return null;
    const cfg = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
    return cfg && typeof cfg === 'object' && !Array.isArray(cfg) ? cfg : null;
  } catch (_) {
    return null;
  }
}

/** A boolean flag from CONFIG_FLAG_DEFAULTS, read fresh from disk. */
function readConfigFlag(configPath, key) {
  return flagFromConfig(readConfigFile(configPath), key);
}

/** The same rule as readConfigFlag, applied to an already-read config. */
function flagFromConfig(cfg, key) {
  if (!Object.prototype.hasOwnProperty.call(CONFIG_FLAG_DEFAULTS, key)) {
    throw new Error(`Unknown config flag: ${key}`);
  }
  const value = cfg ? cfg[key] : undefined;
  return CONFIG_FLAG_DEFAULTS[key] ? value !== false : value === true;
}

module.exports = {
  CONFIG_FLAG_DEFAULTS,
  CONFIG_VALUE_DEFAULTS,
  flagFromConfig,
  readConfigFile,
  readConfigFlag,
};
