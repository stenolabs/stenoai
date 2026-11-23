import * as React from 'react';
import {
  Area,
  AreaChart,
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  Legend,
  Line,
  LineChart,
  Pie,
  PieChart,
  PolarAngleAxis,
  PolarGrid,
  PolarRadiusAxis,
  Radar,
  RadarChart,
  ResponsiveContainer,
  Scatter,
  ScatterChart,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import {
  categoryTable,
  chartTickFormatter,
  chartToCsv,
  isPieChart,
  scatterSeries,
  type CategoryChartSpec,
  type ChartPoint,
  type ChatChartSpec,
  type PieChartSpec,
  type ScatterChartSpec,
} from '@/lib/chatChart';
import { t } from '@/i18n';

// Series hues come from globals.css (--chart-1..8, light and dark). A single
// series keeps the ink foreground so the brand stays neutral by default.
const PALETTE = Array.from({ length: 8 }, (_, i) => `var(--chart-${i + 1})`);
const seriesColor = (index: number, count: number) =>
  count === 1 ? 'var(--fg-1)' : PALETTE[index % PALETTE.length];

const TICK = { fill: 'var(--fg-2)', fontSize: 11 };
const TOOLTIP = {
  contentStyle: {
    background: 'var(--surface-raised)',
    borderColor: 'var(--border-subtle)',
    color: 'var(--fg-1)',
    borderRadius: 8,
    fontSize: 12,
  },
  itemStyle: { color: 'var(--fg-1)' },
  labelStyle: { color: 'var(--fg-2)' },
};
const truncate = (value: unknown) => {
  const text = String(value);
  return text.length > 18 ? `${text.slice(0, 17)}…` : text;
};
const legendText = (value: string) => <span style={{ color: 'var(--fg-2)' }}>{value}</span>;
// Keep the legend in series (or slice) order rather than sorting it by name.
const LEGEND = {
  wrapperStyle: { fontSize: 12 },
  formatter: legendText,
  iconSize: 10,
  itemSorter: null,
};

function CategoryPlot({ spec }: { spec: CategoryChartSpec }) {
  const table = categoryTable(spec);
  const count = table.names.length;
  const values = table.rows.flatMap((row) =>
    table.names.flatMap((_, s) => {
      const v = row[`s${s}`];
      return typeof v === 'number' ? [{ value: v }] : [];
    })
  );
  const formatTick = chartTickFormatter(values);
  const showLegend = count > 1;

  if (spec.type === 'radar') {
    return (
      <RadarChart data={table.rows} outerRadius="72%" accessibilityLayer>
        <PolarGrid stroke="var(--border-strong)" />
        <PolarAngleAxis dataKey="label" tick={TICK} tickFormatter={truncate} />
        <PolarRadiusAxis tick={TICK} tickFormatter={formatTick} axisLine={false} angle={90} />
        <Tooltip {...TOOLTIP} />
        {table.names.map((name, s) => (
          <Radar
            key={name}
            dataKey={`s${s}`}
            name={name}
            stroke={seriesColor(s, count)}
            fill={seriesColor(s, count)}
            fillOpacity={0.12}
            strokeWidth={2}
            isAnimationActive={false}
          />
        ))}
        {showLegend && <Legend {...LEGEND} />}
      </RadarChart>
    );
  }

  const horizontal = spec.type === 'bar' && spec.orientation === 'horizontal';
  const stackId = spec.stacked ? 'stack' : undefined;
  const longest = Math.max(...table.rows.map((row) => truncate(row.label).length));
  const categoryAxis = horizontal ? (
    <YAxis
      type="category"
      dataKey="label"
      tick={TICK}
      tickLine={false}
      axisLine={false}
      tickFormatter={truncate}
      width={Math.min(160, Math.max(56, longest * 7))}
    />
  ) : (
    <XAxis dataKey="label" tick={TICK} tickLine={false} axisLine={false} tickFormatter={truncate} />
  );
  const valueAxis = horizontal ? (
    <XAxis type="number" tickFormatter={formatTick} tick={TICK} tickLine={false} axisLine={false} />
  ) : (
    <YAxis tickFormatter={formatTick} tick={TICK} tickLine={false} axisLine={false} width={65} />
  );
  const common = {
    data: table.rows,
    accessibilityLayer: true,
    margin: { top: 8, right: 16, bottom: 0, left: 0 },
  };
  const grid = (
    <CartesianGrid vertical={horizontal} horizontal={!horizontal} stroke="var(--border-subtle)" />
  );
  const tooltip = (
    <Tooltip {...TOOLTIP} cursor={{ stroke: 'var(--fg-muted)', fill: 'var(--surface-hover)' }} />
  );

  if (spec.type === 'line') {
    return (
      <LineChart {...common}>
        {grid}
        {categoryAxis}
        {valueAxis}
        {tooltip}
        {table.names.map((name, s) => (
          <Line
            key={name}
            dataKey={`s${s}`}
            name={name}
            stroke={seriesColor(s, count)}
            strokeWidth={2}
            dot={{ r: 3, fill: seriesColor(s, count) }}
            isAnimationActive={false}
          />
        ))}
        {showLegend && <Legend {...LEGEND} />}
      </LineChart>
    );
  }
  if (spec.type === 'area') {
    return (
      <AreaChart {...common}>
        {grid}
        {categoryAxis}
        {valueAxis}
        {tooltip}
        {table.names.map((name, s) => (
          <Area
            key={name}
            dataKey={`s${s}`}
            name={name}
            stackId={stackId}
            stroke={seriesColor(s, count)}
            fill={seriesColor(s, count)}
            fillOpacity={spec.stacked ? 0.35 : 0.12}
            strokeWidth={2}
            isAnimationActive={false}
          />
        ))}
        {showLegend && <Legend {...LEGEND} />}
      </AreaChart>
    );
  }
  // Bar. Only the outer end of a bar (or the top of a stack) is rounded.
  const rounded: [number, number, number, number] = horizontal ? [0, 3, 3, 0] : [3, 3, 0, 0];
  return (
    <BarChart {...common} layout={horizontal ? 'vertical' : 'horizontal'}>
      {grid}
      {categoryAxis}
      {valueAxis}
      {tooltip}
      {table.names.map((name, s) => (
        <Bar
          key={name}
          dataKey={`s${s}`}
          name={name}
          stackId={stackId}
          fill={seriesColor(s, count)}
          stroke={count > 1 ? 'var(--surface-raised)' : undefined}
          strokeWidth={count > 1 ? 1 : undefined}
          maxBarSize={48}
          radius={!stackId || s === count - 1 ? rounded : undefined}
          isAnimationActive={false}
        />
      ))}
      {showLegend && <Legend {...LEGEND} />}
    </BarChart>
  );
}

/** Pie slices past the palette fold into one "Other" slice; the table keeps every row. */
function pieSlices(data: ChartPoint[]): ChartPoint[] {
  if (data.length <= PALETTE.length) return data;
  const sorted = [...data].sort((a, b) => b.value - a.value);
  const kept = sorted.slice(0, PALETTE.length - 1);
  const rest = sorted.slice(PALETTE.length - 1).reduce((sum, { value }) => sum + value, 0);
  return [...kept, { label: t('chat.chart.other'), value: rest }];
}

function PiePlot({ spec }: { spec: PieChartSpec }) {
  const slices = pieSlices(spec.data);
  return (
    <PieChart accessibilityLayer>
      <Tooltip {...TOOLTIP} />
      <Pie
        data={slices}
        dataKey="value"
        nameKey="label"
        innerRadius={spec.type === 'donut' ? '55%' : 0}
        outerRadius="80%"
        stroke="var(--surface-raised)"
        strokeWidth={2}
        isAnimationActive={false}
      >
        {slices.map((slice, i) => (
          <Cell key={`${slice.label}-${i}`} fill={PALETTE[i % PALETTE.length]} />
        ))}
      </Pie>
      <Legend {...LEGEND} />
    </PieChart>
  );
}

function ScatterPlot({ spec }: { spec: ScatterChartSpec }) {
  const series = scatterSeries(spec);
  const points = series.flatMap(({ data }) => data);
  const formatX = chartTickFormatter(points.map(({ x }) => ({ value: x })));
  const formatY = chartTickFormatter(points.map(({ y }) => ({ value: y })));
  return (
    <ScatterChart accessibilityLayer margin={{ top: 8, right: 16, bottom: 0, left: 0 }}>
      <CartesianGrid stroke="var(--border-subtle)" />
      <XAxis
        type="number"
        dataKey="x"
        name={spec.xLabel ?? 'x'}
        tickFormatter={formatX}
        tick={TICK}
        tickLine={false}
        axisLine={false}
      />
      <YAxis
        type="number"
        dataKey="y"
        name={spec.yLabel ?? 'y'}
        tickFormatter={formatY}
        tick={TICK}
        tickLine={false}
        axisLine={false}
        width={65}
      />
      <Tooltip
        {...TOOLTIP}
        cursor={{ stroke: 'var(--fg-muted)' }}
        labelFormatter={(_, payload) => {
          const point = payload?.[0]?.payload as { label?: string } | undefined;
          return point?.label ?? '';
        }}
      />
      {series.map((entry, s) => (
        <Scatter
          key={entry.name}
          name={entry.name}
          data={entry.data}
          fill={seriesColor(s, series.length)}
          stroke="var(--surface-raised)"
          strokeWidth={1.5}
          isAnimationActive={false}
        />
      ))}
      {series.length > 1 && <Legend {...LEGEND} />}
    </ScatterChart>
  );
}

function DataTable({ spec }: { spec: ChatChartSpec }) {
  let head: string[];
  let body: (string | number | undefined)[][];
  if (spec.type === 'scatter') {
    const multi = Boolean(spec.series);
    head = [...(multi ? [''] : []), '', spec.xLabel ?? 'x', spec.yLabel ?? 'y'];
    body = scatterSeries(spec).flatMap((entry) =>
      entry.data.map((p) => [...(multi ? [entry.name] : []), p.label, p.x, p.y])
    );
  } else if (isPieChart(spec)) {
    head = [spec.xLabel ?? '', spec.yLabel ?? ''];
    body = spec.data.map((p) => [p.label, p.value]);
  } else {
    const table = categoryTable(spec);
    head = [spec.xLabel ?? '', ...table.names];
    body = table.rows.map((row) => [row.label, ...table.names.map((_, s) => row[`s${s}`])]);
  }
  return (
    <table className="w-full text-left">
      <thead>
        <tr>
          {head.map((cell, i) => (
            <th key={i} scope="col" className="p-2">
              {cell}
            </th>
          ))}
        </tr>
      </thead>
      <tbody>
        {body.map((row, r) => (
          <tr key={r}>
            {row.map((cell, c) => (
              <td
                key={c}
                className={typeof cell === 'number' ? 'p-2 tabular-nums' : 'break-words p-2'}
              >
                {cell}
              </td>
            ))}
          </tr>
        ))}
      </tbody>
    </table>
  );
}

const INLINE_STYLES = [
  'fill',
  'fill-opacity',
  'stroke',
  'stroke-width',
  'stroke-opacity',
  'stroke-dasharray',
  'opacity',
  'font-family',
  'font-size',
  'font-weight',
  'text-anchor',
  'dominant-baseline',
] as const;

/**
 * Rasterise the figure locally: inline the computed theme colours into a
 * clone of the SVG (CSS variables do not survive serialisation), draw it on
 * a canvas with the title and legend, and return a PNG. No network access.
 */
async function chartToPng(figure: HTMLElement, title: string): Promise<Blob> {
  const svg = figure.querySelector<SVGSVGElement>('.recharts-wrapper > svg.recharts-surface');
  if (!svg) throw new Error('No chart surface');
  const { width, height } = svg.getBoundingClientRect();
  const clone = svg.cloneNode(true) as SVGSVGElement;
  const source = [svg, ...svg.querySelectorAll('*')];
  const target = [clone, ...clone.querySelectorAll('*')];
  source.forEach((node, i) => {
    const computed = getComputedStyle(node);
    const style = INLINE_STYLES.map((p) => `${p}:${computed.getPropertyValue(p)}`).join(';');
    target[i]?.setAttribute('style', style);
  });
  clone.setAttribute('xmlns', 'http://www.w3.org/2000/svg');
  clone.setAttribute('width', String(width));
  clone.setAttribute('height', String(height));
  const url = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(
    new XMLSerializer().serializeToString(clone)
  )}`;
  const image = new Image();
  await new Promise<void>((resolve, reject) => {
    image.onload = () => resolve();
    image.onerror = () => reject(new Error('Chart image failed to load'));
    image.src = url;
  });

  const figureStyle = getComputedStyle(figure);
  const legend = [...figure.querySelectorAll<HTMLElement>('.recharts-legend-item')].map((item) => {
    const icon = item.querySelector('path, rect');
    return { text: item.textContent ?? '', color: icon ? getComputedStyle(icon).fill : '' };
  });
  const pad = 16;
  const titleHeight = 28;
  const scale = 2;
  const canvas = document.createElement('canvas');
  canvas.width = (width + pad * 2) * scale;
  canvas.height = (height + pad * 2 + titleHeight) * scale;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('Canvas unavailable');
  ctx.scale(scale, scale);
  ctx.fillStyle = figureStyle.backgroundColor || '#ffffff';
  ctx.fillRect(0, 0, width + pad * 2, height + pad * 2 + titleHeight);
  ctx.fillStyle = figureStyle.color;
  ctx.font = `500 14px ${figureStyle.fontFamily}`;
  ctx.textBaseline = 'top';
  ctx.fillText(title, pad, pad);
  ctx.drawImage(image, pad, pad + titleHeight, width, height);
  // The legend is HTML outside the SVG; redraw it along the bottom edge.
  if (legend.length) {
    ctx.font = `12px ${figureStyle.fontFamily}`;
    let x = pad;
    const y = pad + titleHeight + height - 16;
    for (const item of legend) {
      ctx.fillStyle = item.color || figureStyle.color;
      ctx.fillRect(x, y + 1, 10, 10);
      ctx.fillStyle = figureStyle.color;
      ctx.fillText(item.text, x + 14, y);
      x += 14 + ctx.measureText(item.text).width + 16;
    }
  }
  return new Promise((resolve, reject) =>
    canvas.toBlob(
      (blob) => (blob ? resolve(blob) : reject(new Error('Encode failed'))),
      'image/png'
    )
  );
}

type CopyState = 'idle' | 'image' | 'data' | 'failed';

export default function ChatChart({ spec }: { spec: ChatChartSpec }) {
  const titleId = React.useId();
  const figureRef = React.useRef<HTMLElement>(null);
  const [copied, setCopied] = React.useState<CopyState>('idle');
  React.useEffect(() => {
    if (copied === 'idle') return;
    const timer = window.setTimeout(() => setCopied('idle'), 2000);
    return () => window.clearTimeout(timer);
  }, [copied]);

  const copyImage = async () => {
    try {
      if (!figureRef.current) throw new Error('Chart not mounted');
      const blob = await chartToPng(figureRef.current, spec.title);
      await navigator.clipboard.write([new ClipboardItem({ 'image/png': blob })]);
      setCopied('image');
    } catch {
      setCopied('failed');
    }
  };
  const copyData = async () => {
    try {
      await navigator.clipboard.writeText(chartToCsv(spec));
      setCopied('data');
    } catch {
      setCopied('failed');
    }
  };

  const cartesian = spec.type !== 'pie' && spec.type !== 'donut' && spec.type !== 'radar';
  const isTable = spec.type === 'table';
  const buttonClass =
    'rounded-md px-2 py-1 text-xs transition-colors hover:bg-[var(--surface-hover)] focus-visible:outline focus-visible:outline-2 focus-visible:outline-[var(--focus-ring)]';

  let plot: React.ReactElement | null = null;
  if (isPieChart(spec)) plot = <PiePlot spec={spec} />;
  else if (spec.type === 'scatter') plot = <ScatterPlot spec={spec} />;
  else if (!isTable) plot = <CategoryPlot spec={spec} />;
  const multi = !isPieChart(spec) && Boolean(spec.series);
  const height =
    spec.type === 'pie' || spec.type === 'donut' || spec.type === 'radar' || multi ? 280 : 240;

  return (
    <figure
      ref={figureRef}
      data-chat-chart
      data-chart-type={spec.type}
      aria-labelledby={titleId}
      className="my-3 min-w-0 rounded-xl border p-4"
      style={{
        borderColor: 'var(--border-subtle)',
        background: 'var(--surface-raised)',
        color: 'var(--fg-1)',
      }}
    >
      <div className="mb-1 flex items-start justify-between gap-2">
        <figcaption id={titleId} className="text-sm font-medium">
          {spec.title}
        </figcaption>
        <div className="flex shrink-0 items-center gap-1" style={{ color: 'var(--fg-2)' }}>
          <span role="status" aria-live="polite" className="text-xs">
            {copied === 'failed'
              ? t('chat.chart.copyFailed')
              : copied !== 'idle'
                ? t('chat.chart.copied')
                : null}
          </span>
          {plot && (
            <button type="button" className={buttonClass} onClick={() => void copyImage()}>
              {t('chat.chart.copyImage')}
            </button>
          )}
          <button type="button" className={buttonClass} onClick={() => void copyData()}>
            {t('chat.chart.copyData')}
          </button>
        </div>
      </div>
      {isTable || !plot ? (
        <div className="mt-2 max-h-80 overflow-auto text-xs">
          <DataTable spec={spec} />
        </div>
      ) : (
        <>
          {cartesian && spec.yLabel && (
            <p className="mb-3 text-xs" style={{ color: 'var(--fg-2)' }}>
              {spec.yLabel}
            </p>
          )}
          <div style={{ width: '100%', height }}>
            <ResponsiveContainer width="100%" height="100%" minWidth={0}>
              {plot}
            </ResponsiveContainer>
          </div>
          {cartesian && spec.xLabel && (
            <p className="mt-1 text-center text-xs" style={{ color: 'var(--fg-2)' }}>
              {spec.xLabel}
            </p>
          )}
          <details className="mt-4 text-xs">
            <summary className="cursor-pointer" style={{ color: 'var(--fg-2)' }}>
              {t('chat.chart.viewData')}
            </summary>
            <div className="mt-2 max-h-64 overflow-auto">
              <DataTable spec={spec} />
            </div>
          </details>
        </>
      )}
    </figure>
  );
}
