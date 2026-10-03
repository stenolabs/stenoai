import * as React from 'react';
import { test, expect, vi } from 'vitest';
import { renderHook, act, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ChatSessionsBlob } from '@/lib/ipc';

const h = vi.hoisted(() => ({ load: vi.fn(), save: vi.fn() }));
vi.mock('@/lib/ipc', () => ({ ipc: () => ({ chat: h }) }));
import { useChatSessions } from './useChatSessions';

test('scope changes cannot overwrite history before loading or after a session disappears', async () => {
  let finish!: (value: { success: true; data: ChatSessionsBlob }) => void;
  h.load.mockReturnValue(new Promise((resolve) => { finish = resolve; }));
  h.save.mockResolvedValue({ success: true });
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const wrapper = ({ children }: { children: React.ReactNode }) => <QueryClientProvider client={client}>{children}</QueryClientProvider>;
  const { result } = renderHook(() => useChatSessions('__global__'), { wrapper });
  await act(() => result.current.setScope('saved', '__general__'));
  expect(h.save).not.toHaveBeenCalled();
  const session = { id: 'saved', name: 'Retained', summaryFile: '__global__', messages: [], createdAt: 1, updatedAt: 1 };
  await act(async () => finish({ success: true, data: { sessions: [session] } }));
  await waitFor(() => expect(result.current.isLoading).toBe(false));
  await act(() => result.current.setScope('missing', null));
  expect(h.save).not.toHaveBeenCalled();
  await act(() => result.current.setScope('saved', '__general__'));
  expect(h.save).toHaveBeenCalledWith({ sessions: [{ ...session, scopeFolderId: '__general__', updatedAt: expect.any(Number) }] });
});
