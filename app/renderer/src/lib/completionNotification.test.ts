import { describe, it, expect } from 'vitest';
import {
  classifyCompletionNotification,
  chooseCompletionNotification,
  meetingAlreadyHasNotes,
  completionActions,
} from './completionNotification';

const NOTE = '/meetings/abc_summary.md';
const PROCESSING = '/meetings/processing';
const actions = (currentRoute: string, windowFocused: boolean) =>
  completionActions({
    currentRoute,
    finishedMeetingRoute: NOTE,
    processingRoute: PROCESSING,
    windowFocused,
  });

describe('completionActions (navigate + notify guard)', () => {
  it('on /processing, NOT focused → navigate AND notify (never stranded, and told)', () => {
    // The regression: previously this returned only "notify", so /processing was
    // never advanced and got stuck on "Analyzing transcript". Now it always
    // navigates off /processing, and notifies because the user isn't watching.
    expect(actions(PROCESSING, false)).toEqual({ navigate: true, notify: true });
  });

  it('on /processing, focused → navigate, no notify (watching it finish)', () => {
    expect(actions(PROCESSING, true)).toEqual({ navigate: true, notify: false });
  });

  it('on the note route, NOT focused → notify, no navigate (auto-stop behind the meeting)', () => {
    expect(actions(NOTE, false)).toEqual({ navigate: false, notify: true });
  });

  it('on the note route, focused → suppress both (user is looking at it)', () => {
    expect(actions(NOTE, true)).toEqual({ navigate: false, notify: false });
  });

  it('on any other route → notify only, never navigate', () => {
    expect(actions('/', true)).toEqual({ navigate: false, notify: true });
    expect(actions('/chat', false)).toEqual({ navigate: false, notify: true });
    expect(actions('/meetings/other_summary.md', true)).toEqual({ navigate: false, notify: true });
  });
});

describe('classifyCompletionNotification (#bug2/#bug3)', () => {
  it('notes generated → note-ready (auto_summarize on / reprocess done)', () => {
    expect(classifyCompletionNotification({ notesGenerated: true })).toBe('note-ready');
  });

  it('no notes generated → transcript-ready (auto_summarize off, transcript-only)', () => {
    expect(classifyCompletionNotification({ notesGenerated: false })).toBe('transcript-ready');
  });

  it('notesGenerated absent → transcript-ready (defaults to no notes)', () => {
    expect(classifyCompletionNotification({})).toBe('transcript-ready');
  });

  it('transcription failure → note-ready even with no notes (never offers "generate notes")', () => {
    expect(
      classifyCompletionNotification({ notesGenerated: false, transcriptionFailed: true }),
    ).toBe('note-ready');
  });

  it('failure marked on the meeting → note-ready', () => {
    expect(
      classifyCompletionNotification({
        notesGenerated: false,
        meetingTranscriptionFailed: true,
      }),
    ).toBe('note-ready');
  });

  it('notes generated AND failed → note-ready', () => {
    expect(
      classifyCompletionNotification({ notesGenerated: true, transcriptionFailed: true }),
    ).toBe('note-ready');
  });

  it('append/continue: no new notes but the note already has them → note-ready (M2)', () => {
    expect(
      classifyCompletionNotification({ notesGenerated: false, notesAlreadyExist: true }),
    ).toBe('note-ready');
  });

  it('append into a still-transcript-only note (no notes either way) → transcript-ready', () => {
    expect(
      classifyCompletionNotification({ notesGenerated: false, notesAlreadyExist: false }),
    ).toBe('transcript-ready');
  });
});

describe('chooseCompletionNotification', () => {
  it('keeps the ordinary note-ready notification', () => {
    expect(
      chooseCompletionNotification({
        kind: 'note-ready',
        shouldNotify: true,
        obsidianForked: false,
      }),
    ).toBe('note-ready');
  });

  it('suppresses note-ready after main showed the fork toast, even once that toast has closed', () => {
    expect(
      chooseCompletionNotification({
        kind: 'note-ready',
        shouldNotify: true,
        // Main removes the fork payload after it successfully showed its toast.
        // This durable result must still win after Electron has closed the toast.
        obsidianForked: false,
        mainObsidianForkNotificationShown: true,
      }),
    ).toBeNull();
  });

  it('keeps the ordinary transcript-ready notification', () => {
    expect(
      chooseCompletionNotification({
        kind: 'transcript-ready',
        shouldNotify: true,
        obsidianForked: false,
      }),
    ).toBe('transcript-ready');
  });

  it('keeps an unreserved note-ready fork visible', () => {
    expect(
      chooseCompletionNotification({
        kind: 'note-ready',
        shouldNotify: true,
        obsidianForked: true,
      }),
    ).toBe('obsidian-fork');
  });

  it('shows nothing when the user is watching', () => {
    expect(
      chooseCompletionNotification({
        kind: 'note-ready',
        shouldNotify: false,
        obsidianForked: false,
      }),
    ).toBeNull();
  });

  it('keeps a transcript-only fork visible when the user is watching', () => {
    expect(
      chooseCompletionNotification({
        kind: 'transcript-ready',
        shouldNotify: false,
        obsidianForked: true,
      }),
    ).toBe('obsidian-fork');
  });

  it('keeps Summarise for a transcript-only fork when the user can act on it', () => {
    expect(
      chooseCompletionNotification({
        kind: 'transcript-ready',
        shouldNotify: true,
        obsidianForked: true,
      }),
    ).toBe('transcript-ready');
  });
});

describe('meetingAlreadyHasNotes (#M2 — real notes_generated semantics)', () => {
  // The backend NEVER writes notes_generated:true — it writes false for a
  // transcript-only note or omits the key when the note has notes. These cases
  // exercise the real values the call site actually receives (the prior fix's
  // `Boolean(notes_generated)` was always false because true never occurs).
  it('note WITH notes: notes_generated absent → true', () => {
    expect(meetingAlreadyHasNotes({ session_info: {} })).toBe(true);
  });

  it('transcript-only note: notes_generated explicitly false → false', () => {
    expect(meetingAlreadyHasNotes({ session_info: { notes_generated: false } })).toBe(false);
  });

  it('no meetingData on the event → false (fall back to the transient signal)', () => {
    expect(meetingAlreadyHasNotes(undefined)).toBe(false);
    expect(meetingAlreadyHasNotes(null)).toBe(false);
  });

  it('append into a note with notes classifies as note-ready end-to-end', () => {
    // SUMMARY_SKIPPED (notesGenerated false) + a note that already has notes.
    const notesAlreadyExist = meetingAlreadyHasNotes({ session_info: {} });
    expect(classifyCompletionNotification({ notesGenerated: false, notesAlreadyExist })).toBe(
      'note-ready',
    );
  });

  it('fresh transcript-only note classifies as transcript-ready end-to-end', () => {
    const notesAlreadyExist = meetingAlreadyHasNotes({
      session_info: { notes_generated: false },
    });
    expect(classifyCompletionNotification({ notesGenerated: false, notesAlreadyExist })).toBe(
      'transcript-ready',
    );
  });
});
