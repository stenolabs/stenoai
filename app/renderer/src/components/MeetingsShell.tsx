import * as React from 'react';
import { AppShell } from '@/components/AppShell';
import {
  Sidebar,
  useSidebarCollapsed,
  useSidebarWidth,
  type SidebarContextAction,
  type SidebarFolder,
  type SidebarMeeting,
} from '@/components/Sidebar';
import { MeetingsListProvider } from '@/lib/meetingsListContext';
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { useMeetings, useDeleteMeeting, useUpdateMeeting } from '@/hooks/useMeetings';
import {
  useAddMeetingToFolder,
  useCreateFolder,
  useDeleteFolder,
  useFolders,
  useRemoveMeetingFromFolder,
  useRenameFolder,
} from '@/hooks/useFolders';
import { useRecording } from '@/hooks/useRecording';
import { navigate, useRoute } from '@/lib/router';
import type { Meeting } from '@/lib/ipc';
import { UI_LOCALE } from '@/lib/locale';

interface MeetingsShellProps {
  activeSummaryFile: string | null;
  contentAlign?: 'top' | 'center';
  askBarSlot?: React.ReactNode;
  /**
   * When true, the main toolbar (record button) is hidden AND the centered
   * content wrapper is omitted. Used by /recording where the LiveDock owns
   * recording controls.
   */
  hideToolbar?: boolean;
  /**
   * When true, omits the centered content wrapper but keeps the toolbar
   * visible. Used by /settings, which has its own full-viewport layout.
   */
  bleed?: boolean;
  children: React.ReactNode;
}

