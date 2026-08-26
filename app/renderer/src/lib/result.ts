import type { Result } from './ipc';

export class ResultError extends Error {
  readonly code?: string;

  constructor(message: string, code?: string) {
    super(message);
    this.name = 'ResultError';
    this.code = code;
  }
}

export function unwrap<T>(result: Result<T>): T {
  if (!result.success) throw new ResultError(result.error, result.error_code);
  const { success: _success, ...rest } = result;
  return rest as T;
}
