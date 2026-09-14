import { describe, test, expect, beforeEach, vi } from 'vitest';
import { act, render, screen, fireEvent, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { TooltipProvider } from '@/components/ui/tooltip';
import type { Meeting } from '@/lib/ipc';
import { streamCache, pendingTitleRegens } from '@/lib/meetingDetailState';

/**
 * The regenerate guard, driven through the REAL MeetingDetail wiring rather
 * than a standalone dialog component.
 *
 * Every path here rebuilds the note from the transcript, which throws away the
 * user's corrections. The guard is only worth having if it fires on all of them
 * (the header CTA, the retry banner, and the floating Generate-notes bar that
 * MeetingDetail publishes for a stale/pending note) and only if it stays quiet
 * on a note with nothing to lose. So the tests click the real controls and
 * assert against the real reprocess mutation, not against a prop.
 *
 * Radix Dialog/Popover/Select need these; jsdom implements none of them.
 */
if (!Element.prototype.hasPointerCapture) {
  Element.prototype.hasPointerCapture = () => false;
}
if (!Element.prototype.setPointerCapture) {
  Element.prototype.setPointerCapture = () => {};
}
if (!Element.prototype.releasePointerCapture) {
  Element.prototype.releasePointerCapture = () => {};
}
if (!Element.prototype.scrollIntoView) {
  Element.prototype.scrollIntoView = () => {};
}
// MeetingDetail remembers the last opened note. Node's global localStorage is
// unavailable without --localstorage-file, so give it an in-memory one.
if (!globalThis.localStorage) {
  const store = new Map<string, string>();
  Object.defineProperty(globalThis, 'localStorage', {
    configurable: true,
    value: {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => void store.set(k, String(v)),
      removeItem: (k: string) => void store.delete(k),
      clear: () => store.clear(),
    },
  });
}

const h = vi.hoisted(() => {
  const noop = () => () => {};
  return {
    meeting: null as Meeting | null,
    reprocess: { mutate: vi.fn(), isPending: false },
    retranscribe: { mutate: vi.fn(), isPending: false },
    recordingAvailable: { data: false as boolean | undefined },
    publish: vi.fn(),
    clear: vi.fn(),
    navigate: vi.fn(),
    noop,
  };
});

vi.mock('@/components/MeetingsShell', () => ({
  MeetingsShell: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}));

vi.mock('@/hooks/useMeetings', () => ({
  meetingsKeys: {
    all: ['meetings'] as const,
    detail: (f: string) => ['meetings', 'detail', f] as const,
  },
  useMeeting: () => ({
    data: h.meeting,
    isLoading: false,
    isFetching: false,
    isError: false,
    error: null,
  }),
  useReprocessMeeting: () => h.reprocess,
  useRetranscribeMeeting: () => h.retranscribe,
  useRecordingAvailable: () => h.recordingAvailable,
  useDeleteMeeting: () => ({ mutate: vi.fn(), mutateAsync: vi.fn(), isPending: false }),
  useGenerateReport: () => ({ mutate: vi.fn(), isPending: false }),
  useSetActiveReport: () => ({ mutate: vi.fn() }),
  useDeleteReport: () => ({ mutate: vi.fn() }),
  useUpdateMeeting: () => ({ mutate: vi.fn(), mutateAsync: vi.fn(), isPending: false }),
  useUpdateUserNotes: () => ({ mutate: vi.fn() }),
}));

vi.mock('@/hooks/useTemplates', () => ({ useTemplates: () => ({ templates: [] }) }));

vi.mock('@/hooks/useOrg', () => ({
  useOrgSession: () => ({ data: { signedIn: false } }),
  useShareToOrg: () => ({ mutateAsync: vi.fn(), isPending: false }),
  useOrgBackupState: () => ({ data: undefined }),
  useUnshareFromOrgBySummary: () => ({ mutateAsync: vi.fn(), isPending: false }),
}));

vi.mock('@/hooks/useFolders', () => ({
  useFolders: () => ({ data: [] }),
  useAddMeetingToFolder: () => ({ mutateAsync: vi.fn() }),
  useRemoveMeetingFromFolder: () => ({ mutateAsync: vi.fn() }),
  useCreateFolder: () => ({ mutateAsync: vi.fn() }),
}));

vi.mock('@/lib/askBarContext', () => ({ useActiveMeeting: () => {} }));

vi.mock('@/lib/router', () => ({ navigate: (...a: unknown[]) => h.navigate(...a) }));

vi.mock('@/hooks/useRecording', () => ({
  useRecording: () => ({ status: 'idle', isLoading: false, reprocessingSummaryFiles: new Set(), recordingSummaryFile: null }),
}));

vi.mock('@/hooks/reprocessBridgeStore', () => ({
  useReprocessBridge: (select: (s: unknown) => unknown) =>
    select({ publish: h.publish, clear: h.clear }),
}));

vi.mock('@/lib/ipc', () => ({
  ipc: () => ({
    app: { platform: 'darwin' },
    on: {
      summaryChunk: h.noop,
      summaryComplete: h.noop,
      processingComplete: h.noop,
      processingProgress: h.noop,
    },
    meetings: {
      revealFolder: vi.fn(),
      exportTranscript: vi.fn(),
      exportNotePdf: vi.fn(),
      regenTitle: vi.fn(),
    },
  }),
}));

// Imported after the mocks so the module graph picks them up.
const { MeetingDetail } = await import('./MeetingDetail');

const SUMMARY_FILE = '/tmp/output/quarterly_summary.md';

function makeMeeting(overrides: Partial<Meeting> = {}): Meeting {
  return {
    session_info: {
      name: 'Quarterly Review',
      summary_file: SUMMARY_FILE,
      date: '2026-07-28T10:00:00',
      duration_seconds: 600,
    },
    summary: 'The team agreed to ship on Friday.',
    key_points: ['Ship Friday'],
    action_items: ['Alice pings the vendor'],
    discussion_areas: [{ title: 'Billing', analysis: 'Blocked on the vendor.' }],
    participants: ['Alice'],
    transcript: 'Alice: we ship Friday.',
    ...overrides,
  } as Meeting;
}

function renderDetail(meeting: Meeting) {
  h.meeting = meeting;
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <TooltipProvider>
        <MeetingDetail summaryFile={SUMMARY_FILE} />
      </TooltipProvider>
    </QueryClientProvider>
  );
}

