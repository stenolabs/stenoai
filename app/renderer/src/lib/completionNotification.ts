/**
 * Decide which notification a finished recording/processing job should fire
 * (#bug2/#bug3). Pure so it can be unit-tested without the IPC/route machinery
 * around it in useRecording.
 *
 * - `note-ready`: notes were generated (auto_summarize on, or the deferred
 *   Generate-notes/reprocess finished), OR a transcription failure that still
 *   wrote a note — either way there's a note to open.
 * - `transcript-ready`: transcript-only note (auto_summarize off → no notes
 *   generated) — prompt the user to generate notes rather than claim it's
 *   ready. This is the correctly-timed replacement for the old premature
 *   meeting-end "Summarise?" prompt.
 *
 * A failed transcription is deliberately routed to `note-ready` (with the
 * caller's `failed` flag), NOT `transcript-ready`: there's nothing to summarise
 * on a failed transcript, so we never offer "generate notes" there.
 *
 * `notesAlreadyExist` covers the continue-recording (append) case: the backend
 * always prints SUMMARY_SKIPPED for an append (deferring to on-demand
 * regenerate), so `notesGenerated` is false — but the note it appended to
 * already has notes (now stale). Prompting "generate notes?" for a note that
 * already has them is wrong, so a note that already has notes is `note-ready`.
 */
export type CompletionNotificationKind = 'note-ready' | 'transcript-ready';
export type CompletionNotificationChoice = CompletionNotificationKind | 'obsidian-fork' | null;

export function classifyCompletionNotification(input: {
  notesGenerated?: boolean;
  notesAlreadyExist?: boolean;
  transcriptionFailed?: boolean;
  meetingTranscriptionFailed?: boolean;
}): CompletionNotificationKind {
  const isFailed =
    Boolean(input.transcriptionFailed) || Boolean(input.meetingTranscriptionFailed);
  const hasNotes = Boolean(input.notesGenerated) || Boolean(input.notesAlreadyExist);
  return hasNotes || isFailed ? 'note-ready' : 'transcript-ready';
}

/**
 * Pick the renderer-owned completion notification. A note-ready fork is
 * reserved in main before this event arrives. Its explicit result remains true
 * after Electron has closed the toast, so the generic note-ready fallback must
 * stay suppressed. Unreserved forks are
 * transcript-only, where Summarise wins in the background and the
 * preservation notice remains visible when the user is actively watching.
 */
export function chooseCompletionNotification(input: {
  kind: CompletionNotificationKind;
  shouldNotify: boolean;
  obsidianForked: boolean;
  mainObsidianForkNotificationShown?: boolean;
}): CompletionNotificationChoice {
  if (input.mainObsidianForkNotificationShown) return null;
  if (input.shouldNotify && input.kind === 'transcript-ready') return 'transcript-ready';
  if (input.obsidianForked) return 'obsidian-fork';
  return input.shouldNotify ? input.kind : null;
}

/**
 * Whether the completed job's note ALREADY had notes (the M2 append case).
 *
 * Subtle: the backend only ever writes `notes_generated: false` (a transcript-
 * only note) or OMITS the key entirely (a note that has notes) — it is never
 * written `true`. So "has notes" is `notes_generated !== false`, NOT
 * `notes_generated === true` (which is always false and was the ineffective
 * first fix). Guard on meetingData presence: when the completion event carries
 * no meetingData (the rare list-lookup-failed fallback, and the reprocess/report
 * paths), return false so we fall back to the transient `notesGenerated` signal
 * rather than defaulting a transcript-only note to "has notes". `notes_stale`
 * is NOT a substitute — an append sets it unconditionally, including on
 * transcript-only notes.
 */
export function meetingAlreadyHasNotes(
  meetingData?: { session_info?: { notes_generated?: boolean } } | null,
): boolean {
  if (!meetingData) return false;
  return meetingData.session_info?.notes_generated !== false;
}

/**
 * On job completion, decide two INDEPENDENT things: whether to NAVIGATE off the
 * transient /processing screen, and whether to NOTIFY. They're independent
 * because a backgrounded user sitting on /processing must be BOTH moved to the
 * note (so they're never stranded on a stuck "Analyzing transcript" screen —
 * the regression this fixes) AND notified.
 *
 * - `navigate`: true whenever the user is on /processing. That screen is
 *   transient; leaving them there after completion strands them, so we always
 *   advance to the note regardless of focus. (A background navigate is harmless;
 *   when they return they're on the note, not a stuck spinner.) When they stay
 *   focused on /processing it also completes fine — this just makes the
 *   not-focused case behave the same.
 * - `notify`: true unless the user is actively LOOKING at the result right now —
 *   focused on this note, or focused on /processing watching it finish. Focus,
 *   not visibilityState: `visibilityState` stays 'visible' for a window shown
 *   behind the meeting app (wrongly suppressing); `hasFocus()` is false whenever
 *   Steno isn't the active window.
 */
export function completionActions(input: {
  currentRoute: string;
  finishedMeetingRoute: string;
  processingRoute: string;
  windowFocused: boolean;
}): { navigate: boolean; notify: boolean } {
  const { currentRoute, finishedMeetingRoute, processingRoute, windowFocused } = input;
  const onProcessing = currentRoute === processingRoute;
  const focusedOnThisNote = currentRoute === finishedMeetingRoute && windowFocused;
  const userIsWatching = focusedOnThisNote || (onProcessing && windowFocused);
  return { navigate: onProcessing, notify: !userIsWatching };
}
