import * as React from 'react';
import { ChevronRight } from 'lucide-react';
import { t } from '@/i18n';

// A report's properties, folded away behind a disclosure in the row with the
// My notes / template switch. Closed by default: the report is what a note is
// opened for, and the properties are reference. Open or closed is remembered
// app-wide rather than per note, so someone who wants them sees them on every
// note until they close them again.

export const PROPERTIES_OPEN_KEY = 'steno-report-properties-open';

/** A remembered on/off view choice. Storage can be missing or throw (private
 *  mode, cleared site data); the choice then lasts for the session only. */
export function useStoredFlag(key: string): [boolean, () => void] {
  const [value, setValue] = React.useState(() => {
    try {
      return localStorage.getItem(key) === 'true';
    } catch {
      return false;
    }
  });
  const toggle = React.useCallback(() => {
    setValue((previous) => {
      const next = !previous;
      try {
        localStorage.setItem(key, String(next));
      } catch {
        // Kept in memory only.
      }
      return next;
    });
  }, [key]);
  return [value, toggle];
}

/** The id of the ReportProperties table the toggle opens. */
export const PROPERTIES_PANEL_ID = 'report-properties-panel';

/** The "Properties" disclosure for the right end of the view-switch row. */
export function PropertiesToggle({
  count,
  open,
  onToggle,
}: {
  count: number;
  open: boolean;
  onToggle: () => void;
}) {
  return (
    <button
      type="button"
      aria-expanded={open}
      aria-controls={PROPERTIES_PANEL_ID}
      data-testid="report-properties-toggle"
      onClick={onToggle}
      className="inline-flex items-center gap-1.5 rounded-md px-2 py-1 text-[13px] font-medium transition-colors hover:bg-[color:var(--surface-hover)] hover:text-[color:var(--fg-1)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      style={{ color: 'var(--fg-2)' }}
    >
      {t('report.properties.toggle')}
      <span style={{ color: 'var(--fg-muted)' }}>{count}</span>
      <ChevronRight
        aria-hidden="true"
        className="size-[13px] transition-transform"
        style={{ transform: open ? 'rotate(90deg)' : undefined }}
      />
    </button>
  );
}
