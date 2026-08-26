import * as React from 'react';
import {
  Calendar as CalendarIcon,
  ChevronLeft,
  Clock,
  Loader2,
  PencilLine,
} from 'lucide-react';
import ReactMarkdown from 'react-markdown';
import { create } from 'zustand';
import { MeetingsShell } from '@/components/MeetingsShell';
import { useNavigate } from '@/lib/router';
import { useRecording } from '@/hooks/useRecording';
import { useUpdateMeeting } from '@/hooks/useMeetings';
import { getLiveDraft, useLiveDraftStore } from '@/hooks/liveDraftStore';
import { ipc } from '@/lib/ipc';
import { stripReasoning } from '@/lib/markdown';
import { useTranslation, t } from '@/i18n';
type ProcessingStage = 'transcribing' | 'diarizing' | 'summarizing' | 'finalizing' | 'error';

// Shared flag so the sibling ProcessingDock (the bottom "Processing" chip,
// rendered by App while on this route) can hide once the watchdog concludes
// nothing was captured — otherwise the dock keeps animating "Processing" under
// a "Nothing to process" panel. Set by the Processing screen, read by the dock;
// reset on each screen visit.
const useProcessingWatchdogStore = create<{
  gaveUp: boolean;
  setGaveUp: (v: boolean) => void;
}>((set) => ({
  gaveUp: false,
  setGaveUp: (gaveUp) => set({ gaveUp }),
}));

function getStageLabel(stage: ProcessingStage): string {
  switch (stage) {
    case 'transcribing': return t('processing.analyzingTranscript');
    case 'diarizing': return t('processing.identifyingSpeakers');
    case 'summarizing': return t('processing.generatingNotes');
    case 'finalizing': return t('processing.almostDone');
    case 'error': return t('processing.couldNotProcess');
  }
}

// PROGRESS: lines carry raw counts whose units vary by stage (ASR sample
// position, embedding chunk index, summary chunk index) and can run into
// the tens of millions -- a percentage is the only display that's useful
// across all of them. Returns null (caller shows nothing new) for anything
// unparseable rather than a misleading 0%/NaN%.
function fractionToPercent(numerator: number, denominator: number): number | null {
  if (!Number.isFinite(numerator) || !Number.isFinite(denominator) || denominator <= 0) return null;
  return Math.min(100, Math.max(0, Math.round((numerator / denominator) * 100)));
}

function formatElapsedSeconds(totalSeconds: number): string {
  if (totalSeconds < 60) return `${totalSeconds}s`;
  const m = Math.floor(totalSeconds / 60);
  const s = totalSeconds % 60;
  return `${m}m ${s}s`;
}

// Queue-state watchdog (issue #343). Stopping a recording navigates here
// unconditionally, but a processing job is only queued when the capture
// actually produced a file. A stop that produced nothing (e.g. Stop hit while
// getUserMedia was still pending → stopCapture early-returns with no blob, or
// processSystemAudio resolves {success:false}) emits no processing-complete, so
// without this the screen spins forever. We watch for a genuinely idle-and-empty
// queue rather than a wall clock — long transcriptions have quiet stretches that
// a time-based timeout would false-trip.
//
// The threshold must clear the NORMAL stop→enqueue handoff, which is not
// instant: main flushes the recorder + closes the file, then
// process-system-audio-recording waits up to ~8s for the live-transcript
// sidecar to drain (app/main.js) BEFORE addToProcessingQueue runs. During that
// window main has already cleared the recording state but not yet enqueued, so
// a queue poll legitimately returns idle+empty for a recording that really has
// speech. Requiring 8 consecutive idle ticks at a 1500ms cadence (~12s) clears
// that bounded ~8s drain with comfortable margin; a genuine no-job dead-end
// stays idle+empty indefinitely, so it still trips (just a few seconds later).
const WATCHDOG_TICK_MS = 1500;
const WATCHDOG_IDLE_TICKS = 8;

