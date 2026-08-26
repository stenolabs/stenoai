import { describe, expect, it, afterEach } from 'vitest';

import { setLocale, t } from '@/i18n/index';
import { en, type Translations } from '@/i18n/locales/en';
import { zhTW } from '@/i18n/locales/zh-TW';

type Json = Record<string, unknown>;

/**
 * i18n key parity guard. `t()` keys are free-form strings, so a typo or a
 * missing translation never fails the typecheck — it just renders the key
 * verbatim to the user. This test walks both dictionaries and asserts they
 * expose the exact same nested key set, catching an orphaned key in one
 * locale (a missing translation) or in neither (a stray entry).
 */
function keys(obj: Json): string[] {
  return Object.keys(obj).sort();
}

function allKeys(obj: Json, prefix = ''): string[] {
  const out: string[] = [];
  for (const [name, value] of Object.entries(obj)) {
    const path = `${prefix}${name}`;
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      out.push(...allKeys(value as Json, `${path}.`));
    } else {
      out.push(path);
    }
  }
  return out.sort();
}

function getByPath(obj: Json, path: string): unknown {
  return path.split('.').reduce<unknown>((acc, key) => {
    if (acc && typeof acc === 'object' && key in (acc as Json)) {
      return (acc as Json)[key];
    }
    return undefined;
  }, obj);
}

describe('i18n key parity', () => {
  afterEach(() => {
    // setLocale persists to localStorage; reset to English so other test
    // files don't inherit the zh-TW strings this suite exercises.
    setLocale('en');
  });

  it('en and zh-TW expose the same flat key set', () => {
    expect(keys(en as unknown as Json)).toEqual(keys(zhTW as unknown as Json));
  });

  it('en and zh-TW expose the same nested key set', () => {
    expect(allKeys(en as unknown as Json)).toEqual(allKeys(zhTW as unknown as Json));
  });

  it('every en value is a non-empty string', () => {
    for (const key of allKeys(en as unknown as Json)) {
      const value = getByPath(en as unknown as Json, key);
      expect(typeof value).toBe('string');
      expect((value as string).length).toBeGreaterThan(0);
    }
  });

  it('every zh-TW value is a non-empty string', () => {
    for (const key of allKeys(zhTW as unknown as Json)) {
      const value = getByPath(zhTW as unknown as Json, key);
      expect(typeof value).toBe('string');
      expect((value as string).length).toBeGreaterThan(0);
    }
  });

  it('Translations is fully populated (compile-time)', () => {
    const dict: Translations = en;
    expect(dict.common.save).toBe('Save');
    expect(dict.nav.signInToOrgTitle).toBe('Sign in to share notes with your organisation');
  });

  it('t() returns zh-TW strings after setLocale and interpolates {count}', () => {
    setLocale('zh-TW');
    expect(t('common.save')).toBe('儲存');
    expect(t('toasts.noteDeleted')).toBe('筆記已刪除');
    expect(t('toasts.unnamedSpeakersHint', { count: 2 })).toContain('2 位發言者');
    expect(t('toasts.unnamedSpeakersHint', { count: 1 })).toContain('1 位發言者');
    // Unknown keys fall back to the key path verbatim, never undefined.
    expect(t('common.definitely-missing')).toBe('common.definitely-missing');
    setLocale('en');
  });
});