const headerRegenerate = () => screen.getByRole('button', { name: 'Generate notes' });

/** The confirm dialog if it is on screen, else null. */
function dialog() {
  return document.querySelector('[data-confirm-dialog]');
}

/** ConfirmDialog's handler is async (it awaits onConfirm before clearing its
 *  busy flag), so the click has to be flushed inside act. */
async function clickConfirm(name: RegExp) {
  const button = within(dialog() as HTMLElement).getByRole('button', { name });
  await act(async () => {
    fireEvent.click(button);
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  // Module-level state that outlives a render: a previous test's "analyzing"
  // entry would trip startReprocess's re-entrancy guard in the next one and
  // make a broken guard look like a working one.
  streamCache.clear();
  pendingTitleRegens.clear();
  h.reprocess = { mutate: vi.fn(), isPending: false };
  h.retranscribe = { mutate: vi.fn(), isPending: false };
  h.recordingAvailable = { data: false };
});

describe('the regenerate guard', () => {
  test('asks before regenerating a note that has edits, naming the sections', () => {
    renderDetail(makeMeeting({ edited_fields: ['summary', 'action_items'] }));
    fireEvent.click(headerRegenerate());

    expect(h.reprocess.mutate).not.toHaveBeenCalled();
    const box = dialog();
    expect(box).toBeTruthy();
    // Human section names, not the raw field keys the sidecar stores.
    expect(within(box as HTMLElement).getByText(/Summary/)).toBeTruthy();
    expect(within(box as HTMLElement).getByText(/Action items/)).toBeTruthy();
    expect(box!.textContent).not.toContain('action_items');
    // The edited version's fate is stated once, not "replaced" and "kept" in
    // the same breath, and it names the on-screen control (the menu next to
    // the Summary switcher) rather than the data-testid.
    expect(box!.textContent).toContain(
      'Your edited version stays available as "Standard" with a timestamp, in the menu next to Summary.'
    );
    expect(box!.textContent).not.toContain('note view menu');
  });

  test('confirming goes ahead with the rebuild', async () => {
    renderDetail(makeMeeting({ edited_fields: ['summary'] }));
    fireEvent.click(headerRegenerate());
    await clickConfirm(/regenerate notes/i);
    expect(h.reprocess.mutate).toHaveBeenCalledTimes(1);
    expect(h.reprocess.mutate.mock.calls[0][0]).toMatchObject({ summaryFile: SUMMARY_FILE });
  });

  test('cancelling does nothing at all', async () => {
    renderDetail(makeMeeting({ edited_fields: ['summary'] }));
    fireEvent.click(headerRegenerate());
    await clickConfirm(/keep my edits/i);
    expect(h.reprocess.mutate).not.toHaveBeenCalled();
    expect(h.navigate).not.toHaveBeenCalled();
  });

  // The three shapes that all mean "nothing to lose". A prompt on any of them
  // teaches the user to click through the one that matters.
  test.each([
    ['an empty list', [] as string[]],
    ['a missing field', undefined],
    ['a null field', null as unknown as string[]],
  ])('regenerates immediately with %s', (_label, editedFields) => {
    renderDetail(makeMeeting({ edited_fields: editedFields }));
    fireEvent.click(headerRegenerate());
    expect(dialog()).toBeNull();
    expect(h.reprocess.mutate).toHaveBeenCalledTimes(1);
  });

  test('the retry banner CTA is guarded too', async () => {
    renderDetail(makeMeeting({ edited_fields: ['key_points'] }));
    // Drive the banner the way the user does: a failed regenerate renders it.
    fireEvent.click(headerRegenerate());
    await clickConfirm(/regenerate notes/i);
    const onError = h.reprocess.mutate.mock.calls[0][1].onError as () => void;
    act(() => onError());
    h.reprocess.mutate.mockClear();

    const banner = screen.getByTestId('reprocess-retry');
    fireEvent.click(within(banner).getByRole('button', { name: /generate notes/i }));
    expect(h.reprocess.mutate).not.toHaveBeenCalled();
    expect(within(dialog() as HTMLElement).getByText(/Key points/)).toBeTruthy();
  });

  // The floating GenerateNotesBar doesn't live in this tree: MeetingDetail
  // publishes a `start` callback to the bridge and the bar calls it. If the
  // guard sat on the click handlers instead of on the shared entry point, this
  // path would regenerate with no prompt at all.
  test('the published Generate-notes trigger is guarded too', () => {
    renderDetail(
      makeMeeting({
        edited_fields: ['summary'],
        session_info: {
          ...makeMeeting().session_info,
          notes_stale: true,
        },
      })
    );
    const published = h.publish.mock.calls.at(-1)?.[0] as { start: () => void };
    expect(published).toBeTruthy();
    act(() => published.start());
    expect(h.reprocess.mutate).not.toHaveBeenCalled();
    expect(within(dialog() as HTMLElement).getByText(/Summary/)).toBeTruthy();
  });

  // Re-transcribe re-runs ASR and then rewrites the note, so it discards edits
  // exactly like a reprocess. It already had a confirm; the guard has to make
  // that confirm say what it is about to throw away rather than add a second
  // dialog on top of it.
  test('the re-transcribe confirm names the edited sections', () => {
    h.recordingAvailable = { data: true };
    renderDetail(makeMeeting({ edited_fields: ['discussion_areas'] }));
    fireEvent.click(screen.getByRole('button', { name: /more options/i }));
    fireEvent.click(screen.getByTestId('retranscribe-action'));
    const box = dialog() as HTMLElement;
    // Human section names, not the raw field keys the sidecar stores.
    expect(within(box).getByText(/Key topics/)).toBeTruthy();
    expect(box.textContent).not.toContain('discussion_areas');
    // The edited version's fate is stated once, not "replaced" and "kept" in
    // the same breath, and it names the on-screen control (the menu next to
    // the Summary switcher) rather than the data-testid.
    expect(box.textContent).toContain(
      'Your edited version stays available as "Standard" with a timestamp, in the menu next to Summary.'
    );
    expect(box.textContent).not.toContain('note view menu');
    expect(h.retranscribe.mutate).not.toHaveBeenCalled();
  });

  test('the re-transcribe confirm stays plain when nothing was edited', () => {
    h.recordingAvailable = { data: true };
    renderDetail(makeMeeting({ edited_fields: [] }));
    fireEvent.click(screen.getByRole('button', { name: /more options/i }));
    fireEvent.click(screen.getByTestId('retranscribe-action'));
    const box = dialog() as HTMLElement;
    expect(box.textContent).not.toMatch(/edited/i);
  });
});

describe('describeEditedSections', () => {
  test('maps the stored field keys to the names the note editor uses', async () => {
    const { describeEditedSections } = await import('./MeetingDetail');
    expect(
      describeEditedSections(['summary', 'key_points', 'action_items', 'discussion_areas'])
    ).toEqual(['Summary', 'Key topics', 'Key points', 'Action items']);
  });

  // Canonical order, not the order the sidecar happened to accumulate them in:
  // the dialog should read the same way whichever section was edited first.
  test('lists sections in the order the note shows them', async () => {
    const { describeEditedSections } = await import('./MeetingDetail');
    expect(describeEditedSections(['action_items', 'summary'])).toEqual([
      'Summary',
      'Action items',
    ]);
  });

  // A newer app version could record a field this one has no label for. Naming
  // it readably beats either printing a raw key or silently not warning.
  test('humanises a field key it does not know', async () => {
    const { describeEditedSections } = await import('./MeetingDetail');
    expect(describeEditedSections(['summary', 'decision_log'])).toEqual([
      'Summary',
      'Decision log',
    ]);
  });

  test('is empty for every "nothing was edited" shape', async () => {
    const { describeEditedSections } = await import('./MeetingDetail');
    expect(describeEditedSections([])).toEqual([]);
    expect(describeEditedSections(undefined)).toEqual([]);
    expect(describeEditedSections(null as unknown as string[])).toEqual([]);
    expect(describeEditedSections('summary' as unknown as string[])).toEqual([]);
  });
});
