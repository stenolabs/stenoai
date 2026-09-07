import { ResultError } from './result';

// Fixed English copy, ready to move into the locale catalogue. Never render
// backend error.message, event.message, or an unknown code as user-facing text.
const messages = {
  generation_connection_failed: 'Could not reach the AI service. Check that it is running and that the connection settings are correct, then try again.',
  generation_model_unavailable: 'The selected AI model is unavailable. Check the model in Settings, then try again.',
  generation_auth_failed: 'The AI service denied access. Check your credentials and permissions in Settings, then try again.',
  generation_timeout: 'The AI service took too long to respond. Try again when it is available.',
  generation_out_of_memory: 'There was not enough memory to generate notes. Choose a smaller model in Settings or free up memory, then try again.',
  generation_not_configured: 'The AI service is not configured. Complete its setup in Settings, then try again.',
  generation_failed: 'Notes could not be generated. Try again. If the problem continues, check the AI settings and debug logs.',
} as const;

export type NoteGenerationErrorCode = keyof typeof messages;

export function noteGenerationErrorCode(value: unknown): NoteGenerationErrorCode {
  return typeof value === 'string' && Object.hasOwn(messages, value)
    ? value as NoteGenerationErrorCode
    : 'generation_failed';
}

export function noteGenerationErrorFromResult(error: unknown): NoteGenerationErrorCode {
  return noteGenerationErrorCode(error instanceof ResultError ? error.code : undefined);
}

export function noteGenerationErrorMessage(code: NoteGenerationErrorCode): string {
  return messages[code];
}

// The stream event, terminal event and rejected IPC result can all report the
// same failure. A generic terminal signal must not erase a known stream cause.
export function keepNoteGenerationCause(previous: NoteGenerationErrorCode | null, value: unknown): NoteGenerationErrorCode {
  const next = noteGenerationErrorCode(value);
  return next === 'generation_failed' ? previous ?? next : next;
}
