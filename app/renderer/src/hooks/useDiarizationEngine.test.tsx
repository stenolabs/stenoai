import { describe, test, expect, beforeEach, vi } from 'vitest';
import * as React from 'react';
import { renderHook, act, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

/**
 * Meeting processing never downloads speaker models, so switching engines
 * must prepare any missing models BEFORE the choice is saved -- otherwise
 * every later meeting silently falls back to channel-only "You"/"Others"
 * labels. That includes Sortformer: FluidAudio 0.17 moved its cache to
 * `sortformer/v3/fp16/`, so an upgraded install has to re-download it. These
 * pin the ordering, the upgrade case and the failure path.
 */

const h = vi.hoisted(() => ({
  getEngine: vi.fn(),
  setEngine: vi.fn(),
  speakerModels: vi.fn(),
  speakerModelsStatus: vi.fn(),
  progressListener: null as ((event: { percent: number; phase: string }) => void) | null,
}));

vi.mock('@/lib/ipc', () => ({
  ipc: () => ({
    diarizationEngine: { get: h.getEngine, set: h.setEngine },
    setup: { speakerModels: h.speakerModels, speakerModelsStatus: h.speakerModelsStatus },
    on: {
      speakerModelsProgress: (cb: (event: { percent: number; phase: string }) => void) => {
        h.progressListener = cb;
        return () => {
          h.progressListener = null;
        };
      },
    },
  }),
}));

import {
  useDiarizationEngine,
  useDiarizationModelsState,
  useDownloadDiarizationModels,
  useSetDiarizationEngine,
} from './useModels';

function status(ready: boolean) {
  return {
    success: true,
    ready,
    cache_directory: '/tmp/models',
    required_models: [],
    missing_models: ready ? [] : ['sortformer/v3/fp16/Sortformer_v2.1.mlmodelc'],
  };
}

const UNAVAILABLE = {
  success: false,
  ready: false,
  error: 'Speaker diarization is unavailable on this system',
};

function wrapper() {
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return function Wrapper({ children }: { children: React.ReactNode }) {
    return <QueryClientProvider client={qc}>{children}</QueryClientProvider>;
  };
}

function renderEngine() {
  return renderHook(
    () => {
      const engine = useDiarizationEngine();
      return {
        engine,
        models: useDiarizationModelsState(engine.data),
        setEngine: useSetDiarizationEngine(),
        download: useDownloadDiarizationModels(),
      };
    },
    { wrapper: wrapper() },
  );
}

describe('useSetDiarizationEngine', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    h.getEngine.mockResolvedValue({
      success: true,
      engine: 'sortformer',
      valid_engines: ['sortformer', 'nemotron3'],
    });
    h.speakerModelsStatus.mockResolvedValue(status(true));
  });

  test('prepares missing Nemotron 3 models before saving the choice', async () => {
    h.speakerModelsStatus.mockImplementation(async (engine?: string) =>
      status(engine !== 'nemotron3'),
    );
    h.speakerModels.mockResolvedValue(status(true));
    h.setEngine.mockResolvedValue({ success: true, engine: 'nemotron3' });
    const { result } = renderEngine();
    await waitFor(() => expect(result.current.engine.data).toBe('sortformer'));

    await act(async () => {
      await result.current.setEngine.mutateAsync('nemotron3');
    });

    expect(h.speakerModelsStatus).toHaveBeenCalledWith('nemotron3');
    expect(h.speakerModels).toHaveBeenCalledWith('nemotron3');
    expect(h.speakerModels.mock.invocationCallOrder[0]).toBeLessThan(
      h.setEngine.mock.invocationCallOrder[0],
    );
    expect(h.setEngine).toHaveBeenCalledWith('nemotron3');
    await waitFor(() => expect(result.current.engine.data).toBe('nemotron3'));
  });

  test('a failed download never saves the engine and keeps the previous one', async () => {
    h.speakerModelsStatus.mockResolvedValue(status(false));
    h.speakerModels.mockResolvedValue({ success: false, ready: false, error: 'offline' });
    const { result } = renderEngine();
    await waitFor(() => expect(result.current.engine.data).toBe('sortformer'));

    await act(async () => {
      await result.current.setEngine.mutateAsync('nemotron3').catch(() => undefined);
    });

    expect(h.setEngine).not.toHaveBeenCalled();
    await waitFor(() => expect(result.current.setEngine.isError).toBe(true));
    expect(result.current.engine.data).toBe('sortformer');
  });

  test('an engine whose models are ready switches without a download', async () => {
    h.setEngine.mockResolvedValue({ success: true, engine: 'sortformer' });
    const { result } = renderEngine();
    await waitFor(() => expect(result.current.engine.data).toBe('sortformer'));

    await act(async () => {
      await result.current.setEngine.mutateAsync('sortformer');
    });

    expect(h.speakerModels).not.toHaveBeenCalled();
    expect(h.setEngine).toHaveBeenCalledWith('sortformer');
  });

  test('an upgraded install re-downloads missing Sortformer models', async () => {
    let prepared = false;
    h.speakerModelsStatus.mockImplementation(async () => status(prepared));
    h.speakerModels.mockImplementation(async () => {
      prepared = true;
      return status(true);
    });
    h.setEngine.mockResolvedValue({ success: true, engine: 'sortformer' });
    const { result } = renderEngine();
    await waitFor(() => expect(result.current.models.data).toBe('missing'));

    await act(async () => {
      await result.current.setEngine.mutateAsync('sortformer');
    });

    expect(h.speakerModels).toHaveBeenCalledWith('sortformer');
    expect(h.setEngine).toHaveBeenCalledWith('sortformer');
    await waitFor(() => expect(result.current.models.data).toBe('ready'));
  });

  test('an unavailable sidecar never blocks switching back to Sortformer', async () => {
    h.speakerModelsStatus.mockResolvedValue(UNAVAILABLE);
    h.setEngine.mockResolvedValue({ success: true, engine: 'sortformer' });
    const { result } = renderEngine();
    await waitFor(() => expect(result.current.engine.data).toBe('sortformer'));

    await act(async () => {
      await result.current.setEngine.mutateAsync('sortformer');
    });

    expect(h.speakerModels).not.toHaveBeenCalled();
    expect(h.setEngine).toHaveBeenCalledWith('sortformer');
    // Nothing confirmed the models, so readiness must not read as ready.
    await waitFor(() => expect(result.current.models.isFetching).toBe(false));
    expect(result.current.models.data).toBe('unavailable');
  });
});

