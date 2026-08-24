// Shared language catalogs for the two live transcription engines. Whisper
// uses the broader curated list in Settings and has no live drawer.
export interface TranscriptionLanguageOption {
  code: string;
  label: string;
  hint: string;
}

export const PARAKEET_LANGUAGES: readonly TranscriptionLanguageOption[] = [
  { code: 'auto', label: 'Multi-language', hint: 'Auto-detect per recording (European languages)' },
  { code: 'en', label: 'English', hint: 'Best accuracy when meetings are always in English' },
  { code: 'fr', label: 'French', hint: 'Transcribe and summarise in French' },
  { code: 'de', label: 'German', hint: 'Transcribe and summarise in German' },
  { code: 'es', label: 'Spanish', hint: 'Transcribe and summarise in Spanish' },
  { code: 'nl', label: 'Dutch', hint: 'Transcribe and summarise in Dutch' },
  { code: 'pt', label: 'Portuguese', hint: 'Transcribe and summarise in Portuguese' },
];

export const PARAKEET_LANGUAGE_CODES: Readonly<Record<string, true>> = {
  auto: true,
  en: true,
  fr: true,
  de: true,
  es: true,
  nl: true,
  pt: true,
};

export const APPLE_LANGUAGES: readonly TranscriptionLanguageOption[] = [
  { code: 'auto', label: 'System', hint: 'Use the Mac’s current language and region' },
  { code: 'en', label: 'English', hint: 'Apple on-device English transcription' },
  { code: 'fr', label: 'French', hint: 'Apple on-device French transcription' },
  { code: 'de', label: 'German', hint: 'Apple on-device German transcription' },
  { code: 'es', label: 'Spanish', hint: 'Apple on-device Spanish transcription' },
  { code: 'pt', label: 'Portuguese', hint: 'Apple on-device Portuguese transcription' },
  { code: 'ja', label: 'Japanese', hint: 'Apple on-device Japanese transcription' },
  { code: 'zh-Hans', label: 'Chinese (Simplified)', hint: 'Apple on-device Simplified Chinese' },
  { code: 'zh-Hant', label: 'Chinese (Traditional)', hint: 'Apple on-device Traditional Chinese' },
  { code: 'ko', label: 'Korean', hint: 'Apple on-device Korean transcription' },
  { code: 'hi', label: 'Hindi', hint: 'Apple on-device Hindi transcription' },
];

export const APPLE_LANGUAGE_CODES: Readonly<Record<string, true>> = {
  auto: true,
  en: true,
  fr: true,
  de: true,
  es: true,
  pt: true,
  ja: true,
  'zh-Hans': true,
  'zh-Hant': true,
  ko: true,
  hi: true,
};
