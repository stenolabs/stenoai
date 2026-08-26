import { describe, expect, it } from 'vitest';
import { ResultError, unwrap } from './result';

describe('unwrap', () => {
  it('preserves a structured backend error code', () => {
    expect.assertions(2);
    try {
      unwrap({
        success: false,
        error: 'human-readable detail',
        error_code: 'stale_diarization_run',
      });
    } catch (error) {
      expect(error).toBeInstanceOf(ResultError);
      expect((error as ResultError).code).toBe('stale_diarization_run');
    }
  });
});
