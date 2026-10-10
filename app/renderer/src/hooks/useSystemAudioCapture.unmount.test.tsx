import { describe, test, expect, beforeEach, afterEach, vi } from 'vitest';
import * as React from 'react';
import { renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

/**
 * #568: the hook's unmount cleanup must end the live-transcribe sidecar that
 * main spawned for this recording. In production the hook unmounts when the
 * root ErrorBoundary replaces the app after a render error (and in dev under
 * StrictMode/HMR). A start still waiting on getUserMedia sees `cancelled()`
 * afterwards and skips its own failure path, so the cleanup is the only place
 * left to send `live-transcribe-stop`.
 *
 * The dependency hooks are mocked rather than the whole IPC surface: what is
 * under test is the cleanup's decision, not the settings queries.
 */

const h = vi.hoisted(() => ({
  status: 'idle' as 'idle' | 'recording' | 'paused' | 'processing',
  liveStop: vi.fn(),
  reportState: vi.fn(),
  disableLoopback: vi.fn(async () => ({ success: true })),
  closeFile: vi.fn(async () => ({ success: true })),
  getUserMedia: vi.fn(),
}));

vi.mock('./useRecording', () => ({
  useRecording: () => ({ status: h.status, sessionName: 'Unmount note' }),
}));
vi.mock('./useModels', () => ({
  useTranscriptionEngine: () => ({ data: 'parakeet' }),
}));
vi.mock('./useSettings', () => ({
  settingsKeys: { microphone: () => ['settings', 'microphone'] },
  useMicrophoneSetting: () => ({ data: { device_id: null, label: null } }),
  useSystemAudioSetting: () => ({ data: true }),
  useSystemAudioSupport: () => ({ data: { supported: true } }),
  useSilenceAutoStopSetting: () => ({ data: { enabled: false, minutes: 15 } }),
}));
vi.mock('@/lib/ipc', () => ({
  ipc: () => ({
    settings: {
      getMicrophone: async () => ({ success: true, device_id: null, label: null }),
    },
    recording: {
      reportSystemAudioState: h.reportState,
      disableLoopbackAudio: h.disableLoopback,
      closeSystemAudioFile: h.closeFile,
    },
    liveTranscript: { stop: h.liveStop, pushChunk: vi.fn() },
  }),
}));

import { useSystemAudioCapture } from './useSystemAudioCapture';

function wrapper({ children }: { children: React.ReactNode }) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return <QueryClientProvider client={qc}>{children}</QueryClientProvider>;
}

describe('useSystemAudioCapture unmount cleanup (#568)', () => {
  beforeEach(() => {
    h.status = 'idle';
    vi.clearAllMocks();
    // jsdom has no media devices; a start that never gets its microphone is
    // exactly the "unmounted while still starting" case.
    h.getUserMedia.mockImplementation(() => new Promise(() => {}));
    Object.defineProperty(navigator, 'mediaDevices', {
      configurable: true,
      value: { getUserMedia: h.getUserMedia },
    });
  });

  afterEach(() => {
    Reflect.deleteProperty(navigator, 'mediaDevices');
  });

  test('stops live transcription when unmounted while a start is pending', async () => {
    h.status = 'recording';
    const { unmount } = renderHook(() => useSystemAudioCapture(), { wrapper });
    await waitFor(() => expect(h.getUserMedia).toHaveBeenCalled());

    unmount();

    expect(h.liveStop).toHaveBeenCalledTimes(1);
    expect(h.reportState).toHaveBeenCalledWith(false);
  });

  test('leaves live transcription alone when no capture was running', () => {
    // A plain unmount (StrictMode's simulated one, or an idle app) must not
    // stop a sidecar this instance never owned.
    const { unmount } = renderHook(() => useSystemAudioCapture(), { wrapper });

    unmount();

    expect(h.liveStop).not.toHaveBeenCalled();
    expect(h.reportState).not.toHaveBeenCalled();
  });
});