export function MeetingsShell({
  activeSummaryFile,
  contentAlign = 'top',
  askBarSlot,
  hideToolbar = false,
  bleed = false,
  children,
}: MeetingsShellProps) {
  const meetings = useMeetings();
  const folders = useFolders();
  const recording = useRecording();
  const route = useRoute();

  const createFolder = useCreateFolder();
  const renameFolder = useRenameFolder();
  const deleteFolder = useDeleteFolder();
  const addToFolder = useAddMeetingToFolder();
  const removeFromFolder = useRemoveMeetingFromFolder();
  const updateMeeting = useUpdateMeeting();
  const deleteMeeting = useDeleteMeeting();

  const { sidebarCollapsed, toggleSidebar } = useSidebarCollapsed();
  const { width: sidebarWidth, setWidth: setSidebarWidth } = useSidebarWidth();

  const [newFolderOpen, setNewFolderOpen] = React.useState(false);
  const [newFolderName, setNewFolderName] = React.useState('');
  const creatingFolder = React.useRef(false);
  const [folderError, setFolderError] = React.useState<string | null>(null);
  const createFolderLabel = createFolder.isPending ? 'Creating folder…' : 'Create folder';
  const [renameTarget, setRenameTarget] = React.useState<
    { type: 'folder' | 'meeting'; id: string; current: string; itemRect: DOMRectReadOnly } | null
  >(null);
  const [context, setContext] = React.useState<SidebarContextAction | null>(null);
  // Folders only: deleting a folder is NOT undoable, so it keeps a confirm step.
  // Notes delete straight away and are caught by the Undo toast instead (#234).
  const [deleteTarget, setDeleteTarget] = React.useState<{
    type: 'folder';
    id: string;
    name: string;
    meetingCount: number;
  } | null>(null);

  // Sidebar shows only folder rows + counts. buildSidebar gives us folder
  // metadata (name + meeting count); the per-folder meetings array is unused.
  const { sidebarFolders } = React.useMemo(
    () =>
      buildSidebar({
        meetings: meetings.data ?? [],
        folders: folders.data ?? [],
        search: '',
        activeSummaryFile,
      }),
    [meetings.data, folders.data, activeSummaryFile],
  );

  const totalMeetings = meetings.data?.length ?? 0;

  const isRecording = recording.status === 'recording' || recording.status === 'paused';
  // Toolbar button behaviour: idle or processing → start a new recording AND
  // open the live-note editor (/recording) so the user has somewhere to write
  // notes while it records (a previous note keeps processing in the background
  // queue); recording or paused → re-open that editor. Coexistence still holds
  // — the pill follows the user if they navigate away — but the explicit "New
  // note" action lands them on the note, not nowhere. Stop lives on the pill.
  const onToggleRecording = () => {
    if (!isRecording) void recording.startRecording();
    navigate('/recording');
  };

  const onDropMeetingOnFolder = async (summaryFile: string, folderId: string | null) => {
    const meeting = meetings.data?.find((m) => m.session_info.summary_file === summaryFile);
    if (!meeting) return;
    const current = meeting.folders ?? [];
    const currentFolderId = current[0] ?? null;
    if (currentFolderId === folderId) return;
    if (currentFolderId) {
      await removeFromFolder.mutateAsync({ summaryFile, folderId: currentFolderId });
    }
    if (folderId) {
      await addToFolder.mutateAsync({ summaryFile, folderId });
    }
  };

  const handleCreateFolder = async () => {
    const name = newFolderName.trim();
    if (!name || creatingFolder.current) return;
    creatingFolder.current = true;
    setFolderError(null);
    try {
      await createFolder.mutateAsync({ name });
      setNewFolderName('');
      setNewFolderOpen(false);
    } catch {
      setFolderError('Could not create folder. Please try again.');
    } finally {
      creatingFolder.current = false;
    }
  };

  const openRename = (
    type: 'folder' | 'meeting',
    id: string,
    current: string,
    itemRect: DOMRectReadOnly,
  ) => {
    setRenameTarget({ type, id, current, itemRect });
    setContext(null);
  };

  const commitRename = async (type: 'folder' | 'meeting', id: string, value: string) => {
    try {
      if (type === 'folder') {
        await renameFolder.mutateAsync({ id, name: value });
      } else {
        await updateMeeting.mutateAsync({ summaryFile: id, patch: { name: value } });
      }
    } catch (err) {
      console.error('Rename failed:', err);
    }
  };

  const onDeleteAction = () => {
    if (!context) return;
    if (context.type === 'folder') {
      const folder = folders.data?.find((f) => f.id === context.id);
      if (!folder) return setContext(null);
      const meetingCount =
        meetings.data?.filter((m) => (m.folders ?? []).includes(context.id)).length ?? 0;
      setDeleteTarget({ type: 'folder', id: context.id, name: folder.name, meetingCount });
      setContext(null);
      return;
    }
    // Notes: no confirm step — the soft-delete's Undo toast is the safety net,
    // so asking first would just add a click to an already reversible action.
    const target = meetings.data?.find((m) => m.session_info.summary_file === context.id);
    setContext(null);
    if (!target) return;
    const summaryFile = target.session_info.summary_file;
    void deleteMeeting
      .mutateAsync(target)
      .then(() => {
        if (activeSummaryFile === summaryFile) navigate('/');
      })
      .catch((err) => {
        // A refused delete (main's busy-guard) leaves the row in place. Log it
        // rather than throwing an unhandled rejection; the row staying put is
        // the user-visible signal here, and MeetingDetail surfaces the reason.
        console.error('Delete failed:', err);
      });
  };

  const handleConfirmDeleteFolder = async () => {
    if (!deleteTarget) return;
    await deleteFolder.mutateAsync(deleteTarget.id);
    setDeleteTarget(null);
  };

  return (
    <>
      <AppShell
        recordingStatus={recording.status}
        recordingElapsed={recording.elapsed}
        onToggleRecording={onToggleRecording}
        sidebarWidth={sidebarWidth}
        sidebarCollapsed={sidebarCollapsed}
        askBarSlot={askBarSlot}
        contentAlign={contentAlign}
        hideToolbar={hideToolbar}
        bleed={bleed}
        onToggleSidebar={toggleSidebar}
        sidebar={
          <Sidebar
            collapsed={sidebarCollapsed}
            onToggleCollapsed={toggleSidebar}
            width={sidebarWidth}
            onWidthChange={setSidebarWidth}
            folders={sidebarFolders}
            totalMeetings={totalMeetings}
            onNewFolder={() => setNewFolderOpen(true)}
            onDropMeetingOnFolder={onDropMeetingOnFolder}
            onContextAction={setContext}
            currentRoute={route}
          />
        }
      >
        <MeetingsListProvider onContextAction={setContext}>
          {children}
        </MeetingsListProvider>
      </AppShell>

      {context && (
        <ContextMenu
          action={context}
          onClose={() => setContext(null)}
          onRename={(label) => openRename(context.type, context.id, label, context.itemRect)}
          onDelete={onDeleteAction}
          folders={folders.data ?? []}
          meetings={meetings.data ?? []}
        />
      )}

      <ConfirmDialog
        open={!!deleteTarget}
        onOpenChange={(o) => !o && setDeleteTarget(null)}
        title={deleteTarget ? `Delete folder "${deleteTarget.name}"?` : ''}
        description={
          deleteTarget && deleteTarget.meetingCount > 0 ? (
            <>
              {deleteTarget.meetingCount} meeting
              {deleteTarget.meetingCount === 1 ? '' : 's'} will be moved back to All Notes. No
              recordings or transcripts will be deleted.
            </>
          ) : (
            <>No recordings or transcripts will be deleted.</>
          )
        }
        confirmLabel="Delete"
        destructive
        onConfirm={handleConfirmDeleteFolder}
        isPending={deleteFolder.isPending}
      />

      <Dialog open={newFolderOpen} onOpenChange={(open) => {
        if (!creatingFolder.current) {
          setNewFolderOpen(open);
          setFolderError(null);
        }
      }}>
        <DialogContent closeDisabled={createFolder.isPending}>
          <DialogHeader>
            <DialogTitle>New folder</DialogTitle>
            <DialogDescription>
              Group related meetings together. Folder names are only visible to you.
            </DialogDescription>
          </DialogHeader>
          <Input
            disabled={createFolder.isPending}
            value={newFolderName}
            onChange={(e) => setNewFolderName(e.target.value)}
            placeholder="e.g. Acme Corp"
            autoFocus
            onKeyDown={(e) => {
              if (e.key === 'Enter') void handleCreateFolder();
            }}
          />
          {folderError && <p role="alert">{folderError}</p>}
          <DialogFooter>
            <DialogClose asChild>
              <Button variant="outline" disabled={createFolder.isPending}>Cancel</Button>
            </DialogClose>
            <Button disabled={createFolder.isPending || !newFolderName.trim()} aria-busy={createFolder.isPending} onClick={() => void handleCreateFolder()}>
              {createFolderLabel}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {renameTarget && (
        <RenamePopover
          key={renameTarget.id}
          initialValue={renameTarget.current}
          itemRect={renameTarget.itemRect}
          onSave={(value) => {
            void commitRename(renameTarget.type, renameTarget.id, value);
            setRenameTarget(null);
          }}
          onCancel={() => setRenameTarget(null)}
        />
      )}
    </>
  );
}

