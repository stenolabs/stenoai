import * as React from 'react';
import {
  ChevronDown,
  Globe,
  HelpCircle,
  Home as HomeIcon,
  Inbox,
  LogIn,
  LogOut,
  MessageSquare,
  Plus,
  Search,
  Settings as SettingsIcon,
} from 'lucide-react';
import { navigate, rememberNonSettingsRoute, toggleSettings } from '@/lib/router';
import { cn, shortcut } from '@/lib/utils';
import { ipc } from '@/lib/ipc';
import { LucideIcon, IconPicker } from '@/components/IconPicker';
import { Tooltip, TooltipTrigger, TooltipContent } from '@/components/ui/tooltip';
import { useUpdateFolderIcon } from '@/hooks/useFolders';
import { useOrgLogout, useOrgSession, useSharedNotesGate } from '@/hooks/useOrg';
import { useCommandPalette } from '@/components/CommandPalette';

export interface SidebarMeeting {
  summaryFile: string;
  title: string;
  dateLabel?: string;
  active?: boolean;
  folderId?: string | null;
}

export interface SidebarFolder {
  id: string;
  name: string;
  icon?: string;
  /** User-chosen folder color. Used to tint the sidebar icon so it
   *  matches the chip in the FolderScopePicker / FolderDetail header. */
  color?: string;
  meetings: SidebarMeeting[];
}

export interface SidebarContextAction {
  type: 'folder' | 'meeting';
  id: string;
  clientX: number;
  clientY: number;
  itemRect: DOMRectReadOnly;
}

// sessionStorage so collapsed state resets to open on every app restart
const COLLAPSED_KEY = 'steno-sidebar-collapsed';
const WIDTH_KEY = 'steno-sidebar-width';
const MIN_WIDTH = 220;
// Fresh installs open at the narrowest width; existing users keep their saved
// width (localStorage). Only affects first launch.
const DEFAULT_WIDTH = MIN_WIDTH;
const MAX_WIDTH = 480;

// Module-level singleton store. useState hooks on these values are not enough:
// MeetingsShell and BottomDockSlot need to share a single source of truth, or
// the dock and the main pane drift out of sync (one collapses, the other still
// thinks the sidebar is open) and the chat bar stops aligning with the notes.
type Listener = () => void;

const collapsedStore = (() => {
  let value =
    typeof sessionStorage !== 'undefined' &&
    sessionStorage.getItem(COLLAPSED_KEY) === 'true';
  const listeners = new Set<Listener>();
  return {
    get: () => value,
    set: (next: boolean) => {
      if (value === next) return;
      value = next;
      try {
        sessionStorage.setItem(COLLAPSED_KEY, String(next));
      } catch (_) {}
      listeners.forEach((l) => l());
    },
    subscribe: (l: Listener) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
  };
})();

const widthStore = (() => {
  let value = DEFAULT_WIDTH;
  if (typeof localStorage !== 'undefined') {
    const stored = localStorage.getItem(WIDTH_KEY);
    if (stored) {
      const parsed = parseInt(stored, 10);
      if (!isNaN(parsed)) {
        value = Math.max(MIN_WIDTH, Math.min(MAX_WIDTH, parsed));
      }
    }
  }
  const listeners = new Set<Listener>();
  return {
    get: () => value,
    set: (next: number) => {
      const clamped = Math.max(MIN_WIDTH, Math.min(MAX_WIDTH, next));
      if (value === clamped) return;
      value = clamped;
      try {
        localStorage.setItem(WIDTH_KEY, String(clamped));
      } catch (_) {}
      listeners.forEach((l) => l());
    },
    subscribe: (l: Listener) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
  };
})();

export function useSidebarCollapsed() {
  const sidebarCollapsed = React.useSyncExternalStore(
    collapsedStore.subscribe,
    collapsedStore.get,
    collapsedStore.get,
  );
  const toggleSidebar = React.useCallback(() => {
    collapsedStore.set(!collapsedStore.get());
  }, []);
  return { sidebarCollapsed, toggleSidebar };
}

export function useSidebarWidth() {
  const width = React.useSyncExternalStore(
    widthStore.subscribe,
    widthStore.get,
    widthStore.get,
  );
  const setWidth = React.useCallback((w: number) => widthStore.set(w), []);
  return { width, setWidth };
}

