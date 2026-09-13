import type { ParakeetPullProgressEvent } from './ipc';

export function parakeetProgressLabel(progress?: ParakeetPullProgressEvent | null): string {
  if (progress?.stage === 'loading') return 'Download complete. Preparing model…';
  if (progress?.stage === 'complete') return 'Model ready';
  if (progress?.stage !== 'downloading') return 'Preparing download…';
  const files = Number.isInteger(progress.completed_files) && Number.isInteger(progress.total_files)
    && progress.completed_files! >= 0 && progress.total_files! > 0
    && progress.completed_files! <= progress.total_files!
    ? ` ${progress.completed_files} of ${progress.total_files} files ready.` : '';
  const bytes = Number.isFinite(progress.file_bytes) && progress.file_bytes! > 0
    ? ` Current file: ${(progress.file_bytes! / 1_000_000).toFixed(1)} MB available.` : '';
  return `Downloading model…${files}${bytes}`;
}
