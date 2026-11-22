import { describe, expect, it } from 'vitest';
import { acceleratorKeys, captureAccelerator, formatAccelerator } from './accelerator';

const press = (code: string, mods: Partial<Record<'metaKey' | 'ctrlKey' | 'altKey' | 'shiftKey', boolean>> = {}, key = '') => ({
  code,
  key,
  metaKey: false,
  ctrlKey: false,
  altKey: false,
  shiftKey: false,
  ...mods,
});

describe('formatAccelerator', () => {
  it('uses mac glyphs in ⌃⌥⇧⌘ order', () => {
    expect(formatAccelerator('Control+Alt+R', true)).toBe('⌃⌥R');
    expect(formatAccelerator('CommandOrControl+Shift+9', true)).toBe('⇧⌘9');
    expect(acceleratorKeys('Control+Alt+R', true)).toEqual(['⌃', '⌥', 'R']);
  });

  it('spells keys out on Windows/Linux', () => {
    expect(formatAccelerator('Control+Alt+R', false)).toBe('Ctrl+Alt+R');
    expect(formatAccelerator('CommandOrControl+Shift+F9', false)).toBe('Ctrl+Shift+F9');
    expect(acceleratorKeys('Alt+Space', false)).toEqual(['Alt', 'Space']);
  });
});

describe('captureAccelerator', () => {
  it('builds an accelerator from the physical key', () => {
    expect(captureAccelerator(press('KeyR', { ctrlKey: true, altKey: true }, '®'))).toEqual({
      kind: 'accelerator',
      accelerator: 'Control+Alt+R',
    });
    expect(captureAccelerator(press('F5', { altKey: true, shiftKey: true }))).toEqual({
      kind: 'accelerator',
      accelerator: 'Alt+Shift+F5',
    });
  });

  it('needs a modifier other than Shift', () => {
    expect(captureAccelerator(press('KeyR'))).toEqual({ kind: 'needs-modifier' });
    expect(captureAccelerator(press('KeyR', { shiftKey: true }))).toEqual({ kind: 'needs-modifier' });
  });

  it('waits while only modifiers are held, and Esc cancels', () => {
    expect(captureAccelerator(press('ControlLeft', { ctrlKey: true }, 'Control'))).toEqual({ kind: 'incomplete' });
    expect(captureAccelerator(press('Escape', {}, 'Escape'))).toEqual({ kind: 'cancel' });
  });
});