interface SidebarProps {
  collapsed: boolean;
  onToggleCollapsed: () => void;
  width: number;
  onWidthChange: (w: number) => void;
  folders: SidebarFolder[];
  totalMeetings: number;
  onNewFolder: () => void;
  onDropMeetingOnFolder?: (summaryFile: string, folderId: string | null) => void;
  onContextAction?: (action: SidebarContextAction) => void;
  currentRoute: string;
}

export function Sidebar({
  collapsed,
  onToggleCollapsed: _onToggleCollapsed,
  width,
  onWidthChange,
  folders,
  totalMeetings,
  onNewFolder,
  onDropMeetingOnFolder,
  onContextAction,
  currentRoute,
}: SidebarProps) {
  const palette = useCommandPalette();
  const [foldersOpen, setFoldersOpen] = React.useState(true);
  const [dragOverFolder, setDragOverFolder] = React.useState<string | null>(null);
  const [dragOverAllMeetings, setDragOverAllMeetings] = React.useState(false);
  const isDraggingRef = React.useRef(false);
  const [iconPicker, setIconPicker] = React.useState<{ id: string; anchorRect: DOMRect } | null>(null);
  const updateIcon = useUpdateFolderIcon();

  const isHomeActive = currentRoute === '/' || currentRoute === '';
  const isAllMeetingsActive = currentRoute === '/meetings';
  // Match /chat as well as any /chat/<id> conversation route — the same Chat
  // tab item should stay highlighted when drilling into a session.
  const isChatActive = currentRoute === '/chat' || currentRoute.startsWith('/chat/');
  const isOrgSharedActive = currentRoute.startsWith('/org/');

  const orgSession = useOrgSession();
  const orgLogout = useOrgLogout();
  const orgSignedIn = orgSession.data?.signedIn ?? false;
  // Enterprise can hide the Shared notes feature (tab + cross-folder chat).
  // `enabled` stays false until policy resolves, so the tab doesn't flash in
  // then vanish for an org that has the feature turned off.
  const sharedNotes = useSharedNotesGate(orgSignedIn);
  // Malformed % escapes throw URIError. Guard so a bad route can't crash
  // the entire sidebar render.
  const activeFolderId = React.useMemo<string | null>(() => {
    if (!currentRoute.startsWith('/folders/')) return null;
    const raw = currentRoute.slice('/folders/'.length);
    try {
      return decodeURIComponent(raw);
    } catch {
      return raw;
    }
  }, [currentRoute]);

  const handleFolderDrop = (e: React.DragEvent, folderId: string | null) => {
    e.preventDefault();
    const file = e.dataTransfer.getData('application/x-steno-meeting');
    if (file && onDropMeetingOnFolder) onDropMeetingOnFolder(file, folderId);
    setDragOverFolder(null);
    setDragOverAllMeetings(false);
  };

  const handleFolderContext = (e: React.MouseEvent, id: string) => {
    if (!onContextAction) return;
    e.preventDefault();
    const itemRect = e.currentTarget.getBoundingClientRect();
    onContextAction({ type: 'folder', id, clientX: e.clientX, clientY: e.clientY, itemRect });
  };

  const onResizeMouseDown = React.useCallback(
    (e: React.MouseEvent) => {
      e.preventDefault();
      const startX = e.clientX;
      const startWidth = width;
      isDraggingRef.current = true;
      document.body.style.cursor = 'col-resize';
      document.body.style.userSelect = 'none';

      const onMove = (ev: MouseEvent) => {
        onWidthChange(Math.max(MIN_WIDTH, Math.min(MAX_WIDTH, startWidth + ev.clientX - startX)));
      };
      const onUp = () => {
        isDraggingRef.current = false;
        document.body.style.cursor = '';
        document.body.style.userSelect = '';
        document.removeEventListener('mousemove', onMove);
        document.removeEventListener('mouseup', onUp);
      };
      document.addEventListener('mousemove', onMove);
      document.addEventListener('mouseup', onUp);
    },
    [width, onWidthChange],
  );


  return (
    <aside
      data-sidebar
      className="fixed inset-y-0 left-0 z-20 flex flex-col"
      style={{
        width,
        // Disable pointer events on the collapsed aside so clicks reach the
        // content behind it. sb-top overrides this below to stay interactive.
        pointerEvents: collapsed ? 'none' : undefined,
      }}
    >
      {/* Full-sidebar background + right border — fades when collapsed.
          zIndex:-1 keeps it behind sb-top and content inside the aside's
          stacking context (position:fixed creates one). */}
      <div
        aria-hidden
        style={{
          position: 'absolute',
          inset: 0,
          zIndex: -1,
          background: 'var(--surface-sunken)',
          borderRight: '1px solid var(--border-subtle)',
          opacity: collapsed ? 0 : 1,
          transition: 'opacity 180ms ease',
          pointerEvents: 'none',
        }}
      />

      {/* Top band — drag region for macOS traffic lights.
          The toggle button is rendered in MainToolbar instead (position:fixed,
          inside a no-drag DOM branch) so Electron's app-region logic reliably
          registers the no-drag exclusion. Spacer preserves the visual gap. */}
      {/* sb-top: drag region for traffic lights. Height spacer preserves the
          original 46px row height (14px padding-top + 26px + 6px padding-bottom)
          so the brand section clears the traffic lights. */}
      <div className="sb-top">
        <div style={{ height: 26 }} aria-hidden />
      </div>

      {/* Sidebar content — fades with the background. No explicit pointer-events
          needed: inherits none from aside when collapsed, auto when expanded. */}
      <div
        className="flex min-h-0 flex-1 flex-col overflow-hidden"
        style={{
          opacity: collapsed ? 0 : 1,
          transition: 'opacity 180ms ease',
        }}
      >
        {/* Brand */}
        <div className="flex items-center gap-[9px] px-4 pb-2.5 pt-3.5">
          <span
            aria-hidden="true"
            className="inline-flex h-[22px] w-[22px] items-center justify-center"
            style={{ color: 'var(--fg-1)' }}
          >
            <svg
              xmlns="http://www.w3.org/2000/svg"
              viewBox="0 0 450 450"
              fill="none"
              stroke="currentColor"
              strokeWidth="12"
            >
              <path d="M209.447 166.845C216.663 178.772 218.44 193.966 219.417 213.035C219.422 213.129 219.42 213.225 219.412 213.319C214.789 263.829 206.174 314.234 212.902 339.223C216.552 352.776 220.264 365.163 222.752 376.169C223.295 378.571 226.99 378.494 227.504 376.086C230.284 363.077 235.173 350.435 238.631 339.223C244.283 320.903 234.784 262.669 231.647 213.178C232.645 196.737 231.398 182.538 241.126 166.845M198.971 149.906C168.786 114.986 141.601 89.6233 93.21 90.3707C44.8194 91.1182 56.9695 115.86 74.0034 131.971C91.0372 148.081 141.627 159.331 184.18 158.423C165.298 159.389 201.563 157.91 131.124 159.87C60.7551 161.828 59.9172 224.098 127.681 209.733C127.81 209.705 127.945 209.663 128.065 209.611C168.511 192.126 188.231 177.43 218.676 143.678M231.647 125.494C278.527 72.0571 171.372 66.055 217.429 124.498C240.809 154.72 227.634 146.076 285.026 191.257C342.419 236.437 456.639 176.062 271.806 158.873C290.471 159.304 302.167 161.07 317.703 157.628C434.433 128.215 403.63 47.4569 282.532 121.508C268.291 131.274 261.97 137.712 252.35 150.155" />
            </svg>
          </span>
          <span
            className="text-[18px] font-normal"
            style={{ fontFamily: 'var(--font-serif)', letterSpacing: '-0.02em', color: 'var(--fg-1)' }}
          >
            Steno
          </span>
        </div>

        {/* Search */}
        <div className="px-3 pb-2.5">
          <div className="relative">
            <Search
              className="pointer-events-none absolute left-[9px] top-1/2 -translate-y-1/2 size-[13px]"
              style={{ color: 'var(--fg-2)' }}
            />
            <button
              type="button"
              data-testid="sidebar-search-trigger"
              onClick={() => palette.open()}
              className="flex h-[30px] w-full items-center rounded-md border-0 px-[10px] pl-[30px] text-left text-[13px] outline-none transition-colors hover:shadow-[inset_0_0_0_1px_hsl(var(--border))] focus-visible:shadow-[inset_0_0_0_1px_hsl(var(--border))]"
              style={{ background: 'rgba(27,27,25,0.04)', color: 'var(--fg-muted)', fontFamily: 'var(--font-sans)' }}
              aria-label="Search notes"
            >
              Search
            </button>
            <span
              className="pointer-events-none absolute right-2 top-1/2 -translate-y-1/2 rounded px-1.5 py-px text-[11px] tabular-nums tracking-[0.02em]"
              style={{ color: 'var(--fg-muted)', background: 'rgba(27,27,25,0.04)', fontFamily: 'var(--font-sans)' }}
            >
              {shortcut('⌘K', 'Ctrl+K')}
            </span>
          </div>
        </div>

        <div className="mx-3 h-px" style={{ background: 'var(--border-subtle)' }} />

        {/* Nav */}
        <nav className="scrollbar-clean flex min-h-0 flex-1 flex-col gap-px overflow-auto px-2 pb-2 pt-2">
          <button
            type="button"
            className={cn('sb-row', isHomeActive && 'active')}
            onClick={() => navigate('/')}
          >
            <HomeIcon className="size-[14px]" />
            <span className="flex-1 truncate">Home</span>
          </button>

          <div
            className={cn(dragOverAllMeetings && 'rounded bg-[color:var(--surface-hover)]')}
            onDragOver={(e) => {
              if (e.dataTransfer.types.includes('application/x-steno-meeting')) {
                e.preventDefault();
                e.dataTransfer.dropEffect = 'move';
                setDragOverAllMeetings(true);
              }
            }}
            onDragLeave={(e) => {
              if (e.currentTarget.contains(e.relatedTarget as Node)) return;
              setDragOverAllMeetings(false);
            }}
            onDrop={(e) => handleFolderDrop(e, null)}
          >
            <button
              type="button"
              className={cn('sb-row', isAllMeetingsActive && 'active')}
              onClick={() => navigate('/meetings')}
            >
              <Inbox className="size-[14px]" />
              <span className="flex-1 truncate">All notes</span>
              {totalMeetings > 0 && (
                <span className="text-xs tabular-nums" style={{ color: 'var(--fg-muted)' }}>
                  {totalMeetings}
                </span>
              )}
            </button>
          </div>

          <button
            type="button"
            className={cn('sb-row', isChatActive && 'active')}
            onClick={() => navigate('/chat')}
          >
            <MessageSquare className="size-[14px]" />
            <span className="flex-1 truncate">Chat</span>
          </button>

          {sharedNotes.enabled && (
            <button
              type="button"
              className={cn('sb-row', isOrgSharedActive && 'active')}
              onClick={() => navigate('/org/shared')}
              title={`Shared across ${orgSession.data?.orgId ?? 'your org'}`}
            >
              <Globe className="size-[14px]" />
              <span className="flex-1 truncate">Shared notes</span>
            </button>
          )}

          {/* Folders group */}
          <div className="mt-3.5">
            <div
              className="sb-group-head flex cursor-pointer select-none items-center justify-between px-2.5 py-1.5 text-[11.5px] font-medium tracking-[0.02em] transition-colors hover:text-[color:var(--fg-1)]"
              style={{ color: 'var(--fg-2)' }}
              onClick={() => setFoldersOpen((o) => !o)}
            >
              <span className="flex items-center gap-1.5">
                <ChevronDown className={cn('size-3 transition-transform', !foldersOpen && '-rotate-90')} />
                <span>Folders</span>
              </span>
              <Tooltip>
                <TooltipTrigger asChild>
                  <button
                    type="button"
                    className="inline-flex size-5 items-center justify-center rounded opacity-0 transition-opacity hover:bg-[color:var(--surface-active)] [.sb-group-head:hover_&]:opacity-100"
                    onClick={(e) => { e.stopPropagation(); onNewFolder(); }}
                    aria-label="New folder"
                    style={{ color: 'var(--fg-2)' }}
                  >
                    <Plus className="size-3" />
                  </button>
                </TooltipTrigger>
                <TooltipContent side="top">Create folder</TooltipContent>
              </Tooltip>
            </div>

            {foldersOpen &&
              folders.map((folder) => {
                const isOver = dragOverFolder === folder.id;
                const isActive = activeFolderId === folder.id;
                return (
                  <div
                    key={folder.id}
                    className={cn('rounded', isOver && 'bg-[color:var(--surface-hover)] ring-1 ring-[color:var(--focus-ring)]')}
                    onDragOver={(e) => {
                      if (e.dataTransfer.types.includes('application/x-steno-meeting')) {
                        e.preventDefault();
                        e.dataTransfer.dropEffect = 'move';
                        setDragOverFolder(folder.id);
                      }
                    }}
                    onDragLeave={(e) => {
                      if (e.currentTarget.contains(e.relatedTarget as Node)) return;
                      setDragOverFolder(null);
                    }}
                    onDrop={(e) => handleFolderDrop(e, folder.id)}
                    onContextMenu={(e) => handleFolderContext(e, folder.id)}
                  >
                    <button
                      type="button"
                      data-testid="sidebar-folder"
                      className={cn('sb-row', isActive && 'active')}
                      style={{ paddingLeft: 12 }}
                      onClick={() => navigate(`/folders/${encodeURIComponent(folder.id)}`)}
                    >
                      <span
                        role="button"
                        tabIndex={0}
                        aria-label="Change folder icon"
                        className="flex-shrink-0 rounded p-0.5 hover:bg-[color:var(--surface-active)]"
                        style={{ color: 'var(--fg-2)' }}
                        onClick={(e) => {
                          e.stopPropagation();
                          setIconPicker({ id: folder.id, anchorRect: e.currentTarget.getBoundingClientRect() });
                        }}
                        onKeyDown={(e) => {
                          if (e.key === 'Enter' || e.key === ' ') {
                            e.preventDefault();
                            e.stopPropagation();
                            setIconPicker({ id: folder.id, anchorRect: e.currentTarget.getBoundingClientRect() });
                          }
                        }}
                      >
                        <LucideIcon name={folder.icon ?? 'folder'} size={14} />
                      </span>
                      <span className="flex-1 truncate">{folder.name}</span>
                      <span className="text-xs tabular-nums" style={{ color: 'var(--fg-muted)' }}>
                        {folder.meetings.length}
                      </span>
                    </button>
                  </div>
                );
              })}
          </div>
        </nav>

        {/* Profile chip + Settings cog. When the user is signed in to an org
            adapter, the chip sits on the left and the cog moves to the right
            (justify-between). When signed out we surface a one-click sign-in
            CTA, but ONLY for users who've previously connected to an org —
            personal users who have never signed in don't see clutter for a
            feature they don't use. */}
        <div className="flex items-center justify-between gap-2 px-3 py-2">
          {orgSignedIn ? (
            <ProfileChip
              email={orgSession.data?.email ?? ''}
              name={orgSession.data?.name ?? ''}
              orgId={orgSession.data?.orgId ?? ''}
              onSignOut={() => orgLogout.mutate()}
            />
          ) : orgSession.data?.everSignedIn ? (
            <button
              type="button"
              onClick={() => {
                rememberNonSettingsRoute(currentRoute);
                navigate('/settings?tab=organisation');
              }}
              className="inline-flex h-[26px] min-w-0 items-center gap-1.5 rounded-md px-2 text-[12px] transition-colors hover:bg-[color:var(--surface-active)]"
              style={{ color: 'var(--fg-1)' }}
              title="Sign in to share notes with your organisation"
            >
              <LogIn className="size-[13px]" style={{ color: 'var(--fg-2)' }} />
              <span className="truncate">Sign in to org</span>
            </button>
          ) : (
            <span />
          )}
          {/* Grouped together so justify-between (which splits this row into
              exactly two sides: profile/sign-in-CTA on the left, this group
              on the right) doesn't treat Help as a third independent side and
              spread it away from the Settings cog. */}
          <div className="flex items-center gap-1">
          <Tooltip>
            <TooltipTrigger asChild>
              <button
                type="button"
                onClick={() => void ipc().shell.openExternal('https://docs.stenoai.co')}
                aria-label="Help"
                className="inline-flex h-[26px] w-7 items-center justify-center rounded-md transition-colors hover:bg-[color:var(--surface-active)] hover:text-[color:var(--fg-1)]"
                style={{ color: 'var(--fg-2)' }}
              >
                <HelpCircle className="size-[15px]" />
              </button>
            </TooltipTrigger>
            <TooltipContent side="top">Documentation</TooltipContent>
          </Tooltip>
          <Tooltip>
            <TooltipTrigger asChild>
              <button
                type="button"
                onClick={() => toggleSettings(currentRoute)}
                aria-label="Settings"
                // startsWith so the cog still reads "active" on deep-link routes
                // like /settings?tab=organisation, not just bare /settings.
                aria-pressed={currentRoute.startsWith('/settings')}
                className={cn(
                  'inline-flex h-[26px] w-7 items-center justify-center rounded-md transition-colors hover:bg-[color:var(--surface-active)] hover:text-[color:var(--fg-1)]',
                  currentRoute.startsWith('/settings')
                    ? 'bg-[color:var(--surface-active)] text-[color:var(--fg-1)]'
                    : 'text-[color:var(--fg-2)]',
                )}
              >
                <SettingsIcon className="size-[15px]" />
              </button>
            </TooltipTrigger>
            <TooltipContent side="top">Settings</TooltipContent>
          </Tooltip>
          </div>
        </div>

        {iconPicker && (
          <IconPicker
            anchorRect={iconPicker.anchorRect}
            onSelect={(icon) => updateIcon.mutate({ id: iconPicker.id, icon })}
            onClose={() => setIconPicker(null)}
          />
        )}
      </div>

      {/* Resize handle */}
      {!collapsed && (
        <div
          onMouseDown={onResizeMouseDown}
          aria-hidden
          className="absolute inset-y-0 right-0 z-10 w-1 cursor-col-resize hover:bg-[hsl(var(--border))]"
          style={{ WebkitAppRegion: 'no-drag' } as React.CSSProperties}
        />
      )}
    </aside>
  );
}

