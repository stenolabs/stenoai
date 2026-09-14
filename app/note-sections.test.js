const { test } = require('node:test');
const assert = require('node:assert');

const {
  setSection,
  setSummary,
  setKeyPoints,
  setActionItems,
  setDiscussionAreas,
  containsStructuralLine,
} = require('./note-sections');

// A note body in the exact shape simple_recorder.py writes: the model's
// markdown, then ## Transcript, then ## User Notes.
const BODY = [
  '',
  '## Summary',
  '',
  'We agreed the budget.',
  '',
  '## Key Topics',
  '',
  '### Budget',
  '',
  'Numbers were reviewed.',
  '',
  '## Key Points',
  '',
  '- Budget approved',
  '',
  '## Action Items',
  '',
  '- Anna sends the draft',
  '',
  '## Transcript',
  '',
  '[You] Hello.',
  '',
  '## User Notes',
  '',
  'my own note',
  '',
].join('\n');

test('setSummary replaces only the summary and leaves every other section byte-identical', () => {
  const out = setSummary(BODY, 'We agreed the budget for Q3.');
  assert.match(out, /## Summary\n\nWe agreed the budget for Q3\.\n/);
  assert.match(out, /## Transcript\n\n\[You\] Hello\.\n/);
  assert.match(out, /## User Notes\n\nmy own note\n/);
  assert.match(out, /### Budget\n\nNumbers were reviewed\.\n/);
  assert.strictEqual(out.includes('We agreed the budget.\n'), false);
});

test('setKeyPoints rewrites the bullet list', () => {
  const out = setKeyPoints(BODY, ['Budget approved', 'Anna owns the draft']);
  assert.match(out, /## Key Points\n\n- Budget approved\n- Anna owns the draft\n/);
  assert.match(out, /## Action Items\n\n- Anna sends the draft\n/);
});

test('setActionItems with an empty list removes the section entirely', () => {
  const out = setActionItems(BODY, []);
  assert.strictEqual(out.includes('## Action Items'), false);
  assert.match(out, /## Key Points\n\n- Budget approved\n/);
  assert.match(out, /## Transcript\n/);
});

test('setDiscussionAreas rewrites the ### topics under Key Topics', () => {
  const out = setDiscussionAreas(BODY, [
    { title: 'Budget', analysis: 'Numbers were reviewed.' },
    { title: 'Hiring', analysis: 'Two roles open.' },
  ]);
  assert.match(out, /## Key Topics\n\n### Budget\n\nNumbers were reviewed\.\n\n### Hiring\n\nTwo roles open\.\n/);
});

test('a topic without analysis renders as a bare heading', () => {
  const out = setDiscussionAreas(BODY, [{ title: 'Budget' }]);
  assert.match(out, /### Budget\n/);
  assert.strictEqual(out.includes('undefined'), false);
});

test('a missing section is inserted at its canonical position, not appended', () => {
  const withoutActions = setActionItems(BODY, []);
  const out = setActionItems(withoutActions, ['Robin books the room']);
  const actionsAt = out.indexOf('## Action Items');
  const keyPointsAt = out.indexOf('## Key Points');
  const transcriptAt = out.indexOf('## Transcript');
  assert.ok(keyPointsAt < actionsAt, 'Action Items must follow Key Points');
  assert.ok(actionsAt < transcriptAt, 'Action Items must precede Transcript');
});

test('repeated edits do not accrete blank lines', () => {
  let out = setSummary(BODY, 'One.');
  out = setSummary(out, 'Two.');
  out = setSummary(out, 'Three.');
  assert.strictEqual(/\n{3,}/.test(out), false);
});

// The one place "every other section is left alone" is not literally true, so
// it is pinned here rather than only described in prose. joinSections trims the
// tail of the WHOLE joined body before restoring the final newline, so trailing
// whitespace on the last line of the LAST section disappears even when that
// section was not the one edited. Keep it: it is what stops blank lines
// accreting across repeated edits, and both parsers trim each line anyway, so
// nothing downstream can tell. If this test starts failing because the trim was
// removed, check the accretion test above before "fixing" it.
test('the tail trim reaches the last section, so trailing whitespace there is not preserved', () => {
  const body = '## Summary\nold\n## Transcript\nkeep   \n';
  const out = setSection(body, 'Summary', 'new');
  assert.strictEqual(out, '## Summary\n\nnew\n\n## Transcript\nkeep\n');
  assert.strictEqual(out.includes('keep   '), false);

  // Everything before the final line is preserved exactly, trailing whitespace
  // included - the trim is a tail trim, not a per-line one.
  const midBody = '## Summary\nold\n## Transcript\nkeep   \nlast\n';
  const midOut = setSection(midBody, 'Summary', 'new');
  assert.ok(midOut.includes('keep   \nlast\n'), 'inner trailing whitespace must survive');
});

test('containsStructuralLine catches a heading a user could paste into a field', () => {
  assert.strictEqual(containsStructuralLine('## Transcript'), true);
  assert.strictEqual(containsStructuralLine('ok\n### Sneaky'), true);
  assert.strictEqual(containsStructuralLine('  ## indented'), true);
  assert.strictEqual(containsStructuralLine('a #hashtag is fine'), false);
  assert.strictEqual(containsStructuralLine('C# is fine'), false);
});

// Mirrors parseMeetingMarkdown's section-splitting loop (main.js:2607-2620): it
// walks the body top to bottom and keeps overwriting sections[currentSection]
// on every '## ' heading it sees, so a repeated heading resolves to the LAST
// occurrence, not the first. Reimplemented here (rather than requiring
// main.js, which boots the Electron main process) purely to prove
// note-sections.js output stays parser-compatible on duplicate headings.
function readSectionsLikeParser(body) {
  const sections = {};
  let currentSection = null;
  let currentLines = [];
  for (const line of body.split('\n')) {
    if (line.startsWith('## ')) {
      if (currentSection) sections[currentSection] = currentLines.join('\n').trim();
      currentSection = line.slice(3).trim().toLowerCase();
      currentLines = [];
    } else {
      currentLines.push(line);
    }
  }
  if (currentSection) sections[currentSection] = currentLines.join('\n').trim();
  return sections;
}

// A small local model repeating a '## Summary' heading is a realistic
// streamed-markdown output, and is exactly the parser-drift class that has
// bitten this project twice already (#346, #313).
const DUP_SUMMARY_BODY = [
  '',
  '## Summary',
  '',
  'First summary.',
  '',
  '## Summary',
  '',
  'Second summary.',
  '',
  '## Key Points',
  '',
  '- Budget approved',
  '',
].join('\n');

const DUP_ACTIONS_BODY = [
  '',
  '## Key Points',
  '',
  '- Budget approved',
  '',
  '## Action Items',
  '',
  '- First action',
  '',
  '## Action Items',
  '',
  '- Second action',
  '',
  '## Transcript',
  '',
  '[You] Hello.',
  '',
].join('\n');

const DUP_SUMMARY_WITH_NEIGHBOR_BODY = [
  '',
  '## Summary',
  '',
  'First summary.',
  '',
  '## Key Points',
  '',
  '- Point between',
  '',
  '## Summary',
  '',
  'Second summary.',
  '',
  '## Transcript',
  '',
  '[You] Hello.',
  '',
].join('\n');

test('a duplicate heading collapses to one, written at the LAST occurrence, matching parseMeetingMarkdown last-wins', () => {
  const out = setSummary(DUP_SUMMARY_BODY, 'Third summary.');
  const headingCount = (out.match(/^## Summary$/gm) || []).length;
  assert.strictEqual(headingCount, 1);
  assert.match(out, /## Summary\n\nThird summary\.\n/);
  assert.strictEqual(out.includes('First summary.'), false);
  assert.strictEqual(out.includes('Second summary.'), false);
});

test('clearing a duplicated section removes every occurrence, not just the last', () => {
  const out = setActionItems(DUP_ACTIONS_BODY, []);
  assert.strictEqual(out.includes('## Action Items'), false);
  assert.strictEqual(out.includes('First action'), false);
  assert.strictEqual(out.includes('Second action'), false);
  assert.match(out, /## Key Points\n\n- Budget approved\n/);
  assert.match(out, /## Transcript\n/);
});

test('a duplicate-heading edit is what the parser actually reads back', () => {
  const out = setSummary(DUP_SUMMARY_BODY, 'Edited summary.');
  const sections = readSectionsLikeParser(out);
  assert.strictEqual(sections.summary, 'Edited summary.');
});

test('the surviving block keeps the LAST occurrence position relative to its neighbours', () => {
  const out = setSummary(DUP_SUMMARY_WITH_NEIGHBOR_BODY, 'Edited summary.');
  const summaryAt = out.indexOf('## Summary');
  const keyPointsAt = out.indexOf('## Key Points');
  const transcriptAt = out.indexOf('## Transcript');
  assert.ok(
    keyPointsAt < summaryAt,
    'the surviving Summary must sit after Key Points, where the LAST occurrence was',
  );
  assert.ok(summaryAt < transcriptAt);
});
