import * as React from 'react';
import { Check, Loader2, Trash2, X } from 'lucide-react';
import { Button } from '@/components/ui/button';

// Shared formatters used by both ModelList (Ollama) and WhisperModelList.
// Without these the two lists drift on cosmetic details (size units,
// default-label heuristic) and any future UX tweak has to be hand-applied
// to each component. The actual list components stay separate because
// ModelList has surface area Whisper doesn't need (deprecated section,
// remote/local provider split).
export function formatModelSize(size_gb: number | undefined): string | undefined {
  if (size_gb === undefined) return undefined;
  if (size_gb < 1) return `${Math.round(size_gb * 1024)} MB`;
  return `${size_gb.toFixed(1)} GB`;
}

export function isDefaultModel(description: string | undefined): boolean {
  return /\((default|recommended)\)/i.test(description ?? '');
}

export function modelDisplayName(name: string, displayName?: string): string {
  return displayName?.trim() || name;
}

export function modelNote({
  isRemote,
  managed,
  description,
  speed,
  quality,
}: {
  isRemote: boolean;
  managed?: boolean;
  description?: string;
  speed?: string;
  quality?: string;
}): string | undefined {
  if ((isRemote || managed) && description) return description;
  if (isRemote) return undefined;
  const parts: string[] = [];
  if (speed) parts.push(`${speed} speed`);
  if (quality) parts.push(`${quality} quality`);
  return parts.length ? parts.join(' · ') : undefined;
}

export function parsePullPercent(progress: string | undefined): number | null {
  const match = progress?.match(/(\d{1,3})%/);
  if (!match) return null;
  const value = Number(match[1]);
  return Number.isFinite(value) ? Math.min(100, Math.max(0, value)) : null;
}

// Ollama models are made of several blobs, each streamed as its own 0-100%
// phase (see pull_model's "[Part N]" suffix in simple_recorder.py) -- without
// this, the percentage restarting from a new blob reads as a second,
// unrelated download starting.
function parsePullPart(progress: string | undefined): number | null {
  const match = progress?.match(/\[Part (\d+)\]/);
  if (!match) return null;
  const value = Number(match[1]);
  return Number.isFinite(value) ? value : null;
}

function formatBytesPerSecond(bytesPerSecond: number | undefined): string {
  if (!bytesPerSecond || bytesPerSecond <= 0) return '';
  const mbPerSecond = bytesPerSecond / (1024 * 1024);
  if (mbPerSecond < 1) return `${Math.round(bytesPerSecond / 1024)} KB/s`;
  return `${mbPerSecond.toFixed(1)} MB/s`;
}

