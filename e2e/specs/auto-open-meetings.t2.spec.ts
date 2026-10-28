import { test, expect } from '../fixtures/electron';
import { readUserConfig, enableDeterministicRecording } from '../fixtures/user-config';
import type { ElectronApplication, Page } from '@playwright/test';

/**
 * T2 - auto-open meetings (#560): the four config keys round-trip to config.json,
 * and the show-premeeting-notification seam (which allows auto-open under E2E)
 * decides auto / ask / nothing. shell.openExternal is spied so no browser opens.
 * Each decision case gets its own launch: any non-null action records the open
 * and makes the next fire within the overlap window downgrade to 'ask'.
 */

type Patch = {
  mode?: string;
  lead_minutes?: number;
  providers?: string[];
  accepted_only?: boolean;
};
type CalEvent = {
  id: string;
  title: string;
  start: string;
  end: string;
  meeting_url: string;
  response_status: string;
  own_calendar?: boolean;
};
type TestState = {
  micGuardAvailable?: boolean;
  freshEvents?: CalEvent[] | null | 'failed';
  knownEvents?: CalEvent[];
  ageLastOpenMs?: number;
  skipFire?: boolean;
};
type StenoWindow = Window & {
  stenoai: {
    shell: { openExternal: (url: string, eventId?: string) => Promise<{ success: boolean }> };
    settings: {
      getAutoOpenMeetings: () => Promise<Record<string, unknown>>;
      setAutoOpenMeetings: (p: Patch) => Promise<Record<string, unknown>>;
      setPremeetingNotifications: (v: boolean) => Promise<Record<string, unknown>>;
      showPremeetingNotification: (p: {
        event: CalEvent;
        testState?: TestState;
      }) => Promise<{ success: boolean; shown?: boolean; action?: string | null }>;
    };
    recording: { start: (name?: string) => Promise<{ success: boolean }> };
  };
};

const inMin = (m: number) => new Date(Date.now() + m * 60_000).toISOString();

function makeEvent(id: string, over: Partial<CalEvent> = {}): CalEvent {
  return {
    id,
    title: `Meeting ${id}`,
    start: inMin(1),
    end: inMin(31),
    meeting_url: `https://meet.google.com/${id}`,
    response_status: 'accepted',
    own_calendar: true,
    ...over,
  };
}

const setSettings = (page: Page, patch: Patch) =>
  page.evaluate((p) => (window as StenoWindow).stenoai.settings.setAutoOpenMeetings(p), patch);

const fire = (page: Page, event: CalEvent, testState: TestState = {}) =>
  page.evaluate(({ e, state }) => (window as StenoWindow).stenoai.settings.showPremeetingNotification({ event: e, testState: state }),
    { e: event, state: { micGuardAvailable: true, ...testState } });

async function spyOpenExternal(app: ElectronApplication) {
  await app.evaluate(({ shell }) => {
    const g = globalThis as unknown as { __opened: string[] };
    g.__opened = [];
    shell.openExternal = async (u: string) => {
      g.__opened.push(u);
    };
  });
}

const opened = (app: ElectronApplication) =>
  app.evaluate(() => (globalThis as unknown as { __opened: string[] }).__opened);

test('auto-open settings round-trip to config.json', async ({ launchApp, userDataDir }) => {
  const { page } = await launchApp();

  const defaults = await page.evaluate(() => (window as StenoWindow).stenoai.settings.getAutoOpenMeetings());
  expect(defaults).toMatchObject({
    success: true,
    auto_open_meetings: 'off',
    auto_open_lead_minutes: 1,
    auto_open_providers: [],
    auto_open_accepted_only: true,
  });

  const res = await setSettings(page, {
    mode: 'auto',
    lead_minutes: 5,
    providers: ['meet', 'zoom'],
    accepted_only: false,
  });
  expect(res.success).toBe(true);

  const cfg = readUserConfig(userDataDir);
  expect(cfg.auto_open_meetings).toBe('auto');
  expect(cfg.auto_open_lead_minutes).toBe(5);
  expect(cfg.auto_open_providers).toEqual(['meet', 'zoom']);
  expect(cfg.auto_open_accepted_only).toBe(false);

  const back = await page.evaluate(() => (window as StenoWindow).stenoai.settings.getAutoOpenMeetings());
  expect(back).toMatchObject({
    auto_open_meetings: 'auto',
    auto_open_lead_minutes: 5,
    auto_open_providers: ['meet', 'zoom'],
    auto_open_accepted_only: false,
  });

  const bad = await setSettings(page, { mode: 'bogus' });
  expect(bad.success).toBe(false);
  expect(String(bad.error)).toContain('mode');
});

test('ask mode prompts and does not open the link', async ({ launchApp }) => {
  const { app, page } = await launchApp();
  await spyOpenExternal(app);
  await setSettings(page, { mode: 'ask' });
  const r = await fire(page, makeEvent('ask1'));
  expect(r.action).toBe('ask');
  expect(await opened(app)).toEqual([]);
});

test('auto mode opens an accepted Google Meet link starting in 1 minute', async ({ launchApp }) => {
  const { app, page } = await launchApp();
  await spyOpenExternal(app);
  await setSettings(page, { mode: 'auto' });
  const ev = makeEvent('auto1');
  const r = await fire(page, ev);
  expect(r.action).toBe('auto');
  expect(await opened(app)).toEqual([ev.meeting_url]);
});

test('Automatically asks when the live mic guard is unavailable', async ({ launchApp }) => {
  const { app, page } = await launchApp();
  await spyOpenExternal(app);
  await setSettings(page, { mode: 'auto' });
  expect((await fire(page, makeEvent('guard-off'), { micGuardAvailable: false })).action).toBe('ask');
  expect(await opened(app)).toEqual([]);
});

