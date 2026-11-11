'use strict';

const { test } = require('node:test');
const assert = require('node:assert');

const { parseMeetingMarkdown } = require('./meeting-markdown');

const MD_PATH = '/data/output/2026-01-02_standup.md';

const FULL = [
  '---',
  'title: "Weekly \\"sync\\""',
  'date: 2026-01-02T10:00:00',
  'duration_seconds: 125',
  'language: de',
  'is_diarised: true',
  'folders: ["a", "b"]',
  'continued_recordings: ["x.wav"]',
  '---',
  '',
  '## Summary',
  '',
  'We agreed.',
  '',
  '## Participants',
  '',
  'Ann, Bob,, Cy ',
  '',
  '## Key Topics',
  '',
  'intro line ignored',
  '### Budget',
  'Spend less.',
  '',
  '### Hiring',
  'Two roles.',
  '',
  '## Key Points',
  '',
  '- one',
  '- two',
  'not a bullet',
  '',
  '## Action Items',
  '',
  '- [ ] open task',
  '- [x] done task',
  '- plain task',
  '',
  '## Transcript',
  '',
  '[You] hello',
  '',
  '## User Notes',
  '',
  'my note',
].join('\n');

test('parses a complete note: metadata, every section', () => {
  const r = parseMeetingMarkdown(FULL, MD_PATH);
  assert.deepStrictEqual(r.session_info, {
    name: 'Weekly "sync"',
    processed_at: '2026-01-02T10:00:00',
    duration_seconds: 125,
    summary_file: MD_PATH,
    output_language: 'de',
  });
  assert.strictEqual(r.summary, 'We agreed.');
  assert.deepStrictEqual(r.participants, ['Ann', 'Bob', 'Cy']);
  assert.deepStrictEqual(r.discussion_areas, [
    { title: 'Budget', analysis: 'Spend less.' },
    { title: 'Hiring', analysis: 'Two roles.' },
  ]);
  assert.deepStrictEqual(r.key_points, ['one', 'two']);
  assert.deepStrictEqual(r.action_items, ['open task', 'done task', 'plain task']);
  assert.strictEqual(r.transcript, '[You] hello');
  assert.strictEqual(r.is_diarised, true);
  assert.strictEqual(r.diarised_text, '[You] hello');
  assert.strictEqual(r.user_notes, 'my note');
  assert.deepStrictEqual(r.folders, ['a', 'b']);
  assert.deepStrictEqual(r.continued_recordings, ['x.wav']);
});

test('no frontmatter: defaults, name falls back to file stem', () => {
  const r = parseMeetingMarkdown('## Summary\n\nhi', MD_PATH);
  assert.deepStrictEqual(r.session_info, {
    name: '2026-01-02_standup',
    processed_at: '',
    duration_seconds: null,
    summary_file: MD_PATH,
    output_language: null,
  });
  assert.strictEqual(r.summary, 'hi');
  assert.deepStrictEqual(r.participants, []);
  assert.deepStrictEqual(r.discussion_areas, []);
  assert.deepStrictEqual(r.key_points, []);
  assert.deepStrictEqual(r.action_items, []);
  assert.strictEqual(r.transcript, '');
  assert.strictEqual(r.is_diarised, false);
  assert.strictEqual(r.diarised_text, null);
  assert.strictEqual(r.user_notes, null);
  assert.deepStrictEqual(r.folders, []);
  assert.deepStrictEqual(r.continued_recordings, []);
});

test('empty content parses to the default shape', () => {
  const r = parseMeetingMarkdown('', '/x/y.md');
  assert.strictEqual(r.session_info.name, 'y');
  assert.strictEqual(r.summary, '');
  assert.strictEqual(r.user_notes, null);
});

test('unterminated frontmatter (fewer than two delimiters) is treated as body', () => {
  const r = parseMeetingMarkdown('---\ntitle: x\n## Summary\n\nbody', MD_PATH);
  assert.strictEqual(r.session_info.name, '2026-01-02_standup');
  assert.strictEqual(r.summary, 'body');
});

test('frontmatter value types: null, booleans, ints, bad JSON list, lines without colon', () => {
  const md = [
    '---',
    'duration_seconds: -5',
    'language: null',
    'is_diarised: false',
    'folders: [not json',
    'junk line without colon',
    'title: plain: with colon',
    '---',
    '## Summary',
    'x',
  ].join('\n');
  const r = parseMeetingMarkdown(md, MD_PATH);
  assert.strictEqual(r.session_info.duration_seconds, -5);
  assert.strictEqual(r.session_info.output_language, null);
  assert.strictEqual(r.session_info.name, 'plain: with colon');
  assert.strictEqual(r.is_diarised, false);
  assert.deepStrictEqual(r.folders, []);
});

test('quoted value unescapes backslash sequences', () => {
  const r = parseMeetingMarkdown('---\ntitle: "a\\\\b\\"c"\n---\n', MD_PATH);
  assert.strictEqual(r.session_info.name, 'a\\b"c');
});

