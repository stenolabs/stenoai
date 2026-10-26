import * as React from 'react';
import { ipc, type LiveSegment } from '@/lib/ipc';

export type LiveTranscriptStatus = 'idle' | 'loading' | 'streaming' | 'error';

export interface UseLiveTranscriptResult {
  status: LiveTranscriptStatus;
  /** Every segment in render order: finalised first, in-progress partials
   *  trailing. Kept for search, copy and tail-tracking - rendering uses the
   *  two lanes below so a partial tick doesn't re-render the finals. */
  segments: LiveSegment[];
  /** Finalised segments of the current session, chronologically sorted. */
  finals: LiveSegment[];
  /** The in-progress utterances, at most one per speaker. Replaced ~every
   *  400 ms per channel while someone is talking. */
  partials: LiveSegment[];
  /** Finalised segments from the previous recording into this same note,
   *  carried across a resume/continue. Display-only — render these before
   *  `segments` so the live bar shows the earlier speech instead of blank.
   *  Empty on a fresh (non-continued) recording. */
  priorSegments: LiveSegment[];
  /** Last error reported by the Python consumer (model load failure, MLX
   *  missing, etc.). Null on success. */
  error: { stage: string; message?: string } | null;
  /** True once the model has been in `loading` for longer than the soft
   *  threshold (~2s) — lets the UI soften "preparing" copy to acknowledge
   *  an unavoidable cold load rather than looking frozen. */
  slow: boolean;
}

/** 'You' | 'Others', normalised the same way the UI's charitable default
 *  treats a missing/undefined speaker tag. */
function speakerKey(segment: LiveSegment): 'You' | 'Others' {
  return segment.speaker === 'Others' ? 'Others' : 'You';
}

/**
 * Insert a finalised segment into the chronologically sorted finals lane.
 *
 * A final released late by the live path's bleed-dedup hold (up to
 * PER_SEGMENT_BLEED_WINDOW_S) can land out of chronological order relative to a
 * still-ongoing utterance on the other channel, so the insert point is searched
 * from the end rather than assumed to be the tail.
 */
function insertFinal(prev: LiveSegment[], segment: LiveSegment): LiveSegment[] {
  let insertAt = prev.length;
  while (insertAt > 0 && prev[insertAt - 1].start > segment.start) insertAt--;
  if (insertAt === prev.length) return [...prev, segment];
  return [...prev.slice(0, insertAt), segment, ...prev.slice(insertAt)];
}

/**
 * Fold a partial into the partials lane: at most one in-progress utterance per
 * speaker, the newer one replacing the older **in its existing position**.
 *
 * Two independent channels (mic + system) emit interleaved streams, so a naive
 * "replace whatever is there" would clobber one channel's in-progress partial
 * with the other's the moment they overlap.
 *
 * Position matters because both channels can be mid-utterance at once: filtering
 * the speaker out and re-appending moved that speaker's bubble to the bottom on
 * every tick, so two people talking made the two in-progress rows trade places
 * several times a second.
 */
function replacePartial(prev: LiveSegment[], segment: LiveSegment): LiveSegment[] {
  const key = speakerKey(segment);
  const idx = prev.findIndex((s) => speakerKey(s) === key);
  if (idx === -1) return [...prev, segment];
  const next = prev.slice();
  next[idx] = segment;
  return next;
}

/**
 * Drop the partial a final supersedes.
 *
 * Only a same-speaker partial that could plausibly BE the utterance this final
 * closes (started before the final's utterance ended) is dropped. A
 * bleed-delayed final can arrive well after the SAME speaker has already
 * started a newer, unrelated utterance - dropping every same-speaker partial
 * indiscriminately would clobber that unrelated one until its next tick.
 */
function retirePartials(prev: LiveSegment[], final: LiveSegment): LiveSegment[] {
  if (prev.length === 0) return prev;
  const key = speakerKey(final);
  const next = prev.filter((s) => speakerKey(s) !== key || s.start > final.end);
  return next.length === prev.length ? prev : next;
}

/** Split a backfilled snapshot into the same two lanes main.js keeps it in:
 *  chronologically sorted finals first, trailing in-progress partials last. */
function splitLanes(snapshot: LiveSegment[]): { finals: LiveSegment[]; partials: LiveSegment[] } {
  let splitIdx = snapshot.length;
  while (splitIdx > 0 && !snapshot[splitIdx - 1].isFinal) splitIdx--;
  return { finals: snapshot.slice(0, splitIdx), partials: snapshot.slice(splitIdx) };
}

