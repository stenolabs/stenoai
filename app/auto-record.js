// Auto-record detected meetings (#463): with the setting on, a meeting the mic
// watcher detects starts recording at once instead of posting "Meeting
// detected" and waiting for a Take Notes tap. Off by default, because it
// records without asking; the toast it shows instead says that it did.
//
// Pure helpers, kept out of main.js so they are unit-testable without
// Electron. main.js owns the wiring: handleMicEvent decides, requestAutoRecord
// starts, and createAutoStarts below ties each toast to its own recording.

const fs = require('fs');

// How long an unattended start may stay pending before it is dropped. The
// renderer starts the recording within a second or two; a start that never
// reaches main (the renderer was mid-stop, say) must not hold back the next
// detection for longer than this.
const ANNOUNCE_WINDOW_MS = 30_000;

/**
 * Sync read of the setting from config.json; default OFF. Same pattern as
 * loadAutoDetectMeetingsEnabled in main.js: a JSON read on the detection path
 * instead of spawning Python for a boolean. Only a real `true` turns it on, so
 * a hand-edited "true" string or a missing or unreadable file reads as off.
 */
function loadAutoRecordMeetingsEnabled(configPath) {
  try {
    if (!fs.existsSync(configPath)) return false;
    const cfg = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
    return cfg.auto_record_meetings_enabled === true;
  } catch (_) {
    return false;
  }
}

/**
 * The toast shown once an unattended recording is running: passive, naming the
 * meeting (its calendar title when one matched, else the app), with Stop.
 * Tagged like "Meeting detected" so it replaces a detection toast still waiting
 * in the queue rather than following it.
 */
function buildAutoRecordStartedOptions({ appName, calendarTitle } = {}) {
  return {
    title: 'Recording started',
    body: calendarTitle || appName || 'A meeting',
    actions: [{ type: 'button', text: 'Stop' }],
    iconType: 'recording',
    tag: 'meeting-detected',
  };
}

/**
 * Tracks unattended starts so each "Recording started" toast belongs to exactly
 * one recording (#579 review):
 *
 *   begin(details)        an auto-start is requested; returns its id, or null
 *                         while another is still pending (a second detection
 *                         before capture starts must not replace the first)
 *   recordingStarted(t)   main accepted a start; the trigger says whose. Only
 *                         'auto_record' binds the pending start to this
 *                         recording; any other start drops it, so a recording
 *                         the user started never inherits the meeting's toast
 *   startFailed()         the renderer reported a failed start: drop it
 *   captureConfirmed()    capture is running; returns the bound start's
 *                         details and id once, else null
 *   isCurrent(id)         is that start's recording still the one running?
 *                         The toast's Stop acts only then
 *   recordingStopped()    the recording ended
 *
 * A pending start that never reaches main expires after the window, so it
 * cannot block later detections for long.
 */
function createAutoStarts({ now = Date.now, windowMs = ANNOUNCE_WINDOW_MS } = {}) {
  let nextId = 1;
  let pending = null; // { id, details, at }
  let bound = null; // { id, details, announced }
  const isPending = () => Boolean(pending) && now() - pending.at <= windowMs;
  return {
    isPending,
    begin(details) {
      if (isPending()) return null;
      pending = { id: nextId++, details, at: now() };
      return pending.id;
    },
    recordingStarted(trigger) {
      bound = trigger === 'auto_record' && isPending()
        ? { id: pending.id, details: pending.details, announced: false }
        : null;
      pending = null;
    },
    startFailed() {
      pending = null;
      bound = null;
    },
    captureConfirmed() {
      if (!bound || bound.announced) return null;
      bound.announced = true;
      return { id: bound.id, ...bound.details };
    },
    isCurrent(id) {
      return Boolean(bound) && bound.id === id;
    },
    recordingStopped() {
      bound = null;
    },
  };
}

module.exports = {
  ANNOUNCE_WINDOW_MS,
  loadAutoRecordMeetingsEnabled,
  buildAutoRecordStartedOptions,
  createAutoStarts,
};
