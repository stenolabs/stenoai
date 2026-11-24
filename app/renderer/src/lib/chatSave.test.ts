import { describe, expect, test, vi } from 'vitest';
import { saveWithRetry } from './chatSave';

describe('saveWithRetry', () => {
  test('a save that succeeds first time is not retried', async () => {
    const save = vi.fn().mockResolvedValue('ok');
    const wait = vi.fn().mockResolvedValue(undefined);
    await expect(saveWithRetry(save, { wait })).resolves.toBe('ok');
    expect(save).toHaveBeenCalledTimes(1);
    expect(wait).not.toHaveBeenCalled();
  });

  test('one failure is retried after the delay and the retry result returned', async () => {
    const save = vi.fn().mockRejectedValueOnce(new Error('disk')).mockResolvedValueOnce('saved');
    const wait = vi.fn().mockResolvedValue(undefined);
    await expect(saveWithRetry(save, { wait, delayMs: 7 })).resolves.toBe('saved');
    expect(save).toHaveBeenCalledTimes(2);
    expect(wait).toHaveBeenCalledWith(7);
  });

  test('two failures reject with the last error, so the caller keeps the answer', async () => {
    const save = vi.fn().mockRejectedValueOnce(new Error('first')).mockRejectedValueOnce(new Error('second'));
    const wait = vi.fn().mockResolvedValue(undefined);
    await expect(saveWithRetry(save, { wait })).rejects.toThrow('second');
    expect(save).toHaveBeenCalledTimes(2);
  });
});
