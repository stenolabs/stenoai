import * as React from 'react';
import { en } from './locales/en';
import { zhTW } from './locales/zh-TW';
import type { Locale, Translations } from './types';

export * from './types';

export const SUPPORTED_LOCALES: { code: Locale; label: string }[] = [
  { code: 'zh-TW', label: '華文 (臺灣)' },
  { code: 'en', label: 'English' },
];

const LOCAL_STORAGE_KEY = 'steno-ui-locale';
const DEFAULT_LOCALE: Locale = 'en';

const dictionaries: Record<Locale, Translations> = {
  'zh-TW': zhTW,
  en,
};

type NestedKeyOf<ObjectType extends object> = {
  [Key in keyof ObjectType & (string | number)]: ObjectType[Key] extends object
    ? `${Key}.${NestedKeyOf<ObjectType[Key]>}`
    : `${Key}`;
}[keyof ObjectType & (string | number)];

export type TranslationKey = NestedKeyOf<Translations>;

// Module-level locale store for reactive updates and non-React access
let currentLocale: Locale = (() => {
  if (typeof window !== 'undefined' && window.localStorage) {
    try {
      const stored = window.localStorage.getItem(LOCAL_STORAGE_KEY) as Locale | null;
      if (stored && (stored === 'en' || stored === 'zh-TW')) {
        return stored;
      }
    } catch {
      // ignore
    }
  }
  return DEFAULT_LOCALE;
})();

const listeners = new Set<() => void>();

export function getLocale(): Locale {
  return currentLocale;
}

export function setLocale(locale: Locale): void {
  if (currentLocale === locale) return;
  currentLocale = locale;
  try {
    if (typeof window !== 'undefined' && window.localStorage) {
      window.localStorage.setItem(LOCAL_STORAGE_KEY, locale);
    }
  } catch {
    // ignore
  }
  listeners.forEach((fn) => fn());
}

/**
 * Format string with parameter interpolation.
 * Supports {key} placeholders and {plural} suffixes.
 */
export function formatString(
  template: string,
  params?: Record<string, string | number>,
): string {
  if (!params) return template;
  return template.replace(/\{(\w+)\}/g, (_, key) => {
    if (key in params) {
      return String(params[key]);
    }
    return `{${key}}`;
  });
}

function resolveKey(dict: Translations, path: string): string | undefined {
  const parts = path.split('.');
  let current: unknown = dict;
  for (const part of parts) {
    if (current == null || typeof current !== 'object') return undefined;
    current = (current as Record<string, unknown>)[part];
  }
  return typeof current === 'string' ? current : undefined;
}

export function t(key: string, params?: Record<string, string | number>): string {
  const dict = dictionaries[currentLocale] || dictionaries[DEFAULT_LOCALE];
  let res = resolveKey(dict, key);
  if (res === undefined) {
    // Fallback to English
    res = resolveKey(dictionaries.en, key);
  }
  if (res === undefined) {
    return key;
  }
  return formatString(res, params);
}

interface I18nContextValue {
  locale: Locale;
  setLocale: (locale: Locale) => void;
  t: (key: string, params?: Record<string, string | number>) => string;
}

const I18nContext = React.createContext<I18nContextValue>({
  locale: currentLocale,
  setLocale,
  t,
});

export function I18nProvider({ children }: { children: React.ReactNode }) {
  const locale = React.useSyncExternalStore(
    (callback) => {
      listeners.add(callback);
      return () => listeners.delete(callback);
    },
    getLocale,
    () => DEFAULT_LOCALE,
  );

  const value = React.useMemo<I18nContextValue>(
    () => ({
      locale,
      setLocale,
      t: (key, params) => t(key, params),
    }),
    [locale],
  );

  return <I18nContext.Provider value={value}>{children}</I18nContext.Provider>;
}

export function useI18n(): I18nContextValue {
  return React.useContext(I18nContext);
}

export function useTranslation() {
  const { t, locale, setLocale } = useI18n();
  return { t, locale, setLocale };
}