test('a --- inside the body is kept (remainder is re-joined)', () => {
  const md = '---\ntitle: T\n---\n## Summary\n\nbefore --- after';
  const r = parseMeetingMarkdown(md, MD_PATH);
  assert.strictEqual(r.summary, 'before --- after');
});

test('section headings are case-insensitive; unknown sections are ignored', () => {
  const md = '## SUMMARY\n\ns\n\n## Other\n\nignored\n\n## user notes\n\nn';
  const r = parseMeetingMarkdown(md, MD_PATH);
  assert.strictEqual(r.summary, 's');
  assert.strictEqual(r.user_notes, 'n');
});

test('empty User Notes section yields empty string, absent yields null', () => {
  assert.strictEqual(parseMeetingMarkdown('## User Notes\n', MD_PATH).user_notes, '');
  assert.strictEqual(parseMeetingMarkdown('## Summary\n\nx', MD_PATH).user_notes, null);
});

test('is_diarised without a transcript gives empty diarised_text', () => {
  const r = parseMeetingMarkdown('---\nis_diarised: true\n---\n## Summary\nx', MD_PATH);
  assert.strictEqual(r.diarised_text, '');
});

test('transcription failure markers surface only when flagged', () => {
  const md = [
    '---',
    'transcription_failed: true',
    'reprocessable: true',
    'audio_file: a.wav',
    'error: boom',
    '---',
  ].join('\n');
  const r = parseMeetingMarkdown(md, MD_PATH);
  assert.strictEqual(r.session_info.transcription_failed, true);
  assert.strictEqual(r.session_info.reprocessable, true);
  assert.strictEqual(r.session_info.audio_file, 'a.wav');
  assert.strictEqual(r.session_info.error, 'boom');

  const r2 = parseMeetingMarkdown('---\ntranscription_failed: true\n---\n', MD_PATH);
  assert.strictEqual(r2.session_info.reprocessable, false);
  assert.ok(!('audio_file' in r2.session_info));
  assert.ok(!('error' in r2.session_info));

  const r3 = parseMeetingMarkdown('---\nreprocessable: true\n---\n', MD_PATH);
  assert.ok(!('transcription_failed' in r3.session_info));
  assert.ok(!('reprocessable' in r3.session_info));
});

test('notes_generated, notes_stale, is_live_transcript, processing markers', () => {
  const on = parseMeetingMarkdown(
    '---\nnotes_generated: false\nnotes_stale: true\nis_live_transcript: true\nprocessing: true\n---\n',
    MD_PATH,
  );
  assert.strictEqual(on.session_info.notes_generated, false);
  assert.strictEqual(on.session_info.notes_stale, true);
  assert.strictEqual(on.session_info.is_live_transcript, true);
  assert.strictEqual(on.session_info.processing, true);

  const off = parseMeetingMarkdown(
    '---\nnotes_generated: true\nnotes_stale: false\nprocessing: false\n---\n',
    MD_PATH,
  );
  for (const k of ['notes_generated', 'notes_stale', 'is_live_transcript', 'processing']) {
    assert.ok(!(k in off.session_info), k);
  }
});

test('continued_recordings must be an array', () => {
  const r = parseMeetingMarkdown('---\ncontinued_recordings: "x"\n---\n', MD_PATH);
  assert.deepStrictEqual(r.continued_recordings, []);
});

test('CRLF input: frontmatter values keep no CR, section text is trimmed per section', () => {
  const md = '---\r\ntitle: T\r\nduration_seconds: 7\r\n---\r\n## Summary\r\n\r\nhello\r\n\r\n## Key Points\r\n\r\n- a\r\n- b\r\n';
  const r = parseMeetingMarkdown(md, MD_PATH);
  assert.strictEqual(r.session_info.name, 'T');
  assert.strictEqual(r.session_info.duration_seconds, 7);
  assert.strictEqual(r.summary, 'hello');
  // Headings keep a trailing CR-trimmed key; bullets are trimmed per line.
  assert.deepStrictEqual(r.key_points, ['a', 'b']);
});

test('reasoning-tag glued to a heading is normalised before section split', () => {
  const md = '## Summary\n\nreal text</think>## Key Points\n\n- p';
  const r = parseMeetingMarkdown(md, MD_PATH);
  assert.strictEqual(r.summary, 'real text</think>');
  assert.deepStrictEqual(r.key_points, ['p']);
});

test('key topics: a topic without a following ### is dropped; empty analysis allowed', () => {
  const r = parseMeetingMarkdown('## Key Topics\n\njust prose\n', MD_PATH);
  assert.deepStrictEqual(r.discussion_areas, []);
  const r2 = parseMeetingMarkdown('## Key Topics\n\n### Only title\n', MD_PATH);
  assert.deepStrictEqual(r2.discussion_areas, [{ title: 'Only title', analysis: '' }]);
});

test('bare "##" without trailing space is not a heading', () => {
  const r = parseMeetingMarkdown('## Summary\n\n##notheading\nmore', MD_PATH);
  assert.strictEqual(r.summary, '##notheading\nmore');
});
