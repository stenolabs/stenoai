export type ChartType = 'bar' | 'line' | 'area' | 'pie' | 'donut' | 'scatter' | 'radar' | 'table';

export interface ChartPoint {
  label: string;
  value: number;
}
export interface ScatterPoint {
  x: number;
  y: number;
  label?: string;
}
export interface ChartSeries<P> {
  name: string;
  data: P[];
}

interface ChartBase {
  title: string;
  xLabel?: string;
  yLabel?: string;
}
/** Category charts: one series in `data`, or several in `series`. */
export interface CategoryChartSpec extends ChartBase {
  type: 'bar' | 'line' | 'area' | 'radar' | 'table';
  data?: ChartPoint[];
  series?: ChartSeries<ChartPoint>[];
  stacked?: boolean;
  orientation?: 'horizontal' | 'vertical';
}
export interface PieChartSpec extends ChartBase {
  type: 'pie' | 'donut';
  data: ChartPoint[];
}
export interface ScatterChartSpec extends ChartBase {
  type: 'scatter';
  data?: ScatterPoint[];
  series?: ChartSeries<ScatterPoint>[];
}
export type ChatChartSpec = CategoryChartSpec | PieChartSpec | ScatterChartSpec;

export const isPieChart = (spec: ChatChartSpec): spec is PieChartSpec =>
  spec.type === 'pie' || spec.type === 'donut';

export const CHART_LIMITS = {
  points: 100,
  series: 8,
  label: 120,
  magnitude: 1e12,
  source: 50000,
} as const;

/** Pick one notation for the whole axis, including ticks near zero. */
export function chartTickFormatter<T extends { value: number }>(
  data: readonly T[],
  locale?: string
) {
  const magnitude = Math.max(0, ...data.map(({ value }) => Math.abs(value)));
  return new Intl.NumberFormat(locale, {
    notation: magnitude > 0 && magnitude < 0.0001 ? 'scientific' : 'compact',
    maximumSignificantDigits: 4,
  }).format;
}

// Keep in sync with src/chat_charts.py. Only inline data is accepted; model
// output never becomes executable code, a URL, or arbitrary chart props.
export const CHART_INSTRUCTIONS = `This app renders fenced steno-chart JSON blocks as real charts, so you can draw charts: never say you cannot display or create charts. When the user asks for a chart, graph or plot, answer with a short explanation and a steno-chart block. Examples:
One series: {"type":"bar","title":"Actions by meeting","xLabel":"Meeting","yLabel":"Actions","data":[{"label":"Planning","value":3}]}
Several series: {"type":"bar","title":"Tickets by day","xLabel":"Day","yLabel":"Tickets","stacked":true,"series":[{"name":"Open","data":[{"label":"Mon","value":3}]},{"name":"Closed","data":[{"label":"Mon","value":2}]}]}
Shares: {"type":"pie","title":"Time by topic","data":[{"label":"Hiring","value":20}]}
Scatter: {"type":"scatter","title":"Length vs actions","xLabel":"Minutes","yLabel":"Actions","data":[{"x":30,"y":4,"label":"Planning"}]}
Types: bar for comparisons (add "orientation":"horizontal" for long labels, "stacked":true for parts of a whole), line or area for ordered trends (area may be stacked), pie or donut for shares of one total (data only, values 0 or more), radar for 3 or more categories, scatter for two numbers per item, table for exact values. Use data for one series or series for several, never both.
Use at most 8 series of at most 100 points, finite numbers between -1e12 and 1e12, and labels of at most 120 characters. Use only these fields. Keep the JSON under 50000 characters and close the code fence.
Data rules: for questions about the user's meetings or notes, chart only numbers explicitly present in, or directly countable from, the supplied notes; never invent values or treat missing data as zero. Numbers the user gives in the conversation may be charted as given. For general-knowledge questions the notes do not cover, you may chart widely known public figures from your own knowledge: prefer a few well-known points, and say in the title or text that the values are approximate, from general knowledge rather than the user's notes, and the period covered. Explain the source, units, scope, and any omissions in the surrounding text. If there is not enough evidence, explain that instead of drawing a chart. Do not produce charts unless requested.`;

