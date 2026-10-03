import { it, expect } from 'vitest';
import { parakeetProgressLabel as label, parakeetProgressPercent } from './parakeetProgress';
it('distinguishes measured download, preparation and completion without ETA', () => {
  expect(label()).toBe('Preparing download…');
  expect(label({ stage: 'loading' })).toBe('Download complete. Preparing model…');
  expect(label({ stage: 'complete' })).toBe('Model ready');
  expect(label({ stage: 'downloading', completed_files: 1, total_files: 2, file_bytes: 120000000 }))
    .toBe('Downloading model… 1 of 2 files ready. Current file: 120.0 MB available.');
  expect(label({ stage: 'downloading', completed_files: 9, total_files: 2, file_bytes: NaN }))
    .toBe('Downloading model…');
});

it('reports a measured percent only when the backend sent valid byte totals', () => {
  const percent = parakeetProgressPercent;
  expect(percent({ stage: 'downloading', downloaded_bytes: 640_000_000, total_bytes: 2_560_000_000 })).toBe(25);
  expect(label({ stage: 'downloading', downloaded_bytes: 640_000_000, total_bytes: 2_560_000_000 }))
    .toBe('Downloading model… 640 MB of 2.6 GB');
  // Over-reporting is capped, never shown above 100%.
  expect(percent({ stage: 'downloading', downloaded_bytes: 9e9, total_bytes: 1e9 })).toBe(100);
  for (const bad of [
    { stage: 'downloading', file_bytes: 1e6 },
    { stage: 'downloading', downloaded_bytes: 5, total_bytes: 0 },
    { stage: 'downloading', downloaded_bytes: -1, total_bytes: 10 },
    { stage: 'loading', downloaded_bytes: 5, total_bytes: 10 },
  ]) {
    expect(percent(bad)).toBeNull();
  }
});
