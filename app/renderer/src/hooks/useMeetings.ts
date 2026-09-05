import * as React from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ipc, type Meeting, type UpdateMeetingPatch } from '@/lib/ipc';
import { unwrap } from '@/lib/result';
import { useRecording } from '@/hooks/useRecording';
import { useLiveDraftStore } from '@/hooks/liveDraftStore';
import { meetingsKeys } from '@/hooks/meetingKeys';
import { useUndoDeleteStore } from '@/hooks/undoDeleteStore';
// #bug4 dedup helpers live in a dependency-light module so they're unit-testable
// without this hook's import graph.
import { LIVE_SUMMARY_PREFIX, liveRowRedundant, shouldShowLiveRow } from '@/lib/liveMeetingRow';

export { meetingsKeys };
// Re-exported for existing consumers that import them from here.
export { LIVE_SUMMARY_PREFIX, liveRowRedundant };


export function useMeetings() {
  const query = useQuery({
    queryKey: meetingsKeys.list(),
    queryFn: async () => unwrap(await ipc().meetings.list()).meetings,
  });

  const recording = useRecording();
  const draft = useLiveDraftStore((s) =>
    recording.sessionName ? s.drafts[recording.sessionName] : undefined,
  );

  // Local 1 Hz tick so the live row's duration_seconds advances smoothly
  // regardless of when the queue poll lands. We re-derive from startedAtMs
  // when available, falling back to the polled elapsed value.
  const [nowMs, setNowMs] = React.useState(() => Date.now());
  React.useEffect(() => {
    if (recording.status !== 'recording') return;
    const id = setInterval(() => setNowMs(Date.now()), 1000);
    return () => clearInterval(id);
  }, [recording.status]);

  const liveElapsed = React.useMemo(() => {
    if (!recording.sessionName) return 0;
    if (draft?.startedAtMs && recording.status !== 'paused') {
      return Math.max(0, Math.floor((nowMs - draft.startedAtMs) / 1000));
    }
    return recording.elapsed;
  }, [
    recording.sessionName,
    recording.status,
    recording.elapsed,
    draft?.startedAtMs,
    nowMs,
  ]);

  const data = React.useMemo<Meeting[] | undefined>(() => {
    if (!query.data) return query.data;
    // When one or more reprocesses are in flight, flag the matching
    // existing meeting rows so they show the ProcessingBadge — same
    // surface as a queued recording, no synthetic duplicate row.
    // Without this, Home looks identical to "nothing happening" during
    // a reprocess because reprocess doesn't touch the processingQueue
    // / currentJob. Live recording row (below) is independent — both
    // can co-exist if the user is recording one note AND reprocessing
    // another simultaneously.
    const reprocessing = recording.reprocessingSummaryFiles;
    const base = reprocessing.size > 0
      ? query.data.map((m) =>
          reprocessing.has(m.session_info.summary_file) && !m.is_processing
            ? { ...m, is_processing: true }
            : m,
        )
      : query.data;
    // Gate on the STATUS, not on the name alone: main keeps the session name
    // after a capture start that failed in the renderer, and without this a
    // stale name renders a live row that nothing ever clears. See
    // isLiveRowStatus for the full story.
    const live = shouldShowLiveRow(recording.sessionName, recording.status)
      ? buildLiveMeeting(
          recording.sessionName,
          draft?.title,
          draft?.startedAtMs,
          liveElapsed,
          recording.status === 'processing',
        )
      : null;
    if (!live) return base;
    // #bug4: once the real note file for this session exists in the list, drop
    // the synthetic live row so one recording is never shown as two entries.
    // The instant-stop placeholder (Parakeet) is written at stop keyed by its
    // real summary_file — which main surfaces as `liveSummaryFile` — while the
    // synthetic row is keyed on the sentinel `__live__/<sessionName>`, so they
    // never match on their own and would otherwise coexist during processing.
    if (liveRowRedundant(base, recording.liveSummaryFile)) return base;
    return [live, ...base];
  }, [
    query.data,
    recording.sessionName,
    recording.status,
    recording.reprocessingSummaryFiles,
    recording.liveSummaryFile,
    liveElapsed,
    draft?.title,
    draft?.startedAtMs,
  ]);

  return { ...query, data };
}

function buildLiveMeeting(
  sessionName: string,
  draftTitle: string | undefined,
  startedAtMs: number | undefined,
  elapsedSeconds: number,
  isProcessing: boolean,
): Meeting {
  const ts = startedAtMs ?? Date.now();
  const iso = new Date(ts).toISOString();
  return {
    is_recording: !isProcessing,
    is_processing: isProcessing,
    session_info: {
      name: draftTitle ?? sessionName,
      summary_file: `${LIVE_SUMMARY_PREFIX}${sessionName}`,
      processed_at: iso,
      updated_at: iso,
      duration_seconds: elapsedSeconds,
    },
    summary: '',
    key_points: [],
    action_items: [],
    transcript: '',
    folders: [],
  };
}

