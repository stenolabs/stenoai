import * as React from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { ipc } from '@/lib/ipc';
import { unwrap } from '@/lib/result';
import { meetingsKeys } from './meetingKeys';
import { orgKeys } from './useOrg';
import { useLiveDraftStore } from './liveDraftStore';
import { useRecordTemplateStore } from './useSystemAudioCapture';
import { navigate, routeFromHash } from '@/lib/router';
import { composeShareBody, pickTranscriptForShare } from '@/routes/MeetingDetail';
import { streamCache } from '@/lib/meetingDetailState';
import {
  classifyCompletionNotification,
  meetingAlreadyHasNotes,
  completionActions,
} from '@/lib/completionNotification';
import type { Meeting, QueueStatus, RecordingTrigger } from '@/lib/ipc';

export type RecordingStatus = 'idle' | 'recording' | 'paused' | 'processing';

const queueKey = ['recording', 'queue'] as const;

// ── Shared window-visibility subscription ───────────────────────────────
//
// `useRecording` is consumed by 12+ components. If each consumer manages
// its own `visibilitychange` listener + useState, we end up with N
// listeners on `document` and N re-renders per consumer on every
// visibility flip. Hoist to module scope: one listener total, broadcast
// to subscribers via `useSyncExternalStore` so React still re-renders
// each consumer correctly.
const visibilitySubscribers = new Set<() => void>();
let visibilityListenerInstalled = false;

function ensureVisibilityListener() {
  if (visibilityListenerInstalled || typeof document === 'undefined') return;
  document.addEventListener('visibilitychange', () => {
    for (const cb of visibilitySubscribers) cb();
  });
  visibilityListenerInstalled = true;
}

function subscribeVisibility(callback: () => void): () => void {
  ensureVisibilityListener();
  visibilitySubscribers.add(callback);
  return () => {
    visibilitySubscribers.delete(callback);
  };
}

function getVisibilitySnapshot(): boolean {
  return typeof document !== 'undefined' ? document.visibilityState === 'visible' : true;
}

// SSR fallback. Renderer-only today, but keeps useSyncExternalStore happy.
function getVisibilityServerSnapshot(): boolean {
  return true;
}

function useIsWindowVisible(): boolean {
  return React.useSyncExternalStore(
    subscribeVisibility,
    getVisibilitySnapshot,
    getVisibilityServerSnapshot
  );
}

/** Stable empty-Set sentinel so consumers (useMeetings) don't see a
 *  fresh reference each render when there are no active reprocesses —
 *  keeps their useMemo deps shallow-equal and avoids re-mapping the
 *  whole meetings list every queue poll. */
const EMPTY_REPROCESS_SET: ReadonlySet<string> = new Set<string>();

