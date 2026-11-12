// Caller recognition for phone and FaceTime recordings (macOS, opt-in).
//
// Ties together three things main.js already has: the mic monitor's events,
// which show when a call's audio is on this Mac (com.apple.avconferenced, or
// FaceTime itself); Steno's recordings; and iMCP (imcp-client.js), which serves
// the Mac's call history and Contacts. When a recording that overlapped a call
// has stopped, and the call's audio has ended, it finds the call in the history
// (call-matching.js), looks the number up in Contacts, and hands the result to
// the backend's `apply-call-info`, which stores it beside the note and adds the
// caller to Participants. Nothing about voices. iMCP and the lookups stay on
// this Mac. The caller's name goes into the note and its prompts, and so to a
// cloud provider if the user has chosen one; the number stays beside the note
// (src/call_info.py).
//
// Timing, measured on macOS 26: the call record exists within a second of the
// call ending, so a lookup after the end first waits two seconds, then is
// retried briefly: at once, a call placed on the iPhone may not be there yet,
// and back to back the call before it would be. A call answered on this Mac
// also has a record while it runs, so a recording stopped mid-call is tried
// once at once; any other call has to end first.
//
// A continued note gets the calls of each recording that went into it: the
// backend adds them to those it has stored, one write per note at a time.
//
// Delivery never races the note's own processing: while a job for the note is
// queued or running, the call is only stored (the backend reads it before it
// saves); when the job finishes, it is applied to the note. Applying twice is
// harmless.

const { matchCall } = require('./call-matching');

const CALL_AUDIO_APPS = [/^com\.apple\.avconferenced/, /^com\.apple\.FaceTime/];
const LOOKUP_ATTEMPTS = 15;
const LOOKUP_INTERVAL_MS = 1000;
const RECORD_DELAY_MS = 2000;
const RECENT_CALLS = 10;
const KEEP_MS = 24 * 60 * 60 * 1000;

function isCallAudio(evt) {
  return typeof evt?.app_id === 'string' && CALL_AUDIO_APPS.some((re) => re.test(evt.app_id));
}

class CallerId {
  constructor({
    imcp,
    applyCallInfo,
    isProcessing = () => false,
    log = () => {},
    now = () => Date.now(),
    sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    lookupAttempts = LOOKUP_ATTEMPTS,
    lookupIntervalMs = LOOKUP_INTERVAL_MS,
    recordDelayMs = RECORD_DELAY_MS,
  }) {
    Object.assign(this, { imcp, applyCallInfo, isProcessing, log, now, sleep,
      lookupAttempts, lookupIntervalMs, recordDelayMs });
    this.enabled = false;
    this._generation = 0;
    this._sessions = [];    // call audio on this Mac: { key, startedAt, endedAt }
    this._recordings = [];  // { stem, startedAt, stoppedAt, calls, tried, finalApply }
    this._inflight = new Set();
    this._writes = new Map(); // stem -> the last apply-call-info queued for it
  }

  /** Resolves once no lookup is running (for tests and orderly shutdown). */
  async idle() {
    while (this._inflight.size) await Promise.allSettled([...this._inflight]);
  }

  _run(promise) {
    this._inflight.add(promise);
    promise.finally(() => this._inflight.delete(promise));
  }

  setEnabled(enabled) {
    const next = Boolean(enabled);
    if (next !== this.enabled) this._generation += 1;
    this.enabled = next;
    if (this.enabled) this.imcp.start();
    else {
      this.imcp.stop();
      for (const rec of this._recordings) {
        rec.finalApply = null;
        rec.calls.clear();
      }
    }
  }

  _isCurrent(generation) {
    return this.enabled && generation === this._generation;
  }

  /** Feed every mic-monitor event; only call audio is kept. */
  micEvent(evt) {
    if (!isCallAudio(evt)) return;
    const at = Number.isFinite(evt.ts) ? Math.round(evt.ts * 1000) : this.now();
    const key = `${evt.app_id}:${evt.pid ?? ''}`;
    const open = this._sessions.find((s) => s.key === key && s.endedAt === null);
    if (evt.event === 'start' && !open) {
      this._sessions.push({ key, startedAt: at, endedAt: null });
    } else if (evt.event === 'stop' && open) {
      open.endedAt = at;
      for (const rec of this._recordings) {
        if (rec.stoppedAt !== null && this._overlaps(rec, open)) this._run(this._lookup(rec, open));
      }
    }
    this._prune();
  }

  /** A recording began; `stem` names the note it lands in. */
  recordingStarted(stem, at = this.now()) {
    if (!stem) return;
    this._recordings.push({ stem, startedAt: at, stoppedAt: null, calls: new Map(),
      tried: new Set(), finalApply: null });
  }

