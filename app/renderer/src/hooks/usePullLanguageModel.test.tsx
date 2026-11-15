import { describe, test, expect, beforeEach, vi } from 'vitest';
import * as React from 'react';
import { renderHook, act, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

/**
 * The language-model download survives Settings unmounting: on remount the
 * hook rejoins the pull still running in the main process. Only the call that
 * started the download may switch language models back on, so a switch-off
 * made while it ran is not undone by the rejoined call finishing.
 */

const HEBREW = 'ivrit-large-v3-turbo';

const h = vi.hoisted(() => ({
  list: vi.fn(),
  pull: vi.fn(),
  setLanguageModelsEnabled: vi.fn(),
  activePulls: vi.fn(),
}));

vi.mock('@/lib/ipc', () => ({
  ipc: () => ({
    whisperModels: {
      list: h.list,
      pull: h.pull,
      setLanguageModelsEnabled: h.setLanguageModelsEnabled,
      activePulls: h.activePulls,
    },
    on: {
      whisperPullProgress: () => () => {},
      whisperPullComplete: () => () => {},
    },
  }),
}));

import { usePullLanguageModel } from './useModels';

function wrapper() {
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return function Wrapper({ children }: { children: React.ReactNode }) {
    return <QueryClientProvider client={qc}>{children}</QueryClientProvider>;
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  h.list.mockResolvedValue({
    success: true,
    supported_models: {},
    current_model: 'large-v3-turbo',
    language_models: {
      [HEBREW]: { name: 'ivrit.ai Hebrew Turbo', language: 'he', size: '1.6GB', installed: false },
    },
    language_models_enabled: true,
  });
  h.pull.mockResolvedValue({ success: true, model: HEBREW });
  h.setLanguageModelsEnabled.mockResolvedValue({ success: true, language_models_enabled: true });
});

describe('usePullLanguageModel', () => {
  test('a download started here switches language models on when it finishes', async () => {
    h.activePulls.mockResolvedValue({});
    const { result } = renderHook(() => usePullLanguageModel(), { wrapper: wrapper() });
    await waitFor(() => expect(h.activePulls).toHaveBeenCalled());

    act(() => result.current.mutate(HEBREW));

    await waitFor(() => expect(h.setLanguageModelsEnabled).toHaveBeenCalledWith(true));
    expect(h.pull).toHaveBeenCalledWith(HEBREW);
  });

  test('a remount rejoins a running download without switching language models on', async () => {
    h.activePulls.mockResolvedValue({ [HEBREW]: 'Downloading 42%' });
    const { result } = renderHook(() => usePullLanguageModel(), { wrapper: wrapper() });

    await waitFor(() => expect(h.pull).toHaveBeenCalledWith(HEBREW));
    expect(result.current.progress[HEBREW]).toBe('Downloading 42%');
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(h.setLanguageModelsEnabled).not.toHaveBeenCalled();
  });
});
