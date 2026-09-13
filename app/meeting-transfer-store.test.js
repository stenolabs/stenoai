'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { writePackage, readPackage } = require('./meeting-transfer-codec');
const { importIntoLibrary, makeExportContent, importedAudioSources, STORE_DOCUMENT_LIMIT } = require('./meeting-transfer-store');
const ID = '11111111-2222-4333-8444-555555555555';
const fixture = (notes = 'Synthetic private agenda') => ({
  meeting: { sourceMeetingID: ID, title: 'Synthetic meeting', createdAt: 500000000, sourceStatus: 'ready' }, notes,
  transcript: { localeOrigin: 'absent', speakers: [], turns: [{ start: 0, end: 10,
    segments: [{ text: 'Synthetic transcript', start: 0, end: 10, words: [] }] }] },
});
async function setup(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'steno-transfer-store-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  return root;
}
async function packageAt(t, root, name, content) {
  const file = path.join(root, name + '.stenomeeting');
  await writePackage(file, content);
  const pkg = await readPackage(file);
  t.after(() => pkg.cleanup());
  return pkg;
}
test('import persists exact text; duplicate preserves local edits and changed origin conflicts', async t => {
  const root = await setup(t);
  const output = path.join(root, 'output');
  const pkg = await packageAt(t, root, 'original', fixture());
  const result = await importIntoLibrary(pkg, output);
  assert.equal(result.duplicate, false);
  const meeting = JSON.parse(await fs.readFile(result.summaryFile, 'utf8'));
  assert.equal(meeting.user_notes, 'Synthetic private agenda');
  assert.equal(meeting.transcript, 'Synthetic transcript');
  assert.equal(meeting.session_info.processing, undefined);
  assert.equal(meeting.steno_transfer.sourceMeetingID, ID);
  assert.equal(meeting.steno_transfer.importedTranscriptText, undefined);
  assert.equal(meeting.steno_transfer.importedTranscriptSHA256,
    createHash('sha256').update(meeting.transcript).digest('hex'));
  meeting.user_notes = 'My later edit';
  await fs.writeFile(result.summaryFile, JSON.stringify(meeting));
  assert.equal((await importIntoLibrary(pkg, output)).duplicate, true);
  assert.equal(JSON.parse(await fs.readFile(result.summaryFile, 'utf8')).user_notes, 'My later edit');
  const changed = await packageAt(t, root, 'changed', fixture('Changed sender note'));
  await assert.rejects(importIntoLibrary(changed, output), { code: 'transfer_conflict' });
  assert.equal((await fs.readdir(output)).filter(name => name.endsWith('_summary.json')).length, 1);
});
test('import never follows a conflicting summary symlink or changes its target', { skip: process.platform === 'win32' }, async t => {
  const root = await setup(t);
  const output = path.join(root, 'output');
  await fs.mkdir(output);
  const victim = path.join(root, 'keep.json');
  await fs.writeFile(victim, 'do not touch');
  await fs.symlink(victim, path.join(output, `transfer_${ID}_summary.json`));
  const pkg = await packageAt(t, root, 'original', fixture());
  await assert.rejects(importIntoLibrary(pkg, output));
  assert.equal(await fs.readFile(victim, 'utf8'), 'do not touch');
});
test('export retains structured imported transcript and source identity', async t => {
  const root = await setup(t);
  const pkg = await packageAt(t, root, 'original', fixture());
  const result = await importIntoLibrary(pkg, path.join(root, 'output'));
  const meeting = JSON.parse(await fs.readFile(result.summaryFile, 'utf8'));
  const content = await makeExportContent(meeting, result.summaryFile, root, [], 'test');
  assert.equal(content.meeting.sourceMeetingID, ID);
  assert.deepEqual(content.transcript, pkg.transcript);
  assert.equal(content.notes, pkg.notes);
  const roundtrip = await packageAt(t, root, 'export', content);
  assert.equal(roundtrip.notes, pkg.notes);
  assert.deepEqual(roundtrip.transcript, pkg.transcript);
  meeting.transcript = 'Edited text without the original timing.';
  const edited = await makeExportContent(meeting, result.summaryFile, root, [], 'test');
  assert.equal(edited.transcript.turns[0].segments[0].text, meeting.transcript);
  assert.notDeepEqual(edited.transcript, pkg.transcript);
});
test('export identities are stable without changing the source; legacy text stays exact', async t => {
  const root = await setup(t);
  const meeting = { session_info: { name: 'Saved meeting', processed_at: '2026-09-12T01:02:03Z' },
    summary: 'Existing summary', user_notes: 'My notes', transcript: 'A text without reliable timing.' };
  const file = path.join(root, 'output', 'synthetic_summary.md');
  const first = await makeExportContent(meeting, file, root);
  const second = await makeExportContent(meeting, file, root);
  assert.equal(first.meeting.sourceMeetingID, second.meeting.sourceMeetingID);
  assert.equal(first.transcript.turns[0].segments[0].text, meeting.transcript);
  assert.equal(first.transcript.turns[0].speakerID, undefined);
  assert.match(first.notes, /Existing summary/);
  assert.match(first.notes, /My notes/);
  assert.equal(meeting.steno_transfer, undefined);
});

