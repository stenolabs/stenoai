import { describe, expect, test } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { parseChatChart, CHART_INSTRUCTIONS } from './chatChart';
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
  test('Python and org adapters advertise the same chart contract', () => {
    const python = readFileSync(resolve(__dirname, '../../../../src/chat_charts.py'), 'utf8');
    expect(python).toContain(CHART_INSTRUCTIONS);
  });
});