export function useMeeting(summaryFile: string | null | undefined) {
  return useQuery({
    queryKey: meetingsKeys.detail(summaryFile),
    queryFn: async () => {
      if (!summaryFile) return null;
      const res = await ipc().meetings.get(summaryFile);
      return unwrap(res).meeting;
    },
    enabled: !!summaryFile,
  });
}

export function useTranscript(summaryFile: string | null | undefined) {
  const { data, ...rest } = useMeeting(summaryFile);
  return { ...rest, data: data?.transcript ?? null };
}

export function useUpdateMeeting() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (args: { summaryFile: string; patch: UpdateMeetingPatch }) =>
      unwrap(await ipc().meetings.update(args.summaryFile, args.patch)),
    onSuccess: () => qc.invalidateQueries({ queryKey: meetingsKeys.all }),
  });
}

/**
 * Autosave for the My notes tab. Unlike useUpdateMeeting it does NOT invalidate
 * the whole meetings list (a full backend re-scan) on every debounced save —
 * user_notes is invisible in the list, so it patches only the detail cache in
 * place. The textarea is the source of truth while focused; this just persists.
 */
export function useUpdateUserNotes() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (args: { summaryFile: string; userNotes: string }) =>
      unwrap(
        await ipc().meetings.update(args.summaryFile, { user_notes: args.userNotes }),
      ),
    onSuccess: (_data, args) => {
      qc.setQueryData<Meeting>(meetingsKeys.detail(args.summaryFile), (prev) =>
        prev ? { ...prev, user_notes: args.userNotes } : prev,
      );
    },
  });
}

export function useDeleteMeeting() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (meeting: Meeting) => unwrap(await ipc().meetings.delete(meeting)),
    // Cancel any in-flight meetings-list refetch before touching the cache. A
    // refetch already running when the delete fires was scanned by the backend
    // *before* the file was removed, so its (stale) response would re-introduce
    // the deleted row if it landed after the setQueryData below. The many
    // meetingsKeys.all invalidations elsewhere (processing-complete, update,
    // reprocess, folder edits) make such an overlap reachable. Cancelling drops
    // that stale response without kicking off a new fetch, so we still avoid the
    // backend re-scan this hook exists to remove.
    onMutate: () => qc.cancelQueries({ queryKey: meetingsKeys.list() }),
    // The deleted file is known, so drop just that row from the list cache
    // instead of invalidating — a full `invalidateQueries` re-runs the backend
    // `list-meetings` scan (a Python subprocess + whole-directory re-read) only
    // to remove one row we already know is gone. Folder views derive from this
    // same list (FolderDetail filters useMeetings() by folder id), so they
    // update from this single write too. Removing on success (not optimistically
    // in onMutate) means a failed delete simply leaves the row in place — no
    // snapshot/rollback, so concurrent deletes can't clobber each other.
    onSuccess: async (data, meeting) => {
      // Cancel again here: the onMutate cancel only covers refetches already
      // running at mutation start, but a fresh list refetch can be triggered
      // *during* the (fast) delete IPC and would land after the write below.
      // The setQueryData filter handles a stale response that lands before this
      // point; cancelling handles one that would land after. Together they close
      // the clobber window without a reconciling backend re-scan.
      await qc.cancelQueries({ queryKey: meetingsKeys.list() });
      const deletedFile = meeting.session_info.summary_file;
      // Guard against a falsy summary_file: filtering on it would drop *every*
      // row with a falsy summary_file rather than the one deleted. summary_file
      // is the list's primary key so this shouldn't happen, but the predicate
      // must not silently nuke the list if a malformed row slips through.
      if (deletedFile) {
        qc.setQueryData<Meeting[]>(meetingsKeys.list(), (prev) =>
          prev?.filter((m) => m.session_info.summary_file !== deletedFile),
        );
        // Drop the lazy-loaded detail cache for this meeting too. The list filter
        // above only touches the list query; without this, the deleted meeting's
        // detail payload (transcript etc.) stays served from cache if the detail
        // route is revisited.
        qc.removeQueries({ queryKey: meetingsKeys.detail(deletedFile) });
      }
      // The delete was a soft-delete (only the summary is hidden): surface an
      // Undo toast so the user can undo for a few seconds (#234). Skipped only if
      // the backend didn't return an id (nothing to delete / older shape).
      if (data?.id) {
        useUndoDeleteStore.getState().add({
          id: data.id,
          meeting,
          summaryFile: meeting.session_info.summary_file,
          deadline: data.deadline ?? Date.now() + 8000,
        });
      }
    },
  });
}