// ---------------------------------------------------------------------------
// ProfileChip — shown bottom-left when signed in to an org adapter. Click
// opens a small popover with the full identity + sign-out button. The avatar
// is an emoji per email so we don't need a real photo backend for the demo.
// ---------------------------------------------------------------------------

const AVATAR_BY_LOCAL_PART: Record<string, string> = {
  alice: '👩‍💼',
  bob: '👨‍💼',
  carol: '🧑‍💼',
  dan: '👨‍💻',
};

function avatarFor(email: string): string {
  const local = (email.split('@')[0] || '').toLowerCase();
  return AVATAR_BY_LOCAL_PART[local] || '🧑';
}

interface ProfileChipProps {
  email: string;
  name: string;
  orgId: string;
  onSignOut: () => void;
}

function ProfileChip({ email, name, orgId, onSignOut }: ProfileChipProps) {
  const [open, setOpen] = React.useState(false);
  const ref = React.useRef<HTMLDivElement>(null);

  React.useEffect(() => {
    if (!open) return;
    const onClick = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', onClick);
    return () => document.removeEventListener('mousedown', onClick);
  }, [open]);

  const initial = (name || email).slice(0, 1).toUpperCase();

  return (
    <div ref={ref} className="relative">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex items-center gap-2 rounded-md px-1.5 py-1 transition-colors hover:bg-[color:var(--surface-active)]"
        title={`${name || email} · ${orgId}`}
        aria-haspopup="menu"
        aria-expanded={open}
      >
        <span
          aria-hidden
          className="inline-flex size-[22px] items-center justify-center rounded-full text-[13px]"
          style={{ background: 'var(--surface-raised)', color: 'var(--fg-1)' }}
        >
          {avatarFor(email) || initial}
        </span>
        <span
          className="max-w-[120px] truncate text-[12.5px]"
          style={{ color: 'var(--fg-1)' }}
        >
          {(name || email).split(' ')[0]}
        </span>
      </button>

      {open && (
        <div
          role="menu"
          className="absolute bottom-[110%] left-0 z-30 min-w-[200px] overflow-hidden rounded-[8px] shadow-md"
          style={{
            background: 'var(--surface-raised)',
            border: '1px solid var(--border-subtle)',
          }}
        >
          <div className="px-3 py-2.5">
            <div className="text-[12.5px] font-medium" style={{ color: 'var(--fg-1)' }}>
              {name || email}
            </div>
            <div className="mt-0.5 text-[11px]" style={{ color: 'var(--fg-2)' }}>
              {email}
            </div>
            <div className="mt-1 text-[10.5px]" style={{ color: 'var(--fg-muted)', fontFamily: 'var(--font-mono)' }}>
              org · {orgId}
            </div>
          </div>
          <div className="border-t border-[color:var(--border-subtle)]">
            <button
              type="button"
              role="menuitem"
              className="flex w-full items-center gap-2 px-3 py-2 text-left text-[12.5px] transition-colors hover:bg-[color:var(--surface-hover)]"
              style={{ color: 'var(--fg-1)' }}
              onClick={() => {
                setOpen(false);
                onSignOut();
              }}
            >
              <LogOut className="size-[12px]" /> Sign out
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