test('Ask and Auto-to-Ask recheck moved, deleted and declined events', async ({ launchApp }) => {
  const { app, page } = await launchApp();
  await spyOpenExternal(app);
  for (const mode of ['ask', 'auto']) {
    await setSettings(page, { mode });
    // Auto would open this accepted event from the user's calendar. A failed
    // freshness fetch must downgrade that path to Ask without opening a link.
    const old = makeEvent(`${mode}-stale`);
    expect((await fire(page, old, { freshEvents: [] })).action).toBeNull();
    expect((await fire(page, old, { freshEvents: [makeEvent(old.id, { start: inMin(10) })] })).action).toBeNull();
    expect((await fire(page, old, { freshEvents: [{ ...old, response_status: 'declined' }] })).action).toBeNull();
    expect((await fire(page, old, { freshEvents: null })).action).toBeNull();
    expect((await fire(page, old, { freshEvents: 'failed' })).action).toBe('ask');
  }
  expect(await opened(app)).toEqual([]);
});

test('manual Join protects overlapping meetings through the known calendar end', async ({ launchApp }) => {
  const { app, page } = await launchApp();
  await spyOpenExternal(app);
  await setSettings(page, { mode: 'auto' });
  const first = makeEvent('manual-first', { end: inMin(31) });
  await fire(page, first, { knownEvents: [first], skipFire: true });
  const joined = await page.evaluate(({ url, id }) =>
    (window as StenoWindow).stenoai.shell.openExternal(url, id),
  { url: first.meeting_url, id: first.id });
  expect(joined.success).toBe(true);
  const second = makeEvent('manual-second', { start: inMin(3), end: inMin(33) });
  // Age the one-minute recent-open guard away: the known event end must still
  // protect the overlap, rather than this assertion passing for the short guard.
  expect((await fire(page, second, { ageLastOpenMs: 2 * 60_000 })).action).toBe('ask');
  expect(await opened(app)).toEqual([first.meeting_url]);
});

test('auto mode still opens when scheduled-meeting reminders are off', async ({ launchApp, userDataDir }) => {
  const { app, page } = await launchApp();
  await spyOpenExternal(app);
  await setSettings(page, { mode: 'auto' });
  const off = await page.evaluate(() => (window as StenoWindow).stenoai.settings.setPremeetingNotifications(false));
  expect(off.success).toBe(true);
  expect(readUserConfig(userDataDir).premeeting_notifications_enabled).toBe(false);
  const ev = makeEvent('auto2');
  const r = await fire(page, ev);
  expect(r.action).toBe('auto');
  expect(await opened(app)).toEqual([ev.meeting_url]);
});

test('an unknown host asks instead of opening in auto mode', async ({ launchApp }) => {
  const { app, page } = await launchApp();
  await spyOpenExternal(app);
  await setSettings(page, { mode: 'auto' });
  const r = await fire(page, makeEvent('other1', { meeting_url: 'https://example.com/join/other1' }));
  expect(r.action).toBe('ask');
  expect(await opened(app)).toEqual([]);
});

test('nothing opens when the filters or timing exclude the event', async ({ launchApp }) => {
  const { app, page } = await launchApp();
  await spyOpenExternal(app);
  await setSettings(page, { mode: 'auto', providers: ['zoom'] });
  await page.evaluate(() => (window as StenoWindow).stenoai.settings.setPremeetingNotifications(false));

  // Provider filter: zoom only, Meet link.
  expect((await fire(page, makeEvent('filter1'))).action).toBeNull();

  // Accepted-only: a needsAction invite is skipped.
  await setSettings(page, { providers: [], accepted_only: true });
  expect((await fire(page, makeEvent('pending1', { response_status: 'needsAction' }))).action).toBeNull();
  await setSettings(page, { accepted_only: false });
  expect((await fire(page, makeEvent('pending2', { response_status: 'needsAction' }))).action).toBe('ask');
  await setSettings(page, { accepted_only: true });

  // Started 10 minutes ago: past the late window.
  const late = makeEvent('late1', { start: inMin(-10), end: inMin(20) });
  expect((await fire(page, late)).action).toBeNull();

  expect(await opened(app)).toEqual([]);
});

test('a second overlapping meeting asks instead of auto-opening', async ({ launchApp }) => {
  const { app, page } = await launchApp();
  await spyOpenExternal(app);
  await setSettings(page, { mode: 'auto' });
  const first = makeEvent('ovl1');
  expect((await fire(page, first)).action).toBe('auto');
  const second = makeEvent('ovl2', { start: inMin(2), end: inMin(32) });
  expect((await fire(page, second)).action).toBe('ask');
  expect(await opened(app)).toEqual([first.meeting_url]);
});

test('a shared calendar event never auto-opens', async ({ launchApp }) => {
  const { app, page } = await launchApp();
  await spyOpenExternal(app);
  await setSettings(page, { mode: 'auto' });
  expect((await fire(page, makeEvent('shared1', { own_calendar: false }))).action).toBe('ask');
  expect(await opened(app)).toEqual([]);
});

test('the meeting being recorded neither opens nor asks', async ({ launchApp, userDataDir }) => {
  enableDeterministicRecording(userDataDir);
  const { app, page } = await launchApp();
  await spyOpenExternal(app);
  const ev = makeEvent('rec1', { title: 'Weekly sync' });
  const started = await page.evaluate((n) => (window as StenoWindow).stenoai.recording.start(n), ev.title);
  expect(started.success).toBe(true);
  try {
    for (const mode of ['auto', 'ask']) {
      await setSettings(page, { mode });
      expect((await fire(page, ev)).action).toBeNull();
    }
    expect(await opened(app)).toEqual([]);
  } finally {
    await page.evaluate(() => (window as StenoWindow).stenoai.recording.stop());
  }
});