// ---------------------------------------------------------------------------
// Helpers (formerly in classic MeetingsShell — inlined since we now ship one
// React UI). Kept exported because FolderDetail + Home reuse formatDateLabel.
// ---------------------------------------------------------------------------

interface ContextMenuProps {
  action: SidebarContextAction;
  onClose: () => void;
  onRename: (currentLabel: string) => void;
  onDelete: () => void;
  folders: Array<{ id: string; name: string }>;
  meetings: Meeting[];
}

function ContextMenu({
  action,
  onClose,
  onRename,
  onDelete,
  folders,
  meetings,
}: ContextMenuProps) {
  const ref = React.useRef<HTMLDivElement>(null);
  React.useEffect(() => {
    const onDoc = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('mousedown', onDoc);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDoc);
      document.removeEventListener('keydown', onKey);
    };
  }, [onClose]);

  const currentLabel =
    action.type === 'folder'
      ? (folders.find((f) => f.id === action.id)?.name ?? '')
      : (meetings.find((m) => m.session_info.summary_file === action.id)?.session_info.name ?? '');

  return (
    <div
      ref={ref}
      role="menu"
      style={{ top: action.clientY, left: action.clientX }}
      className="fixed z-50 min-w-[160px] rounded-md border border-border bg-popover p-1 shadow-lg"
    >
      <button
        type="button"
        className="flex w-full items-center rounded px-2 py-1.5 text-left text-sm hover:bg-muted"
        onClick={() => onRename(currentLabel)}
      >
        Rename
      </button>
      <button
        type="button"
        className="flex w-full items-center rounded px-2 py-1.5 text-left text-sm text-destructive hover:bg-destructive/10"
        onClick={onDelete}
      >
        Delete
      </button>
    </div>
  );
}

