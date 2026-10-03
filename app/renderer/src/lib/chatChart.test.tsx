import { describe, expect, test } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { parseChatChart, chartTickFormatter, CHART_INSTRUCTIONS } from './chatChart';
import { renderMarkdown } from './markdown';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const spec = {
  type: 'bar',
  title: 'Actions by meeting',
  xLabel: 'Meeting',
  yLabel: 'Actions',
  data: [{ label: 'Planning', value: 3 }],
};

describe('chat chart boundary', () => {
  test('small adjacent ticks keep consistent notation and meaningful precision', () => {
    const format = chartTickFormatter([{ label: 'A', value: 0.011 }], 'en-US');
    expect(format(0.00995)).toBe('0.00995');
    expect(format(0.01)).toBe('0.01');
    expect(format(0.011)).toBe('0.011');
    const tiny = chartTickFormatter([{ label: 'A', value: 1e-12 }], 'en-US');
    expect(tiny(5e-13)).toMatch(/5E-13/i);
    expect(tiny(1e-12)).toMatch(/1E-12/i);
  });
  test.each(['de-DE', 'ar-EG'])('formats ticks using %s conventions', (locale) => {
    const format = chartTickFormatter([{ label: 'A', value: 0.011 }], locale);
    expect(format(0.00995)).toBe(
      new Intl.NumberFormat(locale, { maximumSignificantDigits: 4 }).format(0.00995)
    );
  });
  test('accepts bar and line charts, including zero and negative values', () => {
    for (const type of ['bar', 'line']) {
      const chart = {
        ...spec,
        type,
        data: [
          { label: 'A', value: 0 },
          { label: 'B', value: -2.5 },
        ],
      };
      expect(parseChatChart(JSON.stringify(chart))).toEqual(chart);
    }
  });
  test.each([
    null,
    [],
    { ...spec, type: 'pie' },
    { ...spec, url: 'https://example.com/data' },
    { ...spec, data: [] },
    { ...spec, data: Array(101).fill({ label: 'A', value: 1 }) },
    { ...spec, title: ' ' },
    { ...spec, title: 'x'.repeat(121) },
    { ...spec, data: [{ label: 'A', value: '3' }] },
    { ...spec, data: [{ label: 'A', value: null }] },
    { ...spec, data: [{ label: 'A', value: 1e13 }] },
    { ...spec, data: [{ label: 'A', value: 2, onClick: 'alert(1)' }] },
  ])('rejects unsupported, oversized, and nonnumeric specifications: %j', (value) => {
    expect(parseChatChart(JSON.stringify(value))).toBeNull();
  });
  test('rejects incomplete JSON, overflowed numbers and large payloads', () => {
    expect(parseChatChart('{"type":')).toBeNull();
    expect(parseChatChart(JSON.stringify(spec).replace('"value":3', '"value":1e999'))).toBeNull();
    expect(parseChatChart(' '.repeat(50001))).toBeNull();
  });
  test('unfinished or invalid chart fences remain readable code; ordinary code is unchanged', () => {
    const source = JSON.stringify(spec);
    expect(renderToStaticMarkup(renderMarkdown('```steno-chart\n' + source))).toContain('<pre');
    expect(renderToStaticMarkup(renderMarkdown('```steno-chart\n{"bad":true}\n```'))).toContain(
      '<pre'
    );
    expect(renderToStaticMarkup(renderMarkdown('```json\n' + source + '\n```'))).toContain(
      'data-lang="json"'
    );
  });
  test('Python and TypeScript share the same chart contract', () => {
    const python = readFileSync(resolve(__dirname, '../../../../src/chat_charts.py'), 'utf8');
    expect(python).toContain(CHART_INSTRUCTIONS);
  });
  test('a chart language fence inside code stays literal until a bare closing fence', () => {
    const html = renderToStaticMarkup(
      renderMarkdown('```text\n```steno-chart\n' + JSON.stringify(spec) + '\n```')
    );
    expect(html).toContain('data-lang="text"');
    expect(html).toContain('```steno-chart');
    expect(html).not.toContain('Loading chart');
  });
  test('a complete valid fence selects the lazy chart renderer', () => {
    const html = renderToStaticMarkup(
      renderMarkdown('```steno-chart\n' + JSON.stringify(spec) + '\n```')
    );
    expect(html).toContain('Loading chart');
    expect(html).not.toContain('<pre');
  });
});
