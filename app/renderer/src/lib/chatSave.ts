/** How long ChatTurnPersister waits before retrying a failed chat save. */
export const CHAT_SAVE_RETRY_DELAY_MS = 1500;

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * Run `save`; when it rejects, wait `delayMs` and try again, `retries` times.
 * Rejects with the last error once every attempt has failed, so the caller
 * can keep what it was saving instead of dropping it.
 */
export async function saveWithRetry<T>(
  save: () => Promise<T>,
  { retries = 1, delayMs = CHAT_SAVE_RETRY_DELAY_MS, wait = sleep }: { retries?: number; delayMs?: number; wait?: (ms: number) => Promise<void> } = {},
): Promise<T> {
  let attempt = 0;
  for (;;) {
    try {
      return await save();
    } catch (err) {
      if (attempt >= retries) throw err;
      attempt += 1;
      await wait(delayMs);
    }
  }
}
