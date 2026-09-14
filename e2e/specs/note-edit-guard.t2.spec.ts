import { test, expect } from '../fixtures/electron';
import { mkdirSync, writeFileSync, readFileSync } from 'fs';
import path from 'path';

/**
 * T2 - the input gate on update-meeting's note content fields, driven through
 * the REAL preload bridge against the REAL handler (main.js), asserting the
 * note file on disk.
 *
 * The gate exists because the renderer is untrusted and because both parsers
 * (parseMeetingMarkdown here, _parse_meeting_markdown in simple_recorder.py)
 * read a note by splitting on `## ` AFTER normalizeMarkdownForParsing has
 * broken a reasoning close-tag away from a heading glued to it. So a value like
 * `b</think>## Summary` is a harmless mid-line string when it is written and a
 * real section boundary when it is read - and the forged heading, being the
 * last occurrence, wins the parsers' last-one-wins rule and blanks the real
 * section everywhere the note is consumed (detail page, clipboard, PDF, org
 * share). Worse, it is unrecoverable through the UI: the section writers match
 * `line.startsWith('## ')` and cannot see a mid-line heading, so every later
 * edit writes the real section while the parser keeps reading the forged one.
 *
 * Not adversarial-only: the normalizer exists because reasoning models emit
 * exactly that shape, so pasting model output into a note is enough to hit it.
 *
 * The other half of the gate is line breaks inside a bullet entry, which the
 * parsers drop (they keep only lines starting with `- `) and the next save then
 * deletes from the file.
 *
 * Model-free: a seeded note plus the note IPCs, no ASR and no Ollama.
 */

const NOTE = [
  '---',
  'title: "Guarded Note"',
  'date: "2026-07-12T10:00:00"',
  'duration_seconds: 600',
  'language: "en"',
  'is_diarised: false',
  '---',
  '',
  '## Summary',
  '',
  'The team agreed to ship on Friday.',
  '',
  '## Key Topics',
  '',
  '### Billing',
  '',
  'The migration is blocked on the vendor.',
  '',
  '## Key Points',
  '',
  '- Ship Friday',
  '',
  '## Action Items',
  '',
  '- Alice pings the vendor',
  '',
  '## Transcript',
  '',
  'Alice: we ship Friday.',
  '',
].join('\n');

test('update-meeting rejects a forged section boundary in every content field', async ({
  launchApp,
  userDataDir,
}) => {
  test.setTimeout(60_000);
  const outputDir = path.join(userDataDir, 'output');
  mkdirSync(outputDir, { recursive: true });
  const summaryPath = path.join(outputDir, 'guarded_summary.md');
  writeFileSync(summaryPath, NOTE, 'utf-8');

  const { page } = await launchApp();
  const update = (patch: Record<string, unknown>) =>
    page.evaluate(
      ([f, p]) => window.stenoai.meetings.update(f as string, p as object),
      [summaryPath, patch] as const,
    );

  // Every field that reaches a section writer, each carrying a heading that is
  // mid-line as written and a real heading once normalized.
  const forged = 'b</think>## Summary';
  const patches: Array<Record<string, unknown>> = [
    { summary: forged },
    { key_points: [forged] },
    { action_items: [forged] },
    { discussion_areas: [{ title: forged, analysis: 'ok' }] },
    { discussion_areas: [{ title: 'ok', analysis: forged }] },
    // The normalizer's whole tag set, case-insensitively.
    { summary: 'x</thinking>## Transcript' },
    { summary: 'x</REASONING>   ### Topic' },
    { summary: 'x</thought>\n## Summary' },
    // A plain leading heading still has to be caught (the original gate).
    { summary: '## Summary\nforged' },
  ];

  for (const patch of patches) {
    const res = await update(patch);
    expect(res, `expected rejection for ${JSON.stringify(patch)}`).toMatchObject({
      success: false,
      error: 'A note field may not contain a markdown heading.',
    });
    // Nothing was written: the gate runs before the note is read or written.
    expect(readFileSync(summaryPath, 'utf8')).toBe(NOTE);
  }
});

