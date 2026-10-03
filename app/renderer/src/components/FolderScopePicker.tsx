import * as React from 'react';
import { ChevronDown, Folder as FolderIcon, Globe, Inbox } from 'lucide-react';
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
  onChange: (folderId: string | null) => void;
}

/**
 * Compact "scope" chip used inside chat composers. Lets the user limit a
 * cross-note query to a single folder instead of asking across everything.
 * Backend filter happens server-side; this just persists the choice and
 * passes it to startGlobalStream.
 */
export function FolderScopePicker({ value, onChange, includeMeeting = false, disabled = false }: FolderScopePickerProps) {
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
  const label = value === GENERAL_SCOPE ? t('chat.scope.general') : value === MEETING_SCOPE ? t('chat.scope.meeting') : isOrg ? 'Shared notes' : folder ? folder.name : 'All notes';

  return (
    <Popover open={open && !disabled} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          disabled={disabled}
          aria-label={t('chat.context.label', { context: label })}
          title={t('chat.context.label', { context: label })}
          className="inline-flex items-center gap-1.5 rounded-md px-2 py-1 text-[12px] transition-colors hover:bg-[color:var(--surface-hover)]"
          style={{ color: 'var(--fg-2)' }}
        >
          {isOrg ? (
            <Globe className="size-[12px]" />
          ) : folder ? (
            <FolderIcon className="size-[12px]" />
          ) : (
            <Inbox className="size-[12px]" />
          )}
          <span className="max-w-[220px] truncate">{t('chat.context.label', { context: label })}</span>
          <ChevronDown className="size-[11px] opacity-60" />
        </button>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-[260px] p-1">
        <div className="px-2 pb-2 pt-1" style={{ color: 'var(--fg-muted)' }}>
          <p className="text-xs font-medium" style={{ color: 'var(--fg-2)' }}>{t('chat.context.heading')}</p>
          <p className="mt-1 text-[11px] leading-relaxed">{t('chat.context.hint')}</p>
        </div>
        <button
          type="button"
          onClick={() => {
            onChange(null);
            setOpen(false);
          }}
          className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-[13px] transition-colors hover:bg-[color:var(--surface-hover)]"
          style={{
            color: 'var(--fg-1)',
            background: value === null ? 'var(--surface-active)' : undefined,
          }}
        >
          <Inbox className="size-[13px]" style={{ color: 'var(--fg-2)' }} />
          All notes
        </button>
        {[GENERAL_SCOPE, ...(includeMeeting ? [MEETING_SCOPE] : [])].map((scope) => (
          <button
            key={scope}
            type="button"
            onClick={() => { onChange(scope); setOpen(false); }}
            className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-[13px] hover:bg-[color:var(--surface-hover)]"
            style={{ color: 'var(--fg-1)', background: value === scope ? 'var(--surface-active)' : undefined }}
          >
            {scope === GENERAL_SCOPE ? t('chat.scope.general') : t('chat.scope.meeting')}
          </button>
        ))}
        {orgSignedIn && (
          <button
            type="button"
            onClick={() => {
              onChange(ORG_SHARED_SCOPE);
              setOpen(false);
            }}
            className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-[13px] transition-colors hover:bg-[color:var(--surface-hover)]"
            style={{
              color: 'var(--fg-1)',
              background: isOrg ? 'var(--surface-active)' : undefined,
            }}
            title={`Cross-note chat against ${orgSession.data?.orgId ?? 'your org'}'s shared notes`}
          >
            <Globe className="size-[13px]" style={{ color: 'var(--fg-2)' }} />
            <span className="truncate">Shared notes</span>
          </button>
        )}
        {(folders.data ?? []).length > 0 && (
          <div
            className="mx-2 my-1 h-px"
            style={{ background: 'var(--border-subtle)' }}
            aria-hidden
          />
        )}
        {(folders.data ?? []).map((f) => (
          <button
            key={f.id}
            type="button"
            onClick={() => {
              onChange(f.id);
              setOpen(false);
            }}
            className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-[13px] transition-colors hover:bg-[color:var(--surface-hover)]"
            style={{
              color: 'var(--fg-1)',
              background: value === f.id ? 'var(--surface-active)' : undefined,
            }}
          >
            <FolderIcon className="size-[13px]" style={{ color: 'var(--fg-2)' }} />
            <span className="truncate">{f.name}</span>
          </button>
        ))}
      </PopoverContent>
    </Popover>
  );
}
