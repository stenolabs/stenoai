import * as React from 'react';
import {
  AudioLines,
  Calendar,
  ChevronLeft,
  ChevronRight,
  Folder as FolderIcon,
  Loader2,
  Plus,
  RefreshCw,
  Search,
  Square,
  X,
} from 'lucide-react';
import { cn, isMac } from '@/lib/utils';
import { MeetingsShell } from '@/components/MeetingsShell';
import { UpcomingCard, type BriefStreamState } from '@/components/home/UpcomingCard';
import { Button } from '@/components/ui/button';
import { AppIcon } from '@/components/ui/app-icon';
import { KbdKey } from '@/components/ui/kbd';
import { useMeetings } from '@/hooks/useMeetings';
import { useRecording } from '@/hooks/useRecording';
import {
  useCalendarEvents,
  useGoogleCalendarAuth,
  useOutlookCalendarAuth,
} from '@/hooks/useCalendarEvents';
import { useFolders } from '@/hooks/useFolders';
import { useRecordHotkeySetting } from '@/hooks/useSettings';
import { ipc, type CalendarEvent, type Meeting } from '@/lib/ipc';
import { pickInProgressEvent } from '@/lib/calendar';
import { heroHeadline, heroSubtitle } from '@/lib/hero';
import { searchNotesDetailed, type NoteSearchMatch } from '@/lib/noteSearch';
import { useMeetingsList } from '@/lib/meetingsListContext';
import { stripReasoning } from '@/lib/markdown';
import { navigate } from '@/lib/router';

interface HomeProps {
  mode: 'home' | 'meetings';
}

