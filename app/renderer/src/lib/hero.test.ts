import { describe, test, expect, beforeEach } from 'vitest';
import type { CalendarEvent } from '@/lib/ipc';
import { heroHeadline, heroSubtitle, type HeroState } from '@/lib/hero';
import { setLocale } from '@/i18n';

// Pure-function coverage for the Home hero copy (#147). Asserts the full
// state matrix: recording state wins over calendar state, the present-tense
// "In a meeting now" only fires once the meeting has truly started (not in
// the early-join grace), and the minute/hour wording flips at the same
// threshold in both the headline and subtitle.

const NOW = Date.UTC(2026, 0, 15, 12, 0, 0); // fixed clock for deterministic deltas
const MIN = 60_000;

function ev(
  startOffsetMs: number,
  endOffsetMs: number,
  extra: Partial<CalendarEvent> = {},
): CalendarEvent {
  return {
    id: extra.id ?? 'e1',
    title: extra.title ?? 'Sprint Planning',
    start: new Date(NOW + startOffsetMs).toISOString(),
    end: new Date(NOW + endOffsetMs).toISOString(),
    ...extra,
  };
}

function state(overrides: Partial<HeroState> = {}): HeroState {
  return {
    status: 'idle',
    sessionName: null,
    inProgressEvent: null,
    nextSoonEvent: null,
    tomorrowPreview: null,
    calendarConnected: false,
    now: NOW,
    hotkeyEnabled: true,
    ...overrides,
  };
}

describe('heroHeadline', () => {
  beforeEach(() => {
    setLocale('en');
  });

  test('recording / paused / processing status wins over everything', () => {
    // Even with a meeting in progress, status copy takes precedence.
    const inMeeting = ev(-5 * MIN, 25 * MIN);
    expect(heroHeadline(state({ status: 'recording', inProgressEvent: inMeeting }))).toBe('Recording');
    expect(heroHeadline(state({ status: 'paused', inProgressEvent: inMeeting }))).toBe('Recording paused');
    expect(heroHeadline(state({ status: 'processing', inProgressEvent: inMeeting }))).toBe('Processing your note');
  });

  test('"In a meeting now" only when the meeting has truly started', () => {
    const started = ev(-5 * MIN, 25 * MIN); // now ∈ [start, end)
    expect(heroHeadline(state({ inProgressEvent: started }))).toBe('In a meeting now');
  });

  test('early-join grace does NOT claim "In a meeting now" — falls through to countdown', () => {
    // pickInProgressEvent returns events up to 5 min before start, but the
    // headline must not say the user is "in" a meeting that hasn't begun.
    const soon = ev(4 * MIN, 34 * MIN);
    const s = state({ inProgressEvent: soon, nextSoonEvent: soon });
    expect(heroHeadline(s)).toBe('Next meeting in 4 mins');
  });

  test('upcoming countdown: minutes, singular minute, and the 60-min → hour flip', () => {
    expect(heroHeadline(state({ nextSoonEvent: ev(30 * MIN, 60 * MIN) }))).toBe('Next meeting in 30 mins');
    expect(heroHeadline(state({ nextSoonEvent: ev(1 * MIN, 31 * MIN) }))).toBe('Next meeting in 1 min');
    // 59.5 min rounds up to 60, which reads unnaturally → "1 hr" instead.
    expect(heroHeadline(state({ nextSoonEvent: ev(59.5 * MIN, 120 * MIN) }))).toBe('Next meeting in 1 hr');
    expect(heroHeadline(state({ nextSoonEvent: ev(120 * MIN, 180 * MIN) }))).toBe('Next meeting in 2 hrs');
  });

  test('idle fallbacks distinguish a connected clear day from no calendar', () => {
    expect(heroHeadline(state({ calendarConnected: true }))).toBe('Clear day ahead');
    expect(heroHeadline(state({ calendarConnected: false }))).toBe('Ready to capture beautiful notes');
  });
});