const TYPES: readonly ChartType[] = [
  'bar',
  'line',
  'area',
  'pie',
  'donut',
  'scatter',
  'radar',
  'table',
];
const COMMON_KEYS = ['type', 'title', 'xLabel', 'yLabel', 'data', 'series'];
const EXTRA_KEYS: Partial<Record<ChartType, string[]>> = {
  bar: ['stacked', 'orientation'],
  area: ['stacked'],
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);
const isLabel = (value: unknown): value is string =>
  typeof value === 'string' && value.trim().length > 0 && value.length <= CHART_LIMITS.label;
const isNumber = (value: unknown): value is number =>
  typeof value === 'number' && Number.isFinite(value) && Math.abs(value) <= CHART_LIMITS.magnitude;
const hasOnly = (record: Record<string, unknown>, keys: readonly string[]) =>
  Object.keys(record).every((key) => keys.includes(key));

function parsePoints(value: unknown, nonNegative = false): ChartPoint[] | null {
  if (!Array.isArray(value) || value.length === 0 || value.length > CHART_LIMITS.points)
    return null;
  const points: ChartPoint[] = [];
  for (const point of value) {
    if (!isRecord(point) || !hasOnly(point, ['label', 'value'])) return null;
    if (!isLabel(point.label) || !isNumber(point.value)) return null;
    if (nonNegative && point.value < 0) return null;
    points.push({ label: point.label, value: point.value });
  }
  return points;
}

function parseScatter(value: unknown): ScatterPoint[] | null {
  if (!Array.isArray(value) || value.length === 0 || value.length > CHART_LIMITS.points)
    return null;
  const points: ScatterPoint[] = [];
  for (const point of value) {
    if (!isRecord(point) || !hasOnly(point, ['x', 'y', 'label'])) return null;
    if (!isNumber(point.x) || !isNumber(point.y)) return null;
    if (point.label !== undefined && !isLabel(point.label)) return null;
    points.push(
      point.label === undefined
        ? { x: point.x, y: point.y }
        : { x: point.x, y: point.y, label: point.label }
    );
  }
  return points;
}

function parseSeries<P>(
  value: unknown,
  parse: (data: unknown) => P[] | null,
  uniqueLabels: (data: P[]) => boolean
): ChartSeries<P>[] | null {
  if (!Array.isArray(value) || value.length === 0 || value.length > CHART_LIMITS.series)
    return null;
  const names = new Set<string>();
  const series: ChartSeries<P>[] = [];
  for (const entry of value) {
    if (!isRecord(entry) || !hasOnly(entry, ['name', 'data']) || !isLabel(entry.name)) return null;
    if (names.has(entry.name)) return null;
    names.add(entry.name);
    const data = parse(entry.data);
    if (!data || !uniqueLabels(data)) return null;
    series.push({ name: entry.name, data });
  }
  return series;
}

const distinctLabels = (data: ChartPoint[]) =>
  new Set(data.map(({ label }) => label)).size === data.length;

