import { APPLE_LANGUAGE_CODES, PARAKEET_LANGUAGE_CODES } from '@/lib/transcription-languages';

export type LangOption = { value: string; label: string };

// Curated language list shown in Settings → Transcribe. Whisper supports
// all 13 (it covers 99 languages at the model level; the dropdown is just
// the tested curation). Chinese is split into Simplified (zh-Hans) and
// Traditional (zh-Hant): whisper.cpp always emits Simplified, so Traditional
// is a post-transcription OpenCC conversion (see src/chinese.py) — both map
// to whisper's "zh" for the actual ASR call.
export const LANGUAGES_WHISPER: LangOption[] = [
  { value: 'auto', label: 'Auto (detect)' },
  { value: 'en', label: 'English' },
  { value: 'es', label: 'Spanish' },
  { value: 'fr', label: 'French' },
  { value: 'de', label: 'German' },
  { value: 'nl', label: 'Dutch' },
  { value: 'pt', label: 'Portuguese' },
  { value: 'ja', label: 'Japanese' },
  { value: 'zh-Hans', label: 'Chinese (Simplified)' },
  { value: 'zh-Hant', label: 'Chinese (Traditional)' },
  { value: 'ko', label: 'Korean' },
  { value: 'hi', label: 'Hindi' },
  { value: 'ar', label: 'Arabic' },
];
// Parakeet exposes the European subset (see transcription-languages.ts for
// why pinning matters even though the decoder is language-agnostic). Derived
// from the Whisper list so labels stay identical and the picker can't drift
// from the shared code set.
export const LANGUAGES_PARAKEET: LangOption[] = LANGUAGES_WHISPER.filter(
  (language) => PARAKEET_LANGUAGE_CODES[language.value] === true
);

export const LANGUAGES_APPLE: LangOption[] = LANGUAGES_WHISPER.filter(
  (language) => APPLE_LANGUAGE_CODES[language.value] === true
).map((language) =>
  language.value === 'auto' ? { value: 'auto', label: 'Auto (system language)' } : language
);