// Shared by the general "Select an uninstalled model" download and the
// "switch to faster build" pull -- both drive the same fixed-width
// bar+percent+MB/s+Cancel row from the same "<status> <pct>% (<bytes>)"
// progress string, so a naive per-flow copy would drift on cosmetic tweaks.
// Fixed-width (not just the bar's fill) so rapid ticks never reflow the row.
function PullProgressBar({
  progress,
  bytesPerSecond,
  onCancel,
}: {
  progress: string | undefined;
  bytesPerSecond: number | undefined;
  onCancel: (() => void) | undefined;
}) {
  return (
    <div className="flex shrink-0 items-center gap-2">
      {/* No outer fixed width here -- it previously hardcoded 96px, which
          fit only the bar+percent pair it was designed for. Adding the
          MB/s and Part columns later pushed the total past 96px, so they
          silently overflowed the box and collided with whatever sat to its
          right (the Cancel button). Each child below still has its own
          fixed width, so per-tick reflow is still fully prevented -- this
          container just needs to actually be wide enough for all of them. */}
      <div className="flex items-center gap-1.5">
        <div
          className="h-1.5 overflow-hidden rounded-full"
          style={{ width: 56, background: 'var(--surface-sunken)' }}
        >
          <div
            className="h-full rounded-full"
            style={{
              width: `${parsePullPercent(progress) ?? 0}%`,
              background: 'var(--fg-1)',
            }}
          />
        </div>
        <span
          className="shrink-0 text-right text-[11px] tabular-nums"
          style={{ color: 'var(--fg-muted)', width: 28 }}
        >
          {parsePullPercent(progress) ?? 0}%
        </span>
        {/* Fixed width + overflow-hidden: "8.8 MB/s" and "120 KB/s" are
            different widths, so a naive inline text here would reflow the
            row on every tick. */}
        <span
          className="shrink-0 overflow-hidden whitespace-nowrap text-[11px] tabular-nums"
          style={{ color: 'var(--fg-muted)', width: 60 }}
        >
          {formatBytesPerSecond(bytesPerSecond)}
        </span>
        {/* Reserved even when blank so the one-time appearance of a second
            blob's part number doesn't shift anything else in the row. */}
        <span
          className="shrink-0 overflow-hidden whitespace-nowrap text-[11px] tabular-nums"
          style={{ color: 'var(--fg-muted)', width: 44 }}
        >
          {parsePullPart(progress) !== null ? `Part ${parsePullPart(progress)}` : ''}
        </span>
      </div>
      {/* Only rendered when the caller doesn't already have its own cancel
          control (e.g. the general download flow's top-right Select/Cancel
          button) -- otherwise this duplicates it right below the name. */}
      {onCancel && (
        <button
          type="button"
          onClick={onCancel}
          className="shrink-0 cursor-pointer border-0 bg-transparent p-0 text-[11px] underline"
          style={{ color: 'var(--fg-muted)' }}
        >
          Cancel
        </button>
      )}
    </div>
  );
}

interface ModelCardProps {
  name: string;
  // Optional provider/engine brand icon shown before the name — used by the
  // Transcription list (Whisper -> OpenAI, Parakeet -> NVIDIA); omitted by
  // the Ollama ModelList, which doesn't attribute per-model brands.
  icon?: React.ReactNode;
  sizeLabel?: string;
  note?: React.ReactNode;
  isCurrent: boolean;
  isDefault?: boolean;
  deprecated?: boolean;
  isDownloading?: boolean;
  downloadProgress?: string;
  downloadBytesPerSecond?: number;
  onSelect: () => void;
  selectDisabled?: boolean;
  // Lets a user on a slow connection (or a misclick on a large model) back
  // out of a download in progress instead of being stuck waiting for it.
  onCancelDownload?: () => void;
  // Shown for an installed, non-current model so disk space can be reclaimed
  // without needing the Ollama CLI. Omitted entirely while the model is
  // downloading (that's what onCancelDownload is for) or is the active
  // selection (deleting it would break the app until another is chosen).
  isInstalled?: boolean;
  onDeleteModel?: () => void;
  // Whether the GGUF id itself was ever actually pulled -- false when
  // "Select" resolved straight to the NVFP4 tag on Apple Silicon, in which
  // case there's nothing to have "switched" from (see the MLX badge tooltip).
  ggufInstalled?: boolean;
  fasterBuildTag?: string;
  fasterBuildInstalled?: boolean;
  fasterBuildState?: 'idle' | 'pulling' | 'verifying' | 'done' | 'error';
  fasterBuildProgress?: string;
  fasterBuildBytesPerSecond?: number;
  // True when a DIFFERENT model's switch-to-faster-build is in flight. The
  // hook backing this only tracks one in-progress switch at a time, so
  // starting a second one while the first is still pulling/verifying/awaiting
  // its delete-confirmation silently drops the first one's completion event
  // (see useSwitchToFasterBuild's activeTagRef check) -- blocking here rather
  // than fixing that hook to track many at once, since real concurrent
  // switches were never a requested use case.
  fasterBuildBlocked?: boolean;
  onSwitchToFasterBuild?: () => void;
  onCancelFasterBuild?: () => void;
  // Non-blocking caution: the model's footprint likely exceeds this Mac's
  // usable memory, so summarising with it may run slowly or fail. Only set for
  // local Ollama models (the RAM check is meaningless for remote/cloud). Shows
  // a subtle badge next to the name — never disables selection (see #248).
  memoryWarning?: boolean;
}