export function Processing() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const recording = useRecording();
  const updateMeeting = useUpdateMeeting();

  // Capture sessionName when we arrive on this route. The backend clears
  // currentRecordingSessionName once processing-complete fires; we also need
  // to remember it for the brief moment between stop and the queue catching up.
  const [activeSession, setActiveSession] = React.useState<string | null>(
    () => recording.sessionName,
  );
  if (recording.sessionName && recording.sessionName !== activeSession) {
    setActiveSession(recording.sessionName);
  }

  const draft = useLiveDraftStore((s) =>
    activeSession ? s.drafts[activeSession] : undefined,
  );
  const startedAt = draft ? new Date(draft.startedAtMs) : null;


  const [stage, setStage] = React.useState<ProcessingStage>('transcribing');
  const [chunkProgress, setChunkProgress] = React.useState<string | null>(null);
  const [streamText, setStreamText] = React.useState('');
  const [streamedTitle, setStreamedTitle] = React.useState<string | null>(null);
  // Preserved source-audio path from a hard processing crash — the only handle
  // we have to actually re-run the failed job (no note/summaryFile is written
  // on that path). Null when unavailable, which disables "Try again" so it can
  // never re-arm the spinner without a real backing job.
  const [retryAudioFile, setRetryAudioFile] = React.useState<string | null>(null);
  const [retrying, setRetrying] = React.useState(false);
  const [retryError, setRetryError] = React.useState<string | null>(null);
  // Set by the watchdog below when it concludes nothing was ever captured, so
  // the error panel shows a calm "nothing to process" message instead of the
  // hard-crash copy.
  const [nothingRecorded, setNothingRecorded] = React.useState(false);

  // ── New-session generation (name-INDEPENDENT) ──────────────────────────
  // This route stays mounted across back-to-back recordings, so the watchdog +
  // per-session UI must reset when a new session takes over. Session identity is
  // only a collidable display name, so a single name check is insufficient: two
  // default-named notes (both 'Note') would not change activeSession. We fold
  // TWO signals into a monotonic `generation`:
  //   1. activeSession changes to a new non-null name (distinct-name case), and
  //   2. recording.status transitions INTO 'recording' (same-name case: a
  //      second recording reusing the name doesn't move activeSession, but its
  //      start still surfaces via useRecording as idle/processing → 'recording').
  // Tracked in state (React's "adjust state when a value changes" pattern, like
  // the setActiveSession above) so no ref is mutated during render.
  const [genState, setGenState] = React.useState({
    generation: 0,
    session: activeSession,
    status: recording.status,
  });
  if (genState.session !== activeSession || genState.status !== recording.status) {
    const isNewSession = activeSession != null && activeSession !== genState.session;
    const startedRecording =
      recording.status === 'recording' && genState.status !== 'recording';
    setGenState({
      generation: genState.generation + (isNewSession || startedRecording ? 1 : 0),
      session: activeSession,
      status: recording.status,
    });
  }
  const generation = genState.generation;

  // Reset per-session UI state on each new generation. Done during render so the
  // new session paints fresh with no flash of the prior "Nothing to process"
  // panel. The watchdog's ref + interval re-arm lives in an effect below (refs
  // can't be reset during render); the 8-tick threshold, isQueueSuccess gate,
  // and hidden-window guard all still apply, so recovery can't reintroduce a
  // false trip.
  const [uiGen, setUiGen] = React.useState(generation);
  if (generation !== uiGen) {
    setUiGen(generation);
    setStage('transcribing');
    setNothingRecorded(false);
    setStreamText('');
    setStreamedTitle(null);
    setChunkProgress(null);
    setRetryAudioFile(null);
    setRetryError(null);
  }

  // Segmentation (the diarizer's own pass over the whole channel, before its
  // embedding-extraction loop even starts) has no per-chunk checkpoint to
  // report a percentage from -- measured on a real ~21-minute recording, it
  // alone took 100+ seconds with zero forward signal otherwise, which reads
  // as "stuck" even though it's healthy. A client-side elapsed-time ticker
  // is the only way to show visible motion during that stretch without a
  // backend change.
  const diarizeTimerRef = React.useRef<ReturnType<typeof setInterval> | null>(null);
  const diarizeStartedAtRef = React.useRef<number | null>(null);
  const diarizeHasPercentRef = React.useRef(false);
  const clearDiarizeTimer = React.useCallback(() => {
    if (diarizeTimerRef.current) {
      clearInterval(diarizeTimerRef.current);
      diarizeTimerRef.current = null;
    }
  }, []);
  React.useEffect(() => () => clearDiarizeTimer(), [clearDiarizeTimer]);

  // Buffer streamed chunks and flush at most every 50ms (~20fps). At a
  // typical token rate of 30-60 tokens/sec, this batches ~3 tokens per
  // commit which keeps the UI smooth without re-parsing the entire markdown
  // string on every single chunk.
  const pendingChunkRef = React.useRef('');
  const flushTimerRef = React.useRef<ReturnType<typeof setTimeout> | null>(null);
  React.useEffect(() => {
    return () => {
      if (flushTimerRef.current) clearTimeout(flushTimerRef.current);
    };
  }, []);

  React.useEffect(() => {
    const flushPending = () => {
      flushTimerRef.current = null;
      if (!pendingChunkRef.current) return;
      const buffered = pendingChunkRef.current;
      pendingChunkRef.current = '';
      setStreamText((t) => t + buffered);
    };
    const offs = [
      ipc().on.summaryChunk((e) => {
        // This screen shows the fresh-recording queue job, which emits bare
        // (no-summaryFile) chunks. A concurrent reprocess/report of a DIFFERENT
        // meeting emits summaryFile-scoped chunks — ignore those so an unrelated
        // reprocess can't move this screen's stage and latch the watchdog's
        // "saw activity" flag (which would hide a real no-job dead-end).
        if (e.summaryFile) return;
        if (activeSession && e.sessionName !== activeSession) return;
        clearDiarizeTimer();
        pendingChunkRef.current += e.chunk;
        setStage((s) => (s === 'transcribing' || s === 'diarizing' ? 'summarizing' : s));
        if (!flushTimerRef.current) {
          flushTimerRef.current = setTimeout(flushPending, 50);
        }
      }),
      ipc().on.summaryTitle((e) => {
        if (activeSession && e.sessionName !== activeSession) return;
        setStreamedTitle(e.title);
      }),
      ipc().on.summaryComplete((e) => {
        // Same reprocess guard as summaryChunk above — a summaryFile-scoped
        // completion belongs to another meeting's reprocess, not this
        // fresh-recording job.
        if (e.summaryFile) return;
        if (activeSession && e.sessionName !== activeSession) return;
        clearDiarizeTimer();
        setChunkProgress(null);
        setStage((s) => (s === 'error' ? s : 'finalizing'));
      }),
      ipc().on.processingComplete((e) => {
        if (activeSession && e.sessionName !== activeSession) return;
        if (!e.success) {
          setRetryAudioFile(e.audioFile ?? null);
          clearDiarizeTimer();
          setChunkProgress(null);
          setStage('error');
          return;
        }
        // Apply title rename if user edited the draft. The global useRecording
        // listener handles navigation to /meetings/<final>.
        const d = getLiveDraft(e.sessionName);
        const summaryFile = e.meetingData?.session_info.summary_file;
        if (summaryFile && d?.title && d.title !== e.sessionName) {
          updateMeeting.mutate({
            summaryFile,
            patch: { name: d.title },
          });
        }
      }),
      ipc().on.processingProgress((e) => {
        // This screen shows the fresh-recording queue job, which emits bare
        // {line} progress (no summaryFile). A concurrent reprocess/report of a
        // DIFFERENT meeting emits summaryFile-scoped progress — ignore those so
        // another meeting's "Summarizing part N" can't hijack this screen's stage.
        if (e.summaryFile) return;
        if (e.line.startsWith('PROGRESS:summarize:')) {
          const raw = e.line.slice('PROGRESS:summarize:'.length);
          if (raw === 'reducing') {
            setChunkProgress('Merging summaries…');
          } else {
            const [step, total] = raw.split('/').map(Number);
            const p = fractionToPercent(step, total);
            if (p !== null) setChunkProgress(`Summarizing… ${p}%`);
          }
          setStage((s) => (s === 'transcribing' || s === 'diarizing' ? 'summarizing' : s));
        } else if (e.line.startsWith('PROGRESS:transcribe:')) {
          const raw = e.line.slice('PROGRESS:transcribe:'.length);
          const [done, total] = raw.split('/').map(Number);
          // done/total are raw sample counts, not chunk counts -- can be in
          // the tens of millions, so only a percentage is ever useful here.
          const p = fractionToPercent(done, total);
          if (p !== null) setChunkProgress(`Transcribing… ${p}%`);
        } else if (e.line.startsWith('PROGRESS:diarize:')) {
          const rest = e.line.slice('PROGRESS:diarize:'.length);
          const [label, kind, fraction] = rest.split(':');
          if (kind === 'start') {
            setStage((s) => (s === 'transcribing' ? 'diarizing' : s));
            clearDiarizeTimer();
            diarizeHasPercentRef.current = false;
            diarizeStartedAtRef.current = Date.now();
            setChunkProgress(`Diarizing ${label} channel…`);
            // Segmentation (before the embedding loop starts ticking below)
            // has no per-chunk checkpoint to report a percentage from -- a
            // real ~21-minute recording measured 100+ seconds of dead air
            // here otherwise. This ticks a plain elapsed-time counter so
            // the stage visibly stays alive until real percentages arrive.
            diarizeTimerRef.current = setInterval(() => {
              if (diarizeHasPercentRef.current || diarizeStartedAtRef.current === null) return;
              const elapsedS = Math.floor((Date.now() - diarizeStartedAtRef.current) / 1000);
              setChunkProgress(`Diarizing ${label} channel… (${formatElapsedSeconds(elapsedS)})`);
            }, 1000);
          } else if (kind === 'embedding' && fraction) {
            const [i, n] = fraction.split('/').map(Number);
            const p = fractionToPercent(i, n);
            if (p !== null) {
              diarizeHasPercentRef.current = true;
              clearDiarizeTimer();
              setChunkProgress(`Diarizing ${label} channel… ${p}%`);
            }
          } else if (kind === 'done') {
            // Stop the elapsed ticker; no other UI action needed -- the
            // next channel's :start, or the first summarize: chunk,
            // supersedes this sub-label shortly after.
            clearDiarizeTimer();
          }
        }
      }),
    ];
    return () => offs.forEach((fn) => fn());
  }, [activeSession, updateMeeting, clearDiarizeTimer]);

  // Watchdog. Any real processing activity — a streamed chunk, chunk progress,
  // a stage move past 'transcribing' (summaryComplete/processingComplete) —
  // permanently disarms it for this screen visit.
  const sawActivity =
    stage !== 'transcribing' || streamText !== '' || chunkProgress !== null;
  // "The queue has resolved real data at least once AND it is genuinely idle and
  // empty AND we've seen nothing yet." The isQueueSuccess gate matters because
  // absent query data defaults to status:'idle'/queueSize:0 — without it a slow
  // first IPC would look like a no-job dead-end.
  const idleEmpty =
    !sawActivity &&
    recording.isQueueSuccess &&
    recording.status === 'idle' &&
    recording.queueSize === 0;
  // Mirror the freshest signals into refs so the interval below can read them
  // without becoming a dependency that would tear itself down and restart (and
  // reset the consecutive-tick counter) on every queue poll.
  const sawActivityRef = React.useRef(false);
  const idleEmptyRef = React.useRef(false);
  React.useEffect(() => {
    if (sawActivity) sawActivityRef.current = true;
    idleEmptyRef.current = idleEmpty;
  });

  const setGaveUp = useProcessingWatchdogStore((s) => s.setGaveUp);
  // Reset the shared "gave up" flag at the start of each screen visit (and clear
  // it on leave) so a fresh recording's dock never inherits a prior visit's
  // watchdog conclusion.
  React.useEffect(() => {
    setGaveUp(false);
    return () => setGaveUp(false);
  }, [setGaveUp]);

  // Re-arm the watchdog for a NEW generation WITHOUT a remount (see the UI-state
  // reset above for the why). Refs can't be reset during render, so the
  // watchdog's latched signals + the shared "gave up" flag are cleared here on a
  // genuine transition; the interval effect below re-arms on generation too,
  // resetting its consecutive-tick counter. sawActivityRef is the important one
  // — it latches true in the error state and would otherwise keep the re-armed
  // interval permanently disarmed for the new session.
  const prevGenRef = React.useRef(generation);
  React.useEffect(() => {
    if (generation === prevGenRef.current) return;
    prevGenRef.current = generation;
    pendingChunkRef.current = '';
    clearDiarizeTimer();
    diarizeStartedAtRef.current = null;
    diarizeHasPercentRef.current = false;
    sawActivityRef.current = false;
    idleEmptyRef.current = false;
    setGaveUp(false);
  }, [generation, setGaveUp, clearDiarizeTimer]);

  React.useEffect(() => {
    let idleTicks = 0;
    const id = setInterval(() => {
      if (sawActivityRef.current) {
        clearInterval(id);
        return;
      }
      // Don't count while the window is hidden: the queue poll cadence drops to
      // 10s and react-query lets the cache go stale, so a job enqueued during a
      // hidden stretch could be missed. Reading document.visibilityState live
      // (not a render-synced ref) avoids any staleness window.
      const hidden =
        typeof document !== 'undefined' && document.visibilityState === 'hidden';
      if (idleEmptyRef.current && !hidden) {
        idleTicks += 1;
        if (idleTicks >= WATCHDOG_IDLE_TICKS) {
          clearInterval(id);
          setNothingRecorded(true);
          setStage('error');
          setGaveUp(true);
        }
      } else {
        // Not counting right now (a job exists, still in the stop→enqueue
        // handoff, the queue hasn't loaded, or the window is hidden) — reset so
        // only *consecutive* idle ticks count.
        idleTicks = 0;
      }
    }, WATCHDOG_TICK_MS);
    return () => clearInterval(id);
    // generation is a dep so the interval re-arms (resetting its local idleTicks
    // counter) for a new session started without a remount — including a
    // same-name second recording, which only surfaces via the generation bump.
  }, [generation, setGaveUp]);

  // Actually re-run the failed job: re-queue the preserved source audio via the
  // same import pipeline a stopped recording uses. Its copy-then-queue semantics
  // keep the original safe across repeated retries. Only re-arm the loading UI
  // once the queue call is confirmed issued — a failed/rejected call stays in
  // the error state instead of spinning forever.
  const handleRetry = React.useCallback(async () => {
    if (!retryAudioFile || !activeSession || retrying) return;
    setRetrying(true);
    setRetryError(null);
    try {
      const res = await ipc().recording.processFile(retryAudioFile, activeSession);
      if (!res.success) {
        setRetryError(res.error || 'Couldn’t restart processing. Please try again.');
        return;
      }
      pendingChunkRef.current = '';
      setStreamText('');
      setStreamedTitle(null);
      setChunkProgress(null);
      setRetryAudioFile(null);
      setStage('transcribing');
    } catch (err) {
      setRetryError(
        err instanceof Error ? err.message : 'Couldn’t restart processing. Please try again.',
      );
    } finally {
      setRetrying(false);
    }
  }, [retryAudioFile, activeSession, retrying]);

  const displayTitle =
    streamedTitle ?? draft?.title ?? activeSession ?? 'Note';

  return (
    <MeetingsShell activeSummaryFile={null}>
      <div className="mx-auto w-full max-w-[760px]">
        <header className="mb-8">
          <button
            type="button"
            onClick={() => navigate('/')}
            className="mb-6 inline-flex cursor-pointer items-center gap-1 rounded-md border-0 bg-transparent px-2 py-1 text-[13px] transition-colors hover:bg-[color:var(--surface-hover)] hover:text-[color:var(--fg-1)]"
            style={{ color: 'var(--fg-2)' }}
            aria-label={t('recording.backToHome')}
          >
            <ChevronLeft size={15} />
            {t('nav.home')}
          </button>

          <h1
            className="m-0 text-[34px] transition-colors"
            style={{
              fontFamily: 'var(--font-serif)',
              letterSpacing: '-0.02em',
              color: 'var(--fg-1)',
              lineHeight: 1.15,
              fontWeight: 400,
            }}
          >
            {displayTitle}
          </h1>

          <div className="mt-3 flex flex-wrap items-center gap-2">
            {startedAt && (
              <Chip icon={<CalendarIcon size={11} />}>
                {formatDate(startedAt)}
              </Chip>
            )}
            <Chip icon={<Clock size={11} />}>
              <ElapsedTimer startedAt={startedAt} fallbackElapsed={recording.elapsed} />
            </Chip>
            {/* Hide the animated "Processing" chip once we've stopped: an error
                (crash or the watchdog's "nothing to process") means nothing is
                actively processing, so the chip would mislead. */}
            {stage !== 'error' && <ProcessingChip />}
          </div>
        </header>

        {stage === 'error' ? (
          <ErrorPanel
            onRetry={handleRetry}
            canRetry={Boolean(retryAudioFile && activeSession)}
            retrying={retrying}
            error={retryError}
            nothingRecorded={nothingRecorded}
          />
        ) : (
          <StageCard stage={stage} streamText={streamText} chunkProgress={chunkProgress} />
        )}

        {draft?.notes && (
          <section className="mt-8">
            <div
              className="mb-2 inline-flex items-center gap-1.5 text-[13px]"
              style={{ color: 'var(--fg-2)' }}
            >
              <PencilLine size={13} />
              {t('recording.myNotes')}
            </div>
            <div
              className="whitespace-pre-wrap text-[15px]"
              style={{
                color: 'var(--fg-1)',
                fontFamily: 'var(--font-sans)',
                lineHeight: 1.6,
              }}
            >
              {draft.notes}
            </div>
          </section>
        )}
      </div>
    </MeetingsShell>
  );
}