export function Home({ mode }: HomeProps) {
  const meetings = useMeetings();
  const folders = useFolders();
  const calendar = useCalendarEvents();
  const recording = useRecording();
  // Default ON while loading / on error so the hero copy doesn't flicker the
  // ⌘⇧R hint off then on (back-compat: the shortcut ships enabled). Also
  // require registered !== false: when another app owns the accelerator the
  // shortcut doesn't actually work, so advertising it would strand the user
  // on dead instructions — fall back to the click-based copy instead.
  const recordHotkey = useRecordHotkeySetting();
  const hotkeyEnabled =
    (recordHotkey.data?.enabled ?? true) && recordHotkey.data?.registered !== false;

  const emptyState = !meetings.data?.length;
  const isRecording = recording.status === 'recording' || recording.status === 'paused';
  // Empty-state CTA: start a new recording AND open the live-note editor
  // (/recording) so the user can write notes while it records; a previous note
  // keeps processing in the background queue. Coexistence still holds (the pill
  // follows on navigation) — the explicit action just lands them on the note.
  const onToggleRecording = () => {
    if (!isRecording) void recording.startRecording();
    navigate('/recording');
  };

  const folderName = React.useMemo(() => {
    const map = new Map<string, string>();
    for (const f of folders.data ?? []) map.set(f.id, f.name);
    return map;
  }, [folders.data]);

  // 60-second tick so the upcoming filter below re-evaluates and
  // events whose end time has passed roll off the list without
  // waiting for the next calendar refetch (which could be many
  // minutes). Minute precision is plenty — events are minute-grained
  // at best. Gated on `mode === 'home'` so the timer doesn't run on
  // /meetings where this widget isn't rendered.
  const [upcomingTickMs, setUpcomingTickMs] = React.useState<number>(() => Date.now());
  React.useEffect(() => {
    if (mode !== 'home') return;
    // Refresh immediately on (re)entering Home, otherwise the hero copy
    // is whatever `upcomingTickMs` was when the user last navigated away
    // — potentially many minutes stale until the 60s interval fires.
    setUpcomingTickMs(Date.now());
    const id = setInterval(() => setUpcomingTickMs(Date.now()), 60_000);
    return () => clearInterval(id);
  }, [mode]);

  // Landing on Home is a recording-intent signal — nudge main to re-warm the
  // Parakeet model so the first record isn't a cold load. Fire-and-forget;
  // main throttles + skips while recording, so calling on every Home entry is
  // safe.
  React.useEffect(() => {
    if (mode !== 'home') return;
    ipc().recording.hintWarmup();
  }, [mode]);
  // Pre-meeting brief streaming state (one in flight at a time across Home)
  const [activeBriefEventId, setActiveBriefEventId] = React.useState<string | null>(null);
  const [briefState, setBriefState] = React.useState<BriefStreamState>({
    text: '',
    status: 'idle',
    error: null,
  });
  const briefUnsubRef = React.useRef<(() => void) | null>(null);
  const briefQueryIdRef = React.useRef<string | null>(null);

  // Helper to cancel active brief stream and backend process
  const cancelActiveBrief = React.useCallback(() => {
    if (briefQueryIdRef.current) {
      ipc().query.cancel(briefQueryIdRef.current);
      briefQueryIdRef.current = null;
    }
    if (briefUnsubRef.current) {
      briefUnsubRef.current();
      briefUnsubRef.current = null;
    }
  }, []);

  // Leaving Home or unmounting cancels any active brief stream
  React.useEffect(() => {
    return () => {
      cancelActiveBrief();
    };
  }, [mode, cancelActiveBrief]);

  const handleToggleBrief = React.useCallback(
    (event: CalendarEvent) => {
      if (activeBriefEventId === event.id) {
        // Collapse
        cancelActiveBrief();
        setActiveBriefEventId(null);
        setBriefState({ text: '', status: 'idle', error: null });
        return;
      }

      // Cancel any prior in-flight brief stream
      cancelActiveBrief();

      const queryId = `brief-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      briefQueryIdRef.current = queryId;
      setActiveBriefEventId(event.id);
      setBriefState({ text: '', status: 'streaming', error: null });

      // Pass the event's title and its attendee DISPLAY NAMES only.
      // Two-step rule: strip an angle-bracketed email tail (e.g. "John Doe <john@example.com>" -> "John Doe"),
      // then drop if the remainder is empty or still contains an '@' (bare addresses like "john@example.com" are never passed).
      const attendeeNames = (event.attendees || [])
        .map((a) => (a.name ? a.name.replace(/<[^>]*>/g, '').trim() : ''))
        .filter((n): n is string => !!n && !n.includes('@'));

      const off = ipc().subscribeQueryStream(queryId, {
        onChunk: (chunk) => {
          setBriefState((prev) => ({
            ...prev,
            text: prev.text + chunk,
          }));
        },
        onDone: () => {
          setBriefState((prev) => ({
            ...prev,
            status: 'done',
          }));
          briefQueryIdRef.current = null;
        },
        onError: (err) => {
          setBriefState((prev) => ({
            ...prev,
            status: 'error',
            error: err.message,
          }));
          briefQueryIdRef.current = null;
        },
      });
      briefUnsubRef.current = off;

      const queryBridge = ipc().query;
      if ('briefStream' in queryBridge && typeof queryBridge.briefStream === 'function') {
        queryBridge.briefStream(
          queryId,
          event.title || 'Untitled meeting',
          attendeeNames
        );
      }
    },
    [activeBriefEventId, cancelActiveBrief]
  );

  // Today's relevant events: anything that overlaps with today AND
  // hasn't ended yet AND that the user is likely to attend. Includes
  // timed events for today and timed multi-day events (conference
  // sessions, calls spanning a day boundary) that started in the past
  // but are still ongoing — those are useful context the user might
  // want to glance at. All-day blocks (OOO, conference day) and declined
  // meetings are dropped — they crowd real meetings off the visible page.
  const upcomingToday = React.useMemo<CalendarEvent[]>(() => {
    if (!calendar.data || calendar.data.needsAuth) return [];
    // Use the tick as the time source so the memo is a pure function of
    // its deps (same inputs → same output) — rather than reading
    // Date.now() inside, which would leave upcomingTickMs as an
    // ostensibly-unused dep used only to trigger re-runs. 60s
    // staleness is well within tolerance for "has this event ended."
    const now = new Date(upcomingTickMs);
    const todayY = now.getFullYear();
    const todayM = now.getMonth();
    const todayD = now.getDate();
    // 00:00 tomorrow — events that start at or after this aren't "today."
    const startOfTomorrow = new Date(todayY, todayM, todayD + 1).getTime();
    const nowMs = now.getTime();
    return calendar.data.events
      .filter((e) => {
        const start = new Date(e.start).getTime();
        const end = new Date(e.end).getTime();
        if (Number.isNaN(start) || Number.isNaN(end)) return false;
        // Event must end after now (not in the past).
        if (end <= nowMs) return false;
        // Event must start before end-of-today (so it overlaps today).
        if (start >= startOfTomorrow) return false;
        // All-day blocks pose as 00:00 "meetings" and crowd out real ones.
        if (e.is_all_day === true) return false;
        // Declined: user said no — don't surface or auto-act on it.
        if (e.response_status === 'declined') return false;
        return true;
      })
      .sort((a, b) => new Date(a.start).getTime() - new Date(b.start).getTime());
  }, [calendar.data, upcomingTickMs]);

  // First event of tomorrow that the user is likely to attend. Used for
  // the "Tomorrow peek" when today's carousel is empty — keeps the panel
  // useful at 6pm with a clear evening, instead of disappearing.
  const tomorrowPreview = React.useMemo<CalendarEvent | null>(() => {
    if (!calendar.data || calendar.data.needsAuth) return null;
    const now = new Date(upcomingTickMs);
    const startOfTomorrow = new Date(
      now.getFullYear(),
      now.getMonth(),
      now.getDate() + 1,
    ).getTime();
    const startOfDayAfter = new Date(
      now.getFullYear(),
      now.getMonth(),
      now.getDate() + 2,
    ).getTime();
    const candidates = calendar.data.events
      .filter((e) => {
        const start = new Date(e.start).getTime();
        if (Number.isNaN(start)) return false;
        if (start < startOfTomorrow) return false;
        if (start >= startOfDayAfter) return false;
        if (e.is_all_day === true) return false;
        if (e.response_status === 'declined') return false;
        return true;
      })
      .sort((a, b) => new Date(a.start).getTime() - new Date(b.start).getTime());
    return candidates[0] || null;
  }, [calendar.data, upcomingTickMs]);

  // All-day events overlapping today that the user hasn't declined. Rendered
  // as a small clickable chip row so the user can see "OOO" / "Conference
  // Day" without these blocks crowding the timed carousel — and can click
  // a chip to record against that event's title.
  const allDayToday = React.useMemo<CalendarEvent[]>(() => {
    if (!calendar.data || calendar.data.needsAuth) return [];
    const now = new Date(upcomingTickMs);
    const startOfToday = new Date(
      now.getFullYear(),
      now.getMonth(),
      now.getDate(),
    ).getTime();
    const startOfTomorrow = new Date(
      now.getFullYear(),
      now.getMonth(),
      now.getDate() + 1,
    ).getTime();
    return calendar.data.events.filter((e) => {
      if (e.is_all_day !== true) return false;
      if (e.response_status === 'declined') return false;
      const start = new Date(e.start).getTime();
      const end = new Date(e.end).getTime();
      if (Number.isNaN(start) || Number.isNaN(end)) return false;
      // Overlaps with today's local window.
      return start < startOfTomorrow && end > startOfToday;
    });
  }, [calendar.data, upcomingTickMs]);

  const [allDayExpanded, setAllDayExpanded] = React.useState(false);

  // Three meetings is the sweet spot — fits the visible card height without
  // crowding, matches Granola's pattern. Earlier-than-now events have
  // already been filtered out, so page 0 always shows "next up".
  const UPCOMING_PAGE_SIZE = 3;
  const upcomingPageCount = Math.max(
    1,
    Math.ceil(upcomingToday.length / UPCOMING_PAGE_SIZE),
  );
  const [upcomingPage, setUpcomingPage] = React.useState(0);
  // Clamp the page when the list shrinks underneath us — e.g. an event
  // ends and rolls off, or the user reloads the calendar with fewer
  // entries. Without this the user could be stuck on an empty page 3
  // after the count drops to 5.
  React.useEffect(() => {
    if (upcomingPage >= upcomingPageCount) {
      setUpcomingPage(Math.max(0, upcomingPageCount - 1));
    }
  }, [upcomingPage, upcomingPageCount]);
  const upcomingVisible = upcomingToday.slice(
    upcomingPage * UPCOMING_PAGE_SIZE,
    (upcomingPage + 1) * UPCOMING_PAGE_SIZE,
  );
  const canPagePrev = upcomingPage > 0;
  const canPageNext = upcomingPage < upcomingPageCount - 1;

  const previous = meetings.data ?? [];

  // Search applies only to /meetings (the All meetings list). Home keeps the
  // unfiltered Previous list since it's already chronologically grouped.
  const [search, setSearch] = React.useState('');
  const searchInputRef = React.useRef<HTMLInputElement>(null);
  const searchResults = React.useMemo(() => {
    if (mode !== 'meetings' || !search.trim()) return null;
    return searchNotesDetailed(previous, search);
  }, [mode, previous, search]);

  const searchMatchMap = React.useMemo(() => {
    if (!searchResults) return new Map<string, NoteSearchMatch>();
    const map = new Map<string, NoteSearchMatch>();
    for (const r of searchResults) {
      map.set(r.meeting.session_info.summary_file, r.match);
    }
    return map;
  }, [searchResults]);

  const filtered = React.useMemo(() => {
    if (mode !== 'meetings') return previous;
    if (!search.trim()) return previous;
    return searchResults ? searchResults.map((r) => r.meeting) : previous;
  }, [mode, previous, search, searchResults]);
  const groups = React.useMemo(() => groupPrevious(filtered), [filtered]);

  // Calendar-connect nudge: most new users don't realise Steno can
  // surface their meetings until something tells them. Show a small
  // dismissible line on Home when calendar is unconnected; persist the
  // dismissal in localStorage so we don't nag the same person twice.
  const NUDGE_KEY = 'home.calendarNudge.dismissed';
  const [calendarNudgeDismissed, setCalendarNudgeDismissed] =
    React.useState<boolean>(() => {
      try {
        return localStorage.getItem(NUDGE_KEY) === 'true';
      } catch {
        return false;
      }
    });
  const showCalendarNudge =
    mode === 'home' &&
    calendar.data?.needsAuth === true &&
    !calendarNudgeDismissed;

  // Inline provider picker for the nudge. Collapsed by default — clicking
  // the message expands it to surface Google / Outlook buttons right
  // where the user is, so we don't make them hunt through Settings.
  const [calendarNudgeExpanded, setCalendarNudgeExpanded] =
    React.useState<boolean>(false);
  const googleAuth = useGoogleCalendarAuth();
  const outlookAuth = useOutlookCalendarAuth();

  // Which provider's OAuth handshake (if any) is currently in flight.
  // Tracks the most recently clicked provider so a Cancel after the user
  // somehow ended up with both pending hits the right one (defensive —
  // the UI normally swaps to the Cancel row on first click, so both-pending
  // shouldn't be reachable, but cheap to guard).
  const googlePending = googleAuth.connect.isPending;
  const outlookPending = outlookAuth.connect.isPending;
  const [lastStartedProvider, setLastStartedProvider] =
    React.useState<'google' | 'outlook' | null>(null);
  const pendingProvider: 'google' | 'outlook' | null = React.useMemo(() => {
    if (googlePending && outlookPending) return lastStartedProvider;
    if (googlePending) return 'google';
    if (outlookPending) return 'outlook';
    return null;
  }, [googlePending, outlookPending, lastStartedProvider]);
  const startConnect = (provider: 'google' | 'outlook') => {
    // In-flight guard: drop rapid duplicate clicks before React has
    // flushed isPending through to the disabled-button check. Without
    // this, two clicks within the React commit cycle both pass and
    // fire two mutate()s — the main-process startGoogleAuth /
    // startOutlookAuth call cancels the previous flow at the top, so
    // the user only sees one OAuth tab, but the renderer briefly ends
    // up with both connect mutations in flight and the Cancel row
    // gets confused about which provider it's cancelling.
    if (googlePending || outlookPending) return;
    setLastStartedProvider(provider);
    if (provider === 'google') googleAuth.connect.mutate();
    else outlookAuth.connect.mutate();
  };
  const onCancelPending = () => {
    if (pendingProvider === 'google') googleAuth.cancel.mutate();
    else if (pendingProvider === 'outlook') outlookAuth.cancel.mutate();
  };

  // Surface the most recent rejection message inline (e.g. "Auth denied",
  // "Timed out — no response from Google."). Filter out "Cancelled" since
  // user-initiated cancels don't need to be reported back to the user.
  // Prefer the error of the last-attempted provider so a stale error from
  // an earlier try-then-switch doesn't shadow the newer one.
  const errorOrder =
    lastStartedProvider === 'outlook'
      ? [outlookAuth.connect.error?.message, googleAuth.connect.error?.message]
      : [googleAuth.connect.error?.message, outlookAuth.connect.error?.message];
  const connectError = errorOrder.find((m) => m && m !== 'Cancelled');
  // Self-clear so a stale error doesn't sit in the UI forever once the
  // user has read it. 12s gives a comfortable read window for the longest
  // message we produce (the timeout line) without feeling sticky. No
  // separate X on the error row — the nudge already has one dismiss X
  // and stacking two looks like competing affordances; the user can also
  // clear by retrying (useMutation auto-resets) or wait out the timer.
  // Inlined reset calls + connectError-only deps: a useCallback closing
  // over `googleAuth.connect`/`outlookAuth.connect` would re-create each
  // render (React Query returns a fresh result object per render — only
  // the methods on it are referentially stable), which would restart
  // this timer on every render and the auto-clear would never fire.
  React.useEffect(() => {
    if (!connectError) return;
    const id = setTimeout(() => {
      googleAuth.connect.reset();
      outlookAuth.connect.reset();
    }, 12000);
    return () => clearTimeout(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [connectError]);

  // Hide the nudge — and abort any in-flight handshake so we don't leak
  // a loopback server (and silently save tokens) after the user has said
  // "go away".
  const onDismissCalendarNudge = () => {
    if (pendingProvider === 'google') googleAuth.cancel.mutate();
    else if (pendingProvider === 'outlook') outlookAuth.cancel.mutate();
    try {
      localStorage.setItem(NUDGE_KEY, 'true');
    } catch {
      // Private mode / quota errors — just hide locally for this session.
    }
    setCalendarNudgeDismissed(true);
  };

  // Rendered both in the empty-state Welcome screen (brand-new users with
  // zero meetings — exactly who needs to discover calendar integration)
  // and in the regular Home above the Upcoming section. Empty state hides
  // the dismiss X — the nudge is the only secondary affordance there, so
  // letting users wipe it out leaves nothing to discover calendar from.
  const renderCalendarNudge = (withDismiss: boolean) =>
    showCalendarNudge ? (
      <div className="flex flex-col gap-1">
        <div
          className="flex items-center gap-3 text-xs"
          style={{ color: 'var(--fg-muted)' }}
        >
          {!calendarNudgeExpanded ? (
            <button
              type="button"
              onClick={() => setCalendarNudgeExpanded(true)}
              className="group -mx-1 flex flex-1 items-center gap-2 rounded px-1 py-0.5 text-left transition-colors hover:bg-[color:var(--surface-hover)]"
              style={{ color: 'var(--fg-muted)' }}
            >
              <Calendar className="size-3.5 flex-shrink-0" />
              <span>Connect your calendar to see today's meetings.</span>
              {!withDismiss && (
                <ChevronRight className="size-3 flex-shrink-0 opacity-60 transition-transform group-hover:translate-x-0.5" />
              )}
            </button>
          ) : pendingProvider ? (
            <>
              <Calendar
                className="size-3.5 flex-shrink-0"
                style={{ color: 'var(--fg-muted)' }}
              />
              <span>
                Connecting to {pendingProvider === 'google' ? 'Google' : 'Outlook'}
                …
              </span>
              <button
                type="button"
                onClick={onCancelPending}
                className="rounded px-2 py-0.5 transition-colors hover:bg-[color:var(--surface-hover)]"
                style={{ color: 'var(--fg-1)' }}
              >
                Cancel
              </button>
            </>
          ) : (
            <>
              <Calendar
                className="size-3.5 flex-shrink-0"
                style={{ color: 'var(--fg-muted)' }}
              />
              <span>Connect:</span>
              <button
                type="button"
                onClick={() => startConnect('google')}
                className="rounded px-2 py-0.5 transition-colors hover:bg-[color:var(--surface-hover)]"
                style={{ color: 'var(--fg-1)' }}
              >
                Google
              </button>
              <button
                type="button"
                onClick={() => startConnect('outlook')}
                className="rounded px-2 py-0.5 transition-colors hover:bg-[color:var(--surface-hover)]"
                style={{ color: 'var(--fg-1)' }}
              >
                Outlook
              </button>
            </>
          )}
          {withDismiss && (
            <button
              type="button"
              onClick={onDismissCalendarNudge}
              aria-label="Dismiss"
              title="Dismiss"
              className="ml-auto rounded p-1 transition-colors hover:bg-[color:var(--surface-hover)]"
              style={{ color: 'var(--fg-muted)' }}
            >
              <X className="size-3" />
            </button>
          )}
        </div>
        {connectError && !pendingProvider && (
          <div
            className="pl-[1.625rem] text-xs"
            style={{ color: 'var(--fg-muted)' }}
          >
            {connectError}
          </div>
        )}
      </div>
    ) : null;
  const emptyStateCalendarNudge = renderCalendarNudge(false);
  const homeCalendarNudge = renderCalendarNudge(true);

  // Hero state inputs. All recompute on the existing 60s tick — no new
  // intervals. `inProgressEvent` uses the same matching window as the
  // backend's auto-detect (5 min early grace, 10 min late floor) so the
  // hero copy and the "Meeting detected" notification agree.
  const inProgressEvent = React.useMemo<CalendarEvent | null>(() => {
    if (!calendar.data || calendar.data.needsAuth) return null;
    return pickInProgressEvent(calendar.data.events, new Date(upcomingTickMs));
  }, [calendar.data, upcomingTickMs]);

  // `upcomingToday` is already all-day/declined/NaN-filtered and sorted by
  // start ascending, so the soonest still-future event is just the first one
  // that starts after now — no need to re-apply the guards here.
  const nextSoonEvent = React.useMemo<CalendarEvent | null>(
    () =>
      upcomingToday.find((e) => new Date(e.start).getTime() > upcomingTickMs) ??
      null,
    [upcomingToday, upcomingTickMs],
  );

  // Whether we have live calendar data to reason about. Distinguishes a
  // genuinely clear day (connected, no events) from "no calendar connected"
  // so the hero only claims "Clear day ahead" when it actually knows.
  const calendarConnected = !!calendar.data && !calendar.data.needsAuth;

  const heroState = React.useMemo(
    () => ({
      status: recording.status,
      sessionName: recording.sessionName,
      inProgressEvent,
      nextSoonEvent,
      tomorrowPreview,
      calendarConnected,
      now: upcomingTickMs,
      hotkeyEnabled,
    }),
    [
      recording.status,
      recording.sessionName,
      inProgressEvent,
      nextSoonEvent,
      tomorrowPreview,
      calendarConnected,
      upcomingTickMs,
      hotkeyEnabled,
    ],
  );
  const greeting = heroHeadline(heroState);
  const heroSub = heroSubtitle(heroState);
  const dateStr = new Date().toLocaleDateString(undefined, {
    weekday: 'long',
    month: 'long',
    day: 'numeric',
  });

  return (
    <MeetingsShell
      activeSummaryFile={null}
      contentAlign={emptyState ? 'center' : 'top'}
    >
      {meetings.isLoading ? (
        <div className="flex min-h-[40vh] items-center justify-center text-[color:var(--fg-2)]">
          Loading meetings…
        </div>
      ) : emptyState ? (
        <div className="flex flex-col items-center gap-8 text-center">
          <AppIcon size={56} />
          <div className="space-y-3">
            <h1
              style={{
                fontFamily: 'var(--font-serif)',
                fontSize: 44,
                lineHeight: 1.1,
                letterSpacing: '-0.025em',
                color: 'var(--fg-1)',
              }}
            >
              Welcome to Steno.
            </h1>
            <p
              className="text-[17px] leading-[1.55]"
              style={{ color: 'var(--fg-2)' }}
            >
              AI for your confidential workflows.
            </p>
            <p className="text-sm" style={{ color: 'var(--fg-muted)' }}>
              Always get consent when transcribing others.
            </p>
          </div>
          <div className="flex flex-col items-center gap-3">
            <Button
              variant={isRecording ? 'destructive' : 'default'}
              onClick={onToggleRecording}
              className="gap-2"
            >
              {isRecording ? <Square className="size-4" /> : <Plus className="size-4" />}
              {isRecording ? 'Stop recording' : 'New note'}
            </Button>
            {hotkeyEnabled && (
              <p
                className="flex items-center gap-1.5 text-xs"
                style={{ color: 'var(--fg-muted)' }}
              >
                <span>Quick start:</span>
                <KbdKey>{isMac ? '⌘' : 'Ctrl'}</KbdKey>
                <KbdKey>{isMac ? '⇧' : 'Shift'}</KbdKey>
                <KbdKey>R</KbdKey>
                <span>from anywhere</span>
              </p>
            )}
          </div>
          {emptyStateCalendarNudge && (
            <div className="pt-8">{emptyStateCalendarNudge}</div>
          )}
        </div>
      ) : (
        <>
          {mode === 'home' && (
            <div className="mb-10">
              <div className="mb-1.5 flex items-end justify-between gap-6">
                <h1 className="home-hello">
                  {greeting}
                  <span className="faint">.</span>
                </h1>
                <div
                  className="pb-2 text-[13px] tabular-nums"
                  style={{ color: 'var(--fg-2)' }}
                >
                  {dateStr}
                </div>
              </div>
              <p
                className="max-w-[52ch] text-sm leading-[1.55]"
                style={{ color: 'var(--fg-2)' }}
              >
                {heroSub}
              </p>
            </div>
          )}

          {homeCalendarNudge && (
            <div className="mb-8 w-fit">{homeCalendarNudge}</div>
          )}

          {upcomingToday.length > 0 && mode === 'home' && (() => {
            const groups: Record<string, typeof upcomingVisible> = {};
            
            const now = new Date(upcomingTickMs);
            const startOfTodayMs = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();

            for (const e of upcomingVisible) {
              const startMs = new Date(e.start).getTime();
              if (Number.isNaN(startMs)) continue;
              
              // Clamp events that started in the past (but are still ongoing) to today
              const effectiveDate = new Date(Math.max(startMs, startOfTodayMs));
              const key = `${effectiveDate.getFullYear()}-${effectiveDate.getMonth()}-${effectiveDate.getDate()}`;
              if (!groups[key]) groups[key] = [];
              groups[key].push(e);
            }

            return (
              <section className="mb-10">
                <SectionHead
                  title="Coming up"
                  isSerif
                  count={upcomingToday.length}
                  action={
                    <div className="flex items-center gap-1.5">
                      {upcomingPageCount > 1 && (
                        <div className="flex items-center gap-0.5">
                          <button
                            type="button"
                            className="inline-flex items-center rounded p-1 transition-colors hover:bg-[color:var(--surface-hover)] disabled:opacity-30 disabled:hover:bg-transparent"
                            title="Previous"
                            onClick={() => setUpcomingPage((p) => Math.max(0, p - 1))}
                            disabled={!canPagePrev}
                            style={{ color: 'var(--fg-2)' }}
                          >
                            <ChevronLeft className="size-[14px]" />
                          </button>
                          <button
                            type="button"
                            className="inline-flex items-center rounded p-1 transition-colors hover:bg-[color:var(--surface-hover)] disabled:opacity-30 disabled:hover:bg-transparent"
                            title="Next"
                            onClick={() => setUpcomingPage((p) => Math.min(upcomingPageCount - 1, p + 1))}
                            disabled={!canPageNext}
                            style={{ color: 'var(--fg-2)' }}
                          >
                            <ChevronRight className="size-[14px]" />
                          </button>
                        </div>
                      )}
                      <button
                        type="button"
                        className="inline-flex items-center rounded p-1 transition-colors hover:bg-[color:var(--surface-hover)] disabled:opacity-50"
                        title="Check for new calendar events"
                        onClick={() => calendar.refetch()}
                        disabled={calendar.isFetching}
                        style={{ color: 'var(--fg-2)' }}
                      >
                        <RefreshCw className={`size-[14px] ${calendar.isFetching ? 'animate-spin' : ''}`} />
                      </button>
                    </div>
                  }
                />
                <AllDayInline
                  events={allDayToday}
                  expanded={allDayExpanded}
                  onToggle={() => setAllDayExpanded((v) => !v)}
                />
                <div 
                  className="rounded-[16px] bg-[color:var(--surface-raised)] border shadow-sm mt-3"
                  style={{ borderColor: 'var(--border-subtle)' }}
                >
                  {Object.entries(groups).map(([dateKey, group]) => {
                    const [y, m, d] = dateKey.split('-').map(Number);
                    const groupDate = new Date(y, m, d);
                    const day = groupDate.getDate();
                    const month = groupDate.toLocaleDateString(undefined, { month: 'short' });
                    const weekday = groupDate.toLocaleDateString(undefined, { weekday: 'short' });
                    
                    return (
                      <div 
                        key={dateKey} 
                        className="flex p-5 pb-4 border-b border-dashed last:border-b-0"
                        style={{ borderColor: 'var(--border-subtle)' }}
                      >
                        {/* Date Column */}
                        <div className="w-[80px] flex-shrink-0 flex flex-col items-start pr-4 text-[color:var(--fg-2)] mt-0.5">
                          <div className="flex items-baseline gap-1.5 leading-none">
                             <span 
                               className="text-[26px] font-medium"
                               style={{ color: 'var(--fg-1)', fontFamily: 'var(--font-serif)', letterSpacing: '-0.02em' }}
                             >
                               {day}
                             </span>
                             <span className="text-[11px] font-semibold">{month}</span>
                          </div>
                          <span className="text-[11px] font-medium mt-1">{weekday}</span>
                        </div>
                        
                        {/* Events Column */}
                        <div className="flex-1 flex flex-col gap-1">
                          {group.map((event) => (
                            <UpcomingCard
                              key={event.id}
                              event={event}
                              isBriefActive={activeBriefEventId === event.id}
                              briefState={activeBriefEventId === event.id ? briefState : undefined}
                              onToggleBrief={handleToggleBrief}
                            />
                          ))}
                        </div>
                      </div>
                    );
                  })}
                </div>
              </section>
            );
          })()}

          {upcomingToday.length === 0 && tomorrowPreview && mode === 'home' && (
            <section className="mb-10">
              <SectionHead title="Tomorrow" count={1} />
              <AllDayInline
                events={allDayToday}
                expanded={allDayExpanded}
                onToggle={() => setAllDayExpanded((v) => !v)}
                activeBriefEventId={activeBriefEventId}
                briefState={briefState}
                onToggleBrief={handleToggleBrief}
              />
              <div 
                className="rounded-[16px] bg-[color:var(--surface-raised)] border shadow-sm p-2"
                style={{ borderColor: 'var(--border-subtle)' }}
              >
                <UpcomingCard
                  event={tomorrowPreview}
                  isBriefActive={activeBriefEventId === tomorrowPreview.id}
                  briefState={activeBriefEventId === tomorrowPreview.id ? briefState : undefined}
                  onToggleBrief={handleToggleBrief}
                />
              </div>
            </section>
          )}

          {upcomingToday.length === 0 && !tomorrowPreview && allDayToday.length > 0 && mode === 'home' && (
            <section className="mb-10">
              <SectionHead title="Today" count={allDayToday.length} />
              <AllDayInline
                events={allDayToday}
                expanded={allDayExpanded}
                onToggle={() => setAllDayExpanded((v) => !v)}
                activeBriefEventId={activeBriefEventId}
                briefState={briefState}
                onToggleBrief={handleToggleBrief}
              />
            </section>
          )}

          <section>
            <SectionHead
              title={mode === 'meetings' ? 'All notes' : 'Previous'}
              count={mode === 'meetings' ? filtered.length : previous.length}
              action={
                mode === 'meetings' ? (
                  <div className="relative">
                    <Search
                      className="pointer-events-none absolute left-2 top-1/2 -translate-y-1/2 size-[12px]"
                      style={{ color: 'var(--fg-muted)' }}
                    />
                    <input
                      ref={searchInputRef}
                      type="text"
                      value={search}
                      onChange={(e) => setSearch(e.target.value)}
                      placeholder="Search notes"
                      aria-label="Search notes"
                      className="h-[26px] w-[180px] rounded-md border-0 pl-7 pr-7 text-[12.5px] outline-none transition-colors focus:shadow-[inset_0_0_0_1px_hsl(var(--border))]"
                      style={{
                        background: 'rgba(27,27,25,0.04)',
                        color: 'var(--fg-1)',
                        fontFamily: 'var(--font-sans)',
                      }}
                    />
                    {search && (
                      <button
                        type="button"
                        onClick={() => {
                          setSearch('');
                          searchInputRef.current?.focus();
                        }}
                        aria-label="Clear search"
                        className="absolute right-1.5 top-1/2 -translate-y-1/2 inline-flex size-4 items-center justify-center rounded transition-colors hover:bg-[color:var(--surface-hover)]"
                        style={{ color: 'var(--fg-muted)' }}
                      >
                        <X className="size-[11px]" />
                      </button>
                    )}
                  </div>
                ) : undefined
              }
            />
            {groups.length === 0 && mode === 'meetings' && search.trim() ? (
              <div
                className="px-6 py-12 text-center text-[13px]"
                style={{ color: 'var(--fg-2)' }}
              >
                No meetings match &ldquo;{search.trim()}&rdquo;.
              </div>
            ) : (
              groups.map((g) => (
                <div key={g.label}>
                  <div
                    className="pb-2 pt-4 text-[11.5px] font-medium tracking-[0.02em]"
                    style={{ color: 'var(--fg-2)' }}
                  >
                    {g.label}
                  </div>
                  <div>
                    {g.items.map((m) => (
                      <HomeMeetingRow
                        key={m.session_info.summary_file}
                        meeting={m}
                        folderName={firstFolderName(m, folderName)}
                        searchMatch={searchMatchMap.get(m.session_info.summary_file)}
                        searchQuery={search}
                      />
                    ))}
                  </div>
                </div>
              ))
            )}
          </section>
        </>
      )}
    </MeetingsShell>
  );
}

interface SectionHeadProps {
  title: string;
  count: number;
  action?: React.ReactNode;
  isSerif?: boolean;
}

function SectionHead({ title, count, action, isSerif }: SectionHeadProps) {
  return (
    <div
      className="mb-3.5 flex items-baseline justify-between pb-2.5"
      style={{ borderBottom: '1px solid var(--border-subtle)' }}
    >
      <div className="flex items-baseline gap-2.5">
        <h2
          className={cn(
            isSerif ? "text-[22px]" : "text-sm font-medium tracking-[-0.005em]"
          )}
          style={{ color: 'var(--fg-1)', fontFamily: isSerif ? 'var(--font-serif)' : 'var(--font-sans)' }}
        >
          {title}
        </h2>
        <span
          className="text-[12.5px] tabular-nums"
          style={{ color: 'var(--fg-muted)' }}
        >
          {count}
        </span>
      </div>
      {action}
    </div>
  );
}


interface AllDayInlineProps {
  events: CalendarEvent[];
  expanded: boolean;
  onToggle: () => void;
  activeBriefEventId?: string | null;
  briefState?: BriefStreamState;
  onToggleBrief?: (event: CalendarEvent) => void;
}

function AllDayInline({
  events,
  expanded,
  onToggle,
  activeBriefEventId,
  briefState,
  onToggleBrief,
}: AllDayInlineProps) {
  if (events.length === 0) return null;
  return (
    <div className="mb-2 flex flex-col gap-2">
      <button
        type="button"
        onClick={onToggle}
        aria-expanded={expanded}
        className="-mx-1 self-start rounded px-1 py-0.5 text-xs transition-colors hover:bg-[color:var(--surface-hover)]"
        style={{ color: 'var(--fg-2)' }}
      >
        + {events.length} all-day event{events.length === 1 ? '' : 's'} today
      </button>
      {expanded && (
        // Render as full UpcomingCards so all-day events match the visual
        // language of the timed carousel below.
        <div 
          className="flex flex-col gap-1 rounded-[16px] bg-[color:var(--surface-raised)] border shadow-sm p-3 mt-1"
          style={{ borderColor: 'var(--border-subtle)' }}
        >
          {events.map((e) => (
            <UpcomingCard
              key={e.id}
              event={e}
              isBriefActive={activeBriefEventId === e.id}
              briefState={activeBriefEventId === e.id ? briefState : undefined}
              onToggleBrief={onToggleBrief}
            />
          ))}
        </div>
      )}
    </div>
  );
}

function firstFolderName(
  m: Meeting,
  folderName: Map<string, string>,
): string | undefined {
  const id = m.folders?.[0] ?? m.session_info.folders?.[0];
  if (!id) return undefined;
  return folderName.get(id);
}

interface Group {
  label: string;
  items: Meeting[];
}

function groupPrevious(meetings: Meeting[]): Group[] {
  const groups: Record<string, Meeting[]> = {};
  const order: string[] = [];
  const now = new Date();
  const sorted = [...meetings].sort((a, b) => {
    const ta = new Date(a.session_info.processed_at ?? a.session_info.updated_at ?? 0).getTime();
    const tb = new Date(b.session_info.processed_at ?? b.session_info.updated_at ?? 0).getTime();
    return tb - ta;
  });
  for (const m of sorted) {
    const raw = m.session_info.processed_at ?? m.session_info.updated_at;
    const label = raw ? groupLabel(new Date(raw), now) : 'Earlier';
    if (!groups[label]) {
      groups[label] = [];
      order.push(label);
    }
    groups[label].push(m);
  }
  return order.map((label) => ({ label, items: groups[label] }));
}

function groupLabel(d: Date, now: Date): string {
  const sameDay = (a: Date, b: Date) =>
    a.getFullYear() === b.getFullYear() &&
    a.getMonth() === b.getMonth() &&
    a.getDate() === b.getDate();
  if (sameDay(d, now)) return 'Today';
  const yesterday = new Date(now);
  yesterday.setDate(now.getDate() - 1);
  if (sameDay(d, yesterday)) return 'Yesterday';
  const age = now.getTime() - d.getTime();
  if (age < 7 * 24 * 60 * 60 * 1000) {
    return d.toLocaleDateString(undefined, { weekday: 'long' });
  }
  return d.toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short' });
}

interface HomeMeetingRowProps {
  meeting: Meeting;
  folderName?: string;
  searchMatch?: NoteSearchMatch;
  searchQuery?: string;
}

function HomeMeetingRow({
  meeting,
  folderName,
  searchMatch,
  searchQuery,
}: HomeMeetingRowProps) {
  const info = meeting.session_info;
  const when = formatTime(info.processed_at ?? info.updated_at);
  const duration = formatDuration(info.duration_seconds);
  const isLive = meeting.is_recording;
  const isProcessing = meeting.is_processing;
  const isSynthetic = isLive || isProcessing;
  const participants = Array.isArray(meeting.participants)
    ? meeting.participants.length
    : 0;
  const list = useMeetingsList();

  const targetPath = isLive
    ? '/recording'
    : isProcessing
      ? '/meetings/processing'
      : `/meetings/${encodeURIComponent(info.summary_file)}`;

  const title = info.name || 'Untitled note';

  const showFieldLabel = Boolean(
    searchQuery?.trim() &&
      searchMatch &&
      searchMatch.field !== 'title' &&
      searchMatch.label
  );
  const preview = previewText(meeting);
  const sub = searchMatch?.snippet || preview;
  const showPreview = sub && !isSynthetic;

  return (
    <div
      className="group relative flex cursor-pointer items-center justify-between py-[10px] -mx-3 px-3 rounded-lg transition-colors hover:bg-[color:var(--surface-hover)]"
      data-testid="previous-row"
      data-recording={isLive ? 'true' : undefined}
      data-processing={isProcessing ? 'true' : undefined}
      role="button"
      tabIndex={0}
      draggable={!isSynthetic && !!list}
      onDragStart={(e) =>
        !isSynthetic && list?.startMeetingDrag(info.summary_file, e)
      }
      onContextMenu={(e) =>
        !isSynthetic && list?.openMeetingContextMenu(info.summary_file, e)
      }
      onClick={() => navigate(targetPath)}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          navigate(targetPath);
        }
      }}
    >
      <div className="flex min-w-0 flex-1 items-center gap-3.5">
        <div
          aria-hidden="true"
          className="flex size-9 flex-shrink-0 items-center justify-center rounded-lg text-[15px] font-medium"
          style={{ background: 'var(--surface-sunken)', color: 'var(--fg-2)' }}
        >
          {title.charAt(0).toUpperCase()}
        </div>

        <div className="flex min-w-0 flex-col gap-1">
          <div className="flex items-center gap-2">
            <div
              className="truncate text-[13.5px] font-medium tracking-[-0.005em]"
              style={{ color: 'var(--fg-1)' }}
            >
              {title}
            </div>
            {isLive && <LiveBadge />}
            {isProcessing && <ProcessingBadge />}
          </div>

          {(folderName || participants > 0 || showFieldLabel || showPreview) && (
            <div
              className="flex items-center gap-1.5 truncate text-[12px] font-medium"
              style={{ color: 'var(--fg-muted)' }}
            >
              {folderName && (
                <>
                  <span className="flex items-center gap-1">
                    <FolderIcon className="size-3" />
                    {folderName}
                  </span>
                  {(participants > 0 || showFieldLabel || showPreview) && (
                    <span className="opacity-40">·</span>
                  )}
                </>
              )}
              {participants > 0 && (
                <>
                  <span>
                    {participants} {participants === 1 ? 'person' : 'people'}
                  </span>
                  {(showFieldLabel || showPreview) && (
                    <span className="opacity-40">·</span>
                  )}
                </>
              )}
              {showFieldLabel && (
                <span
                  className="inline-flex items-center rounded px-1.5 py-0.5 text-[10px] font-medium tracking-[0.01em] shrink-0"
                  style={{
                    background: 'var(--surface-sunken)',
                    color: 'var(--fg-2)',
                    border: '1px solid var(--border-subtle)',
                  }}
                >
                  {searchMatch?.label}
                </span>
              )}
              {showPreview && <span className="truncate">{sub}</span>}
            </div>
          )}
        </div>
      </div>

      <div
        className="flex flex-col items-end gap-1.5 pl-4 text-[12.5px] tabular-nums"
        style={{ color: 'var(--fg-2)' }}
      >
        <span>{isSynthetic ? 'Now' : (when ?? '')}</span>
        {(duration || (!isSynthetic && meeting.has_audio)) && (
          <span className="flex items-center gap-1 text-[11.5px] opacity-70">
            {!isSynthetic && meeting.has_audio && (
              <AudioLines
                className="size-3"
                aria-label="Original audio still available"
                data-testid="previous-row-has-audio"
              >
                <title>Original audio still available</title>
              </AudioLines>
            )}
            {duration}
          </span>
        )}
      </div>
    </div>
  );
}

function LiveBadge() {
  return (
    <span
      className="inline-flex items-center gap-1.5 rounded-full px-2 py-0.5 text-[11px] font-medium"
      style={{
        background: 'var(--recording)',
        color: '#FFFFFF',
      }}
    >
      <span
        aria-hidden
        className="inline-block size-1.5 rounded-full bg-white"
        style={{ animation: 'pulse 1.4s ease-in-out infinite' }}
      />
      Recording
    </span>
  );
}

function ProcessingBadge() {
  return (
    <span
      className="inline-flex items-center gap-1 px-2 py-0.5 text-[11px] font-medium"
      style={{
        background: 'var(--surface-sunken)',
        color: 'var(--fg-2)',
        borderRadius: 'var(--radius-sm)',
      }}
    >
      <Loader2 className="size-[10px] animate-spin" aria-hidden />
      Processing
    </span>
  );
}

function formatTime(iso?: string): string | undefined {
  if (!iso) return undefined;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return undefined;
  const pad = (n: number) => n.toString().padStart(2, '0');
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function formatDuration(seconds?: number): string | undefined {
  if (!seconds || seconds <= 0) return undefined;
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = seconds % 60;
  if (h > 0) return `${h}h ${m}m`;
  if (m > 0) return `${m}m`;
  return `${s}s`;
}

function previewText(meeting: Meeting): string | undefined {
  const summary = meeting.summary ? stripReasoning(meeting.summary).trim() : undefined;
  if (summary) return summary;
  const kp = meeting.key_points?.[0];
  if (typeof kp === 'string' && kp.trim()) return kp.trim();
  return undefined;
}