describe('useDiarizationModelsState', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    h.getEngine.mockResolvedValue({
      success: true,
      engine: 'sortformer',
      valid_engines: ['sortformer', 'nemotron3'],
    });
  });

  test("reports the saved engine's readiness", async () => {
    h.speakerModelsStatus.mockResolvedValue(status(false));
    const { result } = renderEngine();

    await waitFor(() => expect(result.current.models.data).toBe('missing'));
    expect(h.speakerModelsStatus).toHaveBeenCalledWith('sortformer');
  });

  test('tells a build without the sidecar apart from a failed check', async () => {
    h.speakerModelsStatus.mockResolvedValue(UNAVAILABLE);
    const unavailable = renderEngine();
    await waitFor(() => expect(unavailable.result.current.models.data).toBe('unavailable'));

    h.speakerModelsStatus.mockResolvedValue({
      success: false,
      ready: false,
      error: 'Could not check the speaker diarization models',
    });
    const failed = renderEngine();
    await waitFor(() => expect(failed.result.current.models.data).toBe('unknown'));
  });
});

describe('useDownloadDiarizationModels', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    h.getEngine.mockResolvedValue({
      success: true,
      engine: 'nemotron3',
      valid_engines: ['sortformer', 'nemotron3'],
    });
    h.speakerModelsStatus.mockResolvedValue(status(false));
  });

  test("downloads the given engine's models, relaying progress until it ends", async () => {
    let finish: (value: ReturnType<typeof status>) => void = () => undefined;
    h.speakerModels.mockImplementation(
      () => new Promise((resolve) => {
        finish = resolve;
      }),
    );
    const { result } = renderEngine();
    await waitFor(() => expect(result.current.models.data).toBe('missing'));

    act(() => {
      result.current.download.download.mutate('nemotron3');
    });
    await waitFor(() => expect(h.speakerModels).toHaveBeenCalledWith('nemotron3'));
    act(() => h.progressListener?.({ percent: 37, phase: 'downloading' }));
    expect(result.current.download.progress).toEqual({ percent: 37, phase: 'downloading' });

    h.speakerModelsStatus.mockResolvedValue(status(true));
    await act(async () => finish(status(true)));
    await waitFor(() => expect(result.current.models.data).toBe('ready'));
    expect(result.current.download.progress).toBeNull();
    expect(h.setEngine).not.toHaveBeenCalled();
  });

  test('a failed download is an error and leaves the models missing', async () => {
    h.speakerModels.mockResolvedValue({ success: false, ready: false, error: 'offline' });
    const { result } = renderEngine();
    await waitFor(() => expect(result.current.models.data).toBe('missing'));

    await act(async () => {
      await result.current.download.download.mutateAsync('nemotron3').catch(() => undefined);
    });

    await waitFor(() => expect(result.current.download.download.isError).toBe(true));
    expect(result.current.models.data).toBe('missing');
  });
});
