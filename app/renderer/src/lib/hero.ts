import { type CalendarEvent } from '@/lib/ipc';
import { shortcut } from '@/lib/utils';
import { t } from '@/i18n';
// Pure copy logic for the Home hero. Extracted from Home.tsx so the
// headline/subtitle string-building can be unit-tested without mounting the
// React route. Recording state always wins over calendar state.

// Default subtitle — also used as the empty/idle fallback. Cached so it
// renders the same string each call without rebuilding the shortcut.
const RECORD_SHORTCUT = shortcut('⌘⇧R', 'Ctrl+Shift+R');

// Cached at module load to avoid rebuilding on every render. We don't
// react to system-locale changes mid-session — that would require a full
// app relaunch on macOS anyway, and creating an Intl.DateTimeFormat per
// render isn't free. If we ever start supporting in-app locale toggles
// we'd need to move this inside the function.
const HERO_TIME_FMT = new Intl.DateTimeFormat(undefined, {
  hour: 'numeric',
  minute: '2-digit',
});

const HOUR_MS = 60 * 60 * 1000;
const MIN_MS = 60 * 1000;

export interface HeroState {
  status: 'idle' | 'recording' | 'paused' | 'processing';
  sessionName: string | null;
  inProgressEvent: CalendarEvent | null;
  nextSoonEvent: CalendarEvent | null;
  tomorrowPreview: CalendarEvent | null;
  calendarConnected: boolean;
  now: number;
  // Whether the global record shortcut is enabled (Settings). Gates every
  // ⌘⇧R mention in the subtitle copy so the hero never advertises a shortcut
  // the user has turned off.
  hotkeyEnabled: boolean;
}

// True only when `now` is inside the event's real [start, end) — i.e. the
// meeting has actually started. `pickInProgressEvent` also returns events in
// the 5-min early-join grace and the late-join floor, which are the right
// targets for the "start recording" CTA but must NOT drive present-tense
// copy like "In a meeting now" (the meeting may not have begun yet).
function eventIsNow(e: CalendarEvent, nowMs: number): boolean {
  const startMs = new Date(e.start).getTime();
  const endMs = new Date(e.end).getTime();
  if (!Number.isFinite(startMs) || !Number.isFinite(endMs)) return false;
  return startMs <= nowMs && nowMs < endMs;
}

// Headline. Recording state always wins over calendar state — when the
// user is recording / paused / processing they want status, not a
// schedule. Idle falls through to the calendar-driven copy.
export function heroHeadline(s: HeroState): string {
  switch (s.status) {
    case 'recording':
      return t('home.heroHeadlineRecording');
    case 'paused':
      return t('home.heroHeadlinePaused');
    case 'processing':
      return t('home.heroHeadlineProcessing');
  }
  // Only present-tense when the meeting has truly started — not during the
  // early-join grace, which would tell the user they're "in" a meeting that
  // hasn't begun. The pre-start case falls through to "Next meeting in N min".
  if (s.inProgressEvent && eventIsNow(s.inProgressEvent, s.now)) {
    return t('home.heroHeadlineInMeeting');
  }
  if (s.nextSoonEvent) {
    const startMs = new Date(s.nextSoonEvent.start).getTime();
    if (!Number.isNaN(startMs)) {
      const deltaMs = startMs - s.now;
      // Compute mins first and gate on the rounded value: Math.ceil rounds
      // anything in (59 min, 60 min) up to 60, and "60 mins" reads
      // unnaturally — fall straight through to "1 hr" instead. The
      // Math.max(1) keeps the headline non-zero in the last 30 seconds
      // before start.
      const mins = Math.max(1, Math.ceil(deltaMs / MIN_MS));
      if (mins < 60) return t('home.heroHeadlineNextInMins', { count: mins, plural: mins === 1 ? '' : 's' });
      const hrs = Math.max(1, Math.round(deltaMs / HOUR_MS));
      return t('home.heroHeadlineNextInHours', { count: hrs, plural: hrs === 1 ? '' : 's' });
    }
  }
  // Reaching here means nothing is live or upcoming today. Only call the day
  // "clear" when the calendar is actually connected — otherwise we don't know,
  // so keep the neutral invitation.
  if (s.calendarConnected) return t('home.heroHeadlineClearDay');
  return t('home.heroHeadlineReady');
}

// Subtitle. Mirrors the headline cases. Keeps the recording shortcut hint
// as the default fallback so the page always tells the user how to act.
export function heroSubtitle(s: HeroState): string {
  // Idle/upcoming fallback hint — drops the ⌘⇧R clause when the shortcut is off.
  const idleHint = s.hotkeyEnabled
    ? t('home.heroSubtitleIdleHotkey', { shortcut: RECORD_SHORTCUT })
    : t('home.heroSubtitleIdleClick');
  if (s.status === 'recording') {
    // Source of truth for "what we're capturing" is the active session
    // name — the user may have started a recording titled after one
    // event while a different calendar event is also concurrently in
    // progress, and the subtitle should reflect what they actually hit
    // record on. ⌘⇧R is a record-toggle per main.js's global shortcut
    // so "to stop" is accurate when already recording.
    const title =
      s.sessionName?.trim() || s.inProgressEvent?.title?.trim() || t('home.inProgressBadge');
    // Drop the "· ⌘⇧R to stop" tail when the global shortcut is off — stopping
    // is then a click-only action on the bottom bar.
    return s.hotkeyEnabled
      ? t('home.heroSubtitleRecording', { title, shortcut: RECORD_SHORTCUT })
      : t('home.heroSubtitleRecordingClick', { title });
  }
  if (s.status === 'paused') {
    // ⌘⇧R is a record-toggle: while paused it STOPS (finalizes) the recording
    // rather than resuming. Resume is a click-only action on the bottom bar,
    // so point there instead of advertising a shortcut that would end the note.
    return t('home.heroSubtitlePaused');
  }
  if (s.status === 'processing') {
    return t('home.heroSubtitleProcessing');
  }
  // Only when the meeting has truly started (mirrors the headline gate) — the
  // pre-start grace falls through to the timed "starts at …" line below.
  if (s.inProgressEvent && eventIsNow(s.inProgressEvent, s.now)) {
    return s.hotkeyEnabled
      ? t('home.heroSubtitleInMeetingHotkey', { shortcut: RECORD_SHORTCUT })
      : t('home.heroSubtitleInMeetingClick');
  }
  if (s.nextSoonEvent) {
    const startMs = new Date(s.nextSoonEvent.start).getTime();
    if (!Number.isNaN(startMs)) {
      // Mirror the headline's `mins < 60` threshold (Math.ceil-based) so the
      // title-at-time line and the "Next meeting in N min" headline flip to
      // the hours wording at the same instant.
      const mins = Math.max(1, Math.ceil((startMs - s.now) / MIN_MS));
      if (mins < 60) {
        const at = HERO_TIME_FMT.format(new Date(startMs));
        return s.hotkeyEnabled
          ? t('home.heroSubtitleNextSoonHotkey', { title: s.nextSoonEvent.title, time: at, shortcut: RECORD_SHORTCUT })
          : t('home.heroSubtitleNextSoonClick', { title: s.nextSoonEvent.title, time: at });
      }
    }
    return idleHint;
  }
  if (s.tomorrowPreview) {
    const startMs = new Date(s.tomorrowPreview.start).getTime();
    if (!Number.isNaN(startMs)) {
      const at = HERO_TIME_FMT.format(new Date(startMs));
      return t('home.heroSubtitleTomorrow', { title: s.tomorrowPreview.title, time: at });
    }
  }
  return idleHint;
}
