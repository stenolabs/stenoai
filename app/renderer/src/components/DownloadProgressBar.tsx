import * as React from 'react';
import { cn } from '@/lib/utils';

/** Download bar: a status label, a whole-number percent, and an accessible
 *  progressbar. Only for measured progress - pass `percent={null}` for a step
 *  with nothing to measure (e.g. compiling a model) and it renders as an
 *  indeterminate activity bar with no percentage. */
export function DownloadProgressBar({
  label,
  percent,
  'aria-label': ariaLabel,
  className,
  ...rest
}: {
  label: string;
  percent: number | null;
  /** Names the progressbar element itself, not the wrapper. */
  'aria-label': string;
} & Omit<React.HTMLAttributes<HTMLDivElement>, 'aria-label'>) {
  const clamped =
    percent === null ? null : Math.max(0, Math.min(100, Math.round(Number.isFinite(percent) ? percent : 0)));
  return (
    <div className={cn('mt-2', className)} {...rest}>
      <div className="mb-1 flex items-center justify-between gap-3 text-[11px] text-muted-foreground">
        <span className="truncate">{label}</span>
        {clamped !== null && <span className="tabular-nums">{clamped}%</span>}
      </div>
      {clamped === null ? (
        <div
          className="setup-indeterminate-bar relative h-1.5 overflow-hidden rounded-full"
          style={{ background: 'var(--surface-sunken)' }}
          role="progressbar"
          aria-label={ariaLabel}
        />
      ) : (
        <div
          className="h-1.5 overflow-hidden rounded-full"
          style={{ background: 'var(--surface-sunken)' }}
          role="progressbar"
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={clamped}
          aria-label={ariaLabel}
        >
          <div
            className="h-full rounded-full transition-[width] duration-300"
            style={{ width: `${clamped}%`, background: 'var(--fg-1)' }}
          />
        </div>
      )}
    </div>
  );
}
