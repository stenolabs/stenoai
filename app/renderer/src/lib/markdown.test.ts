import { describe, test, expect } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { renderMarkdown, splitFrontmatter, stripReasoning } from '@/lib/markdown';

/**
 * Unit coverage for stripReasoning — the guard that removes `<think>` /
 * `<thought>` / `<thinking>` / `<reasoning>` reasoning blocks emitted by some local models before the text is
 * handed to the markdown renderer. The streaming case (an unclosed tag at the
 * end of a chunk) is the load-bearing edge: a half-streamed reasoning block
 * must not flash into the rendered summary.
 */
describe('stripReasoning', () => {
  test('strips a closed reasoning block and trims leading whitespace', () => {
    const input = '<think>deliberating about the summary</think>\n\n## Summary\nHello';
    expect(stripReasoning(input)).toBe('## Summary\nHello');
  });

  test('strips an unclosed reasoning block to the end of a streaming chunk', () => {
    const input = 'visible intro\n<think>still thinking and the chunk cut off here';
    const result = stripReasoning(input);
    expect(result).toBe('visible intro\n');
    expect(result).not.toContain('still thinking');
  });

  test('passes through text with no reasoning tags unchanged', () => {
    const input = '## Summary\nNo reasoning here, just content.';
    expect(stripReasoning(input)).toBe(input);
  });

  test('returns falsy/empty for empty input', () => {
    expect(stripReasoning('')).toBeFalsy();
    expect(stripReasoning('')).toBe('');
  });

  test('handles multiple blocks and nested/malformed tags', () => {
    const input = 'A\n<think>1</think>\nB\n<thinking>2</thinking>\nC';
    expect(stripReasoning(input)).toBe('A\nB\nC');
  });

  test('handles reasoning tags', () => {
    const input = '<reasoning>...</reasoning>content';
    expect(stripReasoning(input)).toBe('content');
  });

  test('handles different nested tags (outer tag wins)', () => {
    const input = '<think>outer<thinking>inner</thinking></think>content';
    expect(stripReasoning(input)).toBe('content');
  });

  test('preserves spaces and formatting outside blocks', () => {
    const input = '  # Hello \n\n<think>test</think>\nWorld';
    expect(stripReasoning(input)).toBe('  # Hello \n\nWorld');
  });

  test('preserves leading formatting at document start when no reasoning block is present', () => {
    const input = '  <think>test</think>\n  # Hello';
    expect(stripReasoning(input)).toBe('  # Hello');
  });

  test('handles uppercase tags', () => {
    const input = '<THINK>A</think>B';
    expect(stripReasoning(input)).toBe('B');
  });
});


describe('chat Markdown lists', () => {
  function parse(text: string) {
    const div = document.createElement('div');
    div.innerHTML = renderToStaticMarkup(renderMarkdown(text));
    return div;
  }
  test('blank lines and repeated 1 markers form one numbered list', () => {
    for (const text of ['1. First\n\n2. Second\n\n3. Third', '1. First\n\n1. Second\n\n1. Third']) {
      const root = parse(text);
      expect(root.querySelectorAll('ol')).toHaveLength(1);
      expect(root.querySelectorAll('ol > li')).toHaveLength(3);
    }
  });
  test('continuation paragraphs and nested bullets stay inside their parent item', () => {
    const root = parse('1. First\n\n   More detail.\n\n   - Nested\n\n2. Second');
    expect(root.querySelectorAll('ol')).toHaveLength(1);
    expect(root.querySelectorAll('ol > li')).toHaveLength(2);
    expect(root.querySelector('ol > li ul')?.textContent).toContain('Nested');
  });
  test('preserves explicit starts and separates lists divided by a heading', () => {
    const root = parse('3. Third\n4. Fourth\n\n## Next\n\n1. Restart');
    expect(root.querySelectorAll('ol')).toHaveLength(2);
    expect(root.querySelector('ol')?.getAttribute('start')).toBe('3');
  });
  test('retains tables and code without interpreting raw HTML', () => {
    const root = parse('| Name | Value |\n| --- | --- |\n| A | B |\n\n```js\n1. code\n```\n\n<img src=x onerror=alert(1)>');
    expect(root.querySelectorAll('table')).toHaveLength(1);
    expect(root.querySelector('pre code')?.textContent).toContain('1. code');
    expect(root.querySelector('img')).toBeNull();
    expect(root.querySelector('script')).toBeNull();
    expect(parse('Use <div> here').textContent).toContain('Use <div> here');
  });
  test('an incomplete response keeps the first items together as it grows', () => {
    for (const text of ['1. First\n\n2. Sec', '1. First\n\n2. Second\n\n3. Third']) {
      expect(parse(text).querySelectorAll('ol')).toHaveLength(1);
    }
  });
  test('retains typographic bullets and preserves literal code examples', () => {
    const root = parse('• First\n• **Second**\n\n```text\n• literal\n```\n\n    • indented code');
    expect(root.querySelectorAll('ul > li')).toHaveLength(2);
    expect(root.querySelector('li strong')?.textContent).toBe('Second');
    expect(root.querySelectorAll('pre code')[0].textContent).toContain('• literal');
    expect(root.querySelectorAll('pre code')[1].textContent).toContain('• indented code');
  });
});

/**
 * splitFrontmatter — a template can produce a report opening with YAML
 * frontmatter. Fed whole to react-markdown, the opening `---` becomes a
 * horizontal rule and the closing one turns the keys into a heading, which is
 * what the report view showed.
 */
describe('splitFrontmatter', () => {
  test('splits frontmatter from the body', () => {
    const input = '---\nclient: Erika Mustermann\nissue: Empty Bcc field\n---\n\n## Summary\nIt went well.';
    const { properties, body } = splitFrontmatter(input);
    expect(properties).toEqual([
      ['client', 'Erika Mustermann'],
      ['issue', 'Empty Bcc field'],
    ]);
    expect(body).toBe('## Summary\nIt went well.');
  });

  test('a report without frontmatter is returned untouched', () => {
    const input = '## Summary\nNothing structured here.';
    const { properties, body } = splitFrontmatter(input);
    expect(properties).toEqual([]);
    expect(body).toBe(input);
  });

  test('keeps a colon inside a value, which a hand-rolled parser splits', () => {
    const { properties } = splitFrontmatter('---\nissue: "Outlook: access denied"\n---\n\nprose');
    expect(properties).toEqual([['issue', 'Outlook: access denied']]);
  });

  test('lists survive as arrays', () => {
    const { properties } = splitFrontmatter('---\nsymptoms:\n  - one\n  - two\n---\n\nprose');
    expect(properties).toEqual([['symptoms', ['one', 'two']]]);
  });

  test('drops keys the meeting header already shows, and empty values', () => {
    const input = '---\ntitle: Something broke\ndate: 2026-09-06\nduration: "0:10"\nduration_seconds: 587\n'
      + 'language: de\nclient: null\nsystems: []\nissue: Something\n---\n\nprose';
    const { properties } = splitFrontmatter(input);
    expect(properties).toEqual([['issue', 'Something']]);
  });

  test('unparseable frontmatter is left in the body rather than lost', () => {
    const input = '---\nclient: a: b: c\n---\n\nprose';
    const { properties, body } = splitFrontmatter(input);
    expect(properties).toEqual([]);
    expect(body).toBe(input);
  });
});
