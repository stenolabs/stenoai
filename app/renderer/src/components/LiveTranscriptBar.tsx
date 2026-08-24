import * as React from 'react';
import {
  Check,
  ChevronDown,
  Copy,
  Languages,
  Play,
  Search as SearchIcon,
  Square,
} from 'lucide-react';
import { AudioWave } from '@/components/AudioWave';
import { Input } from '@/components/ui/input';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { Tooltip, TooltipTrigger, TooltipContent } from '@/components/ui/tooltip';
import { cn } from '@/lib/utils';
import { useLiveTranscript } from '@/hooks/useLiveTranscript';
import { useRecording } from '@/hooks/useRecording';
import { useLanguageSetting, useSetLanguage } from '@/hooks/useSettings';
import { APPLE_LANGUAGES, PARAKEET_LANGUAGES } from '@/lib/transcription-languages';
import { useTranscriptionEngine } from '@/hooks/useModels';
import { useLiveTranscriptOpen } from '@/hooks/liveTranscriptOpenStore';
import { formatElapsed } from '@/lib/utils';

// Format a segment's start offset (seconds since recording start): MM:SS under
// an hour, H:MM:SS beyond it. The live pipeline already emits per-segment
// `start` on every LIVE_SEG, so this is a pure render of data we already have.
// Kept in the same MM:SS / H:MM:SS shape as the saved-transcript formatter
// (_format_timestamp in src/transcriber.py, which TranscriptPanel then parses
// back out) so the live view and the saved transcript read the same.
function fmtTimestamp(seconds: number): string {
  const s = Math.max(0, Math.floor(seconds));
  const hh = Math.floor(s / 3600);
  const mm = Math.floor((s % 3600) / 60);
  const ss = s % 60;
  const pad = (n: number) => String(n).padStart(2, '0');
  return hh ? `${hh}:${pad(mm)}:${pad(ss)}` : `${pad(mm)}:${pad(ss)}`;
}

/**
 * Live transcript dock — Granola-style.
 *
 * When the user opens the transcript, this panel takes the dock slot
 * **in place of** the LiveDock pill: header on top, segments in the body,
 * and a footer that owns the recording controls (Stop, plus Resume only
 * when the system auto-paused) and the
 * language picker. There's no separate recording pill while the panel is
 * open — all live controls live inside it.
 *
 * Closing returns to the standard LiveDock pill.
 */
