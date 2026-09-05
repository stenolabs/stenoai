/**
 * Live-recording row helpers (#bug4), kept in a dependency-light module so the
 * dedup logic is unit-testable without pulling in the useMeetings hook graph.
 */

/** Sentinel summary_file path used by the synthetic in-progress recording row.
 *  Never matches a real meeting file. Consumers detect via `meeting.is_recording`. */
export const LIVE_SUMMARY_PREFIX = '__live__/';

/** The recording statuses that mean a session is genuinely under way, and so
 *  earn the synthetic live row. Everything else ('idle') does not.
 *
 *  This exists because a session NAME alone is not evidence of a session. main
 *  deliberately keeps `currentRecordingSessionName` after a failed capture
 *  start — see the comment on the `system-audio-recording-state` handler in
 *  main.js, which reasons that "a stale name while hasRecording is false is
 *  inert" so a brief capture flap can't drop the live label mid-recording. That
 *  is only true if every consumer checks the status too. useMeetings did not:
 *  it built the row from `sessionName` alone, so a start that failed in the
 *  renderer (no microphone connected, mic busy, permission revoked) left a
 *  permanently pulsing "Recording" row that survived a reload, and clicking it
 *  routed to /recording which bounced straight back home.
 *
 *  Shared with Recording.tsx's own session check so the two can't drift apart
 *  again. */
const LIVE_ROW_STATUSES: readonly string[] = ['recording', 'paused', 'processing'];

/** Does this recording status mean a session is actually running? */
export function isLiveRowStatus(status: string | null | undefined): boolean {
  return !!status && LIVE_ROW_STATUSES.includes(status);
}

/** Should the meetings list carry a synthetic in-progress row right now?
 *  Both halves are required: a name says WHICH session, a status says whether
 *  there is one.
 *
 *  Declared as a predicate on `sessionName` so the caller keeps the narrowing it
 *  had when this was an inline truthiness check — true here means the name is a
 *  string, and the row builder needs it as one. */
export function shouldShowLiveRow(
  sessionName: string | null | undefined,
  status: string | null | undefined,
): sessionName is string {
  return !!sessionName && isLiveRowStatus(status);
}

/** The synthetic "__live__/…" row is redundant once the session's real note
 *  file exists in the list — showing both is the duplicate-note bug. main
 *  surfaces the real note's key as `liveSummaryFile` (deterministic from the
 *  audio stem, stable across record→process); this returns true when that note
 *  is already present, so the caller drops the synthetic row. */
export function liveRowRedundant(
  base: ReadonlyArray<{ session_info: { summary_file: string } }>,
  liveSummaryFile: string | null | undefined,
): boolean {
  if (!liveSummaryFile) return false;
  return base.some((m) => m.session_info.summary_file === liveSummaryFile);
}
