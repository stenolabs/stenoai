const { test } = require('node:test');
const assert = require('node:assert');

const {
  buildNoteReadyNotificationOptions,
  buildTranscriptReadyBody,
  shouldSuppressNoteReadyNotification,
  shouldReserveObsidianForkNotification,
} = require('./notification-copy');

// Bug C regression guard: the note's real title must reach the notification body.
// The bug was a reprocess completion that carried only the 'Note' placeholder (or
// nothing), so note-ready showed the generic fallback and the title never showed.

test('note-ready body IS the note title when a title is provided', () => {
  const opts = buildNoteReadyNotificationOptions({ title: 'Q3 Planning sync' });
  assert.strictEqual(opts.title, 'Note ready');
  assert.strictEqual(opts.body, 'Q3 Planning sync');
  assert.strictEqual(opts.iconType, 'success');
  assert.strictEqual(opts.outcome, 'success');
});

test('note-ready falls back to a generic body only when there is no title', () => {
  const opts = buildNoteReadyNotificationOptions({});
  assert.strictEqual(opts.body, 'Your note has finished processing');
});

test('note-ready renders the transcription-failure state', () => {
  const opts = buildNoteReadyNotificationOptions({ title: 'Standup', failed: true });
  assert.strictEqual(opts.title, 'Transcription failed');
  assert.strictEqual(opts.iconType, 'alert');
  assert.strictEqual(opts.outcome, 'failed');
});

test('note-ready renders the hard-failure state and quotes the title when present', () => {
  const withTitle = buildNoteReadyNotificationOptions({ title: 'Retro', hardFailure: true });
  assert.strictEqual(withTitle.title, 'Processing failed');
  assert.ok(withTitle.body.includes('"Retro"'));
  assert.strictEqual(withTitle.outcome, 'hard_failure');

  const noTitle = buildNoteReadyNotificationOptions({ hardFailure: true });
  assert.ok(noTitle.body.includes('your note'));
});

test('transcript-ready prompt quotes the note title', () => {
  assert.strictEqual(buildTranscriptReadyBody('Weekly 1:1'), 'Summarise "Weekly 1:1"?');
  assert.strictEqual(buildTranscriptReadyBody(''), 'Summarise?');
  assert.strictEqual(buildTranscriptReadyBody(undefined), 'Summarise?');
});

test('note-ready cannot replace an Obsidian fork notice for the same note', () => {
  const activeOptions = {
    completionKind: 'obsidian-fork',
    summaryFile: '/tmp/output/meeting_summary.md',
  };

  assert.strictEqual(
    shouldSuppressNoteReadyNotification(activeOptions, '/tmp/output/meeting_summary.md'),
    true,
  );
  assert.strictEqual(
    shouldSuppressNoteReadyNotification(undefined, '/tmp/output/meeting_summary.md', true),
    true,
  );
  assert.strictEqual(
    shouldSuppressNoteReadyNotification(
      { completionKind: 'note-ready', summaryFile: '/tmp/output/meeting_summary.md' },
      '/tmp/output/meeting_summary.md',
      true,
    ),
    true,
    'a main-side fork reservation wins even before its toast is active',
  );
  assert.strictEqual(
    shouldSuppressNoteReadyNotification(activeOptions, '/tmp/output/other_summary.md'),
    false,
  );
  assert.strictEqual(
    shouldSuppressNoteReadyNotification(
      { completionKind: 'note-ready', summaryFile: '/tmp/output/meeting_summary.md' },
      '/tmp/output/meeting_summary.md',
    ),
    false,
  );
});

test('a fork reserves its toast before the generic completion request, while transcript-only keeps Summarise', () => {
  const summaryFile = '/tmp/output/meeting_summary.md';
  const forkPending = shouldReserveObsidianForkNotification(true, true);

  assert.strictEqual(forkPending, true);
  assert.strictEqual(
    shouldSuppressNoteReadyNotification(
      { completionKind: 'note-ready', summaryFile },
      summaryFile,
      forkPending,
    ),
    true,
    'the renderer cannot supersede a main-reserved preservation toast',
  );
  assert.strictEqual(
    shouldReserveObsidianForkNotification(true, false),
    false,
    'a transcript-only completion retains the renderer-owned Summarise toast',
  );
  assert.strictEqual(shouldReserveObsidianForkNotification(false, true), false);
});
