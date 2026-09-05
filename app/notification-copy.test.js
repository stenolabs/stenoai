const { test } = require('node:test');
const assert = require('node:assert');

const {
  buildNoteReadyNotificationOptions,
  buildTranscriptReadyBody,
  buildCaptureErrorBody,
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

// --- capture-error copy -----------------------------------------------------
//
// Regression guard for the phantom-recording bug's user-facing half: a start
// that failed in the renderer put the DOMException message straight into a
// desktop notification, so a user with no microphone connected read
// "Recording couldn't start: Requested device not found" — engine text in a
// surface that cannot be expanded or clicked.

test('a missing microphone reads as a missing microphone, not as a device error', () => {
  const body = buildCaptureErrorBody({ name: 'NotFoundError' });
  assert.match(body, /couldn't find a microphone/);
  assert.doesNotMatch(body, /device not found/i);
});

test('a gone pinned microphone reads the same way', () => {
  assert.match(buildCaptureErrorBody({ name: 'OverconstrainedError' }), /couldn't find a microphone/);
});

test('a permission failure names the platform path, and only its own platform', () => {
  const mac = buildCaptureErrorBody({ name: 'NotAllowedError', platform: 'darwin' });
  assert.match(mac, /System Settings > Privacy & Security > Microphone/);

  const win = buildCaptureErrorBody({ name: 'NotAllowedError', platform: 'win32' });
  assert.match(win, /Settings > Privacy & security > Microphone/);
  assert.doesNotMatch(win, /System Settings/);

  // No settings path is named on Linux — there isn't one worth naming.
  const linux = buildCaptureErrorBody({ name: 'NotAllowedError', platform: 'linux' });
  assert.match(linux, /doesn't have permission to use the microphone/);
  assert.doesNotMatch(linux, /Settings/);
});

test('a security-context failure is not sold as a microphone permission', () => {
  // SecurityError means the document may not use the media API at all, so the
  // "grant access in Settings" remedy would point at the wrong place.
  const body = buildCaptureErrorBody({ name: 'SecurityError', platform: 'darwin' });
  assert.doesNotMatch(body, /permission to use the microphone|System Settings/);
  assert.strictEqual(body, "Steno couldn't start the recording. Try again in a moment.");
});

test('a busy microphone points at the other app rather than at a setting', () => {
  assert.match(buildCaptureErrorBody({ name: 'NotReadableError' }), /another app may be using it/);
});

test('an unknown start failure still says something, and nothing developer-shaped', () => {
  assert.strictEqual(
    buildCaptureErrorBody({ name: 'WeirdFutureError' }),
    "Steno couldn't start the recording. Try again in a moment.",
  );
});

// The three situations reportCaptureError serves need three sentences. Telling a
// user mid-recording that the recording "didn't start" is the same class of lie
// as quoting the engine at them.

test('a write failure DURING a recording does not claim the recording never started', () => {
  const body = buildCaptureErrorBody({ phase: 'ongoing' });
  assert.match(body, /may be incomplete/);
  assert.doesNotMatch(body, /didn't start|find a microphone|permission/);
});

test('a failed stop is described as a failed stop', () => {
  const body = buildCaptureErrorBody({ phase: 'stop' });
  assert.match(body, /couldn't finish the recording/);
  assert.doesNotMatch(body, /didn't start/);
});

test('the message is never an input, so no text can name a wrong cause', () => {
  // An EACCES writing the recording FILE used to match /permission/ and told the
  // user Steno lacked MICROPHONE access — wrong cause, and on macOS a pointer to
  // a settings pane that could not have helped. No caller-supplied text reaches
  // the copy at all now.
  const disk = "EACCES: permission denied, open '/Users/x/recordings/note.webm'";
  assert.strictEqual(
    buildCaptureErrorBody({ message: disk, platform: 'darwin' }),
    "Steno couldn't start the recording. Try again in a moment.",
  );
  assert.strictEqual(
    buildCaptureErrorBody({ message: disk, phase: 'ongoing' }),
    'Steno hit a problem while saving this recording, so the note may be incomplete.',
  );
});

test('no developer text survives any branch', () => {
  const cases = [
    { name: 'NotFoundError' },
    { name: 'NotAllowedError' },
    { name: 'NotReadableError' },
    { phase: 'ongoing' },
    { phase: 'stop' },
    { name: 'Error', message: 'ENOENT: no such file or directory, open /tmp/x' },
    {},
  ];
  for (const c of cases) {
    const body = buildCaptureErrorBody({ ...c, platform: 'linux' });
    assert.doesNotMatch(body, /Error:|ENOENT|EACCES|net::|\/tmp\/|asar/);
    assert.ok(body.length > 0);
  }
});
