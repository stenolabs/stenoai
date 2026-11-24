import { isMac } from '@/lib/utils';

/**
 * Electron accelerators for the record shortcut, on the renderer side: show
 * one as keys ("⌃⌥R" / "Ctrl+Alt+R"), and turn a key press in the Settings
 * capture control into one. main.js validates again (app/record-hotkey.js)
 * before anything is registered; this copy only keeps the UI honest.
 */

export const DEFAULT_RECORD_ACCELERATOR = 'Control+Alt+R';

const MOD_ORDER = ['Command', 'CommandOrControl', 'Control', 'Alt', 'AltGr', 'Shift', 'Super'] as const;
type Mod = (typeof MOD_ORDER)[number];

const MOD_ALIASES: Record<string, Mod> = {
  command: 'Command', cmd: 'Command',
  control: 'Control', ctrl: 'Control',
  commandorcontrol: 'CommandOrControl', cmdorctrl: 'CommandOrControl',
  alt: 'Alt', option: 'Alt', altgr: 'AltGr',
  shift: 'Shift', super: 'Super', meta: 'Super',
};

const MAC_GLYPH: Record<Mod, string> = {
  Command: '⌘', CommandOrControl: '⌘', Control: '⌃', Alt: '⌥', AltGr: '⌥', Shift: '⇧', Super: '⌘',
};
const OTHER_LABEL: Record<Mod, string> = {
  Command: 'Win', CommandOrControl: 'Ctrl', Control: 'Ctrl', Alt: 'Alt', AltGr: 'AltGr', Shift: 'Shift', Super: 'Win',
};
const KEY_LABEL: Record<string, string> = {
  Plus: '+', Space: 'Space', Return: '↩', Enter: '↩', Up: '↑', Down: '↓', Left: '←', Right: '→',
  Escape: 'Esc', Esc: 'Esc', Backspace: '⌫', Delete: '⌦', Tab: '⇥',
};

/** The accelerator's keys for display, one entry per key cap. */
export function acceleratorKeys(accel: string, mac: boolean = isMac): string[] {
  const parts = accel.split('+').filter(Boolean);
  const key = parts.pop() ?? '';
  const mods = parts
    .map((p) => MOD_ALIASES[p.toLowerCase()])
    .filter((m): m is Mod => Boolean(m))
    .sort((a, b) => MOD_ORDER.indexOf(a) - MOD_ORDER.indexOf(b));
  // macOS convention orders ⌃⌥⇧⌘.
  if (mac) {
    const macOrder: Mod[] = ['Control', 'Alt', 'AltGr', 'Shift', 'Command', 'CommandOrControl', 'Super'];
    mods.sort((a, b) => macOrder.indexOf(a) - macOrder.indexOf(b));
  }
  const keyLabel = KEY_LABEL[key] ?? (key.length === 1 ? key.toUpperCase() : key);
  return [...mods.map((m) => (mac ? MAC_GLYPH[m] : OTHER_LABEL[m])), keyLabel];
}

// Key-cap labels with the name spelled out on macOS, where the glyphs alone
// (⌃ ⌥ ⇧ ⌘) are unfamiliar to many people.
const MAC_CAP: Record<string, string> = { '⌃': '⌃ Ctrl', '⌥': '⌥ Opt', '⇧': '⇧ Shift', '⌘': '⌘ Cmd' };

/** One readable label per key cap: ["⌃ Ctrl", "⌥ Opt", "R"] on macOS, ["Ctrl", "Alt", "R"] elsewhere. */
export function acceleratorCaps(accel: string, mac: boolean = isMac): string[] {
  return acceleratorKeys(accel, mac).map((k) => (mac ? (MAC_CAP[k] ?? k) : k));
}

/** The accelerator as one string: "⌃⌥R" on macOS, "Ctrl+Alt+R" elsewhere. */
export function formatAccelerator(accel: string, mac: boolean = isMac): string {
  const keys = acceleratorKeys(accel, mac);
  return mac ? keys.join('') : keys.join('+');
}

const CODE_KEYS: Record<string, string> = {
  Space: 'Space', Tab: 'Tab', Backspace: 'Backspace', Delete: 'Delete', Insert: 'Insert',
  Enter: 'Return', NumpadEnter: 'Return', ArrowUp: 'Up', ArrowDown: 'Down', ArrowLeft: 'Left', ArrowRight: 'Right',
  Home: 'Home', End: 'End', PageUp: 'PageUp', PageDown: 'PageDown',
  Minus: '-', Equal: '=', BracketLeft: '[', BracketRight: ']', Backslash: '\\', Semicolon: ';',
  Quote: "'", Comma: ',', Period: '.', Slash: '/', Backquote: '`',
};

/** The non-modifier key of a key press as an accelerator key, or null. */
function keyFromCode(code: string): string | null {
  const letter = /^Key([A-Z])$/.exec(code);
  if (letter) return letter[1] ?? null;
  const digit = /^(?:Digit|Numpad)([0-9])$/.exec(code);
  if (digit) return digit[1] ?? null;
  if (/^F([1-9]|1[0-9]|2[0-4])$/.test(code)) return code;
  return CODE_KEYS[code] ?? null;
}

export type CaptureResult =
  | { kind: 'accelerator'; accelerator: string }
  | { kind: 'incomplete' }
  | { kind: 'needs-modifier' }
  | { kind: 'cancel' };

/**
 * Read one key press from the capture control. Uses `code` (the physical
 * key), so Option+R on a Mac gives "Alt+R" rather than the "®" it types.
 * Esc with no modifier cancels; a lone modifier is still being held.
 */
export function captureAccelerator(e: {
  code: string;
  key: string;
  metaKey: boolean;
  ctrlKey: boolean;
  altKey: boolean;
  shiftKey: boolean;
}): CaptureResult {
  const hasMod = e.metaKey || e.ctrlKey || e.altKey;
  if (e.code === 'Escape' && !hasMod && !e.shiftKey) return { kind: 'cancel' };
  if (['Meta', 'Control', 'Alt', 'Shift', 'OS', 'AltGraph'].includes(e.key)) return { kind: 'incomplete' };
  const key = keyFromCode(e.code);
  if (!key) return { kind: 'incomplete' };
  if (!hasMod) return { kind: 'needs-modifier' };
  const mods: string[] = [];
  if (e.metaKey) mods.push(isMac ? 'Command' : 'Super');
  if (e.ctrlKey) mods.push('Control');
  if (e.altKey) mods.push('Alt');
  if (e.shiftKey) mods.push('Shift');
  return { kind: 'accelerator', accelerator: [...mods, key].join('+') };
}
