import { describe, expect, it } from 'vitest';
import en from './locales/en.json';
import zhTW from './locales/zh-TW.json';

const PLACEHOLDER = /\{\{\s*([A-Za-z_][\w.-]*)\s*\}\}/g;
const placeholders = (text: string) =>
  [...text.matchAll(PLACEHOLDER)].map(([, name]) => name).sort();

describe('zh-TW catalogue', () => {
  const english: Record<string, string> = en;
  const entries = Object.entries(zhTW as Record<string, string>);

  it('only translates keys that exist in the English catalogue', () => {
    expect(entries.map(([key]) => key).filter((key) => !Object.hasOwn(english, key))).toEqual([]);
  });

  it('keeps every placeholder of the English source', () => {
    for (const [key, value] of entries) {
      expect(placeholders(value), key).toEqual(placeholders(english[key] ?? ''));
    }
  });

  it('has no empty translations', () => {
    expect(entries.filter(([, value]) => value.trim() === '').map(([key]) => key)).toEqual([]);
  });
});