// Memoized so it only re-parses when streamText actually changes — without
// this it'd re-render on every parent re-render (stage transitions, draft
// updates, etc.) and re-walk the markdown tree unnecessarily.
const StreamMarkdown = React.memo(function StreamMarkdown({ text }: { text: string }) {
  return <ReactMarkdown>{stripReasoning(text)}</ReactMarkdown>;
});

function StageCard({
  stage,
  streamText,
  chunkProgress,
}: {
  stage: ProcessingStage;
  streamText: string;
  chunkProgress: string | null;
}) {
  // FLIP animation for the scanner bar. The bar is in normal flow under the
  // streaming markdown, so each token batch shifts it down by a discrete
  // amount — jerky if rendered as-is. On every layout we measure the bar's
  // new top, apply an inverse translateY (so visually it stays in the old
  // position), force a reflow, then animate transform back to 0 — giving a
  // smooth glide between positions even though the underlying layout is
  // stepwise. Cheaper than animating a transform driven by a ResizeObserver
  // on the markdown body.
  const barRef = React.useRef<HTMLDivElement>(null);
  const lastTopRef = React.useRef<number | null>(null);
  const willChangeTimerRef = React.useRef<ReturnType<typeof setTimeout> | null>(null);
  React.useEffect(() => {
    return () => {
      if (willChangeTimerRef.current) clearTimeout(willChangeTimerRef.current);
    };
  }, []);
  React.useLayoutEffect(() => {
    const el = barRef.current;
    if (!el) return;
    // Snap any in-flight FLIP animation to its rest position before measuring.
    // Otherwise getBoundingClientRect() returns "layout top + current transform
    // offset", lastTopRef stores that contaminated value, and the next delta
    // ends up with the wrong sign — the bar oscillates instead of gliding
    // down monotonically as new chunks land.
    el.style.transition = 'none';
    el.style.transform = 'none';
    const newTop = el.getBoundingClientRect().top;
    const last = lastTopRef.current;
    lastTopRef.current = newTop;
    if (last === null || last === newTop) return;
    const delta = last - newTop;
    // Promote to its own compositor layer just for the duration of the
    // animation, then clear. Leaving will-change on permanently keeps a
    // layer alive when nothing's animating, costing memory.
    el.style.willChange = 'transform';
    el.style.transform = `translateY(${delta}px)`;
    // Force a reflow so the inverse transform is committed before we kick
    // off the animation back to 0.
    void el.getBoundingClientRect();
    el.style.transition = 'transform 0.32s cubic-bezier(0.33, 1, 0.68, 1)';
    el.style.transform = 'translateY(0)';
    if (willChangeTimerRef.current) clearTimeout(willChangeTimerRef.current);
    willChangeTimerRef.current = setTimeout(() => {
      if (barRef.current) barRef.current.style.willChange = 'auto';
    }, 360);
  }, [streamText]);

  return (
    <div className="relative" style={{ maxWidth: '72ch' }}>
      {streamText && (
        <div
          className="stream-markdown mb-3 text-[15px]"
          style={{
            color: 'var(--fg-1)',
            fontFamily: 'var(--font-sans)',
            lineHeight: 1.6,
          }}
        >
          <StreamMarkdown text={streamText} />
        </div>
      )}

      {/* Scanner bar — rides at the bottom of streamed text, slides down
          smoothly via FLIP as more tokens arrive. */}
      <div
        ref={barRef}
        className="flex items-center gap-2.5 rounded-lg px-3.5 py-2.5"
        style={{
          background: 'var(--surface-raised)',
          border: '1px solid var(--border-subtle)',
          boxShadow: 'var(--shadow-md)',
        }}
      >
        <Loader2
          className="animate-spin"
          size={14}
          style={{ color: 'var(--fg-2)' }}
        />
        <span
          data-testid="processing-stage-label"
          data-stage={stage}
          className="text-[13px] transition-colors"
          style={{ color: 'var(--fg-1)', fontFamily: 'var(--font-sans)' }}
        >
          {chunkProgress && stage !== 'finalizing' && stage !== 'error' ? chunkProgress : getStageLabel(stage)}
        </span>
      </div>
    </div>
  );
}

