import * as React from 'react';
import {
  Bar,
  BarChart,
  CartesianGrid,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import { CHART_COPY, type ChatChartSpec } from '@/lib/chatChart';

const compactNumber = new Intl.NumberFormat(undefined, {
  notation: 'compact',
  maximumSignificantDigits: 3,
});

export default function ChatChart({ spec }: { spec: ChatChartSpec }) {
  const titleId = React.useId();
  const Chart = spec.type === 'bar' ? BarChart : LineChart;
  return (
    <figure
      data-chat-chart
      aria-labelledby={titleId}
      className="my-3 min-w-0 rounded-xl border p-4"
      style={{ borderColor: 'var(--border-subtle)', background: 'var(--surface-raised)' }}
    >
      <figcaption id={titleId} className="mb-1 text-sm font-medium">
        {spec.title}
      </figcaption>
      <p className="mb-3 text-xs" style={{ color: 'var(--fg-2)' }}>
        {spec.yLabel}
      </p>
      <div style={{ width: '100%', height: 240 }}>
        <ResponsiveContainer width="100%" height="100%" minWidth={0}>
          <Chart
            data={spec.data}
            accessibilityLayer
            margin={{ top: 8, right: 16, bottom: 0, left: 0 }}
          >
            <CartesianGrid vertical={false} stroke="var(--border-subtle)" />
            <XAxis
              dataKey="label"
              tick={{ fill: 'var(--fg-2)', fontSize: 11 }}
              tickLine={false}
              axisLine={false}
              tickFormatter={(value: string) =>
                value.length > 18 ? `${value.slice(0, 17)}…` : value
              }
            />
            <YAxis
              tickFormatter={(value: number) =>
                value !== 0 && Math.abs(value) < 0.01
                  ? value.toExponential(1)
                  : compactNumber.format(value)
              }
              tick={{ fill: 'var(--fg-2)', fontSize: 11 }}
              tickLine={false}
              axisLine={false}
              width={65}
            />
            <Tooltip
              contentStyle={{
                background: 'var(--surface-raised)',
                borderColor: 'var(--border-subtle)',
                color: 'var(--fg-1)',
                borderRadius: 8,
                fontSize: 12,
              }}
              itemStyle={{ color: 'var(--fg-1)' }}
              cursor={{ stroke: 'var(--fg-muted)', fill: 'var(--surface-hover)' }}
            />
            {spec.type === 'bar' ? (
              <Bar
                dataKey="value"
                name={spec.yLabel}
                fill="var(--fg-1)"
                maxBarSize={48}
                radius={[3, 3, 0, 0]}
                isAnimationActive={false}
              />
            ) : (
              <Line
                dataKey="value"
                name={spec.yLabel}
                stroke="var(--fg-1)"
                strokeWidth={2}
                dot={{ r: 3, fill: 'var(--fg-1)' }}
                isAnimationActive={false}
              />
            )}
          </Chart>
        </ResponsiveContainer>
      </div>
      <p className="mt-1 text-center text-xs" style={{ color: 'var(--fg-2)' }}>
        {spec.xLabel}
      </p>
      <details className="mt-4 text-xs">
        <summary className="cursor-pointer" style={{ color: 'var(--fg-2)' }}>
          {CHART_COPY.data}
        </summary>
        <div className="mt-2 max-h-64 overflow-auto">
          <table className="w-full text-left">
            <thead>
              <tr>
                <th scope="col" className="p-2">
                  {spec.xLabel}
                </th>
                <th scope="col" className="p-2">
                  {spec.yLabel}
                </th>
              </tr>
            </thead>
            <tbody>
              {spec.data.map((point, index) => (
                <tr key={index}>
                  <td className="break-words p-2">{point.label}</td>
                  <td className="p-2 tabular-nums">{point.value}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </details>
    </figure>
  );
}
