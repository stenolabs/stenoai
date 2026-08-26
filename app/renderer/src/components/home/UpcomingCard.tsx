import * as React from 'react';
import { Sparkles, Video } from 'lucide-react';
import type { CalendarEvent } from '@/lib/ipc';
import { ipc } from '@/lib/ipc';
import { cn } from '@/lib/utils';
import { useRecording } from '@/hooks/useRecording';

export interface BriefStreamState {
  text: string;
  status: 'idle' | 'streaming' | 'done' | 'error';
  error: string | null;
}

export interface UpcomingCardProps {
  event: CalendarEvent;
  isBriefActive?: boolean;
  briefState?: BriefStreamState;
  onToggleBrief?: (event: CalendarEvent) => void;
}

export function UpcomingCard({
  event,
  isBriefActive = false,
  briefState,
  onToggleBrief,
}: UpcomingCardProps) {
  const isAllDay = event.is_all_day === true;
  const relative = isAllDay
    ? ({ prefix: null, value: 'All day', urgent: false, state: 'later' } as const)
    : relativeLabel(event.start);
  const meta = isAllDay
    ? ({ primary: 'Today', timeRange: '' } as const)
    : formatMeta(event.start, event.end, relative.state);
  const meetingUrl = event.meeting_url?.trim();
  const recording = useRecording();
  const isLive = relative.state === 'now';
  const urgent = relative.urgent || isLive;

  const onStart = () => {
    // Never start a second recording over a live one — the dock/pill owns that
    // state and a double start strands the first note.
    if (recording.status === 'recording' || recording.status === 'paused') return;
    // Start recording against this event's title — clicking an upcoming card is
    // the primary way users record scheduled meetings. 'manual' because that is
    // what this is: a user click. main.js whitelists the trigger values
    // (RECORDING_TRIGGERS) and drops anything else, so inventing a new one here
    // would silently lose the analytics counter it was meant to add.
    void recording.startRecording(event.title || 'Meeting', 'manual');
  };

  const onJoin = (e: React.MouseEvent) => {
    e.stopPropagation();
    if (meetingUrl) {
      void ipc().shell.openExternal(meetingUrl);
    }
  };

  const onStartAndJoin = (e: React.MouseEvent) => {
    e.stopPropagation();
    onStart();
    if (meetingUrl) void ipc().shell.openExternal(meetingUrl);
  };

  // Use the explicit calendar color if provided by the backend, otherwise default to a pleasant blue
  const color = event.color || '#3B82F6';

  return (
    <div
      className={cn(
        'group relative flex min-h-[44px] flex-col justify-center py-2 transition-colors hover:bg-[color:var(--surface-hover)] -mx-3 px-3 rounded-lg',
        urgent && 'opacity-100',
        !urgent && 'opacity-90 hover:opacity-100',
        isBriefActive && 'bg-[color:var(--surface-hover)] opacity-100'
      )}
      role="button"
      tabIndex={0}
      onClick={onStart}
      onKeyDown={(e) => {
        if (e.target !== e.currentTarget) return;
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          onStart();
        }
      }}
    >
      {/* Left indicator bar */}
      <div
        className="absolute left-0 top-2 bottom-2 w-0.5 rounded-full"
        style={{ backgroundColor: color }}
      />

      <div className="flex w-full items-center justify-between">
        {/* Main content */}
        <div className="flex min-w-0 flex-1 flex-col pl-3">
          <div className="flex items-center gap-2">
            <div
              className="truncate text-[13.5px] font-medium tracking-[-0.005em]"
              style={{ color: 'var(--fg-1)' }}
            >
              {event.title || 'Untitled meeting'}
            </div>
            {isLive && !!meetingUrl && (
              <span
                className="inline-block size-1.5 rounded-full"
                style={{
                  background: 'var(--recording)',
                  animation: 'record-pulse 1.6s ease-out infinite',
                }}
              />
            )}
          </div>
          <div
            className="flex items-center gap-1.5 text-[11.5px] font-medium"
            style={{ color: 'var(--fg-muted)' }}
          >
            {meta.timeRange || meta.primary}
            {relative.urgent && (
              <>
                <span className="opacity-40">·</span>
                <span style={{ color: 'var(--recording)' }}>{relative.value}</span>
              </>
            )}
          </div>
        </div>

        {/* CTA */}
        <div className="flex flex-shrink-0 items-center gap-1.5 pl-4 opacity-0 transition-opacity pointer-events-none group-hover:opacity-100 group-hover:pointer-events-auto group-focus-within:opacity-100 group-focus-within:pointer-events-auto focus-within:opacity-100 focus-within:pointer-events-auto">
          {onToggleBrief && (
            <button
              type="button"
              data-testid="upcoming-card-brief-btn"
              onClick={(e) => {
                e.stopPropagation();
                onToggleBrief(event);
              }}
              aria-label="Pre-meeting brief"
              title="Pre-meeting brief"
              className={cn(
                'inline-flex h-6 items-center gap-1 rounded-full px-2 text-[11px] font-medium transition-colors cursor-pointer border-0',
                isBriefActive
                  ? 'bg-[color:var(--surface-active)] text-[color:var(--fg-1)]'
                  : 'bg-[color:var(--surface-hover)] text-[color:var(--fg-2)] hover:text-[color:var(--fg-1)] hover:bg-[color:var(--surface-active)]'
              )}
              style={{
                border: '1px solid var(--border-subtle)',
              }}
            >
              <Sparkles className="size-3 shrink-0" />
              <span>Brief</span>
            </button>
          )}

          {meetingUrl ? (
            urgent ? (
              <button
                type="button"
                onClick={onStartAndJoin}
                className="inline-flex h-6 items-center rounded-full px-2.5 text-[11px] font-medium transition-transform hover:scale-105 active:scale-95"
                style={{
                  background: 'var(--fg-1)',
                  color: 'var(--primary-fg)',
                }}
              >
                Start now
              </button>
            ) : (
              <button
                type="button"
                onClick={onJoin}
                className="inline-flex h-6 items-center gap-1.5 rounded-full px-2.5 text-[11px] font-medium transition-colors hover:scale-105 active:scale-95"
                style={{
                  background: 'var(--surface-hover)',
                  border: '1px solid var(--border-subtle)',
                  color: 'var(--fg-1)',
                }}
              >
                <Video className="size-3" />
                Join
              </button>
            )
          ) : null}
        </div>
      </div>

      {/* Pre-meeting Brief Panel */}
      {isBriefActive && (
        <div
          data-testid="upcoming-card-brief-container"
          className="mt-2 ml-3 rounded-lg p-2.5 text-xs transition-all"
          style={{
            background: 'var(--surface-raised)',
            border: '1px solid var(--border-subtle)',
          }}
          onClick={(e) => e.stopPropagation()}
          onKeyDown={(e) => e.stopPropagation()}
        >
          <div className="flex items-center justify-between gap-2 mb-1.5 pb-1 border-b border-[color:var(--border-subtle)]">
            <div className="flex items-center gap-1.5 font-medium text-[11px] text-[color:var(--fg-muted)]">
              <Sparkles className="size-3 text-[color:var(--fg-muted)]" />
              <span>Pre-meeting brief</span>
              {briefState?.status === 'streaming' && (
                <span
                  className="inline-block size-1.5 rounded-full"
                  style={{
                    background: 'var(--fg-muted)',
                    animation: 'record-pulse 1.2s ease-out infinite',
                  }}
                />
              )}
            </div>
            <button
              type="button"
              onClick={() => onToggleBrief?.(event)}
              className="rounded px-1.5 py-0.5 text-[10px] text-[color:var(--fg-muted)] hover:bg-[color:var(--surface-hover)] hover:text-[color:var(--fg-1)] transition-colors cursor-pointer border-0"
              aria-label="Close brief"
            >
              Close
            </button>
          </div>

          {briefState?.status === 'streaming' && !briefState.text && (
            <div className="py-1 text-[12px] text-[color:var(--fg-muted)] animate-pulse">
              Reviewing prior notes…
            </div>
          )}

          {briefState?.text ? (
            <div
              data-testid="upcoming-card-brief-content"
              className="whitespace-pre-wrap text-[12px] leading-relaxed text-[color:var(--fg-1)] select-text"
            >
              {briefState.text}
            </div>
          ) : null}

          {briefState?.status === 'error' && (
            <div
              data-testid="upcoming-card-brief-empty"
              className="py-1 text-[12px] text-[color:var(--fg-muted)]"
            >
              {briefState.error?.includes('No related notes') ||
              briefState.error?.includes('No related notes yet')
                ? 'No related notes yet for this meeting.'
                : briefState.error || 'No related notes yet for this meeting.'}
            </div>
          )}

          {briefState?.status === 'done' && !briefState.text && (
            <div
              data-testid="upcoming-card-brief-empty"
              className="py-1 text-[12px] text-[color:var(--fg-muted)]"
            >
              No related notes yet for this meeting.
            </div>
          )}
        </div>
      )}
    </div>
  );
}

