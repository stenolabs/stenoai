const test = require('node:test');
const assert = require('node:assert/strict');

const {
  DEFAULT_RECORD_ACCELERATOR,
  normalizeAccelerator,
  effectiveAccelerator,
  customAcceleratorFromConfig,
} = require('./record-hotkey');

test('the default is Control+Alt+R, not the browser hard-reload chord', () => {
  assert.equal(DEFAULT_RECORD_ACCELERATOR, 'Control+Alt+R');
  assert.notEqual(DEFAULT_RECORD_ACCELERATOR, 'CommandOrControl+Shift+R');
});

test('legal accelerators normalise to one canonical spelling', () => {
  assert.equal(normalizeAccelerator('ctrl+alt+r'), 'Control+Alt+R');
  assert.equal(normalizeAccelerator('CmdOrCtrl+Shift+9'), 'CommandOrControl+Shift+9');
  assert.equal(normalizeAccelerator('Command+Option+F12'), 'Command+Alt+F12');
  assert.equal(normalizeAccelerator('Control+Space'), 'Control+Space');
  assert.equal(normalizeAccelerator('Alt+/'), 'Alt+/');
  assert.equal(normalizeAccelerator('Control++'), 'Control+Plus');
});

test('rejects no modifier, Shift only, two keys, unknown keys and junk', () => {
  for (const bad of ['R', 'Shift+R', 'Control+R+T', 'Control+Banana', 'R+Control', 'Control+Control+R',
    '', 'Control+', '+R', null, 42, 'Control+'.padEnd(80, 'x')]) {
    assert.equal(normalizeAccelerator(bad), null, String(bad));
  }
});

test('effective accelerator: custom, then the e2e seam, then the default', () => {
  assert.equal(effectiveAccelerator('Alt+Shift+K', 'Control+Alt+F9'), 'Alt+Shift+K');
  assert.equal(effectiveAccelerator(null, 'Control+Alt+F9'), 'Control+Alt+F9');
  assert.equal(effectiveAccelerator(null, undefined), 'Control+Alt+R');
  // A hand-edited invalid value falls back rather than registering junk.
  assert.equal(effectiveAccelerator('R', undefined), 'Control+Alt+R');
});

test('customAcceleratorFromConfig reads only a valid saved value', () => {
  assert.equal(customAcceleratorFromConfig(null), null);
  assert.equal(customAcceleratorFromConfig({}), null);
  assert.equal(customAcceleratorFromConfig({ record_hotkey_accelerator: null }), null);
  assert.equal(customAcceleratorFromConfig({ record_hotkey_accelerator: 'nope' }), null);
  assert.equal(customAcceleratorFromConfig({ record_hotkey_accelerator: 'alt+shift+k' }), 'Alt+Shift+K');
});
