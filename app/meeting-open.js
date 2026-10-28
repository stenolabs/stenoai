const { calendarMeetingProvider } = require('./analytics-helpers');

const PREMEETING_LEAD_MS = 2 * 60 * 1000;
const LATE_WINDOW_MS = 5 * 60 * 1000;
const OVERLAP_MS = 60 * 1000;
const MAX_LEAD_MINUTES = 30;
const MODES = ['off', 'ask', 'auto'];
const PROVIDERS = ['meet', 'zoom', 'teams'];

// Mirrors Config.get_auto_open_meetings in src/config.py (unknown/duplicate
// providers are dropped, a non-list becomes []); keep the two in sync. A float like 5.0 is
// indistinguishable from 5 after JSON.parse, so that one case reads as valid here.
function normalizeAutoOpenSettings(raw) {
  const cfg = raw && typeof raw === 'object' ? raw : {};
  const lead = cfg.auto_open_lead_minutes;
  return {
    mode: MODES.includes(cfg.auto_open_meetings) ? cfg.auto_open_meetings : 'off',
    leadMinutes: Number.isInteger(lead) && lead >= 0 && lead <= MAX_LEAD_MINUTES ? lead : 1,
    providers: Array.isArray(cfg.auto_open_providers)
      ? [...new Set(cfg.auto_open_providers.filter((p) => PROVIDERS.includes(p)))]
      : [],
    acceptedOnly: cfg.auto_open_accepted_only !== false,
  };
}

function startMsOf(event) {
  if (!event || typeof event.start !== 'string' || !event.start.includes('T')) return NaN;
  if (event.is_all_day === true) return NaN;
  return new Date(event.start).getTime();
}

function isSafeMeetingUrl(url) {
  if (typeof url !== 'string' || !url) return false;
  try {
    const u = new URL(url);
    return (u.protocol === 'http:' || u.protocol === 'https:') && !u.username && !u.password;
  } catch (_) {
    return false;
  }
}

// Returns 'auto' | 'ask' | null. ctx: {alreadyOpened, micActive, recordingOther, overlapping, allowAuto}
function decideMeetingOpen(event, settings, ctx, nowMs) {
  if (!settings || settings.mode === 'off') return null;
  const startMs = startMsOf(event);
  if (!isFinite(startMs)) return null;
  if (!isSafeMeetingUrl(event.meeting_url)) return null;
  if (event.response_status === 'declined') return null;
  const accepted = event.response_status === 'accepted' || event.response_status === 'organizer';
  if (settings.acceptedOnly && !accepted) return null;
  const provider = calendarMeetingProvider(event.meeting_url);
  if (settings.providers.length > 0 && !settings.providers.includes(provider)) return null;
  if (nowMs - startMs > LATE_WINDOW_MS) return null;
  const c = ctx || {};
  if (c.alreadyOpened) return null;
  if (settings.mode === 'ask') return 'ask';
  // Invite links are attacker-controlled, so these never open without a click.
  if (!accepted || provider === 'other' || event.own_calendar !== true || c.micActive || c.recordingOther || c.overlapping || !c.allowAuto) return 'ask';
  return 'auto';
}

// lastOpen: { endMs, at } of the previous successful auto open, or null.
function isOverlapping(lastOpen, event, nowMs) {
  if (!lastOpen) return false;
  const startMs = startMsOf(event);
  return (isFinite(startMs) && lastOpen.endMs > startMs) || nowMs - lastOpen.at < OVERLAP_MS;
}

function isMicGuardAvailable({ platform, supported, enabled, monitorRunning }) {
  return platform === 'darwin' && supported === true && enabled === true && monitorRunning === true;
}

function openReservationEndMs(event, nowMs) {
  const startMs = startMsOf(event);
  const endMs = event && typeof event.end === 'string' ? new Date(event.end).getTime() : NaN;
  return Number.isFinite(endMs) && endMs > startMs ? endMs : nowMs;
}

function planPremeetingTimers(events, settings, { premeetingEnabled, firedIds, openedIds }, nowMs) {
  const plan = [];
  for (const event of events || []) {
    if (!event || (firedIds && firedIds.has(event.id))) continue;
    const startMs = startMsOf(event);
    if (!isFinite(startMs) || event.response_status === 'declined') continue;
    const openable = decideMeetingOpen(event, settings, { allowAuto: true, alreadyOpened: Boolean(openedIds && openedIds.has(event.id)) }, nowMs) !== null;
    if (!openable && !premeetingEnabled) continue;
    const lead = openable ? settings.leadMinutes * 60 * 1000 : PREMEETING_LEAD_MS;
    const delayMs = startMs - lead - nowMs;
    if (delayMs > 0) plan.push({ event, delayMs });
    else if (openable) plan.push({ event, delayMs: 0 });
  }
  return plan;
}

module.exports = {
  MAX_LEAD_MINUTES,
  isOverlapping,
  isMicGuardAvailable,
  openReservationEndMs,
  normalizeAutoOpenSettings,
  decideMeetingOpen,
  planPremeetingTimers,
};