describe('heroSubtitle', () => {
  beforeEach(() => {
    setLocale('en');
  });

  test('recording subtitle prefers the active session name', () => {
    const sub = heroSubtitle(state({ status: 'recording', sessionName: 'Q3 Roadmap', inProgressEvent: ev(-5 * MIN, 25 * MIN, { title: 'Other Meeting' }) }));
    expect(sub).toContain('Q3 Roadmap');
    expect(sub).toContain('to stop');
  });
  test('recording subtitle falls back to event title then a generic label', () => {
    expect(heroSubtitle(state({ status: 'recording', inProgressEvent: ev(-5 * MIN, 25 * MIN, { title: 'Standup' }) }))).toContain('Standup');
    expect(heroSubtitle(state({ status: 'recording' }))).toContain('In progress');
  });

  test('paused and processing have their own copy', () => {
    expect(heroSubtitle(state({ status: 'paused' }))).toBe('Recording paused. Tap resume on the bar below to continue.');
    expect(heroSubtitle(state({ status: 'processing' }))).toBe(`We'll have your note ready in a moment.`);
  });

  test('upcoming-soon subtitle names the meeting and its start time', () => {
    const sub = heroSubtitle(state({ nextSoonEvent: ev(20 * MIN, 50 * MIN, { title: 'Design Review' }) }));
    expect(sub).toContain('Design Review');
    expect(sub).toContain('at');
    expect(sub).toContain("when you're ready");
  });

  test('tomorrow preview when nothing is on today', () => {
    const sub = heroSubtitle(state({ tomorrowPreview: ev(24 * 60 * MIN, 24 * 60 * MIN + 30 * MIN, { title: 'Kickoff' }) }));
    expect(sub).toContain('Next up:');
    expect(sub).toContain('Kickoff');
    expect(sub).toContain('tomorrow at');
  });

  test('idle with no events falls back to the recording hint', () => {
    expect(heroSubtitle(state())).toContain('Start recording');
  });

  test('disabled global shortcut drops every record-shortcut mention from the copy', () => {
    // Platform-neutral assertions: under jsdom the shortcut util renders
    // 'Ctrl+Shift+R' (not the mac glyph), so we assert on the enabled-only
    // phrases that surround the shortcut, which are the real signal.
    const off = { hotkeyEnabled: false };
    // Idle fallback: no "from anywhere with …" clause.
    const idle = heroSubtitle(state(off));
    expect(idle).toBe('Start recording from the top-right.');
    expect(idle).not.toContain('anywhere');
    // Recording: no "· … to stop" tail — just the session/title.
    const rec = heroSubtitle(state({ ...off, status: 'recording', sessionName: 'Q3 Roadmap' }));
    expect(rec).toBe('Q3 Roadmap');
    expect(rec).not.toContain('to stop');
    // In-a-meeting-now: click-only phrasing, no "Press … to start recording".
    const inMeeting = heroSubtitle(state({ ...off, inProgressEvent: ev(-5 * MIN, 25 * MIN) }));
    expect(inMeeting).toBe('Tap a meeting card below to start recording.');
    expect(inMeeting).not.toContain('Press');
    // Upcoming-soon: names the meeting + time but no "when you're ready" tail.
    const soon = heroSubtitle(state({ ...off, nextSoonEvent: ev(20 * MIN, 50 * MIN, { title: 'Design Review' }) }));
    expect(soon).toContain('Design Review');
    expect(soon).not.toContain("when you're ready");
  });
});

describe('heroHeadline and heroSubtitle (zh-TW)', () => {
  beforeEach(() => {
    setLocale('zh-TW');
  });

  test('recording / paused / processing status in zh-TW', () => {
    expect(heroHeadline(state({ status: 'recording' }))).toBe('錄音中');
    expect(heroHeadline(state({ status: 'paused' }))).toBe('錄音已暫停');
    expect(heroHeadline(state({ status: 'processing' }))).toBe('正在處理您的筆記');
  });

  test('heroSubtitle in zh-TW', () => {
    expect(heroSubtitle(state({ status: 'paused' }))).toBe('錄音已暫停。請點擊下方控制列的繼續按鈕以繼續。');
    expect(heroSubtitle(state({ status: 'processing' }))).toBe('您的筆記即將完成。');
  });
});
