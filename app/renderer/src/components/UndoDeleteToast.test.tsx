import { describe, test, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, fireEvent, waitFor, act } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { setLocale } from '@/i18n/index';
import type { Meeting } from '@/lib/ipc';
import { UndoDeleteToast } from '@/components/UndoDeleteToast';
import { useUndoDeleteStore } from '@/hooks/undoDeleteStore';

/**
 * Renderer flow for the simplified soft-delete Undo toast (#234, tombstone
 * pivot). Deletion hides only the summary (an atomic rename in main), so Undo is
 * a near-infallible rename-back — the old restoring/restoreFailed/rearm machinery
 * is gone. The contract asserted here:
 *   - Undo calls undoDelete(id) and, on success, removes the toast entry.
 *   - Undo failure (rare no-clobber) LEAVES the toast up (main's timer backstops).
 *   - Dismiss (X) removes the entry and commits the permanent delete.
 * jsdom + real zustand store; only ipc() + the transitive useMeetings deps are
 * mocked, so useUndoDeleteMeeting/useCommitDeleteMeeting run for real.
 */

const undoMock =
  vi.fn<(id: string) => Promise<{ success: boolean; error?: string; meeting?: Meeting }>>();
const commitMock = vi.fn(async () => ({ success: true }));
// Rehydration runs once (module guard) on the first mount; keep it empty so it
// never clobbers the entries a test adds.
const listPendingMock = vi.fn(async () => ({ success: true as const, pending: [] }));

vi.mock('@/lib/ipc', () => ({
  ipc: () => ({
    meetings: {
      undoDelete: (id: string) => undoMock(id),
      commitDelete: () => commitMock(),
      listPendingDeletes: () => listPendingMock(),
    },
  }),
}));
// useMeetings (imported transitively by UndoDeleteToast) pulls these at import
// time; inert stubs keep the import graph off Electron/zustand internals.
vi.mock('@/hooks/useRecording', () => ({
  useRecording: () => ({ status: 'idle', sessionName: null, elapsed: 0, reprocessingSummaryFiles: new Set() }),
}));
vi.mock('@/hooks/liveDraftStore', () => ({ useLiveDraftStore: () => undefined }));

const mkMeeting = (summaryFile: string, name: string): Meeting =>
  ({ session_info: { summary_file: summaryFile, name } }) as unknown as Meeting;

function makeClient() {
  return new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
}

function renderToast() {
  const qc = makeClient();
  const utils = render(
    <QueryClientProvider client={qc}>
      <UndoDeleteToast />
    </QueryClientProvider>,
  );
  return { qc, ...utils };
}

const entries = () => useUndoDeleteStore.getState().entries;

const mkEntry = (id: string, summaryFile: string, name: string) => ({
  id,
  meeting: mkMeeting(summaryFile, name),
  summaryFile,
  deadline: Date.now() + 8000,
});

describe('UndoDeleteToast — tombstone Undo flow', () => {
  beforeEach(() => {
    setLocale('en');
    undoMock.mockReset();
    commitMock.mockClear();
    listPendingMock.mockClear();
    const host = document.createElement('div');
    host.id = 'toast-host';
    document.body.appendChild(host);
    useUndoDeleteStore.setState({ entries: [] });
  });

  afterEach(() => {
    document.getElementById('toast-host')?.remove();
    useUndoDeleteStore.setState({ entries: [] });
  });

  test('a SUCCESSFUL undo removes the entry', async () => {
    undoMock.mockResolvedValue({ success: true, meeting: mkMeeting('a.json', 'Alpha') });
    useUndoDeleteStore.getState().add(mkEntry('d-ok', 'a.json', 'Alpha'));

    const { getByRole } = renderToast();
    await act(async () => {
      fireEvent.click(getByRole('button', { name: /undo/i }));
    });

    await waitFor(() => expect(undoMock).toHaveBeenCalledWith('d-ok'));
    await waitFor(() => expect(entries().find((x) => x.id === 'd-ok')).toBeUndefined());
  });

  test('a FAILED undo leaves the entry on screen (main timer backstops)', async () => {
    undoMock.mockResolvedValue({ success: false, error: 'restore target already exists' });
    useUndoDeleteStore.getState().add(mkEntry('d-fail', 'a.json', 'Alpha'));

    const { getByRole } = renderToast();
    await act(async () => {
      fireEvent.click(getByRole('button', { name: /undo/i }));
    });

    await waitFor(() => expect(undoMock).toHaveBeenCalledWith('d-fail'));
    // The entry is STILL present — not removed on a failed undo.
    await waitFor(() => expect(entries().find((x) => x.id === 'd-fail')).toBeTruthy());
  });

  test('dismiss (X) removes the entry and commits the permanent delete', async () => {
    useUndoDeleteStore.getState().add(mkEntry('d-dismiss', 'a.json', 'Alpha'));

    const { getByRole } = renderToast();
    await act(async () => {
      fireEvent.click(getByRole('button', { name: /dismiss/i }));
    });

    await waitFor(() => expect(commitMock).toHaveBeenCalled());
    await waitFor(() => expect(entries().find((x) => x.id === 'd-dismiss')).toBeUndefined());
  });
});