test('update-meeting rejects a line break inside a key point or action item', async ({
  launchApp,
  userDataDir,
}) => {
  test.setTimeout(60_000);
  const outputDir = path.join(userDataDir, 'output');
  mkdirSync(outputDir, { recursive: true });
  const summaryPath = path.join(outputDir, 'bullets_summary.md');
  writeFileSync(summaryPath, NOTE, 'utf-8');

  const { page } = await launchApp();
  const update = (patch: Record<string, unknown>) =>
    page.evaluate(
      ([f, p]) => window.stenoai.meetings.update(f as string, p as object),
      [summaryPath, patch] as const,
    );

  const r1 = await update({ key_points: ['line one\nline two'] });
  expect(r1).toMatchObject({ success: false, error: 'A key point may not contain a line break.' });
  expect(readFileSync(summaryPath, 'utf8')).toBe(NOTE);

  const r2 = await update({ action_items: ['do this\r\nand that'] });
  expect(r2).toMatchObject({
    success: false,
    error: 'An action item may not contain a line break.',
  });
  expect(readFileSync(summaryPath, 'utf8')).toBe(NOTE);

  // A multi-line SUMMARY is legitimate - the section carries prose, and the
  // parser returns the whole block. Only bullet entries are single-line.
  const r3 = await update({ summary: 'First paragraph.\n\nSecond paragraph.' });
  expect(r3.success).toBe(true);
  expect(readFileSync(summaryPath, 'utf8')).toContain(
    '## Summary\n\nFirst paragraph.\n\nSecond paragraph.\n',
  );
});

test('a note with no readable frontmatter is refused, not silently accepted', async ({
  launchApp,
  userDataDir,
}) => {
  test.setTimeout(60_000);
  // A content edit only ever reaches the note body inside update-meeting's
  // frontmatter branch. A .md file without a parseable `---` block therefore
  // falls straight through it: every section writer is skipped and the file is
  // rewritten byte-identically. Reporting success there is the dangerous
  // answer - the editor closes, the user believes the correction is saved, and
  // it is nowhere. This is the whole reason the frontmatter guard exists, and
  // nothing pinned it.
  //
  // My notes (`user_notes`) is written by the very same branch, so it is the
  // same bug with the same consequence - and it is the one that fires without
  // any user intent, because the My-notes editor autosaves. The guard has to
  // cover EVERY body field, not just the generated ones.
  const outputDir = path.join(userDataDir, 'output');
  mkdirSync(outputDir, { recursive: true });

  // Two shapes of "no readable frontmatter": no delimiter at all, and an
  // opening `---` whose block is never closed (a truncated / hand-edited note).
  const cases: Array<[string, string]> = [
    ['nofm', '## Summary\n\nThe team agreed to ship on Friday.\n'],
    ['openfm', '---\ntitle: "Unclosed"\n\n## Summary\n\nThe team agreed to ship on Friday.\n'],
  ];
  // Every patch shape that reaches the note BODY: the four generated sections
  // and the user's own notes.
  const bodyPatches: Array<[string, Record<string, unknown>]> = [
    ['summary', { summary: 'An edit that must not be reported as saved' }],
    ['user_notes', { user_notes: 'A note that must not be reported as saved' }],
    ['key_points', { key_points: ['Never written'] }],
    ['action_items', { action_items: ['Never written'] }],
    ['discussion_areas', { discussion_areas: [{ title: 'Never', analysis: 'written' }] }],
  ];

  const { page } = await launchApp();
  for (const [stem, body] of cases) {
    const summaryPath = path.join(outputDir, `${stem}_summary.md`);

    for (const [label, patch] of bodyPatches) {
      writeFileSync(summaryPath, body, 'utf-8');
      const res = await page.evaluate(
        ([f, p]) => window.stenoai.meetings.update(f as string, p as object),
        [summaryPath, patch] as const,
      );
      expect(res, `expected refusal for ${stem} / ${label}`).toMatchObject({
        success: false,
        error: 'Note has no readable frontmatter; refusing to edit it.',
      });
      // And the file really is untouched - the refusal is not a rollback message
      // over a partial write.
      expect(readFileSync(summaryPath, 'utf8'), `${stem} / ${label} rewrote the file`).toBe(body);
    }
  }

  // Control: the very same patches on a well-formed note succeed and land. The
  // refusal above is about the note's frontmatter, not about the patch - and in
  // particular a notes-only save, which records no edited field, must NOT be
  // caught by the guard.
  const goodPath = path.join(outputDir, 'goodfm_summary.md');
  writeFileSync(goodPath, NOTE, 'utf-8');
  const ok = await page.evaluate(
    ([f, p]) => window.stenoai.meetings.update(f as string, p as object),
    [goodPath, { summary: 'An edit that must not be reported as saved' }] as const,
  );
  expect(ok.success).toBe(true);
  expect(readFileSync(goodPath, 'utf8')).toContain(
    'An edit that must not be reported as saved',
  );

  const okNotes = await page.evaluate(
    ([f, p]) => window.stenoai.meetings.update(f as string, p as object),
    [goodPath, { user_notes: 'A note that really is saved' }] as const,
  );
  expect(okNotes.success).toBe(true);
  expect(okNotes.edited_fields).toEqual([]);
  expect(readFileSync(goodPath, 'utf8')).toContain(
    '## User Notes\n\nA note that really is saved\n',
  );

  // A title-only rename touches no body section at all, so it stays outside the
  // guard even on a note whose frontmatter cannot be read: there is nothing to
  // silently drop, and the existing rewrite is a no-op either way.
  const nofmPath = path.join(outputDir, 'nofm_summary.md');
  writeFileSync(nofmPath, cases[0][1], 'utf-8');
  const renamed = await page.evaluate(
    ([f, p]) => window.stenoai.meetings.update(f as string, p as object),
    [nofmPath, { name: 'Renamed' }] as const,
  );
  expect(renamed.success).toBe(true);
});

