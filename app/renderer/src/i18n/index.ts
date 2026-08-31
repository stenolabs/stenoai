import en from './locales/en.json';

export type TranslationKey = keyof typeof en;
export type TranslationParams = Readonly<Record<string, string | number>>;

const INTERPOLATION = /\{\{\s*([A-Za-z_][\w.-]*)\s*\}\}/g;

export function createTranslator<const Catalogue extends Record<string, string>>(
  catalogue: Catalogue,
) {
  return function translate<Key extends keyof Catalogue & string>(
    key: Key,
    params: TranslationParams = {},
  ): string {
    return catalogue[key].replace(INTERPOLATION, (token, parameter: string) =>
      Object.hasOwn(params, parameter) ? String(params[parameter]) : token,
    );
  };
}

/**
 * Resolve renderer copy from the canonical English catalogue.
 *
 * The app remains English-only until locale selection lands. Keeping new copy
 * behind this typed boundary makes later locale additions a catalogue change
 * instead of another component migration.
 */
export const t: (key: TranslationKey, params?: TranslationParams) => string =
  createTranslator(en);
