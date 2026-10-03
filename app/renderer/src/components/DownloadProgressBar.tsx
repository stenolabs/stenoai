import * as React from 'react';
import { cn } from '@/lib/utils';

/** Determinate download bar: a status label, a whole-number percent, and an
 *  accessible progressbar. Only for measured progress - use an indeterminate
 *  bar when there is no real total to divide by. */
export function DownloadProgressBar({
  label,
  percent,
  'aria-label': ariaLabel,
  className,
  ...rest
}: {
  label: string;
  percent: number;
  /** Names the progressbar element itself, not the wrapper. */
  'aria-label': string;
} & Omit<React.HTMLAttributes<HTMLDivElement>, 'aria-label'>) {
  const clamped = Math.max(0, Math.min(100, Math.round(percent)));
  return (
    <div className={cn('mt-2', className)} {...rest}>
      <div className="mb-1 flex items-center justify-between gap-3 text-[11px] text-muted-foreground">
        <span className="truncate">{label}</span>
        <span className="tabular-nums">{clamped}%</span>
      </div>
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
    </div>
  );
}