export function useRecording() {
  const qc = useQueryClient();

  // Backed by a shared module-level listener (see useIsWindowVisible at
  // the top of this file) so 12+ useRecording consumers don't each
  // attach their own document listener.
  const isVisible = useIsWindowVisible();

  const queue = useQuery({
    queryKey: queueKey,
    queryFn: async () => {
      const res = await ipc().recording.getQueue();
      if (!res.success) throw new Error(res.error);
      return res;
    },
    refetchInterval: (query) => {
      // Hidden: 10s regardless of state. The user can't see a 1s update
      // anyway; when they bring the window back, react-query's
      // refetchOnWindowFocus + the visibilitychange listener flipping
      // isVisible will both trigger a fresh fetch.
      if (!isVisible) return 10_000;
      return query.state.data?.hasRecording ? 1000 : 2000;
    },
  });

  const status: RecordingStatus = React.useMemo(() => {
    const q = queue.data;
    if (q?.hasRecording) return q.isPaused ? 'paused' : 'recording';
    if (q?.isProcessing) return 'processing';
    return 'idle';
  }, [queue.data]);

  // Memoised so the Set reference is stable across renders when the
  // backend's currentReprocesses array contents haven't changed —
  // useMeetings's dependency on this is then satisfied by a referential
  // equality check rather than re-running the meeting-list map on every
  // queue poll.
  const reprocessingSummaryFiles = React.useMemo(() => {
    const arr = queue.data?.currentReprocesses;
    if (!arr || arr.length === 0) return EMPTY_REPROCESS_SET;
    return new Set(arr.map((r) => r.summaryFile));
  }, [queue.data?.currentReprocesses]);

  // NOTE: processing-complete handling lives in useRecordingProcessingEffects
  // below, mounted ONCE at App level. Putting it here would attach a fresh
  // listener for every consumer of useRecording (12+ at last count), causing
  // duplicate cache invalidations and N navigations per recording.

  const startRecording = React.useCallback(
    async (
      name?: string,
      trigger: RecordingTrigger = 'manual',
      appendTo?: string,
      templateId?: string
    ) => {
      // Resolve the effective template ID.
      // Hard Rule 1: Continue/append recordings (`appendTo` truthy) must NEVER send a templateId.
      // Hard Rule 2: When no template was chosen, the call must be byte-identical to today's
      //              (no 4th argument).
      // Hard Rule 3: If a template was explicitly chosen before recording (or supplied via `templateId`),
      //              we pass it as the 4th argument and track it in `useRecordTemplateStore`
      //              so LiveDock can display it.
      //
      // Design justification for accepting an optional `templateId` parameter with store fallback:
      // Direct callers (tests, future programmatic APIs) can supply a template directly, while
      // all decoupled UI triggers (dock record button, New note button, tray/hotkey shortcuts)
      // seamlessly read the pre-recording selection from `useRecordTemplateStore.getState().chosenTemplateId`.
      const store = useRecordTemplateStore.getState();
      const effectiveTemplateId = !appendTo
        ? (templateId ?? store.chosenTemplateId ?? undefined)
        : undefined;

      // Activate the template for LiveDock display during this session, and clear the pre-recording choice
      // so subsequent recordings revert to the global default.
      store.setActiveTemplateId(effectiveTemplateId ?? null);
      store.setChosenTemplateId(null);

      // Optimistic cache write so the UI flips to status='recording'
      // instantly. The backend's start-recording-ui has a 2s warm-up and
      // the next queue poll (1s) will reconcile sessionName + elapsed.
      // 'Note' is the placeholder that the Python post-processor recognises
      // (regex ^(Meeting|Note)(-[A-Z0-9]{6})?$) and replaces with an AI-
      // generated title from the summary + transcript.
      const optimisticName = name && name.trim() ? name.trim() : 'Note';
      // Clear any stale draft keyed under this same name. The live-draft
      // store is keyed by sessionName, and the most common case
      // (default 'Note') means back-to-back recordings collide on the
      // same key. Previously the draft was only cleared
      // on processing-complete, which can land minutes after the user
      // hits '+ New note' — meaning the new recording reads the previous
      // session's notes and shows them in the UI. Clearing here is
      // tighter: the new recording starts with a guaranteed-clean draft
      // before useLiveMeeting's `ensure` looks for one.
      //
      // Edge case: if the previous recording's draft.title was edited
      // (custom user rename), that rename is also cleared — Processing.tsx
      // applies the rename on processing-complete by reading the draft,
      // so it'll be lost. Acceptable trade-off: the leak case is common,
      // the rename case is rare and recoverable via manual rename
      // post-processing.
      //
      // Snapshot before clearing so we can put it back if start-recording
      // fails — without restore, a transient IPC error would silently drop
      // the previous session's in-memory state.
      const priorDraft = useLiveDraftStore.getState().drafts[optimisticName];
      useLiveDraftStore.getState().clear(optimisticName);
      // Cancel any in-flight queue poll before the optimistic write — a fetch
      // already in the air resolves with hasRecording:false and would clobber
      // the write, unmounting the pill for up to a poll interval. Snapshot
      // the previous cache so a start failure can restore it synchronously
      // (the standard onMutate pattern) instead of showing a phantom
      // "recording" pill until an invalidate round-trips.
      await qc.cancelQueries({ queryKey: queueKey });
      const priorQueue = qc.getQueryData<QueueStatus>(queueKey);
      qc.setQueryData(queueKey, {
        success: true,
        isProcessing: false,
        queueSize: 0,
        currentJob: null,
        hasRecording: true,
        isPaused: false,
        elapsedSeconds: 0,
        sessionName: optimisticName,
        // Reflect the resume/continue target immediately so a detail view's
        // "recording this note" gate flips on click, not a poll later. The
        // next queue poll reconciles it (null for a fresh new-note start).
        recordingSummaryFile: appendTo ?? null,
      });
      // No navigation: recording coexists with the app. PrimaryDock keys off
      // the optimistic status flip above and docks the transcription pill on
      // whatever route the user is on; /recording stays reachable as an
      // optional live-note editor but is never forced.
      try {
        const data = unwrap(
          await (effectiveTemplateId !== undefined
            ? ipc().recording.start(name, trigger, appendTo, effectiveTemplateId)
            : ipc().recording.start(name, trigger, appendTo))
        );
        qc.invalidateQueries({ queryKey: queueKey });
        return data;
      } catch (err) {
        // Roll back template store state so an aborted start does not leave stale active state.
        useRecordTemplateStore.getState().resetChoice();
        // Roll back optimistic state. Restore the prior draft too — the
        // recording never started so the previous session (probably still
        // mid-processing) shouldn't lose its in-memory title / notes.
        if (priorDraft) {
          useLiveDraftStore.getState().restore(optimisticName, priorDraft);
        }
        qc.setQueryData(queueKey, priorQueue);
        qc.invalidateQueries({ queryKey: queueKey });
        // Every caller is fire-and-forget (`void startRecording()`), so an
        // IPC-level failure would otherwise be a silent no-op: the pill
        // flashes out with no explanation. Route it through the same native
        // notification the renderer-capture failure path uses.
        ipc().recording.reportCaptureError(
          err instanceof Error ? err.message : 'Recording could not start'
        );
        throw err;
      }
    },
    [qc]
  );

  const stopRecording = React.useCallback(async ({ navigateToNote = true }: { navigateToNote?: boolean } = {}) => {
    // Reset any active template choice on stop so subsequent recordings start fresh.
    useRecordTemplateStore.getState().resetChoice();
    // Optimistic: flip the queue cache to processing so the UI can swap the
    // pill for the processing dock instantly, before the backend SIGTERM
    // round-trip.
    qc.setQueryData(queueKey, (prev: QueueStatus | undefined) => ({
      success: true as const,
      isProcessing: true,
      queueSize: prev?.queueSize ?? 0,
      currentJob: prev?.sessionName ?? prev?.currentJob ?? null,
      hasRecording: false,
      isPaused: false,
      elapsedSeconds: 0,
      sessionName: prev?.sessionName ?? null,
    }));
    try {
      const data = unwrap(await ipc().recording.stop());
      // Instant stop: main wrote the note from the live transcript (or it's a
      // continued note) and returns its path — land the user ON it, with the
      // batch transcribe/summarise upgrading it in the background. Whisper/
      // import return no summaryFile → the processing dock as before.
      //
      // navigateToNote=false is used by the auto-stop path (meeting ended): the
      // user isn't engaged, so we must NOT move them onto the note's route —
      // otherwise, once macOS brings Steno forward as the meeting app closes,
      // the completion handler sees "focused + on this note" and suppresses the
      // "Transcript ready — Summarise?" notification. Leaving the route where it
      // is keeps that notification firing.
      if (navigateToNote) {
        if (data.summaryFile) {
          navigate(`/meetings/${encodeURIComponent(data.summaryFile)}`);
        } else {
          navigate('/meetings/processing');
        }
      }
      qc.invalidateQueries({ queryKey: queueKey });
      return data;
    } catch (err) {
      // Stop failed before we learned the note path — fall back to the dock so
      // the user isn't stranded on the recording view.
      if (navigateToNote) navigate('/meetings/processing');
      qc.invalidateQueries({ queryKey: queueKey });
      throw err;
    }
  }, [qc]);

  const pauseRecording = React.useCallback(async () => {
    const data = unwrap(await ipc().recording.pause());
    qc.invalidateQueries({ queryKey: queueKey });
    return data;
  }, [qc]);

  const resumeRecording = React.useCallback(async () => {
    const data = unwrap(await ipc().recording.resume());
    qc.invalidateQueries({ queryKey: queueKey });
    return data;
  }, [qc]);

  return {
    status,
    elapsed: queue.data?.elapsedSeconds ?? 0,
    /** Number of jobs waiting in the processing queue. Combined with `status`
     *  it tells the processing screen whether a job actually exists — a
     *  post-stop screen with `status==='idle' && queueSize===0` means the stop
     *  produced no job (nothing was captured), which the watchdog uses to
     *  break out of an otherwise-forever spinner (issue #343). */
    queueSize: queue.data?.queueSize ?? 0,
    // Fall back to currentJob (the in-flight processing session) when no
    // recording is active. Keeps `sessionName` populated through the full
    // recording → processing → done lifecycle so the synthetic in-progress
    // row in useMeetings stays visible while a note is processing —
    // otherwise Home goes blank between "stopped" and "processed" and the
    // user can't see anything is happening in the background.
    sessionName: queue.data?.sessionName ?? queue.data?.currentJob ?? null,
    /** The note (summary-file realpath) an active continue/resume is recording
     *  INTO — lets a detail view match by identity rather than the collidable
     *  display name. Null for a fresh new-note recording or when idle. */
    recordingSummaryFile: queue.data?.recordingSummaryFile ?? null,
    /** The real note file the live recording/processing session produces.
     *  useMeetings dedupes the synthetic live row against it so one recording
     *  never shows as two entries (#bug4). Only Parakeet writes the placeholder
     *  it points at, so dedup only bites there; null when idle. */
    liveSummaryFile: queue.data?.liveSummaryFile ?? null,
    /** Set of summary files whose `reprocess-meeting` IPC is currently
     *  in flight. Used by useMeetings to flip the matching existing
     *  meeting rows' `is_processing` flag so Home shows the badge even
     *  when the user navigates away from MeetingDetail mid-reprocess.
     *  Set rather than array so consumers can do O(1) membership checks
     *  inside the meetings list map. */
    reprocessingSummaryFiles: reprocessingSummaryFiles,
    /** True once the queue poll has resolved successfully at least once. The
     *  processing-screen watchdog must not count "idle+empty" ticks before real
     *  data has arrived — absent query data defaults to status:'idle' /
     *  queueSize:0, so a slow first IPC would otherwise look like a no-job
     *  dead-end (issue #343). */
    isQueueSuccess: queue.isSuccess,
    startRecording,
    stopRecording,
    pauseRecording,
    resumeRecording,
    isLoading: queue.isLoading,
  };
}