/**
 * Subscribes to Parakeet live-transcript events for the active recording.
 *
 * Flow:
 *   1. On mount, snapshot the buffer that main.js has been accumulating
 *      since the recording started — this catches a late-mounting panel up
 *      with any segments it missed. main.js maintains the same
 *      finals-then-per-speaker-partials invariant, so the snapshot splits
 *      cleanly into the two lanes.
 *   2. Subscribe to `live-transcript-chunk` for the tail and fold each update
 *      into its lane.
 *   3. Track ready/error state via the dedicated channels so the UI can
 *      distinguish "no speech yet" from "model still loading" from
 *      "model failed to load."
 *
 * **Why two lanes.** Partials arrive up to ~5x/s (both channels at the
 * sidecar's 400 ms cadence) while finals arrive a couple of times a minute. Held
 * in one array, every partial produced a new array identity for the whole
 * transcript, so React re-rendered every finalised row - a cost that grew with
 * meeting length. Split, a partial tick only invalidates the (at most two)
 * in-progress rows.
 *
 * The hook is safe to mount with no active recording — `getState` returns
 * an empty segments array and the status stays `idle`.
 */
export function useLiveTranscript(sessionName: string | null): UseLiveTranscriptResult {
  const [finals, setFinals] = React.useState<LiveSegment[]>([]);
  const [partials, setPartials] = React.useState<LiveSegment[]>([]);
  // Carried over from the previous recording into this same note. Static for
  // the session — only the getState backfill populates it (there is no live
  // event for it), so it's set once and never folded into the lanes.
  const [priorSegments, setPriorSegments] = React.useState<LiveSegment[]>([]);
  const [ready, setReady] = React.useState(false);
  const [error, setError] = React.useState<{ stage: string; message?: string } | null>(null);
  // Per-session marker that flips true the moment any subscription event
  // arrives. The backfill (getState resolves async) checks it before
  // applying its snapshot — if a chunk landed first, the snapshot is
  // older than what we already have and would clobber live updates.
  const receivedEventRef = React.useRef(false);
  const revokedSpeakersRef = React.useRef<Set<'You' | 'Others'>>(new Set());

  React.useEffect(() => {
    // Reset state for the new session. Doing this in the same effect as
    // the subscription guarantees the marker resets BEFORE any chunk
    // event can fire for the new session.
    receivedEventRef.current = false;
    revokedSpeakersRef.current = new Set();
    setFinals([]);
    setPartials([]);
    setPriorSegments([]);
    setReady(false);
    setError(null);

    if (!sessionName) return;

    // Subscribe FIRST so chunks arriving while getState is in flight are
    // captured (not lost behind a still-pending resolve).
    const offReady = ipc().on.liveTranscriptReady((ev) => {
      if (ev.sessionName !== sessionName) return;
      receivedEventRef.current = true;
      setReady(true);
      setError(null);
    });

    const offChunk = ipc().on.liveTranscriptChunk((ev) => {
      if (ev.sessionName !== sessionName) return;
      receivedEventRef.current = true;
      // ev.segment.speaker already carries the true mic/system channel
      // tag from the Python sidecar — no client-side attribution needed.
      const segment: LiveSegment = ev.segment;
      if (segment.isFinal) {
        setFinals((prev) => insertFinal(prev, segment));
        setPartials((prev) => retirePartials(prev, segment));
      } else {
        setPartials((prev) => replacePartial(prev, segment));
      }
    });

    const offRevoke = ipc().on.liveTranscriptRevoke((ev) => {
      if (ev.sessionName !== sessionName) return;
      revokedSpeakersRef.current.add(ev.speaker);
      setPartials((prev) => prev.filter((segment) => speakerKey(segment) !== ev.speaker));
    });

    const offError = ipc().on.liveTranscriptError((ev) => {
      if (ev.sessionName !== sessionName) return;
      receivedEventRef.current = true;
      setError({ stage: ev.stage, message: ev.message ?? ev.error });
    });

    // Now backfill. If a live event arrived between subscribe and resolve,
    // skip the snapshot — the subscription has fresher data.
    let cancelled = false;
    ipc()
      .liveTranscript.getState()
      .then((res) => {
        if (cancelled || !res.success) return;
        if (res.sessionName !== sessionName) return;
        // priorSegments are independent of the live tail (no live event ever
        // updates them), so apply them even if a chunk raced ahead — the
        // receivedEventRef guard below only protects the live lanes.
        setPriorSegments(res.priorSegments ?? []);
        if (receivedEventRef.current) return;
        // Backfilled segments already carry their true speaker tag —
        // main.js stores it verbatim in liveTranscriptState.segments.
        const lanes = splitLanes(res.segments ?? []);
        setFinals(lanes.finals);
        setPartials(lanes.partials.filter(
          (segment) => !revokedSpeakersRef.current.has(speakerKey(segment)),
        ));
        setReady(res.ready);
        if (res.error) {
          setError({ stage: res.error.stage, message: res.error.message ?? res.error.error });
        }
      })
      .catch(() => {
        // Best-effort backfill; subscription is the source of truth.
      });

    return () => {
      cancelled = true;
      offReady();
      offChunk();
      offRevoke();
      offError();
    };
  }, [sessionName]);

  // Flat view for consumers that need the whole transcript (search, copy,
  // tail tracking). Concatenating pointers is cheap; what used to be
  // expensive was making React walk the result every tick.
  const segments = React.useMemo(
    () => (partials.length === 0 ? finals : [...finals, ...partials]),
    [finals, partials],
  );

  const status: LiveTranscriptStatus = error
    ? 'error'
    : !sessionName
      ? 'idle'
      : segments.length > 0 || priorSegments.length > 0 || ready
        ? 'streaming'
        : 'loading';

  // Flip `slow` once the model has been loading past the soft threshold. The
  // 2s mark is where an unavoidable cold load stops reading as a blink and
  // starts feeling like a hang. The timer (and its reset) live off the effect
  // body — set on timeout, cleared on leaving the loading state — so we never
  // call setState synchronously during render. `sessionName` in the deps
  // restarts the clock for each new recording.
  const [slow, setSlow] = React.useState(false);
  React.useEffect(() => {
    if (status !== 'loading') return;
    const id = window.setTimeout(() => setSlow(true), 2000);
    return () => {
      window.clearTimeout(id);
      setSlow(false);
    };
  }, [status, sessionName]);

  return { status, segments, finals, partials, priorSegments, error, slow };
}

