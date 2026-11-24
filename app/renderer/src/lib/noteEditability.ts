/**
 * The ONE place that decides whether the open note may be edited right now.
 *
 * A note must not be edited while another writer owns it: a summary/report
 * stream or a rebuild (reprocess / re-transcribe) for this note, the
 * post-Stop pipeline (`processing` placeholder, or `refining` after an
 * instant transcript), or a recording that is still appending to this note.
 * Each of those rewrites the file, so an edit made meanwhile would either be
 * overwritten or overwrite the fresher text.
 *
 * Kept as a pure function of explicit inputs so a change to the processing
 * flow means adding a field here, not hunting for scattered conditions.
 * Main enforces the same rule on its side (update-meeting / update-report
 * refuse while isSummaryBusy), so this is the friendly half, not the only one.
 */

export type NoteEditLock =
  /** Streaming or rebuilding: the view shows the stream, not the note. */
  | 'streaming'
  /** The instant-stop placeholder: the pipeline will replace it. */
  | 'processing'
  /** Instant transcript: readable now, the refined note is still coming. */
  | 'refining'
  /** A recording is still appending to this note. */
  | 'recording';

export interface NoteEditInputs {
  streaming: boolean;
  rebuildPending: boolean;
  processing: boolean;
  refining: boolean;
  recordingThisNote: boolean;
}

export function noteEditLock(inputs: NoteEditInputs): NoteEditLock | null {
  if (inputs.streaming || inputs.rebuildPending) return 'streaming';
  if (inputs.processing) return 'processing';
  if (inputs.refining) return 'refining';
  if (inputs.recordingThisNote) return 'recording';
  return null;
}

/** Only the markdown Standard note has a section grammar main can patch. */
export const isEditableNoteFile = (summaryFile: string) => summaryFile.endsWith('_summary.md');
