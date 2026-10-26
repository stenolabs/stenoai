// Single source of truth for which languages the Parakeet engine offers.
//
// Parakeet TDT v3 is language-agnostic at inference (the decoder ignores the
// pin), but the language setting still drives the OUTPUT language of the
// summary, title, chat and reports — so a French/German/… user must be able
// to pin their language or those default to English. We expose the European
// languages Parakeet transcribes well; the non-European codes (ja/zh/ko/hi/ar)
// stay Whisper-only because Parakeet can't transcribe them.
//
// Every Parakeet-aware language control derives from this ONE list so they
// can't drift — codes AND the live-bar copy live here:
//   - Settings → Transcribe picker (LANGUAGES_PARAKEET, routes/Settings.tsx)
//     filters the Whisper list by PARAKEET_LANGUAGE_CODES.
//   - the engine-switch coercion (useSetActiveTranscription, hooks/useModels.ts)
//     resets an out-of-set pin to 'auto'.
//   - the live transcript bar's language selector
//     (components/LiveTranscriptBar.tsx) maps PARAKEET_LANGUAGES directly.
// New entries also need the curated Whisper list and backend SUPPORTED_LANGUAGES
// entry; the Parakeet codes set below is derived from this list.
export interface ParakeetLanguageOption {
  code: string;
  label: string;
  hint: string;
}

export const PARAKEET_LANGUAGES: readonly ParakeetLanguageOption[] = [
  { code: 'auto', label: 'Multi-language', hint: 'Auto-detect per recording (European languages)' },
  { code: 'en', label: 'English', hint: 'Best accuracy when meetings are always in English' },
  { code: 'fr', label: 'French', hint: 'Transcribe and summarise in French' },
  { code: 'de', label: 'German', hint: 'Transcribe and summarise in German' },
  { code: 'it', label: 'Italian', hint: 'Transcribe and summarise in Italian' },
  { code: 'es', label: 'Spanish', hint: 'Transcribe and summarise in Spanish' },
  { code: 'nl', label: 'Dutch', hint: 'Transcribe and summarise in Dutch' },
  { code: 'pt', label: 'Portuguese', hint: 'Transcribe and summarise in Portuguese' },
  { code: 'ru', label: 'Russian', hint: 'Transcribe and summarise in Russian' },
];

export const PARAKEET_LANGUAGE_CODES: ReadonlySet<string> = new Set(
  PARAKEET_LANGUAGES.map((l) => l.code),
);

export const APPLE_LANGUAGES: readonly ParakeetLanguageOption[] = [
  { code: 'auto', label: t('settings.ai.apple.system'), hint: t('settings.ai.apple.systemHint') },
  { code: 'en', label: 'English', hint: t('settings.ai.apple.languageHint', { language: 'English' }) },
  { code: 'fr', label: 'French', hint: t('settings.ai.apple.languageHint', { language: 'French' }) },
  { code: 'de', label: 'German', hint: t('settings.ai.apple.languageHint', { language: 'German' }) },
  { code: 'es', label: 'Spanish', hint: t('settings.ai.apple.languageHint', { language: 'Spanish' }) },
  { code: 'pt', label: 'Portuguese', hint: t('settings.ai.apple.languageHint', { language: 'Portuguese' }) },
  { code: 'ja', label: 'Japanese', hint: t('settings.ai.apple.languageHint', { language: 'Japanese' }) },
  { code: 'zh-Hans', label: 'Chinese (Simplified)', hint: t('settings.ai.apple.languageHint', { language: 'Simplified Chinese' }) },
  { code: 'zh-Hant', label: 'Chinese (Traditional)', hint: t('settings.ai.apple.languageHint', { language: 'Traditional Chinese' }) },
  { code: 'ko', label: 'Korean', hint: t('settings.ai.apple.languageHint', { language: 'Korean' }) },
  { code: 'hi', label: 'Hindi', hint: t('settings.ai.apple.languageHint', { language: 'Hindi' }) },
];

export const APPLE_LANGUAGE_CODES: ReadonlySet<string> = new Set(
  APPLE_LANGUAGES.map((l) => l.code),
);
import { t } from '@/i18n';
