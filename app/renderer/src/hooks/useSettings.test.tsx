import { describe, test, expect, beforeEach, vi } from 'vitest';
import * as React from 'react';
import { renderHook, act, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

/**
 * Settings toggles write optimistically (see `useToggleSetting`).
 *
 * The property under test is a performance one, so it needs pinning: a toggle
 * must NOT read its value back after writing it. Each `set-*`/`get-*` pair
 * spawns a backend process (~315 ms packaged), so the old
 * `onSuccess: invalidateQueries` shape cost two processes per click and left
 * the switch frozen until the second returned. A regression that re-adds the
 * invalidate is invisible in behaviour tests — only the call count catches it.
 */

const h = vi.hoisted(() => ({
  getNotifications: vi.fn(),
  setNotifications: vi.fn(),
  getIdentityMatchingEnabled: vi.fn(),
  setIdentityMatchingEnabled: vi.fn(),
}));

vi.mock('@/lib/ipc', () => ({
  ipc: () => ({
    settings: {
      getNotifications: h.getNotifications,
      setNotifications: h.setNotifications,
      getIdentityMatchingEnabled: h.getIdentityMatchingEnabled,
      setIdentityMatchingEnabled: h.setIdentityMatchingEnabled,
    },
  }),
}));

import {
  useIdentityMatchingEnabledSetting,
  useNotificationsSetting,
  useSetIdentityMatchingEnabled,
  useSetNotifications,
} from './useSettings';

function wrapper() {
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return function Wrapper({ children }: { children: React.ReactNode }) {
    return <QueryClientProvider client={qc}>{children}</QueryClientProvider>;
  };
}

/** Both hooks under one provider, so the mutation writes the cache the query reads. */
function renderToggle() {
  return renderHook(
    () => ({ value: useNotificationsSetting(), setValue: useSetNotifications() }),
    { wrapper: wrapper() },
  );
}

/** A promise resolved by hand, plus a `settled` flag so a test can prove the
 *  backend write had NOT completed at the moment it asserted. */
function defer<T>() {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  const box = {
    promise,
    settled: false,
    resolve: (v: T) => {
      box.settled = true;
      resolve(v);
    },
    reject: (e: unknown) => {
      box.settled = true;
      reject(e);
    },
  };
  return box;
}

describe('settings toggles write optimistically', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    h.getNotifications.mockResolvedValue({ success: true, notifications_enabled: true });
  });

  test('the toggle flips before the backend write resolves', async () => {
    const write = defer<{ success: true }>();
    h.setNotifications.mockReturnValue(write.promise);

    const { result } = renderToggle();
    await waitFor(() => expect(result.current.value.data).toBe(true));

    await act(async () => {
      result.current.setValue.mutate(false);
    });

    // The optimistic write lands one microtask in (onMutate awaits
    // cancelQueries first, per the TanStack pattern) — not after the backend.
    await waitFor(() => expect(result.current.value.data).toBe(false));
    // The decisive part: the value flipped while the write is STILL in flight.
    expect(result.current.setValue.isPending).toBe(true);
    expect(write.settled).toBe(false);

    await act(async () => {
      write.resolve({ success: true });
      await write.promise;
    });
    expect(result.current.value.data).toBe(false);
  });

  test('a successful write does NOT read the value back', async () => {
    h.setNotifications.mockResolvedValue({ success: true });

    const { result } = renderToggle();
    await waitFor(() => expect(result.current.value.data).toBe(true));
    expect(h.getNotifications).toHaveBeenCalledTimes(1); // the initial read

    await act(async () => {
      await result.current.setValue.mutateAsync(false);
    });

    expect(h.setNotifications).toHaveBeenCalledTimes(1);
    expect(h.setNotifications).toHaveBeenCalledWith(false);
    // Still 1: no refetch was bolted onto the write. This is the assertion that
    // fails if `onSuccess: invalidateQueries` ever comes back.
    expect(h.getNotifications).toHaveBeenCalledTimes(1);
  });

  test('a failed write rolls the toggle back', async () => {
    h.setNotifications.mockRejectedValue(new Error('backend unavailable'));

    const { result } = renderToggle();
    await waitFor(() => expect(result.current.value.data).toBe(true));

    await act(async () => {
      await result.current.setValue.mutateAsync(false).catch(() => {});
    });

    // Disk still holds `true`, so the switch must not claim otherwise.
    await waitFor(() => expect(result.current.value.data).toBe(true));
  });
});

describe('speaker identification toggle', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    h.getIdentityMatchingEnabled.mockResolvedValue({
      success: true,
      identity_matching_enabled: false,
    });
    h.setIdentityMatchingEnabled.mockResolvedValue({ success: true });
  });

  test('updates its shared cache without a redundant backend read', async () => {
    const { result } = renderHook(
      () => ({
        value: useIdentityMatchingEnabledSetting(),
        setValue: useSetIdentityMatchingEnabled(),
      }),
      { wrapper: wrapper() },
    );
    await waitFor(() => expect(result.current.value.data).toBe(false));

    await act(async () => {
      await result.current.setValue.mutateAsync(true);
    });

    await waitFor(() => expect(result.current.value.data).toBe(true));
    expect(h.getIdentityMatchingEnabled).toHaveBeenCalledTimes(1);
  });
});