export function ModelCard({
  name,
  icon,
  sizeLabel,
  note,
  isCurrent,
  isDefault = false,
  deprecated = false,
  isDownloading = false,
  downloadProgress,
  downloadBytesPerSecond,
  onSelect,
  selectDisabled = false,
  onCancelDownload,
  isInstalled = false,
  onDeleteModel,
  ggufInstalled = false,
  fasterBuildTag,
  fasterBuildInstalled = false,
  fasterBuildState = 'idle',
  fasterBuildProgress,
  fasterBuildBytesPerSecond,
  fasterBuildBlocked = false,
  onSwitchToFasterBuild,
  onCancelFasterBuild,
  memoryWarning = false,
}: ModelCardProps) {
  return (
    <div
      // flex-wrap + gap-y lets the wide faster-build row (badge + progress bar
      // + Cancel) drop onto its own line under the name at a realistic Settings
      // width, instead of being forced onto one line that squeezes the name to
      // near-zero (char-wrapping it) and overflows the fixed-width progress
      // columns into an overlapping mess. The name/button row stays on line 1.
      className="mb-1.5 flex flex-wrap items-center gap-x-4 gap-y-2 rounded-[8px] px-4 py-[13px] transition-colors"
      style={{
        border: `1px solid ${
          isCurrent ? 'var(--border-strong)' : 'var(--border-subtle)'
        }`,
        background: isCurrent ? 'var(--surface-raised)' : 'transparent',
        // Dim deprecated rows EXCEPT when they're the user's current
        // selection. A user's active choice should never look disabled —
        // the Deprecated badge does the warning work, the dim just adds
        // noise for someone who already opted in (e.g. existing Whisper
        // Small users migrated from v0.3.7).
        opacity: deprecated && !isCurrent ? 0.4 : 1,
      }}
    >
      <div className="min-w-0 flex-1">
        <div className="mb-[3px] flex flex-wrap items-baseline gap-2.5">
          {icon && (
            <span className="inline-flex shrink-0" style={{ color: 'var(--fg-muted)' }}>
              {icon}
            </span>
          )}
          <span
            className="font-mono text-[13px]"
            style={{
              color: 'var(--fg-1)',
              fontWeight: isCurrent ? 500 : 400,
            }}
          >
            {name}
          </span>
          {sizeLabel && (
            <span
              className="text-[12px] tabular-nums"
              style={{ color: 'var(--fg-muted)' }}
            >
              {sizeLabel}
            </span>
          )}
          {isDefault && !isCurrent && (
            <span
              className="rounded-[3px] px-1.5 py-px text-[11px]"
              style={{
                background: 'var(--surface-sunken)',
                color: 'var(--fg-muted)',
                border: '1px solid var(--border)',
              }}
            >
              Default
            </span>
          )}
          {deprecated && (
            <span
              className="rounded-[3px] px-1.5 py-px text-[11px]"
              style={{
                color: 'var(--fg-muted)',
                border: '1px solid var(--border-subtle)',
              }}
            >
              Deprecated
            </span>
          )}
          {fasterBuildTag && fasterBuildInstalled && (
            <span
              className="rounded-[3px] px-1.5 py-px text-[11px]"
              title={
                ggufInstalled
                  ? `Running the MLX build (${fasterBuildTag}) instead of ${name}`
                  : `Downloaded directly as the MLX build (${fasterBuildTag}) -- ${name} was never pulled`
              }
              style={{
                background: 'var(--surface-sunken)',
                color: 'var(--fg-muted)',
                border: '1px solid var(--border)',
              }}
            >
              MLX model
            </span>
          )}
          {memoryWarning && (
            <span
              className="rounded-[3px] px-1.5 py-px text-[11px]"
              title="This model may exceed your Mac's available memory and could run slowly or fail."
              style={{
                background: 'var(--danger-bg)',
                color: 'var(--danger)',
                border: '1px solid var(--danger)',
              }}
            >
              May exceed memory
            </span>
          )}
        </div>
        {note && (
          <div
            className="text-[13px] leading-[1.4]"
            style={{ color: 'var(--fg-2)' }}
          >
            {note}
          </div>
        )}
      </div>
      {isDownloading && downloadProgress && (
        // Inline, to the right of the name, on the same row as the Select /
        // Cancel button (it's shrink-0, so it stays intact; the name gives way
        // via its own min-w-0 block). No onCancel here -- the top-right Button
        // already doubles as Cancel while isDownloading (see the button block
        // below). A faster-build switch is excluded from isDownloading upstream,
        // so this never double-renders with the faster-build progress bar.
        <PullProgressBar progress={downloadProgress} bytesPerSecond={downloadBytesPerSecond} onCancel={undefined} />
      )}
      {isCurrent ? (
        <span
          className="inline-flex shrink-0 items-center gap-1.5 text-[13px] font-medium"
          style={{ color: 'var(--fg-1)' }}
        >
          <Check size={13} />
          Selected
        </span>
      ) : !deprecated ? (
        <div className="flex shrink-0 items-center gap-1.5">
          {isInstalled && !isDownloading && onDeleteModel && (
            <button
              type="button"
              onClick={onDeleteModel}
              aria-label="Delete model"
              title="Delete this model to free up disk space"
              className="flex size-[28px] cursor-pointer items-center justify-center rounded-[6px] border-0 bg-transparent"
              style={{ color: 'var(--fg-muted)' }}
            >
              <Trash2 size={14} />
            </button>
          )}
          <Button
            variant="outline"
            size="sm"
            className="h-[28px] px-3.5 text-[13px]"
            // Whisper/Parakeet share this component but don't wire cancel
            // support -- without the `onCancelDownload` check, this showed
            // an active-looking "Cancel" for them that did nothing on click.
            disabled={selectDisabled || (isDownloading && !onCancelDownload)}
            onClick={isDownloading ? onCancelDownload : onSelect}
          >
            {isDownloading ? (
              onCancelDownload ? (
                <>
                  <X className="mr-1.5 size-3" />
                  Cancel
                </>
              ) : (
                <>
                  <Loader2 className="mr-1.5 size-3 animate-spin" />
                  Downloading
                </>
              )
            ) : (
              'Select'
            )}
          </Button>
        </div>
      ) : null}
      {/* Rendered LAST and w-full so flex-wrap pushes it onto its own line
          below the name + Select/Selected row, rather than fighting them for
          horizontal space. The badge + progress bar (or switch button) can
          then sit comfortably at full width. */}
      {fasterBuildTag && !fasterBuildInstalled && (
        <div className="flex w-full items-center gap-2">
          <span
            className="shrink-0 rounded-[3px] px-1.5 py-px text-[11px]"
            style={{
              color: 'var(--fg-muted)',
              border: '1px solid var(--border-subtle)',
            }}
          >
            Faster build available
          </span>
          {fasterBuildState === 'pulling' ? (
            <PullProgressBar
              progress={fasterBuildProgress}
              bytesPerSecond={fasterBuildBytesPerSecond}
              onCancel={onCancelFasterBuild}
            />
          ) : (
            <button
              type="button"
              onClick={onSwitchToFasterBuild}
              disabled={fasterBuildState === 'verifying' || fasterBuildBlocked}
              title={fasterBuildBlocked ? 'Finish the current switch first' : undefined}
              className="shrink-0 cursor-pointer border-0 bg-transparent p-0 text-[12px] underline disabled:cursor-default disabled:no-underline disabled:opacity-60"
              style={{ color: 'var(--fg-1)' }}
            >
              {fasterBuildState === 'verifying' && 'Verifying…'}
              {fasterBuildState === 'error' && 'Retry: switch to faster build'}
              {(fasterBuildState === 'idle' || fasterBuildState === 'done') && 'Switch to faster build'}
            </button>
          )}
        </div>
      )}
    </div>
  );
}
