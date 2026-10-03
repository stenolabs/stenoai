import { t } from '@/i18n';
import type { ParakeetPullProgressEvent, SpeakerModelsProgressEvent } from './ipc';

/** Measured byte totals, when the backend could read the Hub's file sizes. */
function byteTotals(progress?: ParakeetPullProgressEvent | null) {
  if (progress?.stage !== 'downloading') return null;
  const { downloaded_bytes: done, total_bytes: total } = progress;
  if (!Number.isFinite(done) || !Number.isFinite(total) || total! <= 0 || done! < 0) return null;
  return { done: Math.min(done!, total!), total: total! };
}

function formatBytes(bytes: number): string {
  return bytes >= 1e9 ? `${(bytes / 1e9).toFixed(1)} GB` : `${Math.round(bytes / 1e6)} MB`;
}

/** Whole-download percent, or null when only file-level progress is known
 *  (older Hub releases, or the size lookup failed) - never an estimate. */
export function parakeetProgressPercent(progress?: ParakeetPullProgressEvent | null): number | null {
  const totals = byteTotals(progress);
  return totals ? (totals.done / totals.total) * 100 : null;
}

export function parakeetProgressLabel(progress?: ParakeetPullProgressEvent | null): string {
  if (progress?.stage === 'loading') return 'Download complete. Preparing model…';
  if (progress?.stage === 'complete') return 'Model ready';
  if (progress?.stage !== 'downloading') return 'Preparing download…';
  const totals = byteTotals(progress);
  if (totals) {
    return t('downloads.parakeet.bytes', {
      downloaded: formatBytes(totals.done),
      total: formatBytes(totals.total),
    });
  }
  const files = Number.isInteger(progress.completed_files) && Number.isInteger(progress.total_files)
    && progress.completed_files! >= 0 && progress.total_files! > 0
    && progress.completed_files! <= progress.total_files!
    ? ` ${progress.completed_files} of ${progress.total_files} files ready.` : '';
  const bytes = Number.isFinite(progress.file_bytes) && progress.file_bytes! > 0
    ? ` Current file: ${(progress.file_bytes! / 1_000_000).toFixed(1)} MB available.` : '';
  return `Downloading model…${files}${bytes}`;
}

/** FluidAudio fills 0-50% while downloading and 50-100% while compiling the
 *  models for this Mac; say which, so a slow second half isn't mistaken for
 *  a stalled download. */
export function speakerModelsProgressLabel(progress: SpeakerModelsProgressEvent): string {
  return progress.phase === 'compiling'
    ? t('downloads.speakers.preparing')
    : t('downloads.speakers.downloading');
}
