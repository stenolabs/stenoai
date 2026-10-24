// Which phone or FaceTime call a recording captured, chosen from the Mac's call
// history as iMCP's `phone_calls_fetch` returns it. Pure, so it is unit-testable
// without Electron or iMCP.
//
// How that history behaves, measured on macOS 26 with four Continuity calls
// (answered on the Mac; answered on the iPhone and moved to the Mac; placed on
// the iPhone and moved to the Mac, twice):
//  - A call the Mac rang for has a record from the moment it is answered, on
//    either device, with a duration of 0 until it ends.
//  - A call placed on the iPhone and moved to the Mac has no record until it
//    ends. Then it gets one, with the call's true start from the iPhone.
//  - Every record existed within a second of hanging up.
//  - A record's start is reliable. Its final duration is not: it came out at
//    about double the real length on every ended call. So the duration is used
//    to tell an ended call from a running one, and as a bound read both ways.
//  - A call answered on the iPhone that never came to the Mac keeps 0 for good.
//
// Back-to-back calls: read at face value, a doubled duration lets the call
// before reach into the next one. In historical call data, a call followed
// closely by the next overlapped it at its stored duration, but not at half of
// it. Read as doubled, then, a call that ended before this call's audio began
// is not this call.

// The record's start is the moment the call connected; the call's audio reaches
// the Mac at the same moment or later. Seconds, since iMCP drops fractions.
const START_TOLERANCE_MS = 5000;
// An ended call must have lasted until its audio left the Mac, and, with its
// duration read as doubled, must not have ended before its audio arrived.
// Measured, the duration only ever errs long, so neither check rejects the
// right call; together they reject an earlier call that ended before this one
// began. Were the doubling to go away, the second would cost the caller only of
// a call moved to the Mac after more than half its length, never name the
// wrong one.
const END_TOLERANCE_MS = 10000;

const SERVICES = {
  'com.apple.Telephony': 'phone',
  'com.apple.FaceTime': 'facetime',
};

/** One entry of `phone_calls_fetch`'s `itemListElement`, normalised; null if unusable. */
function normaliseCall(entry) {
  if (!entry || typeof entry !== 'object') return null;
  const startedAt = new Date(entry.date);
  if (Number.isNaN(startedAt.getTime())) return null;
  const duration = Number(entry.durationSeconds);
  const number = typeof entry.phoneNumber === 'string' && entry.phoneNumber !== 'Unknown'
    ? entry.phoneNumber : null;
  return {
    id: entry['@id'] ?? null,
    number,
    direction: entry.callType === 'outgoing' ? 'outgoing' : 'incoming',
    missed: entry.callType === 'missed',
    service: SERVICES[entry.serviceProvider] || entry.serviceProvider || null,
    startedAt,
    durationSeconds: Number.isFinite(duration) && duration > 0 ? duration : 0,
    name: typeof entry.name === 'string' && entry.name ? entry.name : null,
  };
}

/**
 * The call behind one call-audio session on this Mac, or null.
 *
 * `audio.startedAt` and `audio.endedAt` come from the mic monitor: when the call's
 * audio (com.apple.avconferenced) started and stopped on this Mac. `endedAt` is
 * null while the call is still running.
 *
 * Accepted:
 *  - a call answered on this Mac, ended or not: started within seconds of the
 *    audio, still at duration 0 while it runs;
 *  - once the audio has ended, any call that started before the audio did and
 *    lasted until the audio ended, but had not ended, by half its stored
 *    duration, before the audio began.
 * Of those, the one that started last. Missed calls never match.
 */
function matchCall(entries, audio) {
  const audioStart = audio?.startedAt instanceof Date ? audio.startedAt.getTime() : NaN;
  if (Number.isNaN(audioStart)) return null;
  const audioEnd = audio.endedAt instanceof Date ? audio.endedAt.getTime() : null;

  let best = null;
  for (const call of (Array.isArray(entries) ? entries : []).map(normaliseCall)) {
    if (!call || call.missed) continue;
    const start = call.startedAt.getTime();
    if (start > audioStart + START_TOLERANCE_MS) continue;

    const answeredHere = call.durationSeconds === 0
      && Math.abs(start - audioStart) <= START_TOLERANCE_MS;
    const endedWithAudio = audioEnd !== null
      && call.durationSeconds > 0
      && start + call.durationSeconds * 1000 >= audioEnd - END_TOLERANCE_MS
      && start + call.durationSeconds * 500 >= audioStart - END_TOLERANCE_MS;
    if (!answeredHere && !endedWithAudio) continue;

    if (!best || start > best.startedAt.getTime()) best = call;
  }
  return best;
}

module.exports = { matchCall, normaliseCall, START_TOLERANCE_MS, END_TOLERANCE_MS };