export function parseChatChart(source: string): ChatChartSpec | null {
  if (source.length > CHART_LIMITS.source) return null;
  let spec: unknown;
  try {
    spec = JSON.parse(source);
  } catch {
    return null;
  }
  if (!isRecord(spec) || !TYPES.includes(spec.type as ChartType)) return null;
  const type = spec.type as ChartType;
  if (!hasOnly(spec, [...COMMON_KEYS, ...(EXTRA_KEYS[type] ?? [])])) return null;
  if (!isLabel(spec.title)) return null;
  for (const key of ['xLabel', 'yLabel'] as const)
    if (spec[key] !== undefined && !isLabel(spec[key])) return null;
  if (spec.stacked !== undefined && typeof spec.stacked !== 'boolean') return null;
  if (
    spec.orientation !== undefined &&
    spec.orientation !== 'horizontal' &&
    spec.orientation !== 'vertical'
  )
    return null;
  // Exactly one of data / series.
  if ((spec.data === undefined) === (spec.series === undefined)) return null;

  const base: ChartBase = { title: spec.title };
  if (spec.xLabel !== undefined) base.xLabel = spec.xLabel as string;
  if (spec.yLabel !== undefined) base.yLabel = spec.yLabel as string;

  if (type === 'pie' || type === 'donut') {
    if (spec.series !== undefined) return null;
    const data = parsePoints(spec.data, true);
    if (!data || !data.some(({ value }) => value > 0)) return null;
    return { type, ...base, data };
  }
  if (type === 'scatter') {
    if (spec.data !== undefined) {
      const data = parseScatter(spec.data);
      return data ? { type, ...base, data } : null;
    }
    const series = parseSeries(spec.series, parseScatter, () => true);
    return series ? { type, ...base, series } : null;
  }
  const result: CategoryChartSpec = { type, ...base };
  if (spec.data !== undefined) {
    // A single series may repeat labels (rows render by position).
    const data = parsePoints(spec.data);
    if (!data) return null;
    result.data = data;
  } else {
    // Several series are joined by label, so labels must be unambiguous.
    const series = parseSeries(spec.series, (data) => parsePoints(data), distinctLabels);
    if (!series) return null;
    result.series = series;
  }
  if (spec.stacked !== undefined) result.stacked = spec.stacked as boolean;
  if (spec.orientation !== undefined)
    result.orientation = spec.orientation as CategoryChartSpec['orientation'];
  return result;
}

/** A category chart as rows for recharts: one row per label, one key per series. */
export interface CategoryTable {
  names: string[];
  rows: Record<string, string | number | undefined>[];
}

/**
 * Join category series by label in first-seen order. A label a series does
 * not mention stays undefined (a gap), never zero.
 */
export function categoryTable(spec: CategoryChartSpec): CategoryTable {
  if (spec.data) {
    const name = spec.yLabel ?? spec.title;
    return {
      names: [name],
      rows: spec.data.map(({ label, value }) => ({ label, s0: value })),
    };
  }
  const series = spec.series ?? [];
  const rows: CategoryTable['rows'] = [];
  const index = new Map<string, number>();
  series.forEach((entry, s) => {
    for (const { label, value } of entry.data) {
      let row = index.get(label);
      if (row === undefined) {
        row = rows.length;
        index.set(label, row);
        rows.push({ label });
      }
      rows[row][`s${s}`] = value;
    }
  });
  return { names: series.map(({ name }) => name), rows };
}

export function scatterSeries(spec: ScatterChartSpec): ChartSeries<ScatterPoint>[] {
  return spec.data ? [{ name: spec.yLabel ?? spec.title, data: spec.data }] : (spec.series ?? []);
}

const csvCell = (value: string | number | undefined) => {
  if (value === undefined) return '';
  const text = String(value);
  // Quote separators and neutralise spreadsheet formula prefixes.
  const safe = /^[=+\-@\t\r]/.test(text) && typeof value === 'string' ? `'${text}` : text;
  return /[",\n\r]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
};

/** The chart's data as CSV, with headers from the chart's own labels. */
export function chartToCsv(spec: ChatChartSpec): string {
  const lines: (string | number | undefined)[][] = [];
  if (spec.type === 'scatter') {
    const series = scatterSeries(spec);
    const multi = Boolean(spec.series);
    lines.push([...(multi ? ['series'] : []), 'label', spec.xLabel ?? 'x', spec.yLabel ?? 'y']);
    for (const entry of series)
      for (const point of entry.data)
        lines.push([...(multi ? [entry.name] : []), point.label, point.x, point.y]);
  } else if (isPieChart(spec)) {
    lines.push([spec.xLabel ?? 'label', spec.yLabel ?? 'value']);
    for (const point of spec.data) lines.push([point.label, point.value]);
  } else {
    const table = categoryTable(spec);
    lines.push([spec.xLabel ?? 'label', ...table.names]);
    for (const row of table.rows)
      lines.push([row.label, ...table.names.map((_, s) => row[`s${s}`])]);
  }
  return lines.map((line) => line.map(csvCell).join(',')).join('\n');
}