/**
 * Mount once at App level. Wires tray / shortcut / macOS-Shortcuts / global
 * hotkey events to start/stop recording, and tells main.js the renderer is
 * ready to receive shortcut events so any queued-from-launch URLs get
 * flushed.
 */
export function useRecordingEvents() {
  const { status, startRecording, stopRecording, pauseRecording, resumeRecording } = useRecording();

  React.useEffect(() => {
    const bridge = ipc();
    const toggle = () => {
      // 'processing' is the post-stop, pre-summary state. Treat it like
      // idle for start purposes — the previous note keeps summarising in
      // the background queue while a new recording starts. Matches the
      // Home empty-state CTA + UpcomingCard click behaviour so the hotkey
      // doesn't silently no-op when a user is doing back-to-back notes.
      if (status === 'recording' || status === 'paused') void stopRecording();
      else void startRecording(undefined, 'hotkey');
    };
    const offs = [
      bridge.on.toggleRecordingHotkey(toggle),
      bridge.on.trayStartRecording(() => {
        void startRecording(undefined, 'tray');
      }),
      bridge.on.trayStopRecording(() => {
        void stopRecording();
      }),
      bridge.on.shortcutStartRecording(({ sessionName }) => {
        void startRecording(sessionName ?? undefined, 'url_scheme');
      }),
      bridge.on.shortcutStopRecording(() => {
        void stopRecording();
      }),
      bridge.on.autoRecordRequested(({ sessionName }) => {
        // Suggested by the mic-monitor auto-detect notification ("Take Notes").
        // Allow start when idle OR when a previous note is still processing
        // — the user explicitly opted in by clicking "Take Notes", and the
        // background queue handles the previous summary fine. Only skip if
        // an active recording (recording/paused) is already in progress —
        // user already manually started or is mid-meeting.
        if (status === 'recording' || status === 'paused') return;
        void startRecording(sessionName ?? undefined, 'notification_click');
        // "Take Notes" is an explicit intent to write notes, so open the
        // live-note editor (main already brought the window forward). Mirrors
        // the toolbar New-note button.
        navigate('/recording');
      }),
      bridge.on.autoPauseRequested(() => {
        // Mic stopped on the meeting app — pause so we don't keep recording
        // ambient silence while waiting for user to confirm summarise.
        // No status guard: `status` is polled and can lag the main-side state
        // machine by up to a poll interval. If pause then resume fire back-to-
        // back, a stale 'recording' read here would skip the resume on the
        // companion handler below. Trust main (it already gates on its own
        // autoStartedSession state) and let pauseRecording's IPC validate.
        void pauseRecording();
      }),
      bridge.on.autoResumeRequested(() => {
        // Meeting came back before user clicked Summarise — keep capturing.
        // Same stale-status reason as autoPauseRequested above: don't gate
        // on the polled status, just trust that main only fires this when
        // its own state says we're paused.
        void resumeRecording();
      }),
      bridge.on.autoSummariseRequested(() => {
        // Auto-stop of an ended auto-detected meeting — stop the (auto-paused)
        // recording so the shared post-stop pipeline runs, exactly like a manual
        // stop. Do NOT navigate to the note: the user isn't engaged (they're
        // leaving the meeting), and navigating there would let the completion
        // handler suppress the completion notification once macOS surfaces Steno
        // as the meeting closes. The summarise decision then happens after
        // transcription via the transcript-ready → "Summarise?" → note-ready
        // notifications — no separate meeting-end prompt.
        if (status === 'recording' || status === 'paused') {
          // Surface a failed auto-stop: unlike startRecording, stopRecording
          // re-throws without notifying, and this path deliberately doesn't
          // navigate — so without this the meeting would silently fail to
          // finalize with no user-visible signal. Route it through the same
          // capture-error notification the start path uses.
          void stopRecording({ navigateToNote: false }).catch((err) => {
            ipc().recording.reportCaptureError(
              err instanceof Error ? err.message : 'Recording could not stop'
            );
          });
        }
      }),
      bridge.on.generateNotesRequested(({ summaryFile, name }) => {
        // User tapped "Summarise" on the transcript-ready notification. Run the
        // same reprocess path as GenerateNotesBar in the BACKGROUND (no
        // navigate/focus) — main tracks it in activeReprocessJobs so the badge
        // shows, and its completion fires processing-complete with
        // notesGenerated:true → the "Note ready" notification, whose click opens
        // the note. That's where the user is brought in. (#bug2/#bug3)
        if (summaryFile) {
          // `name` here is only the processing-badge label (reprocess never
          // passes it to the CLI, so it can't blank the note's title).
          void ipc().meetings.reprocess(summaryFile, false, name ?? '').catch(() => {
            // Reprocess failure surfaces via its own STREAM_ERROR/processing
            // path; nothing to recover here.
          });
        }
      }),
    ];
    bridge.shortcuts.rendererReady();
    return () => offs.forEach((off) => off());
  }, [status, startRecording, stopRecording, pauseRecording, resumeRecording]);
}

