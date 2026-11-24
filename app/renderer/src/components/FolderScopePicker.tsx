import * as React from 'react';
import { Check, ChevronDown, CircleOff, FileText, Folder as FolderIcon, Globe, Inbox } from 'lucide-react';
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from '@/components/ui/popover';
import { useFolders } from '@/hooks/useFolders';
import { useOrgSession } from '@/hooks/useOrg';
import { t } from '@/i18n';
import type { Folder } from '@/lib/ipc';

/** Sentinel for "ask across the org-shared corpus instead of local notes".
 *  Comparable to a folder id so the picker / handoff plumbing doesn't have
 *  to carry a separate type. */
export const ORG_SHARED_SCOPE = '__org_shared__';
export const GENERAL_SCOPE = '__general__';
export const MEETING_SCOPE = '__meeting__';

interface FolderScopePickerProps {
  /** Selected folder ID, or ORG_SHARED_SCOPE for the org corpus. null = all local notes. */
  value: string | null;
  includeMeeting?: boolean;
  disabled?: boolean;
  /** Icon-only trigger (the note's ask bar); the label stays in the tooltip and accessible name. */
  iconOnly?: boolean;
  onChange: (folderId: string | null) => void;
}

/**
 * Compact context chip in chat composers. The default is smart (a note's chat
 * starts on "This meeting", the Chat page on "All notes"); clicking opens a
 * short picker: This meeting, All notes, Shared notes, Spaces, No context.
 * Backend filtering happens server-side; this only persists the choice.
 */
export function FolderScopePicker({ value, onChange, includeMeeting = false, disabled = false, iconOnly = false }: FolderScopePickerProps) {
  const folders = useFolders();
  const orgSession = useOrgSession();
  const orgSignedIn = orgSession.data?.signedIn ?? false;
  const [open, setOpen] = React.useState(false);
  React.useEffect(() => {
    if (disabled) setOpen(false);
  }, [disabled]);

  const folder = React.useMemo<Folder | null>(() => {
    if (!value || [ORG_SHARED_SCOPE, GENERAL_SCOPE, MEETING_SCOPE].includes(value)) return null;
    return folders.data?.find((f) => f.id === value) ?? null;
  }, [folders.data, value]);

  // If the scoped folder was deleted out from under us, drop the scope so we
  // don't keep filtering against a dead id (and so the chip stops lying about
  // what's selected). Same goes for the org sentinel — if the user signs out
  // mid-session, we shouldn't keep claiming an org scope.
  //
  // Critically: gate the org clear on `orgSession.isSuccess`. Otherwise the
  // initial render — before useOrgSession() has settled — sees
  // `orgSignedIn === false` and would wipe a freshly-selected ORG_SHARED_SCOPE
  // before the auth status has actually loaded.
  const orgSessionSettled = orgSession.isSuccess;
  React.useEffect(() => {
    if (value && ![ORG_SHARED_SCOPE, GENERAL_SCOPE, MEETING_SCOPE].includes(value) && folders.data && !folder) {
      onChange(null);
    }
    if (value === ORG_SHARED_SCOPE && orgSessionSettled && !orgSignedIn) {
      onChange(null);
    }
  }, [value, folders.data, folder, orgSessionSettled, orgSignedIn, onChange]);

  const isOrg = value === ORG_SHARED_SCOPE;
  const label = value === GENERAL_SCOPE
    ? t('chat.scope.general')
    : value === MEETING_SCOPE
      ? t('chat.scope.meeting')
      : isOrg
        ? t('chat.scope.shared')
        : folder
          ? folder.name
          : t('chat.scope.all');
  const pick = (scope: string | null) => {
    onChange(scope);
    setOpen(false);
  };
  const Icon = isOrg ? Globe : value === GENERAL_SCOPE ? CircleOff : value === MEETING_SCOPE ? FileText : folder ? FolderIcon : Inbox;

  return (
    <Popover open={open && !disabled} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          disabled={disabled}
          aria-label={t('chat.context.label', { context: label })}
          title={t('chat.context.label', { context: label })}
          data-testid="chat-context-chip"
          className={
            iconOnly
              ? 'inline-flex size-[28px] shrink-0 items-center justify-center rounded-full transition-colors hover:bg-[color:var(--surface-hover)] disabled:opacity-60'
              : 'inline-flex h-[24px] items-center gap-1.5 rounded-full border px-2.5 text-[12px] transition-colors hover:bg-[color:var(--surface-hover)] disabled:opacity-60'
          }
          style={{ color: 'var(--fg-2)', borderColor: 'var(--border-subtle)' }}
        >
          <Icon aria-hidden className={iconOnly ? 'size-[15px]' : 'size-[12px]'} />
          {!iconOnly && <span className="max-w-[200px] truncate">{label}</span>}
          {!iconOnly && <ChevronDown aria-hidden className="size-[11px] opacity-60" />}
        </button>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-[220px] p-1">
        {includeMeeting && (
          <ScopeOption icon={FileText} label={t('chat.scope.meeting')} selected={value === MEETING_SCOPE} onSelect={() => pick(MEETING_SCOPE)} />
        )}
        <ScopeOption icon={Inbox} label={t('chat.scope.all')} selected={value === null} onSelect={() => pick(null)} />
        {orgSignedIn && (
          <ScopeOption icon={Globe} label={t('chat.scope.shared')} selected={isOrg} onSelect={() => pick(ORG_SHARED_SCOPE)} />
        )}
        {(folders.data ?? []).length > 0 && <Divider />}
        {(folders.data ?? []).map((f) => (
          <ScopeOption key={f.id} icon={FolderIcon} label={f.name} selected={value === f.id} onSelect={() => pick(f.id)} />
        ))}
        <Divider />
        <ScopeOption icon={CircleOff} label={t('chat.scope.general')} selected={value === GENERAL_SCOPE} onSelect={() => pick(GENERAL_SCOPE)} />
      </PopoverContent>
    </Popover>
  );
}

function Divider() {
  return <div className="mx-2 my-1 h-px" style={{ background: 'var(--border-subtle)' }} aria-hidden />;
}

function ScopeOption({
  icon: Icon,
  label,
  selected,
  onSelect,
}: {
  icon: React.ComponentType<{ className?: string; style?: React.CSSProperties; 'aria-hidden'?: boolean }>;
  label: string;
  selected: boolean;
  onSelect: () => void;
}) {
  return (
    <button
      type="button"
      aria-pressed={selected}
      onClick={onSelect}
      className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-[13px] transition-colors hover:bg-[color:var(--surface-hover)]"
      style={{ color: 'var(--fg-1)', background: selected ? 'var(--surface-active)' : undefined }}
    >
      <Icon aria-hidden className="size-[13px] shrink-0" style={{ color: 'var(--fg-2)' }} />
      <span className="min-w-0 flex-1 truncate">{label}</span>
      {selected && <Check aria-hidden className="size-[12px] shrink-0" style={{ color: 'var(--fg-2)' }} />}
    </button>
  );
}
