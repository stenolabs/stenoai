import { act, renderHook, waitFor } from '@testing-library/react';
import { beforeEach, expect, test, vi } from 'vitest';
import { useStreamingQuery } from './useStreamingQuery';
import { CHART_INSTRUCTIONS } from '@/lib/chatChart';
import { ORG_SHARED_SCOPE } from '@/components/FolderScopePicker';

const bridge = vi.hoisted(() => ({
  subscribeQueryStream: vi.fn(() => () => {}),
  query: { cancel: vi.fn() },
  org: {
    listMeetings: vi.fn(async () => ({ success: true, meetings: [] })),
    chatStream: vi.fn(),
  },
}));
vi.mock('@/lib/ipc', () => ({ ipc: () => bridge }));
vi.mock('@/components/FolderScopePicker', () => ({ ORG_SHARED_SCOPE: '__org_shared__' }));
beforeEach(() => vi.clearAllMocks());

test.each(['global', 'note'])(
  'org %s chat sends chart instructions through the bridge',
  async (scope) => {
    const { result, unmount } = renderHook(() => useStreamingQuery());
    act(() => {
      if (scope === 'global')
        result.current.startGlobalStream('Chart the actions', ORG_SHARED_SCOPE);
      else result.current.startOrgNoteStream('Planning: 3 actions.', 'Chart the actions');
    });
    await waitFor(() => expect(bridge.org.chatStream).toHaveBeenCalledOnce());
    const [, payload] = bridge.org.chatStream.mock.calls[0];
    expect(payload.system).toContain(CHART_INSTRUCTIONS);
    expect(payload.messages).toContainEqual({ role: 'user', content: 'Chart the actions' });
    unmount();
  }
);
