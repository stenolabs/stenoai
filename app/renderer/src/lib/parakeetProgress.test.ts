import { it, expect } from 'vitest';
import { parakeetProgressLabel as label } from './parakeetProgress';
it('distinguishes measured download, preparation and completion without ETA', () => {
  expect(label()).toBe('Preparing download…');
  expect(label({ stage: 'loading' })).toBe('Download complete. Preparing model…');
  expect(label({ stage: 'complete' })).toBe('Model ready');
  expect(label({ stage: 'downloading', completed_files: 1, total_files: 2, file_bytes: 120000000 }))
    .toBe('Downloading model… 1 of 2 files ready. Current file: 120.0 MB available.');
  expect(label({ stage: 'downloading', completed_files: 9, total_files: 2, file_bytes: NaN }))
    .toBe('Downloading model…');
});
