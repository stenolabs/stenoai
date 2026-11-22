'use strict';

/**
 * The global record shortcut's accelerator: the platform default, the user's
 * own choice from Settings (config.json `record_hotkey_accelerator`, null =
 * default), and the check that a renderer-supplied value is a legal Electron
 * accelerator before main hands it to globalShortcut.
 *
 * Pure (no Electron), so node --test covers it (record-hotkey.test.js).
 */

// ⌃⌥R on macOS, Ctrl+Alt+R on Windows/Linux. Not Cmd/Ctrl+Shift+R: that is a
// browser's hard reload, which a global shortcut would swallow everywhere.
const DEFAULT_RECORD_ACCELERATOR = 'Control+Alt+R';

const MODIFIERS = new Map([
  ['command', 'Command'], ['cmd', 'Command'],
  ['control', 'Control'], ['ctrl', 'Control'],
  ['commandorcontrol', 'CommandOrControl'], ['cmdorctrl', 'CommandOrControl'],
  ['alt', 'Alt'], ['option', 'Alt'], ['altgr', 'AltGr'],
  ['shift', 'Shift'],
  ['super', 'Super'], ['meta', 'Super'],
]);

const NAMED_KEYS = [
  'Plus', 'Space', 'Tab', 'Backspace', 'Delete', 'Insert', 'Return', 'Enter',
  'Up', 'Down', 'Left', 'Right', 'Home', 'End', 'PageUp', 'PageDown', 'Escape', 'Esc',
  'num0', 'num1', 'num2', 'num3', 'num4', 'num5', 'num6', 'num7', 'num8', 'num9',
  'numdec', 'numadd', 'numsub', 'nummult', 'numdiv',
];
const NAMED_KEY_MAP = new Map(NAMED_KEYS.map((k) => [k.toLowerCase(), k]));
const PUNCTUATION = new Set([')', '!', '@', '#', '$', '%', '^', '&', '*', '(', ':', ';', '<', '=', '>', '?', '_', '-', '{', '}', '[', ']', '|', '\\', '"', "'", ',', '.', '/', '`', '~']);

/**
 * The canonical form of `value` when it is a legal accelerator with at least
 * one modifier other than Shift (Shift+R alone would capture typing a capital
 * R in every app), else null.
 */
function normalizeAccelerator(value) {
  if (typeof value !== 'string' || !value || value.length > 64) return null;
  // "+" can be the key itself ("Control+Plus" is the documented spelling, but
  // tolerate a trailing "++").
  const raw = value.endsWith('++') ? [...value.slice(0, -2).split('+'), 'Plus'] : value.split('+');
  const parts = raw.map((p) => p.trim());
  if (parts.some((p) => !p)) return null;
  const mods = [];
  let key = null;
  for (const p of parts) {
    const mod = MODIFIERS.get(p.toLowerCase());
    if (mod) {
      if (key) return null; // modifiers come first
      if (mods.includes(mod)) return null;
      mods.push(mod);
      continue;
    }
    if (key) return null; // exactly one key
    if (/^[a-z0-9]$/i.test(p)) key = p.toUpperCase();
    else if (/^f([1-9]|1[0-9]|2[0-4])$/i.test(p)) key = p.toUpperCase();
    else if (NAMED_KEY_MAP.has(p.toLowerCase())) key = NAMED_KEY_MAP.get(p.toLowerCase());
    else if (PUNCTUATION.has(p)) key = p;
    else return null;
  }
  if (!key || !mods.some((m) => m !== 'Shift')) return null;
  return [...mods, key].join('+');
}

/** The accelerator to register: the user's own, else the e2e seam, else the default. */
function effectiveAccelerator(custom, envOverride) {
  return normalizeAccelerator(custom) || normalizeAccelerator(envOverride) || DEFAULT_RECORD_ACCELERATOR;
}

/** The saved custom accelerator from an already-read config, or null. */
function customAcceleratorFromConfig(cfg) {
  return cfg ? normalizeAccelerator(cfg.record_hotkey_accelerator) : null;
}

module.exports = {
  DEFAULT_RECORD_ACCELERATOR,
  normalizeAccelerator,
  effectiveAccelerator,
  customAcceleratorFromConfig,
};