/**
 * Mount once at App level. The processing-complete listener does cache
 * pre-seeding + invalidation + post-recording navigation. Splitting this out
 * of useRecording keeps the side-effect singleton even though useRecording
 * itself is consumed by many components.
 */
export function useRecordingProcessingEffects() {
  const qc = useQueryClient();
  React.useEffect(() => {
    const off = ipc().on.processingComplete((data) => {
      if (data.success && data.meetingData?.session_info.summary_file) {
        const newMeeting = data.meetingData as Meeting;
        const newSummaryFile = newMeeting.session_info.summary_file;
        qc.setQueryData<Meeting[]>(meetingsKeys.list(), (prev) => {
          if (!prev) return [newMeeting];
          const filtered = prev.filter((m) => m.session_info.summary_file !== newSummaryFile);
          return [newMeeting, ...filtered];
        });

        // Fire-and-forget auto-backup. Main does all the gating
        // (signed-in, toggle on, not-already-attempted), so the renderer
        // just hands it the formatted artifact and forgets. Failures are
        // silent — the manual Share button is the user-visible recovery
        // path. We invalidate the org meetings list on success so the
        // sidebar Shared Notes view updates without a refresh.
        const title = newMeeting.session_info.name || 'Untitled note';
        const body = composeShareBody(newMeeting);
        const transcript = pickTranscriptForShare(newMeeting);
        // Never auto-backup a transcription failure — it has no real notes,
        // only the failure message, and shouldn't propagate to the org. Check
        // both the event flag and the authoritative meeting marker.
        const isFailedNote =
          Boolean(data.transcriptionFailed) ||
          Boolean(newMeeting.session_info.transcription_failed);
        if (body && !isFailedNote) {
          ipc()
            .org.tryAutoBackup({
              summaryFile: newSummaryFile,
              title,
              body,
              transcript,
              visibility: 'org',
            })
            .then((res) => {
              if (res.attempted) {
                qc.invalidateQueries({ queryKey: orgKeys.meetings() });
                // Flip the MeetingDetail Share/Unshare toggle to
                // "Unshare" without waiting for staleTime — the user
                // may already be looking at the note.
                qc.invalidateQueries({ queryKey: orgKeys.backupState(newSummaryFile) });
              } else if (res.reason === 'upload-failed' || res.reason === 'error') {
                console.warn('[org-auto-backup] skipped:', res.reason, res.error);
                // Only 'upload-failed' persists a failure in main (the outer
                // 'error' catch deliberately doesn't); refresh the per-note
                // backup state so the note-detail "Not backed up" chip appears
                // without waiting for staleTime.
                if (res.reason === 'upload-failed') {
                  qc.invalidateQueries({ queryKey: orgKeys.backupState(newSummaryFile) });
                }
              }
            })
            .catch((e) => {
              console.warn('[org-auto-backup] ipc failed:', e);
            });
        }
      }
      // Hard processing crash (process-streaming non-zero exit): no note was
      // written, so the synthetic processing row is about to vanish on the
      // queue invalidation below with nothing to show for it. Surface a
      // failure notification keyed on the session so an import/recording that
      // dies in the background doesn't just silently disappear. The graceful
      // transcription-failure path takes the success:true branch above (it
      // writes a marked note), so this only fires for true crashes.
      if (!data.success) {
        void ipc()
          .settings.showNoteReadyNotification({
            title: data.sessionName?.trim() || 'your note',
            failed: true,
            hardFailure: true,
          })
          .catch(() => {
            // Notification failure isn't fatal — nothing else to fall back to.
          });
      }
      qc.invalidateQueries({ queryKey: meetingsKeys.all });
      qc.invalidateQueries({ queryKey: queueKey });
      // Clear any streamCache entry for the finished session. MeetingDetail
      // does its own cleanup when mounted (with a 400ms grace so the "done"
      // phase animates), but if the user navigated away mid-reprocess the
      // component-local listener gets torn down before the event arrives
      // and the cache stays stuck at 'generating'. This app-level
      // cleanup runs regardless of route so the next time the user opens
      // the note, the page reads fresh data instead of stale phase state.
      const summaryFileFromEvent =
        data.meetingData?.session_info.summary_file ?? data.summaryFile ?? null;
      if (summaryFileFromEvent) {
        streamCache.delete(summaryFileFromEvent);
      }
      // Clear the live-draft entry for this finished session so the next
      // "New note" with the same default sessionName ('Note') doesn't
      // inherit the previous title or notes.
      if (data.sessionName) {
        useLiveDraftStore.getState().clear(data.sessionName);
      }
      // The summary file lands here for both flows: recording-complete
      // carries it via meetingData; reprocess carries it as a top-level
      // summaryFile field (no meetingData). Treat both the same below.
      const finishedSummaryFile =
        data.meetingData?.session_info.summary_file ?? data.summaryFile ?? null;
      if (data.success && finishedSummaryFile) {
        const currentRoute = routeFromHash(window.location.hash);
        const finishedMeetingRoute = `/meetings/${encodeURIComponent(finishedSummaryFile)}`;
        // #bug1 lets an auto-detected recording run with the window HIDDEN
        // (tray-only) or backgrounded behind the meeting app, so "the route is
        // this note" no longer implies the user is looking at it. Gate the
        // suppress-when-already-here logic on FOCUS, not route alone and not
        // visibilityState: after an auto-stop, stopRecording navigates to the
        // note's own route, but Steno is usually behind the meeting window —
        // where visibilityState is still 'visible' (the window is shown, just
        // not frontmost), which wrongly suppressed the notification. hasFocus()
        // is false whenever Steno isn't the active window (hidden, minimised, OR
        // backgrounded), so we correctly notify unless the user is truly looking
        // at this note.
        const windowFocused =
          typeof document !== 'undefined' && document.hasFocus();
        const { navigate: shouldNavigate, notify: shouldNotify } = completionActions({
          currentRoute,
          finishedMeetingRoute,
          processingRoute: '/meetings/processing',
          windowFocused,
        });
        if (shouldNavigate) {
          // On the transient /processing screen → always advance to the note so
          // the user is never stranded on a stuck spinner (regression fix),
          // whether or not Steno is focused.
          navigate(finishedMeetingRoute);
        }
        if (shouldNotify) {
          // A different route (Home, Chat, Settings, recording another note, a
          // different meeting) OR this note's route but the window is
          // hidden/minimised (tray-only after an auto-detected wrap-up) → fire a
          // notification so the user learns their note finished. Clicking it
          // navigates straight here (navigate-to-meeting listener below) — an
          // explicit "take me there", so no back-to-back-recording interruption
          // risk. When the window is visible AND already on this note, we skip
          // it: the static summary is right there.
          const title =
            data.meetingData?.session_info.name?.trim() ||
            data.sessionName?.trim() ||
            'Your note has finished processing';
          const isFailed =
            Boolean(data.transcriptionFailed) ||
            Boolean(data.meetingData?.session_info.transcription_failed);
          const kind = classifyCompletionNotification({
            notesGenerated: data.notesGenerated,
            // Continue-recording (append) skips summarization but the note it
            // appended to already has notes — treat as note-ready, not
            // "generate notes?" (M2). meetingAlreadyHasNotes encodes the subtle
            // notes_generated frontmatter semantics (absent = has notes).
            notesAlreadyExist: meetingAlreadyHasNotes(data.meetingData),
            transcriptionFailed: data.transcriptionFailed,
            meetingTranscriptionFailed: data.meetingData?.session_info.transcription_failed,
          });
          // Note: no `notifications_enabled` pre-check here — the IPC
          // handlers in main.js gate internally via `notificationsEnabled()`
          // and short-circuit when the user has notifications disabled. A
          // renderer round-trip to fetch the setting first would be a wasted
          // poll; the gate stays single-source-of-truth in main.
          if (kind === 'note-ready') {
            // Notes were generated (auto-summarize on, or the deferred
            // Generate-notes/reprocess finished) — or a transcription failure
            // that still wrote a note. Either way it's "ready": open on click.
            void ipc()
              .settings.showNoteReadyNotification({
                title,
                summaryFile: finishedSummaryFile,
                failed: isFailed,
              })
              .catch(() => {
                // Notification failure isn't fatal — the note is still
                // visible in Home + sidebar. Don't bubble up.
              });
          } else {
            // Transcript-only note (auto_summarize off → no notes generated).
            // Prompt to generate notes rather than claim "Note ready" (#bug2);
            // this is also the correctly-timed replacement for the old
            // premature meeting-end "Summarise?" prompt (#bug3).
            void ipc()
              .settings.showTranscriptReadyNotification({
                title,
                summaryFile: finishedSummaryFile,
                name: data.sessionName ?? null,
              })
              .catch(() => {
                // Notification failure isn't fatal.
              });
          }
        }
        // else: on this note's own detail page → nothing. The streaming
        // UI's own listener swaps to the static view; no extra signal
        // needed.
      }
      // Clear the live-draft entry AFTER any other processing-complete
      // listeners (notably Processing.tsx's, which reads draft.title to
      // apply a custom rename). Deferring to the next microtask gives
      // those listeners a tick to consume the draft before we drop it.
      if (data.sessionName) {
        const sessionName = data.sessionName;
        queueMicrotask(() => {
          useLiveDraftStore.getState().clear(sessionName);
        });
      }
    });
    return off;
  }, [qc]);

  // Fired by main when the user clicks the "Note ready" notification —
  // an explicit request to jump to that note, so navigate unconditionally.
  React.useEffect(() => {
    return ipc().on.navigateToMeeting(({ summaryFile }) => {
      if (summaryFile) navigate(`/meetings/${encodeURIComponent(summaryFile)}`);
    });
  }, []);
}
