import * as React from 'react';
import { act, renderHook } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { beforeEach, describe, expect, test, vi } from 'vitest';

const h = vi.hoisted(() => ({
  confirm: vi.fn(),
  markCluster: vi.fn(),
}));

vi.mock('@/lib/ipc', () => ({
  ipc: () => ({
    speakers: {
      confirm: h.confirm,
      markCluster: h.markCluster,
    },
  }),
}));

import { meetingsKeys } from './meetingKeys';
import {
  speakersKeys,
  useConfirmSpeaker,
  useMarkSpeakerCluster,
} from './useSpeakerSuggestions';

function renderMutation<T>(hook: () => T) {
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  const invalidate = vi.spyOn(qc, 'invalidateQueries').mockResolvedValue();
  const wrapper = ({ children }: { children: React.ReactNode }) => (
    <QueryClientProvider client={qc}>{children}</QueryClientProvider>
  );
  return { ...renderHook(hook, { wrapper }), invalidate };
}

describe('speaker mutation recovery refreshes committed backend state', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    h.confirm.mockResolvedValue({ success: false, error: 'transcript write failed' });
    h.markCluster.mockResolvedValue({ success: false, error: 'transcript write failed' });
  });

  test('a failed confirm refreshes suggestions, profiles, and the meeting detail', async () => {
    const summaryFile = '/data/mtg001_summary.md';
    const { result, invalidate } = renderMutation(useConfirmSpeaker);

    await act(async () => {
      await result.current.mutateAsync({
        meetingStem: 'mtg001',
        channel: 'mic',
        diarizationSpeakerId: 'SPEAKER_00',
        expectedRunId: 'run-1',
        newPersonName: 'Person Alpha',
        summaryFile,
      }).catch(() => {});
    });

    expect(invalidate).toHaveBeenCalledWith({
      queryKey: speakersKeys.suggestions('mtg001'),
    });
    expect(invalidate).toHaveBeenCalledWith({ queryKey: speakersKeys.profiles() });
    expect(invalidate).toHaveBeenCalledWith({ queryKey: meetingsKeys.detail(summaryFile) });
  });

  test('a failed mark refreshes all speaker state and the meeting detail', async () => {
    const summaryFile = '/data/mtg001_summary.md';
    const { result, invalidate } = renderMutation(useMarkSpeakerCluster);

    await act(async () => {
      await result.current.mutateAsync({
        meetingStem: 'mtg001',
        channel: 'mic',
        diarizationSpeakerId: 'SPEAKER_00',
        expectedRunId: 'run-1',
        containsMultipleSpeakers: true,
        summaryFile,
      }).catch(() => {});
    });

    expect(invalidate).toHaveBeenCalledWith({ queryKey: speakersKeys.all });
    expect(invalidate).toHaveBeenCalledWith({ queryKey: meetingsKeys.detail(summaryFile) });
  });
});