test('export still recognizes unchanged transcripts from older text-based receipts', async t => {
  const root = await setup(t);
  const pkg = await packageAt(t, root, 'original', fixture());
  const result = await importIntoLibrary(pkg, path.join(root, 'output'));
  const meeting = JSON.parse(await fs.readFile(result.summaryFile, 'utf8'));
  delete meeting.steno_transfer.importedTranscriptSHA256;
  meeting.steno_transfer.importedTranscriptText = meeting.transcript;
  const content = await makeExportContent(meeting, result.summaryFile, root);
  assert.deepEqual(content.transcript, pkg.transcript);
});

test('an oversized stored document is rejected before copying media or publishing a summary', async t => {
  const root = await setup(t);
  const pkg = await readPackage(path.join(__dirname, '..', 'tests', 'fixtures', 'swift-meeting-v1.stenomeeting'));
  t.after(pkg.cleanup);
  const output = path.join(root, 'output');
  const copy = t.mock.method(fs, 'copyFile', async () => { throw new Error('No audio should be copied'); });
  await assert.rejects(importIntoLibrary(pkg, output, { documentLimit: 128 }), { code: 'package_too_large' });
  assert.equal(copy.mock.callCount(), 0);
  assert.deepEqual(await fs.readdir(output), ['.meeting-transfer']);
  assert.deepEqual(await fs.readdir(path.join(output, '.meeting-transfer')), []);
});

test('the stored-document bound cannot exceed the shared application read limit', async t => {
  const root = await setup(t);
  const pkg = await packageAt(t, root, 'original', fixture());
  assert.equal(STORE_DOCUMENT_LIMIT, 100 * 1024 * 1024);
  await assert.rejects(importIntoLibrary(pkg, path.join(root, 'output'), {
    documentLimit: STORE_DOCUMENT_LIMIT + 1,
  }), { code: 'package_too_large' });
  await assert.rejects(fs.stat(path.join(root, 'output')), { code: 'ENOENT' });
});

test('a bounded import retains validated audio and a readable summary', async t => {
  const root = await setup(t);
  const pkg = await readPackage(path.join(__dirname, '..', 'tests', 'fixtures', 'swift-meeting-v1.stenomeeting'));
  t.after(pkg.cleanup);
  const result = await importIntoLibrary(pkg, path.join(root, 'output'), { documentLimit: 4096 });
  const retained = await fs.readFile(result.summaryFile);
  assert.ok(retained.length <= 4096);
  const meeting = JSON.parse(retained);
  const audio = await importedAudioSources(meeting, result.summaryFile);
  assert.equal(audio.length, 1);
  assert.deepEqual(await fs.readFile(audio[0].sourcePath), await fs.readFile(pkg.audio[0].sourcePath));
  assert.deepEqual(await fs.readdir(path.dirname(audio[0].sourcePath)), ['track-1.caf']);
});

test('insufficient library-volume capacity leaves neither media nor a published summary', async t => {
  const root = await setup(t);
  const pkg = await readPackage(path.join(__dirname, '..', 'tests', 'fixtures', 'swift-meeting-v1.stenomeeting'));
  t.after(pkg.cleanup);
  const output = path.join(root, 'output');
  const capacity = t.mock.method(fs, 'statfs', async () => ({ bsize: 1n, bavail: 1n }));
  const copy = t.mock.method(fs, 'copyFile', async () => { throw new Error('No audio should be copied'); });
  await assert.rejects(importIntoLibrary(pkg, output), { code: 'insufficient_space' });
  assert.equal(copy.mock.callCount(), 0);
  assert.equal(capacity.mock.callCount(), 1);
  assert.equal(path.dirname(capacity.mock.calls[0].arguments[0]), await fs.realpath(path.join(output, '.meeting-transfer')));
  assert.deepEqual(await fs.readdir(output), ['.meeting-transfer']);
  assert.deepEqual(await fs.readdir(path.join(output, '.meeting-transfer')), []);
});

test('export rejects a media root replaced with a symlink even when track hashes match', { skip: process.platform === 'win32' }, async t => {
  const root = await setup(t);
  const pkg = await readPackage(path.join(__dirname, '..', 'tests', 'fixtures', 'swift-meeting-v1.stenomeeting'));
  t.after(pkg.cleanup);
  const output = path.join(root, 'output');
  const imported = await importIntoLibrary(pkg, output);
  const meeting = JSON.parse(await fs.readFile(imported.summaryFile, 'utf8'));
  const media = path.join(output, '.meeting-transfer');
  const moved = path.join(root, 'outside');
  await fs.rename(media, moved);
  await fs.symlink(moved, media);
  await assert.rejects(importedAudioSources(meeting, imported.summaryFile), { code: 'unsafe_storage' });
  assert.equal((await fs.readdir(path.join(moved, meeting.steno_transfer.mediaDirectory))).length, 1);
});