function ErrorPanel({
  // error panel

  onRetry,
  canRetry,
  retrying,
  error,
  nothingRecorded,
}: {
  onRetry: () => void;
  canRetry: boolean;
  retrying: boolean;
  error: string | null;
  nothingRecorded: boolean;
}) {
  const { t } = useTranslation();
  // The watchdog case is not a failure — nothing was lost because nothing was
  // captured — so it gets a calmer heading and copy than the hard-crash path.
  const heading = nothingRecorded ? t('processing.nothingToProcess') : getStageLabel('error');
  const detail = nothingRecorded
    ? 'This recording didn’t capture any audio, so there’s nothing to process. Nothing was lost. Head back to Home to start a new note.'
    : canRetry
      ? 'Try again to re-run processing on this recording.'
      : 'This recording couldn’t be recovered automatically. Try importing the audio file again from Home.';
  return (
    <div className="py-3">
      <p
        className="text-[17px]"
        style={{ color: 'var(--fg-1)', fontFamily: 'var(--font-sans)' }}
      >
        {heading}
      </p>
      <p
        className="mt-1 text-[14px]"
        style={{ color: 'var(--fg-2)' }}
      >
        {detail}
      </p>
      {error && (
        <p
          className="mt-2 text-[14px]"
          role="alert"
          style={{ color: 'var(--danger, #b4231f)' }}
        >
          {error}
        </p>
      )}
      <button
        type="button"
        onClick={onRetry}
        disabled={!canRetry || retrying}
        className="mt-4 inline-flex h-9 cursor-pointer items-center gap-2 rounded-[8px] border-0 px-4 text-[14px] font-medium disabled:cursor-not-allowed disabled:opacity-60"
        style={{
          background: 'var(--fg-1)',
          color: 'var(--fg-inverse)',
        }}
      >
        {retrying && <Loader2 className="animate-spin" size={14} />}
        {retrying ? `${t('common.retry')}…` : t('common.retry')}
      </button>
    </div>
  );
}

