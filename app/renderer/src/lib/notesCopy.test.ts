import { describe, test, expect } from 'vitest';
import { buildNotesCopyText, type NotesCopySections } from '@/lib/notesCopy';

/**
 * Unit coverage for buildNotesCopyText — the builder behind the "Copy notes"
 * header action. The load-bearing case: when a generated template report is
 * open, the copy must contain THAT report, not the Standard structured note
 * (the on-screen content and the clipboard must never disagree).
 */

const sections: NotesCopySections = {
  name: 'Weekly sync',
  meta: 'Mon, Jun 23, 2026, 10:00 AM · 45m',
  summary: 'We discussed the roadmap.',
  discussionAreas: [
    { title: 'Roadmap', analysis: 'Q3 priorities agreed.' },
    { title: 'Hiring' },
  ],
  keyPoints: ['Ship v2 in July'],
  actionItems: ['Casey Example: draft the announcement'],
  participants: ['Casey Example', 'Morgan Example'],
};

describe('buildNotesCopyText', () => {
  test('no active report → the Standard structured note, all sections in order', () => {
    const text = buildNotesCopyText(sections, null);
    expect(text).toBe(
      [
        'Weekly sync',
        'Mon, Jun 23, 2026, 10:00 AM · 45m',
        '',
        'SUMMARY',
        'We discussed the roadmap.',
        '',
        'KEY TOPICS',
        '- Roadmap: Q3 priorities agreed.',
        '- Hiring',
        '',
        'KEY POINTS',
        '- Ship v2 in July',
        '',
        'ACTION ITEMS',
        '- Casey Example: draft the announcement',
        '',
        'PARTICIPANTS',
        'Casey Example, Morgan Example',
      ].join('\n'),
    );
  });

  test('active report → title + meta + the report markdown, no Standard sections', () => {
    const text = buildNotesCopyText(sections, {
      content: '## 1:1 Notes\n\n- Roadmap locked\n',
    });
    expect(text).toBe(
      [
        'Weekly sync',
        'Mon, Jun 23, 2026, 10:00 AM · 45m',
        '',
        '## 1:1 Notes',
        '',
        '- Roadmap locked',
      ].join('\n'),
    );
    expect(text).not.toContain('SUMMARY');
  });

  test('empty sections are omitted entirely (no dangling headers)', () => {
    const text = buildNotesCopyText(
      {
        name: 'Quick call',
        meta: undefined,
        summary: '  ',
        discussionAreas: [],
        keyPoints: [],
        actionItems: [],
        participants: [],
      },
      null,
    );
    expect(text).toBe('Quick call');
  });

  test('active report with only-whitespace content still copies just title + meta', () => {
    const text = buildNotesCopyText(sections, { content: '   \n  ' });
    expect(text).toBe('Weekly sync\nMon, Jun 23, 2026, 10:00 AM · 45m');
  });
});
