import * as React from 'react';
import { useVirtualizer } from '@tanstack/react-virtual';
import { Search as SearchIcon } from 'lucide-react';
import { Input } from '@/components/ui/input';
import { cn } from '@/lib/utils';
import { useMeeting } from '@/hooks/useMeetings';
import { parseTranscript, type Segment } from '@/lib/transcriptSegments';

/** Local-meeting wrapper — fetches the meeting JSON, then renders. Kept as
 *  the original API so existing callers don't change. */
export function TranscriptPanelContent({
  summaryFile,
}: {
  summaryFile: string;
  onClose?: () => void;
}) {
  const meeting = useMeeting(summaryFile);

  if (meeting.isLoading) {
    return <div className="px-4 py-3 text-sm text-muted-foreground">Loading…</div>;
  }
  if (!meeting.data) {
    return <div className="px-4 py-3 text-sm text-muted-foreground">No transcript available.</div>;
  }
  const m = meeting.data;
  const isDiarised = !!(m.is_diarised && m.diarised_text);
  const text = isDiarised ? (m.diarised_text ?? '') : (m.transcript ?? '');
  return <TranscriptBody text={text} isDiarised={isDiarised} />;
}

/** Org-meeting wrapper — transcript already in memory (came from the
 *  adapter's GET /meetings/{id} response). Diarisation is auto-detected
 *  from the presence of [You]/[Others] markers because the adapter
 *  doesn't currently round-trip an explicit flag (avoids another
 *  enterprise schema change). */
export function OrgTranscriptPanelContent({ transcript }: { transcript: string }) {
  if (!transcript.trim()) {
    return <div className="px-4 py-3 text-sm text-muted-foreground">No transcript available.</div>;
  }
  const isDiarised = /\[(?:You|Others)\]/.test(transcript);
  return <TranscriptBody text={transcript} isDiarised={isDiarised} />;
}


function TranscriptBody({ text, isDiarised }: { text: string; isDiarised: boolean }) {
  const segments = React.useMemo(() => parseTranscript(text, isDiarised), [text, isDiarised]);
  const [query, setQuery] = React.useState('');

  // Precompute lowercased segment text once per segment list, not on every
  // keystroke. A 1-hour diarised meeting can produce 6,000+ segments;
  // re-lowercasing all of them per keystroke (~10 ms of pure string work)
  // adds visible lag to typing in the search box. With this memo each
  // keystroke just filters by `includes` — sub-millisecond.
  const segmentsLower = React.useMemo(
    () => segments.map((s) => s.text.toLowerCase()),
    [segments],
  );

  const filtered = React.useMemo(() => {
    if (!query.trim()) return segments;
    const needle = query.trim().toLowerCase();
    return segments.filter((_s, i) => segmentsLower[i].includes(needle));
  }, [segments, segmentsLower, query]);

  const parentRef = React.useRef<HTMLDivElement>(null);
  const rowVirtualizer = useVirtualizer({
    count: filtered.length,
    getScrollElement: () => parentRef.current,
    estimateSize: () => 80,
    overscan: 8,
  });

  if (segments.length === 0) {
    return (
      <div className="px-4 py-3 text-sm text-muted-foreground">No transcript available.</div>
    );
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex flex-shrink-0 items-center px-3 py-1.5">
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

      <div ref={parentRef} className="min-h-0 flex-1 overflow-auto px-3 pb-3">
        <div style={{ height: rowVirtualizer.getTotalSize(), position: 'relative' }}>
          {rowVirtualizer.getVirtualItems().map((virtualRow) => {
            const segment = filtered[virtualRow.index];
            return (
              <div
                key={virtualRow.key}
                data-index={virtualRow.index}
                ref={rowVirtualizer.measureElement}
                style={{
                  position: 'absolute',
                  top: 0,
                  left: 0,
                  right: 0,
                  transform: `translateY(${virtualRow.start}px)`,
                }}
                className="py-1"
              >
                <TranscriptRow segment={segment} highlight={query} />
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}

function TranscriptRow({ segment, highlight }: { segment: Segment; highlight: string }) {
  // Granola-style chat bubbles for every line, including non-diarised
  // (mono / mic-only / bleed-collapsed) recordings. Position (right vs
  // left) and tint do the speaker-attribution work; explicit "You" /
  // "Others" pill labels are redundant once the visual cue is there.
  // Max-width keeps long monologues readable rather than spanning the
  // whole panel.
  //
  // Default to "You" when we have no speaker marker: this covers mono-mic
  // recordings (no stereo source) and bleed-collapsed stereo recordings
  // where transcriber.py decided the system channel was just mic echo.
  // In both cases the recording mechanically belongs to the user and
  // showing their content as un-bubbled plain text (or worse, on the
  // "Others" side) reads as wrong. Granola takes the same charitable
  // default — when in doubt, attribute to the mic owner. Explicit
  // `Others` markers and acoustically-diarized `Speaker N` markers
  // (transcriber.py's _resolve_speaker_placeholders) both render as
  // grey/left — only an exact "You" (or no marker at all) is "self".
  const isYou = segment.speaker === 'You' || segment.speaker == null;
  // A confirmed real name (via the speaker-review panel's relabeling) is
  // genuinely new information, unlike the generic "Others"/"Speaker N"
  // placeholders the comment above is about -- show it.
  const isGenericLabel =
    segment.speaker === 'Others' || (segment.speaker != null && /^Speaker \d+$/.test(segment.speaker));
  const realName = !isYou && !isGenericLabel ? segment.speaker : null;
  return (
    <div className={cn('flex flex-col gap-0.5 px-1 py-0.5', isYou ? 'items-end' : 'items-start')}>
      {(segment.timestamp || realName) && (
        <span className="flex items-center gap-1.5 px-1.5 text-[10.5px] tabular-nums" style={{ color: 'var(--fg-2)' }}>
          {realName && <span className="font-medium">{realName}</span>}
          {segment.timestamp}
        </span>
      )}
      <div
        className={cn(
          'max-w-[78%] rounded-2xl px-3 py-1.5 text-sm leading-[1.5]',
          // Granola-style: olive/sage green for self, neutral grey for
          // others. Light/dark variants keep contrast in either theme.
          isYou
            ? 'bg-green-100 text-green-950 rounded-br-md dark:bg-green-900/40 dark:text-green-100'
            : 'bg-neutral-200/80 text-neutral-900 rounded-bl-md dark:bg-neutral-700/60 dark:text-neutral-100',
        )}
      >
        {renderHighlighted(segment.text, highlight)}
      </div>
    </div>
  );
}

function renderHighlighted(text: string, highlight: string): React.ReactNode {
  const needle = highlight.trim();
  if (!needle) return text;
  const lower = text.toLowerCase();
  const ln = needle.toLowerCase();
  const parts: React.ReactNode[] = [];
  let cursor = 0;
  let idx = lower.indexOf(ln, cursor);
  let key = 0;
  while (idx !== -1) {
    if (idx > cursor) parts.push(text.slice(cursor, idx));
    parts.push(
      <mark
        key={key++}
        className="rounded bg-yellow-200/60 px-0.5 text-foreground dark:bg-yellow-500/30"
      >
        {text.slice(idx, idx + needle.length)}
      </mark>,
    );
    cursor = idx + needle.length;
    idx = lower.indexOf(ln, cursor);
  }
  if (cursor < text.length) parts.push(text.slice(cursor));
  return parts;
}


