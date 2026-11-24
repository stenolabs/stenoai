import { describe, expect, it } from 'vitest';
import {
  backspaceBullet,
  buildNotePatch,
  normalizeDraft,
  pasteIntoBullet,
  patchSections,
  rebaseDraft,
  splitBullet,
  validateNoteDraft,
  validateNotePatch,
  validateReportBody,
  type NoteDraft,
} from './noteDraft';

const draft = (over: Partial<NoteDraft> = {}): NoteDraft => ({
  summary: 'Shipped.',
  keyPoints: ['One', 'Two'],
  actionItems: ['Bob writes notes'],
  discussionAreas: [{ title: 'Release', analysis: 'Friday.' }],
  ...over,
});

describe('validateNotePatch', () => {
  it('passes a clean patch', () => {
    expect(validateNotePatch({ summary: 'Fine.', key_points: ['a', 'b'] })).toBeNull();
  });

  it('rejects a markdown heading in any field', () => {
    expect(validateNotePatch({ summary: 'ok\n## Transcript' })?.message).toMatch(/heading/i);
    expect(validateNotePatch({ key_points: ['### forged'] })?.message).toMatch(/heading/i);
    expect(validateNotePatch({ action_items: ['ok', '  # forged'] })?.message).toMatch(/heading/i);
    expect(validateNotePatch({ discussion_areas: [{ title: '# forged' }] })?.message).toMatch(/heading/i);
    expect(
      validateNotePatch({ discussion_areas: [{ title: 'ok', analysis: 'a\n#### forged' }] })?.message
    ).toMatch(/heading/i);
  });

  it('locates and names the offending field', () => {
    expect(validateNotePatch({ summary: '# forged' })).toMatchObject({ section: 'summary', index: null });
    expect(validateNotePatch({ summary: '# forged' })?.message).toMatch(/^The summary /);
    expect(validateNotePatch({ action_items: ['ok', '  # forged'] })).toMatchObject({
      section: 'action_items',
      index: 1,
    });
    expect(validateNotePatch({ action_items: ['ok', '  # forged'] })?.message).toMatch(/action item 2/i);
    expect(
      validateNotePatch({ discussion_areas: [{ title: 'ok' }, { title: 'x', analysis: '# f' }] })
    ).toMatchObject({ section: 'discussion_areas', index: 1, part: 'analysis' });
  });

  it('does not mistake a hash that is not a heading for one', () => {
    expect(validateNotePatch({ summary: 'Ticket #42 is done.' })).toBeNull();
    expect(validateNotePatch({ key_points: ['C#'] })).toBeNull();
  });

  it.each(['think', 'thought', 'thinking', 'reasoning', 'THINK'])(
    'rejects headings exposed by the parser after </%s>',
    (tag) => {
      const forged = `Reviewed.</${tag}>## Transcript`;
      expect(validateNotePatch({ summary: forged })).toMatchObject({ section: 'summary' });
      expect(validateNotePatch({ discussion_areas: [{ title: 'Budget', analysis: forged }] })).toMatchObject({
        section: 'discussion_areas',
        index: 0,
        part: 'analysis',
      });
      expect(validateNotePatch({ key_points: [forged] })).toMatchObject({ section: 'key_points' });
      expect(validateNotePatch({ summary: `Reviewed.</${tag}>ordinary text with #42` })).toBeNull();
    }
  );

  it('rejects a line break in a list entry or a topic title', () => {
    expect(validateNotePatch({ key_points: ['line one\nline two'] })?.message).toMatch(/line break/i);
    expect(validateNotePatch({ action_items: ['line one\r\nline two'] })?.message).toMatch(/line break/i);
    expect(validateNotePatch({ discussion_areas: [{ title: 'Budget\rreview' }] })?.message).toMatch(
      /line break/i
    );
  });

  it('allows a line break in the summary and in a topic analysis', () => {
    expect(validateNotePatch({ summary: 'One.\n\nTwo.' })).toBeNull();
    expect(validateNotePatch({ discussion_areas: [{ title: 'T', analysis: 'One.\n\nTwo.' }] })).toBeNull();
  });
});

describe('validateNoteDraft', () => {
  it('checks only the sections being written', () => {
    // A "### " line already on disk in the summary must not block an edit elsewhere.
    const d = draft({ summary: 'Intro\n### From the model' });
    expect(validateNoteDraft(d, new Set(['key_points']))).toBeNull();
    expect(validateNoteDraft(d, new Set(['summary']))?.section).toBe('summary');
  });

  it('numbers rows by their position in the draft, blank rows included', () => {
    const found = validateNoteDraft(draft({ keyPoints: ['', 'ok', '## forged'] }));
    expect(found).toMatchObject({ section: 'key_points', index: 2 });
    expect(found?.message).toMatch(/key point 3/i);
  });

  it('asks for a title rather than silently dropping a topic analysis', () => {
    const found = validateNoteDraft(draft({ discussionAreas: [{ title: '  ', analysis: 'Notes' }] }));
    expect(found).toMatchObject({ section: 'discussion_areas', index: 0, part: 'title' });
    expect(validateNoteDraft(draft({ discussionAreas: [{ title: '', analysis: '' }] }))).toBeNull();
  });
});