type RelativeState = 'now' | 'soon' | 'later';

function relativeLabel(startIso: string): {
  prefix: string | null;
  value: string;
  urgent: boolean;
  state: RelativeState;
} {
  const start = new Date(startIso).getTime();
  if (Number.isNaN(start)) {
    return { prefix: null, value: 'Today', urgent: false, state: 'later' };
  }
  const now = Date.now();
  const diffMinutes = Math.round((start - now) / (60 * 1000));

  if (diffMinutes <= 0 && diffMinutes >= -60) {
    return { prefix: null, value: 'Now', urgent: true, state: 'now' };
  }
  if (diffMinutes > 0 && diffMinutes <= 15) {
    return { prefix: 'in', value: `${diffMinutes}m`, urgent: true, state: 'soon' };
  }
  if (diffMinutes > 15 && diffMinutes < 60) {
    return { prefix: 'in', value: `${diffMinutes}m`, urgent: false, state: 'soon' };
  }
  return { prefix: null, value: 'Later today', urgent: false, state: 'later' };
}

// Locale-aware time formatter — inherits the user's system locale, so
// US users get "11:30 PM" and EU users get "23:30" without a setting.
const TIME_FMT = new Intl.DateTimeFormat(undefined, {
  hour: 'numeric',
  minute: '2-digit',
});

function formatMeta(
  startIso: string,
  endIso: string,
  state: RelativeState
): { primary: string; timeRange: string } {
  const start = new Date(startIso);
  const end = new Date(endIso);
  if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) {
    return { primary: 'Today', timeRange: '' };
  }
  const timeRange = `${TIME_FMT.format(start)} – ${TIME_FMT.format(end)}`;
  if (state === 'now') {
    return { primary: 'Happening now', timeRange };
  }
  return { primary: timeRange, timeRange };
}