test('the heading gate does not reject legitimate text that merely contains a hash', async ({
  launchApp,
  userDataDir,
}) => {
  test.setTimeout(60_000);
  const outputDir = path.join(userDataDir, 'output');
  mkdirSync(outputDir, { recursive: true });
  const summaryPath = path.join(outputDir, 'hashes_summary.md');
  writeFileSync(summaryPath, NOTE, 'utf-8');

  const { page } = await launchApp();
  const update = (patch: Record<string, unknown>) =>
    page.evaluate(
      ([f, p]) => window.stenoai.meetings.update(f as string, p as object),
      [summaryPath, patch] as const,
    );

  // None of these is a heading to either the writers or the parsers: no space
  // after the hashes, a hash mid-line, or a hash inside a word.
  const legit = 'Ported ##Foo to C# and tagged it #hashtag; issue #42 is next.';
  const res = await update({
    summary: legit,
    key_points: [legit],
    action_items: [legit],
    discussion_areas: [{ title: 'C# migration', analysis: legit }],
  });
  expect(res.success).toBe(true);

  const md = readFileSync(summaryPath, 'utf8');
  expect(md).toContain(`## Summary\n\n${legit}\n`);
  expect(md).toContain(`- ${legit}`);
  expect(md).toContain('### C# migration');
  // The note still has exactly the sections it started with.
  expect(md.match(/^## /gm)?.length).toBe(5);

  // And the parser agrees, so nothing was smuggled into a new section.
  const parsed = await page.evaluate(async (f) => {
    const r = await window.stenoai.meetings.get(f as string);
    return r.success ? r.meeting : { error: r.error };
  }, summaryPath);
  expect(parsed.summary).toBe(legit);
  expect(parsed.key_points).toEqual([legit]);
});
