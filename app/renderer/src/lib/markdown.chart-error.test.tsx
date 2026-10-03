import * as React from 'react';
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, expect, test, vi } from 'vitest';
import { renderMarkdown } from './markdown';
import { ChartErrorBoundary } from '@/components/ChartErrorBoundary';

vi.mock('@/components/ChatChart', () => ({
  default: () => {
    throw new Error('Chart renderer failed');
  },
}));
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

test('a chart render failure preserves its data and the surrounding conversation', async () => {
  vi.spyOn(console, 'error').mockImplementation(() => {});
  const source = JSON.stringify({
    type: 'bar',
    title: 'Actions',
    xLabel: 'Meeting',
    yLabel: 'Count',
    data: [{ label: 'Planning', value: 3 }],
  });
  render(
    <>
      {renderMarkdown('Before the chart\n\n```steno-chart\n' + source + '\n```\n\nAfter the chart')}
    </>
  );
  expect(await screen.findByText(source)).toBeTruthy();
  expect(screen.getByText('Before the chart')).toBeTruthy();
  expect(screen.getByText('After the chart')).toBeTruthy();
});

test('a rejected lazy import falls back without unmounting the conversation', async () => {
  vi.spyOn(console, 'error').mockImplementation(() => {});
  const MissingChart = React.lazy(() => Promise.reject(new Error('Chunk unavailable')));
  render(
    <>
      <p>Conversation remains</p>
      <ChartErrorBoundary fallback={<pre>Original chart data</pre>}>
        <React.Suspense fallback={null}>
          <MissingChart />
        </React.Suspense>
      </ChartErrorBoundary>
    </>
  );
  expect(await screen.findByText('Original chart data')).toBeTruthy();
  expect(screen.getByText('Conversation remains')).toBeTruthy();
});
