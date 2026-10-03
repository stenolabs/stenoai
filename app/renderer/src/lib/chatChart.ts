export interface ChatChartSpec {
  type: 'bar' | 'line';
  title: string;
  xLabel: string;
  yLabel: string;
  data: { label: string; value: number }[];
}

export const CHART_COPY = { loading: 'Loading chart…', data: 'View data' };

/** Pick one notation for the whole axis, including ticks near zero. */
export function chartTickFormatter(data: ChatChartSpec['data'], locale?: string) {
  const magnitude = Math.max(...data.map(({ value }) => Math.abs(value)));
  return new Intl.NumberFormat(locale, {
    notation: magnitude > 0 && magnitude < 0.0001 ? 'scientific' : 'compact',
    maximumSignificantDigits: 4,
  }).format;
}

// Keep in sync with src/chat_charts.py. Only inline data is accepted; model
// output never becomes executable code, a URL, or arbitrary chart props.
export const CHART_INSTRUCTIONS = `When the user asks for a chart and the supplied notes contain enough numeric data, include a fenced steno-chart JSON block with this shape:
{"type":"bar","title":"Chart title","xLabel":"Category","yLabel":"Count","data":[{"label":"Example","value":3}]}
Use type bar for comparisons or line for ordered trends. Use at most 100 data points, finite numbers between -1e12 and 1e12, and labels of at most 120 characters. Use only these fields. Keep the JSON under 50000 characters and close the code fence.
Chart only numbers explicitly present in, or directly countable from, the supplied notes. Never invent values or treat missing data as zero. Explain the source, units, scope, and any omissions in the surrounding text. If there is not enough numeric evidence, explain that instead of drawing a chart. Do not produce charts unless requested.`;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);
const isLabel = (value: unknown): value is string =>
  typeof value === 'string' && value.trim().length > 0 && value.length <= 120;

export function parseChatChart(source: string): ChatChartSpec | null {
  if (source.length > 50000) return null;
  try {
    const spec: unknown = JSON.parse(source);
    if (!isRecord(spec) || (spec.type !== 'bar' && spec.type !== 'line')) return null;
    if (
      Object.keys(spec).some((key) => !['type', 'title', 'xLabel', 'yLabel', 'data'].includes(key))
    )
      return null;
    if (!isLabel(spec.title) || !isLabel(spec.xLabel) || !isLabel(spec.yLabel)) return null;
    if (!Array.isArray(spec.data) || spec.data.length === 0 || spec.data.length > 100) return null;
    const data: ChatChartSpec['data'] = [];
    for (const point of spec.data) {
      if (!isRecord(point) || Object.keys(point).some((key) => key !== 'label' && key !== 'value'))
        return null;
      if (
        !isLabel(point.label) ||
        typeof point.value !== 'number' ||
        !Number.isFinite(point.value) ||
        Math.abs(point.value) > 1e12
      )
        return null;
      data.push({ label: point.label, value: point.value });
    }
    return { type: spec.type, title: spec.title, xLabel: spec.xLabel, yLabel: spec.yLabel, data };
  } catch {
    return null;
  }
}