function RenamePopover({
  initialValue,
  itemRect,
  onSave,
  onCancel,
}: {
  initialValue: string;
  itemRect: DOMRectReadOnly;
  onSave: (value: string) => void;
  onCancel: () => void;
}) {
  const [value, setValue] = React.useState(initialValue);
  const [visible, setVisible] = React.useState(false);
  const inputRef = React.useRef<HTMLInputElement>(null);
  const closingRef = React.useRef(false);
  const valueRef = React.useRef(value);
  React.useEffect(() => {
    valueRef.current = value;
  }, [value]);

  React.useEffect(() => {
    const id = requestAnimationFrame(() => setVisible(true));
    inputRef.current?.select();
    return () => cancelAnimationFrame(id);
  }, []);

  const close = React.useCallback((save: boolean) => {
    if (closingRef.current) return;
    closingRef.current = true;
    setVisible(false);
    setTimeout(() => {
      if (save) {
        const trimmed = valueRef.current.trim();
        if (trimmed && trimmed !== initialValue) {
          onSave(trimmed);
        } else {
          onCancel();
        }
      } else {
        onCancel();
      }
    }, 120);
  }, [initialValue, onSave, onCancel]);

  return (
    <div
      className="fixed z-50 rounded-lg border border-border bg-card p-2 shadow-lg"
      style={{
        top: itemRect.bottom + 4,
        left: itemRect.left,
        width: Math.max(itemRect.width, 200),
        opacity: visible ? 1 : 0,
        transition: 'opacity 120ms ease',
      }}
    >
      <Input
        ref={inputRef}
        value={value}
        onChange={(e) => setValue(e.target.value)}
        onBlur={() => close(true)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') { e.preventDefault(); close(true); }
          if (e.key === 'Escape') { e.preventDefault(); close(false); }
        }}
      />
    </div>
  );
}

interface BuildArgs {
  meetings: Meeting[];
  folders: Array<{ id: string; name: string; icon?: string; color?: string; order: number }>;
  search: string;
  activeSummaryFile: string | null;
}

function buildSidebar({ meetings, folders, search, activeSummaryFile }: BuildArgs) {
  const needle = search.trim().toLowerCase();
  const match = (m: Meeting) =>
    !needle || m.session_info.name.toLowerCase().includes(needle);

  const foldered = new Set<string>();
  const sidebarFolders: SidebarFolder[] = [...folders]
    .sort((a, b) => a.order - b.order)
    .map((f) => {
      const folderMeetings = meetings.filter((m) => (m.folders ?? []).includes(f.id));
      folderMeetings.forEach((m) => foldered.add(m.session_info.summary_file));
      return {
        id: f.id,
        name: f.name,
        icon: f.icon,
        color: f.color,
        meetings: folderMeetings
          .filter(match)
          .map((m) => meetingToSidebar(m, activeSummaryFile)),
      };
    });

  const sidebarUnfiled = meetings
    .filter((m) => !foldered.has(m.session_info.summary_file))
    .filter(match)
    .map((m) => meetingToSidebar(m, activeSummaryFile));

  return { sidebarUnfiled, sidebarFolders };
}

function meetingToSidebar(meeting: Meeting, activeSummaryFile: string | null): SidebarMeeting {
  return {
    summaryFile: meeting.session_info.summary_file,
    title: meeting.session_info.name,
    dateLabel: formatDateLabel(meeting.session_info),
    active: meeting.session_info.summary_file === activeSummaryFile,
  };
}

export function formatDateLabel(info: Meeting['session_info']): string | undefined {
  const raw = info.processed_at ?? info.updated_at;
  if (!raw) return undefined;
  const d = new Date(raw);
  if (Number.isNaN(d.getTime())) return undefined;
  const now = new Date();
  const sameDay =
    d.getFullYear() === now.getFullYear() &&
    d.getMonth() === now.getMonth() &&
    d.getDate() === now.getDate();
  if (sameDay) return 'Today';
  const yesterday = new Date(now);
  yesterday.setDate(now.getDate() - 1);
  const wasYesterday =
    d.getFullYear() === yesterday.getFullYear() &&
    d.getMonth() === yesterday.getMonth() &&
    d.getDate() === yesterday.getDate();
  if (wasYesterday) return 'Yesterday';
  if (now.getTime() - d.getTime() < 7 * 24 * 60 * 60 * 1000) {
    return d.toLocaleDateString(UI_LOCALE, { weekday: 'short' });
  }
  return d.toLocaleDateString(UI_LOCALE, { month: 'short', day: 'numeric' });
}
