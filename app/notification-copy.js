// Pure copy-builders for the completion notifications, extracted from main.js so
// they're unit-testable without Electron. The key invariant they guard is Bug C:
// the note's title must reach the notification body — a reprocess completion that
// carried only the 'Note' placeholder was showing the generic fallback and the
// title never appeared.

/**
 * Window options (minus the click wiring) for the note-ready / failure
 * notification. `outcome` feeds the analytics lifecycle tag.
 *
 * Three honest states:
 *  - hardFailure: processing crashed (or an import never enqueued) so no note was
 *    written — nothing to open; keep the copy neutral.
 *  - failed: a graceful transcription failure DID write a marked note.
 *  - otherwise: the note is genuinely ready — the body IS the note title.
 */
function buildNoteReadyNotificationOptions(payload) {
  const { title, failed, hardFailure } = payload || {};
  return {
    title: hardFailure ? 'Processing failed' : failed ? 'Transcription failed' : 'Note ready',
    body: hardFailure
      ? `Steno couldn't process ${title ? `"${title}"` : 'your note'}.`
      : failed
        ? 'Your recording was preserved — open the note for details.'
        : (title || 'Your note has finished processing'),
    iconType: (hardFailure || failed) ? 'alert' : 'success',
    outcome: hardFailure ? 'hard_failure' : failed ? 'failed' : 'success',
  };
}

/** Body text for the transcript-ready "Summarise?" prompt. */
function buildTranscriptReadyBody(title) {
  return title ? `Summarise "${title}"?` : 'Summarise?';
}

/**
 * Body text for the recording-failure notification.
 *
 * The renderer's capture failure carries a DOMException, and its `message` used
 * to go into the notification verbatim: a user with no microphone connected got
 * "Recording couldn't start: Requested device not found" — browser-engine text
 * in a desktop notification, which cannot be expanded or clicked, so the user
 * sees a truncated fragment naming a "device" they never asked about. Same
 * failure mode update-error-copy.js exists to stop for the updater, and the same
 * three rules apply: name what actually failed, say whether the user has to do
 * anything, and let no developer text through.
 *
 * Dispatch is on the DOMException NAME and the caller's PHASE only. The message
 * is deliberately NOT an input: searching it for words like "permission" named
 * wrong causes — an EACCES writing the recording FILE would have been reported
 * as a missing microphone permission — and no text search can tell those apart
 * reliably. A caller that knows nothing beyond "it failed" gets a vague but true
 * sentence instead of a confident wrong one.
 *
 * `reportCaptureError` serves three different situations and they need three
 * different sentences: a start that never got off the ground, a write failure
 * DURING a recording that is still running, and a stop that did not complete.
 * Telling a user mid-recording that "the recording didn't start" is exactly the
 * kind of lie this module exists to prevent.
 *
 * @param {Object} [o]
 * @param {string} [o.name]     DOMException name (NotFoundError, NotAllowedError, …)
 * @param {'start'|'ongoing'|'stop'} [o.phase] what the caller was doing
 * @param {string} [o.platform] defaults to the running platform; injectable so the
 *   platform-specific permission hint is testable on either OS
 * @returns {string} one or two sentences, free of errno/DOMException text
 */
function buildCaptureErrorBody({ name, phase = 'start', platform = process.platform } = {}) {
  if (phase === 'ongoing') {
    // The recording is STILL RUNNING; only the write failed. Saying anything
    // about starting would be false, and the cause is disk, not audio.
    return 'Steno hit a problem while saving this recording, so the note may be incomplete.';
  }
  if (phase === 'stop') {
    return "Steno couldn't finish the recording. Try stopping it again from the toolbar.";
  }

  const n = typeof name === 'string' ? name : '';

  // No usable input device. OverconstrainedError lands here too: it means the
  // pinned microphone's deviceId no longer matches anything, which the user
  // experiences as "my microphone is gone", not as a constraint problem.
  if (n === 'NotFoundError' || n === 'OverconstrainedError') {
    return "Steno couldn't find a microphone, so the recording didn't start. Connect one and try again.";
  }
  // Deliberately NOT SecurityError: that means the document may not use the
  // media API at all (an insecure context, a feature-policy block), so the
  // "grant access in Settings" remedy would send the user somewhere that cannot
  // help. It falls through to the generic sentence instead.
  if (n === 'NotAllowedError') {
    // CLAUDE.md's cross-platform rule applies to copy as much as to code: a
    // macOS-only instruction must not reach a Windows or Linux user. Linux has
    // no single settings path worth naming, so it gets the sentence alone.
    const hint =
      platform === 'darwin'
        ? ' Grant access in System Settings > Privacy & Security > Microphone.'
        : platform === 'win32'
          ? ' Grant access in Settings > Privacy & security > Microphone.'
          : '';
    return `Steno doesn't have permission to use the microphone, so the recording didn't start.${hint}`;
  }
  // The device exists but could not be opened — almost always another app
  // holding it exclusively.
  if (n === 'NotReadableError' || n === 'AbortError') {
    return "Steno couldn't open the microphone — another app may be using it. Close it and try again.";
  }
  return "Steno couldn't start the recording. Try again in a moment.";
}

module.exports = {
  buildNoteReadyNotificationOptions,
  buildTranscriptReadyBody,
  buildCaptureErrorBody,
};
