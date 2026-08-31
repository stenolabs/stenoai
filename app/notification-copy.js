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
 * Keep an actionable preservation notice when a late ordinary note-ready
 * request refers to that same note. The fork request may still be waiting on
 * its asynchronous settings gate, or its toast may already be active. Different
 * notes retain normal single-toast semantics and may supersede one another.
 */
function shouldSuppressNoteReadyNotification(activeOptions, summaryFile, forkPending = false) {
  return typeof summaryFile === 'string' && summaryFile.length > 0 &&
    (forkPending || (
      activeOptions?.completionKind === 'obsidian-fork' &&
      activeOptions.summaryFile === summaryFile
    ));
}

/**
 * The main process reserves an Obsidian preservation toast before emitting the
 * completion event. A transcript-only result deliberately leaves that event to
 * the renderer so its actionable "Summarise" prompt keeps priority.
 */
function shouldReserveObsidianForkNotification(forked, summarizationCompleted) {
  return Boolean(forked) && Boolean(summarizationCompleted);
}

module.exports = {
  buildNoteReadyNotificationOptions,
  buildTranscriptReadyBody,
  shouldSuppressNoteReadyNotification,
  shouldReserveObsidianForkNotification,
};
