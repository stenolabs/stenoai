import { describe, expect, test } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import {
  parseChatChart,
  chartTickFormatter,
  chartToCsv,
  categoryTable,
  CHART_INSTRUCTIONS,
  type CategoryChartSpec,
} from './chatChart';
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
    { ...spec, type: 'pie3d' },
    { ...spec, type: 'Bar' },
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

const series = [
  {
    name: 'Open',
    data: [
      { label: 'Mon', value: 3 },
      { label: 'Tue', value: 1 },
    ],
  },
  {
    name: 'Closed',
    data: [
      { label: 'Mon', value: 2 },
      { label: 'Wed', value: 4 },
    ],
  },
];
const parse = (value: unknown) => parseChatChart(JSON.stringify(value));

describe('chart families', () => {
  test('a legacy single-series spec parses to exactly the same object', () => {
    const parsed = parse(spec);
    expect(parsed).toStrictEqual(spec);
  });
  test.each(['bar', 'line', 'area', 'radar', 'table'])('%s accepts data or series', (type) => {
    expect(parse({ type, title: 'T', data: [{ label: 'A', value: 1 }] })).toStrictEqual({
      type,
      title: 'T',
      data: [{ label: 'A', value: 1 }],
    });
    expect(parse({ type, title: 'T', xLabel: 'Day', series })).toStrictEqual({
      type,
      title: 'T',
      xLabel: 'Day',
      series,
    });
  });
  test('stacked and horizontal bars, stacked areas', () => {
    expect(
      parse({ type: 'bar', title: 'T', series, stacked: true, orientation: 'horizontal' })
    ).toMatchObject({ stacked: true, orientation: 'horizontal' });
    expect(parse({ type: 'area', title: 'T', series, stacked: true })).toMatchObject({
      stacked: true,
    });
  });
  test.each(['pie', 'donut'])('%s takes non-negative single-series data', (type) => {
    const data = [
      { label: 'Hiring', value: 20 },
      { label: 'Budget', value: 0 },
    ];
    expect(parse({ type, title: 'Time', data })).toStrictEqual({ type, title: 'Time', data });
  });
  test('scatter takes x/y points with optional labels, single or multi-series', () => {
    const data = [
      { x: 30, y: 4, label: 'Planning' },
      { x: -2.5, y: 0 },
    ];
    expect(
      parse({ type: 'scatter', title: 'T', xLabel: 'Min', yLabel: 'Acts', data })
    ).toStrictEqual({ type: 'scatter', title: 'T', xLabel: 'Min', yLabel: 'Acts', data });
    expect(
      parse({
        type: 'scatter',
        title: 'T',
        series: [
          { name: 'Q1', data },
          { name: 'Q2', data },
        ],
      })
    ).toMatchObject({ series: [{ name: 'Q1' }, { name: 'Q2' }] });
  });
  const pie = { type: 'pie', title: 'T', data: [{ label: 'A', value: 1 }] };
  test.each([
    ['both data and series', { ...spec, series }],
    ['neither data nor series', { type: 'bar', title: 'T' }],
    ['missing title', { type: 'bar', data: spec.data }],
    ['stacked on a line', { type: 'line', title: 'T', series, stacked: true }],
    ['orientation on an area', { type: 'area', title: 'T', series, orientation: 'horizontal' }],
    ['unknown orientation', { ...spec, orientation: 'diagonal' }],
    ['non-boolean stacked', { ...spec, stacked: 'yes' }],
    [
      '9 series',
      {
        type: 'bar',
        title: 'T',
        series: Array.from({ length: 9 }, (_, i) => ({ name: `S${i}`, data: spec.data })),
      },
    ],
    ['duplicate series names', { type: 'bar', title: 'T', series: [series[0], series[0]] }],
    [
      'duplicate labels within a series',
      {
        type: 'bar',
        title: 'T',
        series: [
          {
            name: 'A',
            data: [
              { label: 'X', value: 1 },
              { label: 'X', value: 2 },
            ],
          },
        ],
      },
    ],
    [
      'series with extra keys',
      { type: 'bar', title: 'T', series: [{ ...series[0], color: 'red' }] },
    ],
    ['blank series name', { type: 'bar', title: 'T', series: [{ name: ' ', data: spec.data }] }],
    ['empty series data', { type: 'bar', title: 'T', series: [{ name: 'A', data: [] }] }],
    [
      '101 points in a series',
      {
        type: 'line',
        title: 'T',
        series: [
          {
            name: 'A',
            data: Array.from({ length: 101 }, (_, i) => ({ label: `L${i}`, value: i })),
          },
        ],
      },
    ],
    ['pie with series', { ...pie, data: undefined, series }],
    ['pie with negative value', { ...pie, data: [{ label: 'A', value: -1 }] }],
    ['pie with all zeros', { ...pie, data: [{ label: 'A', value: 0 }] }],
    ['pie with stacked', { ...pie, stacked: true }],
    ['scatter with label/value points', { type: 'scatter', title: 'T', data: spec.data }],
    ['scatter with string x', { type: 'scatter', title: 'T', data: [{ x: '1', y: 2 }] }],
    ['scatter with huge y', { type: 'scatter', title: 'T', data: [{ x: 1, y: 1e13 }] }],
    [
      'scatter with blank label',
      { type: 'scatter', title: 'T', data: [{ x: 1, y: 2, label: '' }] },
    ],
    ['category points with x/y', { type: 'bar', title: 'T', data: [{ x: 1, y: 2 }] }],
    ['long xLabel', { ...spec, xLabel: 'x'.repeat(121) }],
  ])('rejects %s', (_, value) => {
    expect(parse(value)).toBeNull();
  });
  test('multi-series rows join by label and leave missing values as gaps, not zero', () => {
    const table = categoryTable(parse({ type: 'bar', title: 'T', series }) as CategoryChartSpec);
    expect(table.names).toEqual(['Open', 'Closed']);
    expect(table.rows).toEqual([
      { label: 'Mon', s0: 3, s1: 2 },
      { label: 'Tue', s0: 1 },
      { label: 'Wed', s1: 4 },
    ]);
  });
  test('CSV export quotes separators, keeps gaps empty and neutralises formulas', () => {
    const chart = parse({ type: 'bar', title: 'T', xLabel: 'Day', series });
    expect(chartToCsv(chart!)).toBe('Day,Open,Closed\nMon,3,2\nTue,1,\nWed,,4');
    const risky = parse({
      type: 'pie',
      title: 'T',
      data: [
        { label: '=HYPERLINK("x")', value: 1 },
        { label: 'a, b', value: 2 },
      ],
    });
    expect(chartToCsv(risky!)).toBe('label,value\n"\'=HYPERLINK(""x"")",1\n"a, b",2');
    const scatter = parse({ type: 'scatter', title: 'T', data: [{ x: 1, y: -2, label: 'P' }] });
    expect(chartToCsv(scatter!)).toBe('label,x,y\nP,1,-2');
  });
  test('instructions document each family and keep the evidence rules', () => {
    for (const word of [
      '"series"',
      '"stacked":true',
      '"orientation":"horizontal"',
      '"type":"pie"',
      '"type":"scatter"',
      'donut',
      'radar',
      'table',
    ])
      expect(CHART_INSTRUCTIONS).toContain(word);
    expect(CHART_INSTRUCTIONS).toContain('Never invent values or treat missing data as zero.');
  });
});
