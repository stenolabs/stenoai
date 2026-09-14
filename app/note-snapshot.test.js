const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const {
  noteSnapshotPath,
  readSnapshot,
  captureSnapshot,
  markEdited,
  editedFieldNames,
} = require('./note-snapshot');

function tmpNote() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'note-snapshot-'));
  const file = path.join(dir, 'Weekly_Sync_summary.md');
  fs.writeFileSync(file, '---\ntitle: "Weekly Sync"\n---\n\n## Summary\n\nhi\n', 'utf8');
  return file;
}

const FIELDS = {
  summary: 'We agreed the budget.',
  key_points: ['Budget approved'],
  action_items: ['Anna sends the draft'],
  discussion_areas: [{ title: 'Budget', analysis: 'Reviewed.' }],
  participants: ['Anna'],
};

test('noteSnapshotPath swaps the _summary.md suffix for _original.json', () => {
  assert.strictEqual(
    path.basename(noteSnapshotPath('/x/Weekly_Sync_summary.md')),
    'Weekly_Sync_original.json',
  );
});

test('noteSnapshotPath throws for a path that does not end in _summary.md', () => {
  assert.throws(() => noteSnapshotPath('/x/Weekly_Sync.md'), /_summary\.md/);
});

test('readSnapshot returns null when no sidecar exists', () => {
  assert.strictEqual(readSnapshot(tmpNote()), null);
});

test('captureSnapshot writes the original fields and is readable back', () => {
  const note = tmpNote();
  captureSnapshot(note, FIELDS, 'generation');
  const back = readSnapshot(note);
  assert.strictEqual(back.version, 1);
  assert.strictEqual(back.capture, 'generation');
  assert.deepStrictEqual(back.original, FIELDS);
  assert.deepStrictEqual(back.edited_fields, []);
});

test('captureSnapshot never overwrites an existing snapshot', () => {
  const note = tmpNote();
  captureSnapshot(note, FIELDS, 'generation');
  captureSnapshot(note, { ...FIELDS, summary: 'DIFFERENT' }, 'first_edit');
  assert.strictEqual(readSnapshot(note).original.summary, 'We agreed the budget.');
  assert.strictEqual(readSnapshot(note).capture, 'generation');
});

test('captureSnapshot does not clobber a sidecar written by a newer version', () => {
  const note = tmpNote();
  const file = noteSnapshotPath(note);
  const future = JSON.stringify({ version: 999, future: true }, null, 2);
  fs.writeFileSync(file, future, 'utf8');
  const result = captureSnapshot(note, FIELDS, 'generation');
  assert.strictEqual(result, null);
  assert.strictEqual(fs.readFileSync(file, 'utf8'), future);
});

test('markEdited accumulates field names without duplicates and stamps a time', () => {
  const note = tmpNote();
  captureSnapshot(note, FIELDS, 'generation');
  markEdited(note, ['summary']);
  const back = markEdited(note, ['summary', 'action_items']);
  assert.deepStrictEqual(back.edited_fields.sort(), ['action_items', 'summary']);
  assert.ok(back.edited_at);
});

test('a corrupt sidecar reads as null rather than throwing', () => {
  const note = tmpNote();
  fs.writeFileSync(noteSnapshotPath(note), '{ not json', 'utf8');
  assert.strictEqual(readSnapshot(note), null);
});

test('markEdited on a note with no snapshot is a no-op that does not throw', () => {
  const note = tmpNote();
  assert.strictEqual(markEdited(note, ['summary']), null);
  assert.strictEqual(fs.existsSync(noteSnapshotPath(note)), false);
});

// Both declines below are silent by construction: neither function throws, so
// update-meeting's two catch blocks never fire and the user's note keeps saving
// while its edit bookkeeping is quietly dead. The log line is the only trace,
// which is exactly why it is worth pinning.
test('captureSnapshot warns when it declines to write over an unreadable sidecar', (t) => {
  const warn = t.mock.method(console, 'warn', () => {});
  const note = tmpNote();
  fs.writeFileSync(noteSnapshotPath(note), '{ not json', 'utf8');
  assert.strictEqual(captureSnapshot(note, FIELDS, 'first_edit'), null);
  assert.strictEqual(warn.mock.callCount(), 1);
  assert.match(warn.mock.calls[0].arguments[0], /unreadable/);
  assert.match(warn.mock.calls[0].arguments[0], /Weekly_Sync_original\.json/);
});

test('captureSnapshot does not warn when the existing sidecar is perfectly usable', (t) => {
  const warn = t.mock.method(console, 'warn', () => {});
  const note = tmpNote();
  captureSnapshot(note, FIELDS, 'generation');
  assert.ok(captureSnapshot(note, FIELDS, 'first_edit'));
  assert.strictEqual(warn.mock.callCount(), 0);
});

