import * as React from 'react';
import { Check, ChevronDown, FileText, Folder as FolderIcon, Globe, Inbox } from 'lucide-react';
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from '@/components/ui/popover';
import { useFolders } from '@/hooks/useFolders';
import { useOrgSession } from '@/hooks/useOrg';
import { useMeetings } from '@/hooks/useMeetings';
import type { Folder } from '@/lib/ipc';

/** Sentinel for "ask across the org-shared corpus instead of local notes".
 *  Comparable to a folder id so the picker / handoff plumbing doesn't have
 *  to carry a separate type. */
export const ORG_SHARED_SCOPE = '__org_shared__';

interface FolderScopePickerProps {
  /** Selected folder ID, or ORG_SHARED_SCOPE for the org corpus. null = all local notes. */
  value: string | null;
  onChange: (folderId: string | null) => void;
  /** Selected meeting summary file paths. */
  selectedMeetings?: string[];
  /** Callback when meeting selection changes. */
  onSelectedMeetingsChange?: (meetingFiles: string[]) => void;
}
/**
 * Compact "scope" chip used inside chat composers. Lets the user limit a
 * cross-note query to a single folder instead of asking across everything.
 * Backend filter happens server-side; this just persists the choice and
 * passes it to startGlobalStream.
 */
export function FolderScopePicker({
  value,
  onChange,
  selectedMeetings,
  onSelectedMeetingsChange,
}: FolderScopePickerProps) {
  const folders = useFolders();
  const orgSession = useOrgSession();
  const orgSignedIn = orgSession.data?.signedIn ?? false;
  const meetingsQuery = useMeetings();
  const [open, setOpen] = React.useState(false);

  const meetingsList = React.useMemo(() => {
    const raw = meetingsQuery.data ?? [];
    return raw.filter(
      (m) =>
        m.session_info?.summary_file &&
        !m.session_info.summary_file.startsWith('__live_')
    );
  }, [meetingsQuery.data]);

  const folder = React.useMemo<Folder | null>(() => {
    if (!value || value === ORG_SHARED_SCOPE) return null;
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
    if (value && value !== ORG_SHARED_SCOPE && folders.data && !folder) {
      onChange(null);
    }
    if (value === ORG_SHARED_SCOPE && orgSessionSettled && !orgSignedIn) {
      onChange(null);
    }
  }, [value, folders.data, folder, orgSessionSettled, orgSignedIn, onChange]);

  // If scoped meetings were deleted, drop them from the selection.
  React.useEffect(() => {
    if (selectedMeetings && selectedMeetings.length > 0 && meetingsQuery.data) {
      const validFiles = new Set(meetingsList.map((m) => m.session_info.summary_file));
      const filtered = selectedMeetings.filter((f) => validFiles.has(f));
      if (filtered.length !== selectedMeetings.length) {
        onSelectedMeetingsChange?.(filtered);
      }
    }
  }, [selectedMeetings, meetingsQuery.data, meetingsList, onSelectedMeetingsChange]);

  const selectedCount = selectedMeetings?.length ?? 0;
  const isSelectedMeetings = selectedCount > 0;
  const isOrg = !isSelectedMeetings && value === ORG_SHARED_SCOPE;
  // "notes", not "meetings": every other label in this picker (All notes,
  // Shared notes, Specific notes) and the sidebar itself call them notes.
  const label = isSelectedMeetings
    ? selectedCount === 1
      ? '1 note'
      : `${selectedCount} notes`
    : isOrg
    ? 'Shared notes'
    : folder
    ? folder.name
    : 'All notes';

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          data-testid="scope-picker-trigger"
          aria-label={`Scope: ${label}`}
          title={`Scope: ${label}`}
          className="inline-flex items-center gap-1.5 rounded-md px-2 py-1 text-[12px] transition-colors hover:bg-[color:var(--surface-hover)]"
          style={{ color: 'var(--fg-2)' }}
        >
          {isSelectedMeetings ? (
            <FileText className="size-[12px]" />
          ) : isOrg ? (
            <Globe className="size-[12px]" />
          ) : folder ? (
            <FolderIcon className="size-[12px]" />
          ) : (
            <Inbox className="size-[12px]" />
          )}
          <span className="max-w-[140px] truncate">{label}</span>
          <ChevronDown className="size-[11px] opacity-60" />
        </button>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-[240px] p-1" data-testid="scope-picker-popover">
        <div className="px-2 pb-1 pt-0.5 text-[11px] font-medium" style={{ color: 'var(--fg-muted)' }}>
          Ask across…
        </div>
        <button
          type="button"
          data-testid="scope-all-notes"
          onClick={() => {
            onChange(null);
            onSelectedMeetingsChange?.([]);
            setOpen(false);
          }}
          className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-[13px] transition-colors hover:bg-[color:var(--surface-hover)]"
          style={{
            color: 'var(--fg-1)',
            background: !isSelectedMeetings && value === null ? 'var(--surface-active)' : undefined,
          }}
        >
          <Inbox className="size-[13px]" style={{ color: 'var(--fg-2)' }} />
          All notes
        </button>
        {orgSignedIn && (
          <button
            type="button"
            data-testid="scope-shared-notes"
            onClick={() => {
              onChange(ORG_SHARED_SCOPE);
              onSelectedMeetingsChange?.([]);
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
            data-testid={`scope-folder-${f.id}`}
            onClick={() => {
              onChange(f.id);
              onSelectedMeetingsChange?.([]);
              setOpen(false);
            }}
            className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-[13px] transition-colors hover:bg-[color:var(--surface-hover)]"
            style={{
              color: 'var(--fg-1)',
              background: !isSelectedMeetings && value === f.id ? 'var(--surface-active)' : undefined,
            }}
          >
            <FolderIcon className="size-[13px]" style={{ color: 'var(--fg-2)' }} />
            <span className="truncate">{f.name}</span>
          </button>
        ))}

        {meetingsList.length > 0 && onSelectedMeetingsChange && (
          <>
            <div
              className="mx-2 my-1 h-px"
              style={{ background: 'var(--border-subtle)' }}
              aria-hidden
            />
            <div className="flex items-center justify-between px-2 pb-1 pt-0.5 text-[11px] font-medium" style={{ color: 'var(--fg-muted)' }}>
              <span>Specific notes</span>
              {selectedCount > 0 && (
                <button
                  type="button"
                  data-testid="scope-clear-meetings"
                  onClick={() => {
                    onSelectedMeetingsChange([]);
                  }}
                  className="text-[11px] transition-colors hover:underline"
                  style={{ color: 'var(--fg-muted)' }}
                >
                  Clear ({selectedCount})
                </button>
              )}
            </div>
            <div className="max-h-[160px] overflow-y-auto">
              {meetingsList.map((m) => {
                const summaryFile = m.session_info.summary_file;
                const isChecked = selectedMeetings?.includes(summaryFile) ?? false;
                return (
                  <button
                    key={summaryFile}
                    type="button"
                    data-testid="scope-meeting-item"
                    data-meeting-file={summaryFile}
                    aria-label={`Select ${m.session_info.name || 'Untitled note'}`}
                    onClick={() => {
                      const current = selectedMeetings ?? [];
                      let next: string[];
                      if (isChecked) {
                        next = current.filter((f) => f !== summaryFile);
                      } else {
                        next = [...current, summaryFile];
                        onChange(null);
                      }
                      onSelectedMeetingsChange(next);
                    }}
                    className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-[13px] transition-colors hover:bg-[color:var(--surface-hover)]"
                    style={{
                      color: 'var(--fg-1)',
                      background: isChecked ? 'var(--surface-active)' : undefined,
                    }}
                  >
                    <div
                      className="flex size-[14px] items-center justify-center rounded border"
                      style={{
                        borderColor: isChecked ? 'var(--accent-primary)' : 'var(--border-subtle)',
                        background: isChecked ? 'var(--surface-raised)' : 'transparent',
                        color: 'var(--fg-1)',
                      }}
                    >
                      {isChecked && <Check className="size-[10px]" />}
                    </div>
                    <span className="truncate flex-1">
                      {m.session_info.name || 'Untitled note'}
                    </span>
                  </button>
                );
              })}
            </div>
          </>
        )}
      </PopoverContent>
    </Popover>
  );
}
