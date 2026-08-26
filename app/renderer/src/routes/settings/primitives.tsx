import * as React from 'react';
import { cn } from '@/lib/utils';

// ---------------------------------------------------------------------------
// Shared Settings primitives — style helpers + layout rows used across more
// than one tab. Values come straight from the design (Pencil bundle at
// /tmp/design-extract/.../Settings.jsx). Kept local to the Settings route
// rather than promoted to /components/ui because they only fit this layout.
// ---------------------------------------------------------------------------

export const COMPACT_TRIGGER =
  'h-[30px] min-w-[150px] rounded-[6px] bg-[color:var(--surface-raised)] px-2.5 py-0 text-[13px]';
export const COMPACT_BTN = 'h-[30px] px-3 text-[13px]';
export const COMPACT_INPUT =
  'h-[30px] bg-[color:var(--surface-raised)] text-[13px]';

interface SettingRowProps {
  label: string;
  description?: React.ReactNode;
  descriptionId?: string;
  children: React.ReactNode;
  align?: 'center' | 'start';
  noBorder?: boolean;
  muted?: boolean;
}

export function SettingRow({
  label,
  description,
  descriptionId,
  children,
  align = 'center',
  // A hairline divider sits between rows within a group (like Claude's own
  // settings list) — pass noBorder on the last row of a group so it doesn't
  // show a trailing line right before the next section's heading.
  noBorder = false,
  muted = false,
}: SettingRowProps) {
  return (
    <div
      className={cn(
        'flex gap-6 py-4',
        align === 'start' ? 'items-start' : 'items-center',
      )}
      style={{
        opacity: muted ? 0.45 : 1,
        borderBottom: noBorder ? 'none' : '1px solid var(--border-subtle)',
      }}
    >
      <div className="min-w-0 flex-1">
        <div
          className="text-[14px] font-normal"
          style={{ color: 'var(--fg-1)', marginBottom: 2 }}
        >
          {label}
        </div>
        {description && (
          <div
            id={descriptionId}
            className="text-[13px] leading-[1.5]"
            style={{ color: 'var(--fg-2)' }}
          >
            {description}
          </div>
        )}
      </div>
      <div className="shrink-0">{children}</div>
    </div>
  );
}

interface SectionHeadingProps {
  children: React.ReactNode;
  // Pass true only for a SectionHeading that's the very first thing on a
  // page (e.g. TemplatesTab, OrganisationTab) — skips the top divider so it
  // doesn't sit directly under the page header's own border-bottom.
  first?: boolean;
}

export function SectionHeading({ children, first = false }: SectionHeadingProps) {
  return (
    <div
      className="text-[15px] font-semibold"
      style={{
        // Bold + normal case + dark ink, so the section name is the loudest
        // thing on the page — settings underneath it read quieter by
        // comparison (see SettingRow's font-normal label). Row-to-row
        // dividers (SettingRow's own borderBottom) mark the boundary
        // between individual settings; this heading only needs generous
        // space above it to read as a new section starting.
        color: 'var(--fg-1)',
        marginTop: first ? 0 : '32px',
        marginBottom: '12px',
      }}
    >
      {children}
    </div>
  );
}
