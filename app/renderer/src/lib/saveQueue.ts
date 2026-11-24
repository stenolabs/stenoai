/**
 * A per-document autosave queue.
 *
 * - `schedule(value)` records the latest value and (re)starts a debounce timer.
 * - `flush()` writes the latest value now and resolves once nothing is left to
 *   write (or the write failed). It never starts a second write while one is in
 *   flight: edits that arrive during a write are coalesced into ONE follow-up
 *   write of the newest value.
 * - A failed write is kept as the pending value and is not retried on its own.
 *   The next keystroke, `flush()` or `retry()` tries again.
 *
 * Pure TypeScript with injectable timers so the ordering rules can be unit
 * tested without React or a DOM.
 */

export type SaveStatus = 'idle' | 'pending' | 'saving' | 'saved' | 'error';

export interface SaveQueueOptions<T> {
  save: (value: T) => Promise<void>;
  delayMs?: number;
  onStatus?: (status: SaveStatus, error?: unknown) => void;
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (handle: unknown) => void;
}

export interface SaveQueue<T> {
  schedule(value: T): void;
  /** Resolves true when everything recorded so far is written, false when a write failed. */
  flush(): Promise<boolean>;
  /** Drops a recorded but not yet started write. An in-flight write still completes. */
  cancel(): void;
  /** True while there is a recorded value that has not been written, or a write in flight. */
  hasUnsaved(): boolean;
  status(): SaveStatus;
}

export function createSaveQueue<T>(options: SaveQueueOptions<T>): SaveQueue<T> {
  const delayMs = options.delayMs ?? 800;
  const setTimer =
    options.setTimer ?? ((fn: () => void, ms: number) => globalThis.setTimeout(fn, ms));
  const clearTimer =
    options.clearTimer ??
    ((handle: unknown) => globalThis.clearTimeout(handle as ReturnType<typeof setTimeout>));

  let latest: T | undefined;
  let hasLatest = false;
  // Only a value that has been asked for (timer fired or flush called) is
  // written by the loop. A keystroke during an in-flight write therefore waits
  // for its own debounce instead of being written the moment the first returns.
  let due = false;
  let timer: unknown = null;
  let loop: Promise<boolean> | null = null;
  let current: SaveStatus = 'idle';

  const setStatus = (next: SaveStatus, error?: unknown) => {
    current = next;
    options.onStatus?.(next, error);
  };

  const stopTimer = () => {
    if (timer !== null) {
      clearTimer(timer);
      timer = null;
    }
  };

  async function runLoop(): Promise<boolean> {
    let ok = true;
    while (hasLatest && due) {
      const value = latest as T;
      hasLatest = false;
      due = false;
      setStatus('saving');
      try {
        await options.save(value);
        ok = true;
      } catch (error) {
        ok = false;
        if (!hasLatest) {
          // Keep the failed value so a retry writes it; do not loop on it.
          latest = value;
          hasLatest = true;
          setStatus('error', error);
          return false;
        }
        // Newer edits arrived during the failed write: they supersede it.
      }
    }
    if (hasLatest) setStatus('pending');
    else if (ok) setStatus('saved');
    return ok;
  }

  const flush = (): Promise<boolean> => {
    stopTimer();
    if (hasLatest) due = true;
    if (loop) {
      // The running loop normally picks up `due` work when its write returns;
      // the follow-up flush covers a value recorded after its last check.
      return loop.then((ok) => (hasLatest && due ? flush() : ok));
    }
    if (!hasLatest) return Promise.resolve(current !== 'error');
    loop = runLoop().finally(() => {
      loop = null;
    });
    return loop;
  };

  return {
    schedule(value: T) {
      latest = value;
      hasLatest = true;
      due = false;
      if (current !== 'saving') setStatus('pending');
      stopTimer();
      timer = setTimer(() => {
        timer = null;
        void flush();
      }, delayMs);
    },
    flush,
    cancel() {
      stopTimer();
      hasLatest = false;
      due = false;
      if (!loop) setStatus('idle');
    },
    hasUnsaved: () => hasLatest || loop !== null,
    status: () => current,
  };
}