export function LiveTranscriptBar() {
  const recording = useRecording();
  const sessionName = recording.sessionName;
  const paused = recording.status === 'paused';
  const isRecording = recording.status === 'recording';
  const stopped = !paused && !isRecording;

  const { status, segments, finals, partials, priorSegments, error, slow } =
    useLiveTranscript(sessionName);

  // On a resume/continue, prior finalised segments render before the live
  // tail so the bar shows earlier speech instead of starting blank. Merge for
  // search/copy/scroll; a divider marks the boundary (only when unfiltered,
  // where the first priorSegments.length rows are the carried-over ones).
  const allSegments = React.useMemo(
    () => (priorSegments.length ? [...priorSegments, ...segments] : segments),
    [priorSegments, segments]
  );

  const open = useLiveTranscriptOpen((s) => s.open);
  const setOpen = useLiveTranscriptOpen((s) => s.setOpen);

  const [query, setQuery] = React.useState('');
  const [copied, setCopied] = React.useState(false);
  const bodyRef = React.useRef<HTMLDivElement>(null);

  // Auto-scroll to the most recent segment on every change. Compare against
  // trailing text rather than just length so a partial that updates in
  // place (same array length, different last text) still triggers a scroll.
  //
  // Deferred to the next animation frame: reading scrollHeight in the effect
  // body forces a synchronous layout of the whole list in the middle of
  // React's commit, several times a second, and the list can be thousands of
  // rows deep in a long meeting. At frame time the layout is due anyway.
  //
  // Skip the auto-scroll while the user has an active search query — they
  // were browsing past matches and a jump to the new tail would yank the
  // viewport away from what they were reading. They get the new segment
  // automatically once they clear the query.
  const tailText = allSegments[allSegments.length - 1]?.text ?? '';
  const filtering = query.trim().length > 0;
  React.useEffect(() => {
    if (filtering) return;
    if (!open) return;
    let second = 0;
    const first = requestAnimationFrame(() => {
      const el = bodyRef.current;
      if (!el) return;
      el.scrollTop = el.scrollHeight;
      // A row rendered for the first time replaces its reserved intrinsic
      // height with its real one, which can grow the scroller a few pixels
      // *after* the assignment above clamped to the old maximum - leaving the
      // newest line a sliver below the fold. Re-assert on the next frame,
      // once that layout has settled.
      second = requestAnimationFrame(() => {
        const node = bodyRef.current;
        if (node) node.scrollTop = node.scrollHeight;
      });
    });
    return () => {
      cancelAnimationFrame(first);
      if (second) cancelAnimationFrame(second);
    };
  }, [allSegments.length, tailText, open, filtering]);

  const filtered = React.useMemo(() => {
    if (!query.trim()) return allSegments;
    const needle = query.trim().toLowerCase();
    return allSegments.filter((s) => s.text.toLowerCase().includes(needle));
  }, [allSegments, query]);

  const copyAll = React.useCallback(async () => {
    const text = allSegments
      .filter((s) => s.isFinal)
      .map((s) => s.text.trim())
      .filter(Boolean)
      .join('\n');
    if (!text) return;
    await navigator.clipboard.writeText(text);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  }, [allSegments]);

  const onPauseToggle = () => {
    if (paused) void recording.resumeRecording();
    else if (isRecording) void recording.pauseRecording();
  };
  const onStop = () => {
    void recording.stopRecording();
  };

  // Don't render when there's no active recording, or when the user has
  // toggled the panel closed via the LiveDock Transcript button. Both
  // gates unmount the whole shell — LiveDock takes over the dock slot.
  if (stopped || !sessionName) return null;
  if (!open) return null;

  return (
    <div className="pointer-events-auto" data-testid="live-transcript-panel">
      <div className="mv-transcript open" onMouseDown={(e) => e.stopPropagation()}>
        {/* Header — wave + "Transcript" + copy + minimize. The minimize
            (chevron) is the primary click target; copy is a sibling
            action button, not nested. (Nesting `<button>` inside `<button>`
            is invalid HTML and breaks both keyboard navigation and
            assistive-tech focus order.) */}
        <div className="mv-transcript-head" role="group" aria-label="Transcript header">
          {/* Static (non-animated) wave for the header — the "is anything
              happening?" cue lives in the footer's recording indicator. */}
          <span className="mv-transcript-wave mv-transcript-wave-static" aria-hidden="true">
            <span />
            <span />
            <span />
            <span />
            <span />
            <span />
            <span />
          </span>
          <span className="mv-transcript-label">Transcript</span>
          <Tooltip>
            <TooltipTrigger asChild>
              <button
                type="button"
                className="mv-chat-tool"
                onClick={() => void copyAll()}
                aria-label="Copy transcript"
              >
                {copied ? <Check size={13} /> : <Copy size={13} />}
              </button>
            </TooltipTrigger>
            <TooltipContent side="bottom">{copied ? 'Copied!' : 'Copy transcript'}</TooltipContent>
          </Tooltip>
          <button
            type="button"
            className="mv-chat-tool"
            onClick={() => setOpen(false)}
            aria-label="Minimize transcript"
            title="Minimize transcript"
          >
            <ChevronDown size={13} />
          </button>
        </div>

        {/* Search bar */}
        <div
          className="flex items-center px-3 py-1.5"
          style={{ borderTop: '1px solid var(--border-subtle)' }}
        >
          <Input
            variant="sunken"
            size="sm"
            iconStart={<SearchIcon className="size-3.5" />}
            placeholder="Search transcript"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            className="flex-1"
          />
        </div>

        {/* Body — segments. Height chosen to dominate the bottom of the
            page without crowding the notes area above. */}
        <div
          ref={bodyRef}
          className="scrollbar-clean overflow-auto px-3 pb-2"
          style={{ height: 200 }}
        >
          <LiveTranscriptBodyState
            status={status}
            error={error}
            filtered={filtered}
            filtering={filtering}
            priorSegments={priorSegments}
            finals={finals}
            partials={partials}
            slow={slow}
          />
        </div>

        {/* Footer — recording status + controls + language selector. The
            animated wave + timer is the "live" cue (since the header wave
            is now static), replacing the indicator the LiveDock pill
            normally provides. */}
        <div
          className="flex items-center justify-between px-3 py-2"
          style={{ borderTop: '1px solid var(--border-subtle)' }}
        >
          <div className="flex items-center gap-2">
            <RecordingStatusChip paused={paused} elapsedSeconds={recording.elapsed} />
            {/* No manual pause — stop ends the segment and the note can be
                continued later (continue-recording). Resume appears only
                when the SYSTEM auto-paused (sleep / meeting-app mic drop),
                so an auto-paused recording is never stranded. */}
            {paused && (
              <button
                type="button"
                onClick={onPauseToggle}
                aria-label="Resume recording"
                title="Resume recording"
                className="inline-flex size-8 cursor-pointer items-center justify-center rounded-full border-0 transition-colors hover:bg-[color:var(--surface-hover)]"
                style={{ background: 'transparent', color: 'var(--fg-1)' }}
              >
                <Play size={14} />
              </button>
            )}
            <button
              type="button"
              onClick={onStop}
              aria-label="Stop recording"
              title="Stop recording"
              className="inline-flex h-8 cursor-pointer items-center gap-1.5 rounded-full border-0 px-3 text-[13px] font-medium transition-opacity hover:opacity-90"
              style={{ background: 'var(--recording)', color: '#FFFFFF' }}
            >
              <Square size={12} fill="currentColor" stroke="currentColor" />
              Stop
            </button>
          </div>
          <LanguageSelector />
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Body states
// ---------------------------------------------------------------------------

type Segments = ReturnType<typeof useLiveTranscript>['segments'];

interface BodyStateProps {
  status: 'idle' | 'loading' | 'streaming' | 'error';
  error: { stage: string; message?: string } | null;
  /** The search result, rendered as one flat list while a query is active. */
  filtered: Segments;
  filtering: boolean;
  /** Unfiltered rendering runs in three lanes so that a partial tick - up to
   *  ~5 a second - only invalidates the in-progress rows instead of every
   *  finalised row above them. Order on screen: prior, divider, finals,
   *  partials, which is the order the merged list had. */
  priorSegments: Segments;
  finals: Segments;
  partials: Segments;
  slow: boolean;
}

function LiveTranscriptBodyState({
  status,
  error,
  filtered,
  filtering,
  priorSegments,
  finals,
  partials,
  slow,
}: BodyStateProps) {
  if (status === 'error' && error) {
    return (
      <EmptyState
        title="Live transcription unavailable"
        subtitle={error.message ? `${error.stage}: ${error.message}` : `Stage: ${error.stage}`}
      />
    );
  }
  if (status === 'loading') {
    return (
      <EmptyState
        title="Preparing transcription…"
        subtitle={
          slow
            ? 'Still warming up — first launch can take a moment. Audio is being captured.'
            : 'Parakeet is warming up. Audio is being captured.'
        }
      />
    );
  }
  const liveCount = finals.length + partials.length;
  if (filtering ? filtered.length === 0 : priorSegments.length + liveCount === 0) {
    return (
      <EmptyState
        title={filtering ? 'No matches' : 'Listening…'}
        subtitle={
          filtering
            ? 'Nothing matches your filter yet.'
            : 'Start speaking — finalised sentences will appear here.'
        }
      />
    );
  }
  // Granola-style bubbles. Speaker attribution comes from the renderer-
  // side per-channel RMS lookup in useLiveTranscript: 'Others' renders
  // grey/left, anything else (explicit 'You' or no attribution) renders
  // green/right. Same charitable default as TranscriptPanel — the
  // recording mechanically belongs to the mic owner, so default to You.
  // Partials stay dimmed at 0.55 opacity so the user can see them
  // forming without confusing them for finalised text.
  return (
    <ul className="flex flex-col gap-0">
      {filtering ? (
        <SegmentRows segments={filtered} lane="q" />
      ) : (
        <>
          <SegmentRows segments={priorSegments} lane="e" />
          {priorSegments.length > 0 && liveCount > 0 && (
            <li
              className="flex items-center gap-2 px-1 py-1.5"
              aria-hidden="true"
              data-testid="live-transcript-resume-divider"
            >
              <span className="h-px flex-1" style={{ background: 'var(--border-subtle)' }} />
              <span
                className="text-[10px] font-medium uppercase tracking-wide"
                style={{ color: 'var(--fg-2)' }}
              >
                Resumed
              </span>
              <span className="h-px flex-1" style={{ background: 'var(--border-subtle)' }} />
            </li>
          )}
          <SegmentRows segments={finals} lane="f" />
          <SegmentRows segments={partials} lane="p" />
        </>
      )}
    </ul>
  );
}

/**
 * One lane of bubbles.
 *
 * Memoised on the array identity, which is what makes the lane split pay off:
 * a partial tick produces a new `partials` array but leaves `finals`
 * untouched, so React skips the finalised rows entirely instead of
 * re-creating and diffing every one of them.
 *
 * Keys are content-derived in the lanes that get inserted into. A final
 * released late by the bleed-dedup hold is inserted *into* the sorted finals
 * lane, and index keys made React re-bind every row below the insert point;
 * start+speaker is unique there (one utterance per speaker can begin at a given
 * instant within one recording) and stable. The partial lane keys on the
 * speaker alone, so a speaker's growing utterance updates one node in place,
 * tick after tick.
 *
 * The prior lane is the exception and keys on position: it carries the
 * finalised text of EVERY earlier recording into this note (main.js prepends
 * the existing priors on each continue), and `start` counts from zero within
 * each recording - so the same speaker at the same offset in two sessions
 * would collide. That lane is written once and never reordered, which is
 * exactly the case an index key is right for.
 *
 * The filtered lane keys on position too, and there the index genuinely does
 * point at a different segment after the query changes. It stays because these
 * rows hold no state of their own - no input, no focus, no animation - so
 * reusing a node just means React writes new text into it. Only the
 * reconciliation is less efficient, and only while someone is typing in the
 * search box.
 */
const SegmentRows = React.memo(function SegmentRows({
  segments,
  lane,
}: {
  segments: Segments;
  lane: 'e' | 'f' | 'p' | 'q';
}) {
  // Granola-style bubbles. Speaker attribution is the mic/system channel the
  // Python sidecar tagged the segment with: 'Others' renders grey/left,
  // anything else (explicit 'You' or no attribution) renders green/right -
  // the same charitable default as TranscriptPanel, since the recording
  // mechanically belongs to the mic owner. Partials stay dimmed at 0.55
  // opacity so the user can see them forming without confusing them for
  // finalised text.
  return (
    <>
      {segments.map((seg, i) => {
        const isYou = seg.speaker !== 'Others';
        const key =
          lane === 'p'
            ? `p:${isYou ? 'You' : 'Others'}`
            : lane === 'q' || lane === 'e'
              ? `${lane}:${i}`
              : `f:${seg.start}:${isYou ? 'You' : 'Others'}`;
        return (
          <li
            key={key}
            className={cn(
              'live-row flex flex-col gap-0.5 px-1 py-0.5',
              isYou ? 'items-end' : 'items-start'
            )}
            style={{ opacity: seg.isFinal ? 1 : 0.55 }}
          >
            <span className="px-1.5 text-[10.5px] tabular-nums" style={{ color: 'var(--fg-2)' }}>
              {fmtTimestamp(seg.start)}
            </span>
            <div
              className={cn(
                'max-w-[78%] rounded-2xl px-3 py-1.5 text-sm leading-[1.5]',
                isYou
                  ? 'bg-green-100 text-green-950 rounded-br-md dark:bg-green-900/40 dark:text-green-100'
                  : 'bg-neutral-200/80 text-neutral-900 rounded-bl-md dark:bg-neutral-700/60 dark:text-neutral-100'
              )}
            >
              {seg.text}
            </div>
          </li>
        );
      })}
    </>
  );
});

function EmptyState({ title, subtitle }: { title: string; subtitle: string }) {
  return (
    <div
      className="flex h-full flex-col items-center justify-center gap-1 text-center"
      style={{ color: 'var(--fg-2)' }}
    >
      <div className="text-[13px]" style={{ color: 'var(--fg-1)' }}>
        {title}
      </div>
      <div className="text-[11.5px]">{subtitle}</div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Language selector (Multi / English) — bottom-right of the panel
// ---------------------------------------------------------------------------

// The live picker follows the active engine's actual locale coverage and
// writes the same global language setting as Settings → Transcription.
function LanguageSelector() {
  const language = useLanguageSetting();
  const setLanguage = useSetLanguage();
  const engine = useTranscriptionEngine();
  const [popoverOpen, setPopoverOpen] = React.useState(false);
  const options = engine.data === 'parakeet' ? PARAKEET_LANGUAGES : APPLE_LANGUAGES;

  const current = language.data ?? 'auto';
  const selected = options.find((option) => option.code === current);
  const autoLabel = engine.data === 'parakeet' ? 'Multi' : 'System';
  const display = current === 'auto' ? autoLabel : (selected?.label ?? current.toUpperCase());

  const pick = (code: string) => {
    setLanguage.mutate(code);
    setPopoverOpen(false);
  };

  return (
    <Popover open={popoverOpen} onOpenChange={setPopoverOpen}>
      <Tooltip>
        <TooltipTrigger asChild>
          <PopoverTrigger asChild>
            <button
              type="button"
              className={cn(
                'inline-flex items-center gap-1 rounded-md px-2 py-1 text-[12px] font-medium',
                'cursor-pointer transition-colors hover:bg-[color:var(--surface-hover)]'
              )}
              style={{ color: 'var(--fg-2)' }}
              aria-label={`Language: ${display}`}
            >
              <Languages size={12} />
              <span style={{ color: 'var(--fg-1)' }}>{display}</span>
              <ChevronDown size={12} />
            </button>
          </PopoverTrigger>
        </TooltipTrigger>
        <TooltipContent side="top">Transcript language</TooltipContent>
      </Tooltip>
      <PopoverContent align="end" sideOffset={8} className="w-56 p-1">
        {options.map((opt) => {
          const active = opt.code === current;
          return (
            <button
              key={opt.code}
              type="button"
              onClick={() => pick(opt.code)}
              className={cn(
                'flex w-full flex-col items-start gap-0.5 rounded-md px-2 py-1.5 text-left',
                'cursor-pointer transition-colors hover:bg-[color:var(--surface-hover)]'
              )}
            >
              <span
                className="flex w-full items-center justify-between text-[13px] font-medium"
                style={{ color: 'var(--fg-1)' }}
              >
                {opt.label}
                {active && <Check size={13} />}
              </span>
              <span className="text-[11.5px]" style={{ color: 'var(--fg-2)' }}>
                {opt.hint}
              </span>
            </button>
          );
        })}
      </PopoverContent>
    </Popover>
  );
}

// ---------------------------------------------------------------------------
// Recording status chip — footer, replaces the LiveDock RecordingPill
// ---------------------------------------------------------------------------

function RecordingStatusChip({
  paused,
  elapsedSeconds,
}: {
  paused: boolean;
  elapsedSeconds: number;
}) {
  const label = paused ? 'Paused' : 'Recording';
  return (
    <span
      className="inline-flex items-center gap-2 px-2 text-[13px]"
      style={{ color: 'var(--fg-1)' }}
    >
      <span style={{ color: 'var(--recording)' }}>
        <AudioWave active={!paused} paused={paused} bars={7} height={14} barWidth={2} gap={2} />
      </span>
      <span style={{ color: 'var(--fg-2)' }}>{label}</span>
      <span
        className="tabular-nums"
        style={{ fontFamily: 'var(--font-mono)', fontSize: 13, color: 'var(--fg-1)' }}
      >
        {formatElapsed(elapsedSeconds)}
      </span>
    </span>
  );
}
