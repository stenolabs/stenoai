import * as React from 'react';
import { cn } from '@/lib/utils';
import { Input } from '@/components/ui/input';
import { Switch } from '@/components/ui/switch';

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

// Controls that have no visible name of their own, so the row's label is their
// accessible name. Buttons and links already name themselves through their
// text; pointing aria-labelledby at the row label would replace that name.
// Select roots do not forward ARIA props (the trigger would need them).
const ROW_LABELLED_CONTROLS: ReadonlySet<unknown> = new Set([Switch, Input]);

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
  const labelId = React.useId();
  const generatedDescId = React.useId();
  const resolvedDescId = description ? (descriptionId ?? generatedDescId) : undefined;

  let labeledChildren = children;
  if (
    React.isValidElement<Record<string, unknown>>(children) &&
    ROW_LABELLED_CONTROLS.has(children.type)
  ) {
    const props = children.props;
    const hasAccessibleName =
      typeof props['aria-label'] === 'string' || typeof props['aria-labelledby'] === 'string';
    const hasDescribedBy = typeof props['aria-describedby'] === 'string';
    if (!hasAccessibleName || (resolvedDescId && !hasDescribedBy)) {
      const injected: Record<string, unknown> = {};
      if (!hasAccessibleName) injected['aria-labelledby'] = labelId;
      if (resolvedDescId && !hasDescribedBy) injected['aria-describedby'] = resolvedDescId;
      labeledChildren = React.cloneElement(children, injected);
    }
  }

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
          id={labelId}
          className="text-[14px] font-normal"
          style={{ color: 'var(--fg-1)', marginBottom: 2 }}
        >
          {label}
        </div>
        {description && (
          <div
            id={resolvedDescId}
            className="text-[13px] leading-[1.5]"
            style={{ color: 'var(--fg-2)' }}
          >
            {description}
          </div>
        )}
      </div>
      <div className="shrink-0">{labeledChildren}</div>
    </div>
  );
}

interface SubSettingsProps {
  children: React.ReactNode;
  // Draw the divider under the whole group, so the next top-level row is
  // separated from it. Leave off for the last group of a section.
  divider?: boolean;
}

/**
 * Settings that only apply while the row above them is on (or refine it),
 * indented under that row. The last nested row's own divider is dropped so
 * the group's left rule ends cleanly; `divider` draws one across the group.
 */
export function SubSettings({ children, divider = false }: SubSettingsProps) {
  return (
    <div style={{ borderBottom: divider ? '1px solid var(--border-subtle)' : 'none' }}>
      <div
        className="border-l pl-4 [&>div:last-child]:!border-b-0"
        style={{ borderColor: 'var(--border-subtle)' }}
      >
        {children}
      </div>
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
    <h2
      // Opt out of the base h1/h2 display serif: settings section headings
      // are UI labels in the sans face.
      className="font-sans text-[15px] font-semibold leading-[inherit] tracking-normal"
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
    </h2>
  );
}