function ProcessingChip() {
  return (
    <span
      data-testid="processing-chip"
      className="inline-flex items-center gap-1.5 px-2 py-1 text-[12px]"
      style={{
        color: 'var(--fg-2)',
        background: 'var(--surface-sunken)',
        borderRadius: 'var(--radius-sm)',
      }}
    >
      <Loader2 className="animate-spin" size={11} />
      Processing
    </span>
  );
}

function Chip({
  icon,
  children,
}: {
  icon: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <span
      className="inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-[12px]"
      style={{
        color: 'var(--fg-2)',
        border: '1px solid var(--border-subtle)',
        background: 'var(--surface-raised)',
      }}
    >
      {icon}
      {children}
    </span>
  );
}

// ---------------------------------------------------------------------------
// Bottom-dock content for /meetings/processing — same screen slot as AskBar
// and LiveDock so the transition feels like a content swap.
// ---------------------------------------------------------------------------

export function ProcessingDock() {
  const { t } = useTranslation();
  const recording = useRecording();
  const sessionName = recording.sessionName;
  const draft = useLiveDraftStore((s) =>
    sessionName ? s.drafts[sessionName] : undefined,
  );
  const startedAt = draft ? new Date(draft.startedAtMs) : null;

  // Once the watchdog concluded nothing was captured, the screen shows a
  // "Nothing to process" panel — don't keep animating "Processing" beneath it.
  const gaveUp = useProcessingWatchdogStore((s) => s.gaveUp);
  if (gaveUp) return null;

  return (
    <div className="flex justify-center pointer-events-none">
      <div
        className="pointer-events-auto flex items-center gap-3 rounded-full px-3 py-2"
        style={{
          background: 'var(--surface-raised)',
          border: '1px solid var(--border-subtle)',
          boxShadow: 'var(--shadow-md)',
        }}
      >
        <span
          className="inline-flex items-center gap-2 px-2 text-[13px]"
          style={{ color: 'var(--fg-1)' }}
        >
          <Loader2
            className="animate-spin"
            size={14}
            style={{ color: 'var(--fg-2)' }}
          />
          <span style={{ color: 'var(--fg-2)' }}>{t('common.processing')}</span>
          <span
            className="tabular-nums"
            style={{
              color: 'var(--fg-1)',
              fontFamily: 'var(--font-sans)',
              fontSize: 13,
            }}
          >
            <ElapsedTimer startedAt={startedAt} fallbackElapsed={recording.elapsed} />
          </span>
        </span>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function ElapsedTimer({ startedAt, fallbackElapsed }: { startedAt: Date | null, fallbackElapsed: number }) {
  const [now, setNow] = React.useState(() => Date.now());
  React.useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);

  const totalElapsedSeconds = startedAt
    ? Math.max(0, Math.floor((now - startedAt.getTime()) / 1000))
    : fallbackElapsed;

  return <>{formatDurationEnglish(totalElapsedSeconds)}</>;
}

function formatDate(d: Date): string {
  return d.toLocaleDateString(undefined, {
    weekday: 'short',
    day: 'numeric',
    month: 'short',
    year: 'numeric',
  });
}

/** Plain-English duration ("12 min", "1 h 4 min"). Mono is reserved for the live timer. */
function formatDurationEnglish(seconds: number): string {
  if (seconds < 60) return `${seconds} sec`;
  const totalMinutes = Math.floor(seconds / 60);
  if (totalMinutes < 60) return `${totalMinutes} min`;
  const h = Math.floor(totalMinutes / 60);
  const m = totalMinutes % 60;
  if (m === 0) return `${h} h`;
  return `${h} h ${m} min`;
}