test('markEdited warns when there is no usable snapshot to record the edit in', (t) => {
  const warn = t.mock.method(console, 'warn', () => {});
  const note = tmpNote();
  fs.writeFileSync(noteSnapshotPath(note), JSON.stringify({ version: 999 }), 'utf8');
  assert.strictEqual(markEdited(note, ['summary']), null);
  assert.strictEqual(warn.mock.callCount(), 1);
  assert.match(warn.mock.calls[0].arguments[0], /not recorded/);
});

test('markEdited does not warn on the ordinary path', (t) => {
  const warn = t.mock.method(console, 'warn', () => {});
  const note = tmpNote();
  captureSnapshot(note, FIELDS, 'generation');
  assert.ok(markEdited(note, ['summary']));
  assert.strictEqual(warn.mock.callCount(), 0);
});

test('readSnapshot returns null for a malformed note path instead of throwing', () => {
  assert.strictEqual(readSnapshot('/x/not-a-note.txt'), null);
});

test('captureSnapshot still throws for a malformed note path', () => {
  assert.throws(() => captureSnapshot('/x/not-a-note.txt', FIELDS, 'generation'), /_summary\.md/);
});

test('markEdited still throws for a malformed note path', () => {
  assert.throws(() => markEdited('/x/not-a-note.txt', ['summary']), /_summary\.md/);
});

// editedFieldNames is what get-meeting hands the renderer, so it is the input
// to the regenerate guard. Every "nothing was edited" shape has to come back as
// the SAME empty array: a guard that fires on an unedited note trains the user
// to click through it, which costs exactly the edits it exists to protect.
test('editedFieldNames returns [] when there is no sidecar', () => {
  assert.deepStrictEqual(editedFieldNames(tmpNote()), []);
});

test('editedFieldNames returns [] for a freshly captured (unedited) snapshot', () => {
  const note = tmpNote();
  captureSnapshot(note, FIELDS, 'generation');
  assert.deepStrictEqual(editedFieldNames(note), []);
});

test('editedFieldNames returns [] for a corrupt sidecar', () => {
  const note = tmpNote();
  fs.writeFileSync(noteSnapshotPath(note), '{ not json', 'utf8');
  assert.deepStrictEqual(editedFieldNames(note), []);
});

test('editedFieldNames returns [] for a malformed note path instead of throwing', () => {
  assert.deepStrictEqual(editedFieldNames('/x/not-a-note.txt'), []);
});

test('editedFieldNames reports the sections markEdited recorded', () => {
  const note = tmpNote();
  captureSnapshot(note, FIELDS, 'generation');
  markEdited(note, ['summary', 'action_items']);
  assert.deepStrictEqual(editedFieldNames(note).sort(), ['action_items', 'summary']);
});

// The sidecar is a file on disk, so its edited_fields can be anything. It ends
// up rendered in a dialog and must not carry arbitrary text there, and a
// non-array must not make the guard throw on the way to the renderer.
test('editedFieldNames drops entries that are not plain field keys', () => {
  const note = tmpNote();
  captureSnapshot(note, FIELDS, 'generation');
  const file = noteSnapshotPath(note);
  const snapshot = JSON.parse(fs.readFileSync(file, 'utf8'));
  snapshot.edited_fields = [
    'summary',
    'summary',
    42,
    null,
    { key: 'summary' },
    '<img src=x onerror=alert(1)>',
    'a'.repeat(200),
    'action_items',
  ];
  fs.writeFileSync(file, JSON.stringify(snapshot), 'utf8');
  assert.deepStrictEqual(editedFieldNames(note).sort(), ['action_items', 'summary']);
});

test('editedFieldNames returns [] when edited_fields is not an array', () => {
  const note = tmpNote();
  captureSnapshot(note, FIELDS, 'generation');
  const file = noteSnapshotPath(note);
  const snapshot = JSON.parse(fs.readFileSync(file, 'utf8'));
  snapshot.edited_fields = 'summary';
  fs.writeFileSync(file, JSON.stringify(snapshot), 'utf8');
  assert.deepStrictEqual(editedFieldNames(note), []);
});

test('editedFieldNames caps a pathological sidecar rather than passing it through', () => {
  const note = tmpNote();
  captureSnapshot(note, FIELDS, 'generation');
  const file = noteSnapshotPath(note);
  const snapshot = JSON.parse(fs.readFileSync(file, 'utf8'));
  snapshot.edited_fields = Array.from({ length: 5000 }, (_, i) => `field_${i}`);
  fs.writeFileSync(file, JSON.stringify(snapshot), 'utf8');
  assert.strictEqual(editedFieldNames(note).length, 8);
});