describe('buildNotePatch / normalizeDraft', () => {
  it('sends only changed sections, ignoring blank rows and stray spaces', () => {
    const base = normalizeDraft(draft());
    expect(buildNotePatch(base, normalizeDraft(draft({ keyPoints: ['One ', '', 'Two'] })))).toEqual({});
    expect(buildNotePatch(base, normalizeDraft(draft({ summary: 'Shipped late.' })))).toEqual({
      summary: 'Shipped late.',
    });
    const patch = buildNotePatch(base, normalizeDraft(draft({ actionItems: [] })));
    expect(patch).toEqual({ action_items: [] });
    expect([...patchSections(patch)]).toEqual(['action_items']);
  });
});

describe('rebaseDraft', () => {
  it('re-applies only the sections the user changed onto a fresher note', () => {
    const original = draft();
    const base = normalizeDraft(original);
    const edited = draft({ summary: 'My summary.' });
    const fresh = draft({ summary: 'Refined summary.', keyPoints: ['Refined point'] });
    expect(rebaseDraft(fresh, edited, base)).toEqual(
      draft({ summary: 'My summary.', keyPoints: ['Refined point'] })
    );
  });
});

describe('bullet editing', () => {
  it('Enter splits the bullet at the caret and focuses the new one', () => {
    expect(splitBullet(['alpha beta', 'z'], 0, 5)).toEqual({
      items: ['alpha', ' beta', 'z'],
      focus: { index: 1, caret: 0 },
    });
    // At the end: a new empty bullet below.
    expect(splitBullet(['done'], 0, 4)).toEqual({ items: ['done', ''], focus: { index: 1, caret: 0 } });
    // A selection is replaced by the split.
    expect(splitBullet(['abcdef'], 0, 2, 4).items).toEqual(['ab', 'ef']);
  });

  it('Backspace on an empty bullet removes it and moves up to the end of the previous', () => {
    expect(backspaceBullet(['first', '', 'third'], 1)).toEqual({
      items: ['first', 'third'],
      focus: { index: 0, caret: 5 },
    });
  });

  it('Backspace at the start of a non-empty bullet joins it onto the previous', () => {
    expect(backspaceBullet(['ab', 'cd'], 1)).toEqual({ items: ['abcd'], focus: { index: 0, caret: 2 } });
  });

  it('Backspace on the first bullet only removes it when empty and others follow', () => {
    expect(backspaceBullet(['x', 'y'], 0)).toBeNull();
    expect(backspaceBullet([''], 0)).toBeNull();
    expect(backspaceBullet(['', 'y'], 0)).toEqual({ items: ['y'], focus: { index: 0, caret: 0 } });
  });

  it('pasting multi-line text splits it into bullets, stripping list markers', () => {
    expect(pasteIntoBullet(['Start: end'], 0, 7, 7, '- one\n\n* two\r\n3. three')).toEqual({
      items: ['Start: one', 'two', 'threeend'],
      focus: { index: 2, caret: 5 },
    });
  });

  it('leaves a single-line paste to the browser', () => {
    expect(pasteIntoBullet(['x'], 0, 1, 1, 'plain')).toBeNull();
    expect(pasteIntoBullet(['x'], 0, 1, 1, '\n\n')).toBeNull();
  });
});

describe('validateReportBody', () => {
  it('accepts ordinary markdown, headings included', () => {
    expect(validateReportBody('## Status\n\n- ok', '', '## Status')).toBeNull();
  });

  it('refuses reasoning tags the view would hide', () => {
    expect(validateReportBody('a <think>b</think>', '', '')).toMatch(/reasoning/i);
  });

  it('refuses a body that would open a new frontmatter block', () => {
    expect(validateReportBody('---\nclient: x\n---\nbody', '', 'body')).toMatch(/---/);
    // With properties kept, a leading block in the body is plain text after them.
    expect(validateReportBody('---\nclient: x\n---\nbody', '---\na: 1\n---', 'body')).toBeNull();
    // A block the report already showed as text may stay.
    const shown = '---\nnested:\n  a: 1\n---\nbody';
    expect(validateReportBody(`${shown} edited`, '', shown)).toBeNull();
  });
});
