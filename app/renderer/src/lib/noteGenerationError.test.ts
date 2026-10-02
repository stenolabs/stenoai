import { describe, expect, it } from 'vitest';
import { ResultError } from './result';
import { keepNoteGenerationCause, noteGenerationErrorCode, noteGenerationErrorFromResult, noteGenerationErrorMessage } from './noteGenerationError';

describe('note generation error copy', () => {
  it('uses only known codes, never raw diagnostics or inherited object keys', () => {
    for (const value of ['toString', '__proto__', 'https://internal.invalid/secret', undefined, null, {}]) {
      expect(noteGenerationErrorCode(value)).toBe('generation_failed');
    }
    expect(noteGenerationErrorFromResult(new Error('No route to private server'))).toBe('generation_failed');
    const code = noteGenerationErrorFromResult(new ResultError('private diagnostics', 'generation_model_unavailable'));
    expect(noteGenerationErrorMessage(code)).toContain('selected AI model is unavailable');
    expect(noteGenerationErrorMessage(code)).not.toContain('private');
  });

  it('keeps a specific stream cause when the terminal event is generic', () => {
    expect(keepNoteGenerationCause('generation_connection_failed', undefined)).toBe('generation_connection_failed');
    expect(keepNoteGenerationCause('generation_failed', 'generation_model_unavailable')).toBe('generation_model_unavailable');
    expect(keepNoteGenerationCause(null, undefined)).toBe('generation_failed');
  });
});