/**
 * Undo a soft-delete (#234): main renames the hidden summary back, so the note
 * reappears in every backend scan. Re-insert the returned meeting into the list
 * cache (dedup) so the row returns without a re-scan — covering both the
 * still-cached row (delete removed it) and a mid-window refetch that dropped it.
 * The detail cache is invalidated so a revisit re-reads the note.
 */
export function useUndoDeleteMeeting() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (id: string) => unwrap(await ipc().meetings.undoDelete(id)),
    onSuccess: (data, id) => {
      const meeting = data.meeting;
      const file = meeting?.session_info?.summary_file;
      if (file) {
        qc.setQueryData<Meeting[]>(meetingsKeys.list(), (prev) => {
          if (!prev) return prev;
          // Guard against a double-undo re-inserting a duplicate row.
          if (prev.some((m) => m.session_info.summary_file === file)) return prev;
          return [meeting, ...prev];
        });
        qc.invalidateQueries({ queryKey: meetingsKeys.detail(file) });
      } else {
        qc.invalidateQueries({ queryKey: meetingsKeys.list() });
      }
      useUndoDeleteStore.getState().remove(id);
    },
    // On failure (rare no-clobber) leave the toast up; MAIN's timer is the
    // backstop and there's nothing to reconcile in the cache.
  });
}

/**
 * Commit a soft-delete (#234): the toast was dismissed or its window elapsed.
 * Main permanently unlinks the note's files. Idempotent on the backend; the
 * store entry + the (possibly still-cached) list row are cleaned up in the toast.
 */
export function useCommitDeleteMeeting() {
  return useMutation({
    mutationFn: async (id: string) => unwrap(await ipc().meetings.commitDelete(id)),
  });
}

export function useReprocessMeeting() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (args: { summaryFile: string; regenTitle: boolean; name: string }) =>
      unwrap(await ipc().meetings.reprocess(args.summaryFile, args.regenTitle, args.name)),
    onSuccess: () => qc.invalidateQueries({ queryKey: meetingsKeys.all }),
  });
}

export function useRetranscribeMeeting() {
  const qc = useQueryClient();
  return useMutation({
    // Re-run ASR on the source recording (#266) then re-summarise. Mirrors
    // useReprocessMeeting's success invalidation so the rewritten note (fresh
    // transcript + summary) refreshes across list + detail.
    mutationFn: async (args: { summaryFile: string; name: string }) =>
      unwrap(await ipc().meetings.retranscribe(args.summaryFile, args.name)),
    onSuccess: () => qc.invalidateQueries({ queryKey: meetingsKeys.all }),
  });
}

/** Whether the source recording for a note still exists on disk, so the UI can
 *  offer "Re-transcribe" only when re-running ASR is possible (#266). */
export function useRecordingAvailable(summaryFile: string | null | undefined) {
  return useQuery({
    queryKey: [...meetingsKeys.detail(summaryFile ?? ''), 'recording-available'],
    queryFn: async () =>
      unwrap(await ipc().meetings.recordingAvailable(summaryFile as string)).available,
    enabled: Boolean(summaryFile),
  });
}

export function useGenerateReport() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (args: { summaryFile: string; templateId: string }) =>
      unwrap(await ipc().meetings.generateReport(args.summaryFile, args.templateId)),
    onSuccess: (_data, args) =>
      qc.invalidateQueries({ queryKey: meetingsKeys.detail(args.summaryFile) }),
  });
}

export function useSaveMeetingNotes() {
  return useMutation({
    mutationFn: async (args: { name: string; notes: string }) =>
      unwrap(await ipc().meetings.saveNotes(args.name, args.notes)),
  });
}

export const useSetActiveReport = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (a: { summaryFile: string; reportId: string }) =>
      unwrap(await ipc().meetings.setActiveReport(a.summaryFile, a.reportId)),
    onSuccess: (_d, a) => qc.invalidateQueries({ queryKey: meetingsKeys.detail(a.summaryFile) }),
  });
};

export const useDeleteReport = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (a: { summaryFile: string; reportId: string }) =>
      unwrap(await ipc().meetings.deleteReport(a.summaryFile, a.reportId)),
    onSuccess: (_d, a) => qc.invalidateQueries({ queryKey: meetingsKeys.detail(a.summaryFile) }),
  });
};