  /** The current recording stopped. Safe to call more than once. */
  recordingStopped(at = this.now()) {
    const rec = [...this._recordings].reverse().find((r) => r.stoppedAt === null);
    if (!rec) return;
    rec.stoppedAt = at;
    for (const session of this._sessions) {
      if (!this._overlaps(rec, session)) continue;
      // An ended call can be looked up now. A running one only if it was
      // answered here: try once, and otherwise wait for its audio to end.
      this._run(this._lookup(rec, session, { once: session.endedAt === null }));
    }
  }

  /** A processing job finished; `stems` are the notes it wrote. */
  processingFinished(stems) {
    for (const rec of this._recordings) {
      if (rec.finalApply !== null && this._isCurrent(rec.finalApply) && stems.includes(rec.stem)) {
        const generation = rec.finalApply;
        rec.finalApply = null;
        this._run(this._apply(rec, false, generation));
      }
    }
  }

  _overlaps(rec, session) {
    const recEnd = rec.stoppedAt ?? Infinity;
    const callEnd = session.endedAt ?? Infinity;
    return session.startedAt < recEnd && callEnd > rec.startedAt;
  }

  async _lookup(rec, session, { once = false } = {}) {
    const generation = this._generation;
    if (!this._isCurrent(generation)) return;
    const attempt = `${generation}:${session.key}@${session.startedAt}:${session.endedAt ?? 'running'}`;
    if (rec.tried.has(attempt)) return;
    rec.tried.add(attempt);

    const audio = { startedAt: new Date(session.startedAt),
      endedAt: session.endedAt === null ? null : new Date(session.endedAt) };
    const attempts = once ? 1 : this.lookupAttempts;
    for (let i = 0; i < attempts; i += 1) {
      if (i > 0) await this.sleep(this.lookupIntervalMs);
      else if (audio.endedAt) await this.sleep(this.recordDelayMs);
      if (!this._isCurrent(generation)) return;
      if (this.imcp.status.state !== 'ready') continue;
      try {
        const call = matchCall(await this.imcp.recentCalls(RECENT_CALLS), audio);
        if (call) {
          await this._found(rec, call, generation);
          return;
        }
      } catch (error) {
        this.log(`[caller-id] lookup failed: ${error?.message || error}`);
      }
    }
    this.log(`[caller-id] no call found for a recording (${once ? 'call still running' : 'after the call'})`);
  }

  async _found(rec, call, generation) {
    if (!this._isCurrent(generation)) return;
    const key = call.id ?? call.startedAt.toISOString();
    if (rec.calls.has(key)) return;
    let name = call.name;
    if (!name && call.number) {
      name = await this.imcp.contactName(call.number).catch((error) => {
        this.log(`[caller-id] Contacts lookup failed: ${error?.message || error}`);
        return null;
      });
    }
    // Turning the feature off cancels this lookup, even if it is enabled
    // again before the Contacts request resolves.
    if (!this._isCurrent(generation)) return;
    rec.calls.set(key, { name: name || null, number: call.number, direction: call.direction,
      service: call.service, started_at: call.startedAt.toISOString() });
    this.log(`[caller-id] call found for a recording (${name ? 'named' : 'number only'})`);
    const busy = this.isProcessing(rec.stem);
    if (busy) rec.finalApply = generation;
    await this._apply(rec, busy, generation);
  }

  // One write per note at a time: the backend adds these calls to those it has
  // stored, and two writes at once could each miss the other's.
  _apply(rec, sidecarOnly, generation) {
    const write = (this._writes.get(rec.stem) || Promise.resolve())
      .then(() => {
        if (this._isCurrent(generation)) {
          return this.applyCallInfo(rec.stem, [...rec.calls.values()], { sidecarOnly });
        }
      })
      .catch((error) => this.log(`[caller-id] apply-call-info failed: ${error?.message || error}`));
    this._writes.set(rec.stem, write);
    write.then(() => { if (this._writes.get(rec.stem) === write) this._writes.delete(rec.stem); });
    return write;
  }

  _prune() {
    const cutoff = this.now() - KEEP_MS;
    // An open session this old lost its stop event (the mic monitor restarted
    // mid-call, say); left open it would overlap every later recording.
    this._sessions = this._sessions.filter((s) => (s.endedAt ?? s.startedAt) > cutoff);
    this._recordings = this._recordings.filter(
      (r) => r.stoppedAt === null || r.stoppedAt > cutoff || r.finalApply);
  }
}

module.exports = { CallerId, isCallAudio };
