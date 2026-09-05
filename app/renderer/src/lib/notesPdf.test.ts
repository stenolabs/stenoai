import { describe, test, expect } from 'vitest';
import { buildNotesHtml, hasNotesContent, escapeHtml, type NotesPdfInput } from '@/lib/notesPdf';

/**
 * Unit coverage for the branded-PDF HTML builder. Load-bearing cases: it must
 * (a) escape all dynamic note content so a title/item can't inject markup,
 * (b) omit empty sections cleanly, and (c) refuse to build for a note with no
 * structured content (which is what disables the Save-as-PDF action).
 */

const full: NotesPdfInput = {
  name: 'Weekly sync',
  meta: 'Mon, Jun 23, 2026 · 45m',
  summary: 'We discussed the roadmap.',
  discussionAreas: [
    { title: 'Roadmap', analysis: 'Q3 priorities agreed.' },
    { title: 'Hiring' },
  ],
  keyPoints: ['Ship v2 in July'],
  actionItems: ['Casey Example: draft the announcement'],
  participants: ['Casey Example', 'Morgan Example'],
};

describe('buildNotesHtml', () => {
  test('renders every populated section with brand chrome', () => {
    const html = buildNotesHtml(full);
    expect(html.startsWith('<!doctype html>')).toBe(true);
    expect(html).toContain('<title>Weekly sync</title>');
    expect(html).toContain('<h1>Weekly sync</h1>');
    expect(html).toContain('Mon, Jun 23, 2026 · 45m');
    // Section headings + content.
    expect(html).toContain('>Summary</h2>');
    expect(html).toContain('We discussed the roadmap.');
    expect(html).toContain('>Key Topics</h2>');
    expect(html).toContain('<span class="lead">Roadmap:</span> Q3 priorities agreed.');
    expect(html).toContain('<span class="lead">Hiring</span>');
    expect(html).toContain('>Key Points</h2>');
    expect(html).toContain('<li>Ship v2 in July</li>');
    expect(html).toContain('>Action Items</h2>');
    expect(html).toContain('<li>Casey Example: draft the announcement</li>');
    expect(html).toContain('>Participants</h2>');
    expect(html).toContain('Casey Example, Morgan Example');
    // Brand chrome: embedded font + logo, footer tagline + site.
    expect(html).toContain('@font-face');
    expect(html).toContain('data:image/svg+xml;base64,');
    expect(html).toContain('www.stenoai.co');
  });

  test('escapes HTML in every dynamic field (no markup injection)', () => {
    const html = buildNotesHtml({
      ...full,
      name: '<script>alert(1)</script> & "quotes"',
      summary: 'a < b && c > d',
      keyPoints: ['<img src=x onerror=1>'],
      actionItems: ["O'Brien: <b>bold</b>"],
      participants: ['A & B'],
      discussionAreas: [{ title: '<i>t</i>', analysis: '<u>a</u>' }],
    });
    expect(html).not.toContain('<script>alert(1)</script>');
    expect(html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
    expect(html).toContain('a &lt; b &amp;&amp; c &gt; d');
    expect(html).not.toContain('<img src=x');
    expect(html).toContain('&lt;img src=x onerror=1&gt;');
    expect(html).toContain('O&#39;Brien: &lt;b&gt;bold&lt;/b&gt;');
    expect(html).toContain('A &amp; B');
    // The <h1>/<title> carry the escaped name, never raw markup.
    expect(html).toContain('<h1>&lt;script&gt;alert(1)&lt;/script&gt; &amp; &quot;quotes&quot;</h1>');
  });

  test('omits empty sections and the meta line', () => {
    const html = buildNotesHtml({
      name: 'Quick call',
      summary: 'Just a summary.',
      discussionAreas: [],
      keyPoints: [],
      actionItems: [],
      participants: [],
    });
    expect(html).toContain('>Summary</h2>');
    expect(html).not.toContain('>Key Topics</h2>');
    expect(html).not.toContain('>Key Points</h2>');
    expect(html).not.toContain('>Action Items</h2>');
    expect(html).not.toContain('>Participants</h2>');
    expect(html).not.toContain('class="meta"');
  });

  test('falls back to a placeholder title when the name is blank', () => {
    const html = buildNotesHtml({ ...full, name: '   ' });
    expect(html).toContain('<h1>Untitled note</h1>');
  });

  test('returns empty string when there is no structured content', () => {
    expect(
      buildNotesHtml({
        name: 'Transcript-only',
        summary: '   ',
        discussionAreas: [],
        keyPoints: [],
        actionItems: [],
        participants: ['Someone'],
      }),
    ).toBe('');
  });
});

describe('hasNotesContent', () => {
  test('true when any of summary/topics/points/actions is present', () => {
    const base = {
      name: 'x',
      discussionAreas: [],
      keyPoints: [],
      actionItems: [],
      participants: [],
    };
    expect(hasNotesContent({ ...base, summary: 'hi' })).toBe(true);
    expect(hasNotesContent({ ...base, keyPoints: ['a'] })).toBe(true);
    // Participants alone is NOT enough (matches the disabled-action rule).
    expect(hasNotesContent({ ...base, participants: ['a'] })).toBe(false);
    expect(hasNotesContent({ ...base, summary: '   ' })).toBe(false);
  });
});

describe('escapeHtml', () => {
  test('escapes the five HTML-significant characters', () => {
    expect(escapeHtml(`&<>"'`)).toBe('&amp;&lt;&gt;&quot;&#39;');
  });
});

/**
 * A generated template report is free-form markdown, not the Standard note's
 * structured fields — so when one is on screen the PDF must carry THAT, the way
 * "Copy notes" already does (#318). The caller serialises the markdown with the
 * same renderer the detail view uses and hands the HTML in; this builder only
 * places it inside the branded shell.
 */
describe('buildNotesHtml with an open template report', () => {
  const report = {
    templateName: 'Shareable summary',
    contentHtml: '<h2>Outcome</h2>\n<p>We ship on <strong>Friday</strong>.</p>',
  };

  test('renders the report instead of the Standard sections', () => {
    const html = buildNotesHtml(full, report);
    // The report's content is present…
    expect(html).toContain('<p>We ship on <strong>Friday</strong>.</p>');
    // …labelled with the template it came from…
    expect(html).toContain('>Shareable summary</h2>');
    // …and the Standard note's sections are NOT along for the ride.
    expect(html).not.toContain('>Key Topics</h2>');
    expect(html).not.toContain('Ship v2 in July');
    expect(html).not.toContain('Casey Example: draft the announcement');
  });

  test('keeps the brand chrome, title and meta line', () => {
    const html = buildNotesHtml(full, report);
    expect(html.startsWith('<!doctype html>')).toBe(true);
    expect(html).toContain('<h1>Weekly sync</h1>');
    expect(html).toContain('Mon, Jun 23, 2026 · 45m');
    expect(html).toContain('@font-face');
  });

  test('renders a report even when the Standard note is empty', () => {
    // A transcript-only note (auto-summarise off) can still have a generated
    // report — the export must not be gated on the Standard sections.
    const empty: NotesPdfInput = {
      name: 'Transcript only',
      discussionAreas: [],
      keyPoints: [],
      actionItems: [],
      participants: [],
    };
    const html = buildNotesHtml(empty, report);
    expect(html).toContain('<p>We ship on <strong>Friday</strong>.</p>');
    expect(html).toContain('<h1>Transcript only</h1>');
  });

  test('escapes the template name but passes the pre-rendered content through', () => {
    const html = buildNotesHtml(full, {
      templateName: 'Q3 <Review> & Notes',
      contentHtml: '<p>kept &amp; intact</p>',
    });
    expect(html).toContain('Q3 &lt;Review&gt; &amp; Notes');
    expect(html).toContain('<p>kept &amp; intact</p>');
  });
});
