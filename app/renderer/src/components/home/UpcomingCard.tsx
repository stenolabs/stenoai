import * as React from 'react';
import { Video } from 'lucide-react';
import type { CalendarEvent } from '@/lib/ipc';
import { ipc } from '@/lib/ipc';
import { cn } from '@/lib/utils';
import { useRecording } from '@/hooks/useRecording';
import { UI_LOCALE } from '@/lib/locale';

interface UpcomingCardProps {
  event: CalendarEvent;
}

export function UpcomingCard({ event }: UpcomingCardProps) {
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
    if (recording.status === 'recording' || recording.status === 'paused') return;
    void recording.startRecording(event.title);
  };

  const onJoin = (e: React.MouseEvent) => {
    e.stopPropagation();
    if (!meetingUrl) return;
    void ipc().shell.openExternal(meetingUrl);
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
        'group relative flex min-h-[44px] cursor-pointer items-center justify-between py-2 transition-colors hover:bg-[color:var(--surface-hover)] -mx-3 px-3 rounded-lg',
        urgent && 'opacity-100',
        !urgent && 'opacity-90 hover:opacity-100'
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

      {/* Main content */}
      <div className="flex min-w-0 flex-1 flex-col pl-3">
        <div className="flex items-center gap-2">
          <div
            className="truncate text-[13.5px] font-medium tracking-[-0.005em]"
            style={{ color: 'var(--fg-1)' }}
          >
            {event.title || 'Untitled meeting'}
          </div>
          {(isLive && !!meetingUrl) && (
            <span 
              className="inline-block size-1.5 rounded-full" 
              style={{ background: 'var(--recording)', animation: 'record-pulse 1.6s ease-out infinite' }} 
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
      <div className="flex flex-shrink-0 items-center gap-2 pl-4 opacity-0 transition-opacity pointer-events-none group-hover:opacity-100 group-hover:pointer-events-auto group-focus-within:opacity-100 group-focus-within:pointer-events-auto focus-within:opacity-100 focus-within:pointer-events-auto">
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
  );
}

type RelativeState = 'now' | 'soon' | 'later';

function relativeLabel(startIso: string): {
  prefix: string | null;
  value: string;
  urgent: boolean;
  state: RelativeState;
} {
  const start = new Date(startIso);
  if (Number.isNaN(start.getTime()))
    return { prefix: null, value: '—', urgent: false, state: 'later' };
  const diffMs = start.getTime() - Date.now();
  const diffMins = Math.round(diffMs / 60000);
  if (diffMins <= 0) return { prefix: null, value: 'Now', urgent: true, state: 'now' };
  if (diffMins < 60)
    return {
      prefix: 'In',
      value: `${diffMins} min${diffMins === 1 ? '' : 's'}`,
      urgent: diffMins <= 15,
      state: diffMins <= 15 ? 'soon' : 'later',
    };
  const hrs = Math.round(diffMins / 60);
  if (hrs < 24)
    return {
      prefix: 'In',
      value: `${hrs} hr${hrs === 1 ? '' : 's'}`,
      urgent: false,
      state: 'later',
    };
  const days = Math.round(hrs / 24);
  return {
    prefix: 'In',
    value: `${days} day${days === 1 ? '' : 's'}`,
    urgent: false,
    state: 'later',
  };
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
  state: RelativeState,
): { primary: string; timeRange: string } {
  const start = new Date(startIso);
  const end = endIso ? new Date(endIso) : null;
  const now = new Date();
  const sameDay = (a: Date, b: Date) =>
    a.getFullYear() === b.getFullYear() &&
    a.getMonth() === b.getMonth() &&
    a.getDate() === b.getDate();

  const tomorrow = new Date(now);
  tomorrow.setDate(now.getDate() + 1);

  // For in-progress events, the absolute day ("Today" / "Fri 5 Jun") is
  // noise — what the user actually wants to know is how this meeting maps
  // to the present moment. Surface either the soft deadline ("Ends in 8
  // min" prompts you to wrap up) or progress so far ("Started 30 min ago"
  // for context on what they walked into).
  let primary: string;
  if (state === 'now' && end && !Number.isNaN(end.getTime())) {
    const endsInMins = Math.round((end.getTime() - Date.now()) / 60000);
    if (endsInMins > 0 && endsInMins <= 15) {
      primary = `Ends in ${endsInMins} min${endsInMins === 1 ? '' : 's'}`;
    } else {
      const startedAgoMins = Math.max(
        0,
        Math.round((Date.now() - start.getTime()) / 60000),
      );
      primary =
        startedAgoMins === 0
          ? 'Just started'
          : `Started ${startedAgoMins} min${startedAgoMins === 1 ? '' : 's'} ago`;
    }
  } else if (sameDay(start, now)) {
    primary = 'Today';
  } else if (sameDay(start, tomorrow)) {
    primary = 'Tomorrow';
  } else {
    primary = start.toLocaleDateString(UI_LOCALE, {
      weekday: 'short',
      day: 'numeric',
      month: 'short',
    });
  }

  const clock = Number.isNaN(start.getTime()) ? '' : TIME_FMT.format(start);
  const endClock =
    end && !Number.isNaN(end.getTime()) ? TIME_FMT.format(end) : '';
  const timeRange = endClock ? `${clock} – ${endClock}` : clock;

  return { primary, timeRange };
}