/**
 * Status-only view of the same stream, for consumers that render a label rather
 * than the transcript (the LiveDock pill's "Preparing…").
 *
 * The pill is mounted for the whole meeting, so subscribing it to the full hook
 * meant a second complete copy of every segment was retained and re-inserted on
 * every tick purely to answer "is the model still loading?". This tracks a
 * boolean instead, with identical semantics: any segment arriving means the
 * model is past loading, whether or not LIVE_READY was seen first.
 */
export function useLiveTranscriptStatus(sessionName: string | null): {
  status: LiveTranscriptStatus;
  slow: boolean;
} {
  const [ready, setReady] = React.useState(false);
  const [sawSegment, setSawSegment] = React.useState(false);
  const [error, setError] = React.useState<{ stage: string; message?: string } | null>(null);
  const receivedEventRef = React.useRef(false);

  React.useEffect(() => {
    receivedEventRef.current = false;
    setReady(false);
    setSawSegment(false);
    setError(null);
    if (!sessionName) return;

    const offReady = ipc().on.liveTranscriptReady((ev) => {
      if (ev.sessionName !== sessionName) return;
      receivedEventRef.current = true;
      setReady(true);
      setError(null);
    });
    const offChunk = ipc().on.liveTranscriptChunk((ev) => {
      if (ev.sessionName !== sessionName) return;
      receivedEventRef.current = true;
      // setState with the same value is a no-op re-render-wise, so the
      // remaining per-tick cost here is the IPC hand-off itself.
      setSawSegment(true);
    });
    const offError = ipc().on.liveTranscriptError((ev) => {
      if (ev.sessionName !== sessionName) return;
      receivedEventRef.current = true;
      setError({ stage: ev.stage, message: ev.message ?? ev.error });
    });

    // Same backfill the full hook does, reduced to the booleans this one
    // exposes - a pill mounted after the recording started must not sit at
    // "Preparing…" until the next event. Carried-over prior segments count as
    // streaming here exactly as they do there, so a resumed recording reads
    // the same in both.
    let cancelled = false;
    ipc()
      .liveTranscript.getState()
      .then((res) => {
        if (cancelled || !res.success) return;
        if (res.sessionName !== sessionName) return;
        if ((res.priorSegments ?? []).length > 0) setSawSegment(true);
        if (receivedEventRef.current) return;
        if ((res.segments ?? []).length > 0) setSawSegment(true);
        setReady(res.ready);
        if (res.error) {
          setError({ stage: res.error.stage, message: res.error.message ?? res.error.error });
        }
      })
      .catch(() => {
        /* best-effort backfill; the subscription is the source of truth */
      });

    return () => {
      cancelled = true;
      offReady();
      offChunk();
      offError();
    };
  }, [sessionName]);

  const status: LiveTranscriptStatus = error
    ? 'error'
    : !sessionName
      ? 'idle'
      : sawSegment || ready
        ? 'streaming'
        : 'loading';

  const [slow, setSlow] = React.useState(false);
  React.useEffect(() => {
    if (status !== 'loading') return;
    const id = window.setTimeout(() => setSlow(true), 2000);
    return () => {
      window.clearTimeout(id);
      setSlow(false);
    };
  }, [status, sessionName]);

  return { status, slow };
}
