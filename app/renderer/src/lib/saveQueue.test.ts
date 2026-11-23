import { describe, expect, it, vi } from 'vitest';
import { createSaveQueue, type SaveStatus } from './saveQueue';

/** A save whose calls resolve or reject only when the test says so. */
function controlledSave() {
  const calls: { value: string; resolve: () => void; reject: (e: unknown) => void }[] = [];
  const save = vi.fn(
    (value: string) =>
      new Promise<void>((resolve, reject) => {
        calls.push({ value, resolve, reject });
      })
  );
  return { save, calls };
}

const tick = () => new Promise((r) => setTimeout(r, 0));

describe('createSaveQueue', () => {
  it('debounces: only the last value typed before the pause is written', async () => {
    vi.useFakeTimers();
    try {
      const save = vi.fn(async () => {});
      const q = createSaveQueue<string>({ save, delayMs: 800 });
      q.schedule('a');
      vi.advanceTimersByTime(500);
      q.schedule('ab');
      vi.advanceTimersByTime(500);
      expect(save).not.toHaveBeenCalled();
      vi.advanceTimersByTime(300);
      await vi.runAllTimersAsync();
      expect(save).toHaveBeenCalledTimes(1);
      expect(save).toHaveBeenCalledWith('ab');
      expect(q.status()).toBe('saved');
    } finally {
      vi.useRealTimers();
    }
  });

  it('never overlaps writes and coalesces edits made during one into a single follow-up', async () => {
    const { save, calls } = controlledSave();
    const q = createSaveQueue<string>({ save, delayMs: 10_000 });
    q.schedule('v1');
    const first = q.flush();
    expect(calls).toHaveLength(1);
    q.schedule('v2');
    q.schedule('v3');
    const second = q.flush();
    // Still one write in flight.
    expect(calls).toHaveLength(1);
    calls[0].resolve();
    await tick();
    expect(calls).toHaveLength(2);
    expect(calls[1].value).toBe('v3');
    calls[1].resolve();
    expect(await first).toBe(true);
    expect(await second).toBe(true);
    expect(save).toHaveBeenCalledTimes(2);
    expect(q.hasUnsaved()).toBe(false);
  });

  it('an edit during a write waits for its own debounce rather than riding the first write', async () => {
    vi.useFakeTimers();
    try {
      const { save, calls } = controlledSave();
      const q = createSaveQueue<string>({ save, delayMs: 800 });
      q.schedule('v1');
      void q.flush();
      q.schedule('v2');
      calls[0].resolve();
      await vi.advanceTimersByTimeAsync(0);
      expect(calls).toHaveLength(1);
      expect(q.status()).toBe('pending');
      await vi.advanceTimersByTimeAsync(800);
      expect(calls).toHaveLength(2);
      expect(calls[1].value).toBe('v2');
      calls[1].resolve();
    } finally {
      vi.useRealTimers();
    }
  });

  it('keeps a failed value for retry without retrying on its own', async () => {
    const statuses: SaveStatus[] = [];
    const { save, calls } = controlledSave();
    const q = createSaveQueue<string>({ save, onStatus: (s) => statuses.push(s) });
    q.schedule('draft');
    const attempt = q.flush();
    calls[0].reject(new Error('disk full'));
    expect(await attempt).toBe(false);
    expect(q.status()).toBe('error');
    expect(q.hasUnsaved()).toBe(true);
    await tick();
    expect(calls).toHaveLength(1);

    const retry = q.flush();
    expect(calls).toHaveLength(2);
    expect(calls[1].value).toBe('draft');
    calls[1].resolve();
    expect(await retry).toBe(true);
    expect(statuses).toEqual(['pending', 'saving', 'error', 'saving', 'saved']);
  });

  it('newer edits made during a failing write supersede it', async () => {
    const { save, calls } = controlledSave();
    const q = createSaveQueue<string>({ save, delayMs: 10_000 });
    q.schedule('old');
    const run = q.flush();
    q.schedule('new');
    void q.flush();
    calls[0].reject(new Error('busy'));
    await tick();
    expect(calls).toHaveLength(2);
    expect(calls[1].value).toBe('new');
    calls[1].resolve();
    expect(await run).toBe(true);
  });

  it('cancel drops a scheduled write; flush with nothing recorded resolves at once', async () => {
    vi.useFakeTimers();
    try {
      const save = vi.fn(async () => {});
      const q = createSaveQueue<string>({ save });
      q.schedule('x');
      q.cancel();
      await vi.runAllTimersAsync();
      expect(save).not.toHaveBeenCalled();
      expect(await q.flush()).toBe(true);
      expect(q.status()).toBe('idle');
    } finally {
      vi.useRealTimers();
    }
  });
});
