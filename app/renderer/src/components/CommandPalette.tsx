import * as React from 'react';
import { Search } from 'lucide-react';
import { useMeetings, LIVE_SUMMARY_PREFIX } from '@/hooks/useMeetings';
import { searchNotes, snippet } from '@/lib/noteSearch';
import { navigate, useRoute } from '@/lib/router';
import { isMac } from '@/lib/utils';
import type { Meeting } from '@/lib/ipc';

interface PaletteContextValue {
  open: () => void;
}

const PaletteContext = React.createContext<PaletteContextValue | null>(null);

export function useCommandPalette(): PaletteContextValue {
  const ctx = React.useContext(PaletteContext);
  if (!ctx) throw new Error('useCommandPalette must be used within CommandPaletteProvider');
  return ctx;
}

const RECENT_COUNT = 8;
// Bound how many matches we render/snippet per keystroke; a broad term against a
// large library would otherwise build hundreds of rows. Refine the query to reach
// the rest — standard command-palette behavior.
const MAX_RESULTS = 50;

/** Most-recent first. The backend list (useMeetings) is unsorted; Home re-sorts
 *  in groupPrevious by the same key, so we mirror it here. */
function recencyMs(m: Meeting): number {
  return new Date(m.session_info.processed_at ?? m.session_info.updated_at ?? 0).getTime();
}

interface SettingsEntry {
  id: string;
  /** A deep-link tab id accepted by Settings.tsx (its DEEP_LINK_IDS). Selecting
   *  a row navigates to `/settings?tab=<tab>`. Keep these in sync with the
   *  current nav rail (SettingsNav) — a stale id would land on the General tab. */
  tab: string;
  title: string;
  sub: string;
  /** Settings that only render on macOS (behind `isMac` in GeneralTab):
   *  "Record system audio" and "Hide dock icon". On Windows those rows don't
   *  exist, so indexing them would jump to a tab where nothing's there —
   *  filtered out below when not on mac (#405). */
  macOnly?: boolean;
}

// Searchable index of the app's settings, mapped to the tab each one lives on
// today (post-v0.6.2 nav rail). Selecting a result opens that tab. Transcription
// settings now live on the AI tab, so they map to `ai`. Adapted from @Vassista's
// PR #349 and retargeted to the current tab layout.
//
// Keep titles in sync with the rendered setting labels (GeneralTab/AiTab/
// AboutTab etc.) — the T1 spec asserts a few titles still match, to catch the
// index drifting out from under a renamed control.
const SETTINGS_INDEX: SettingsEntry[] = [
  { id: 'general-name', tab: 'general', title: 'Your name', sub: 'In-app greeting' },
  { id: 'general-theme', tab: 'general', title: 'Appearance', sub: 'Light, dark, or system theme' },
  { id: 'general-calendar', tab: 'general', title: 'Connect calendar', sub: 'Google, Outlook' },
  { id: 'general-scheduled', tab: 'general', title: 'Scheduled meetings', sub: 'Upcoming calendar events' },
  { id: 'general-autodetect', tab: 'general', title: 'Auto-detected meetings', sub: 'Notify when another app uses the microphone' },
  { id: 'general-notifications', tab: 'general', title: 'Post meeting notifications', sub: 'Desktop notifications when notes are ready' },
  { id: 'general-mic', tab: 'general', title: 'Microphone', sub: 'Input device' },
  { id: 'general-system-audio', tab: 'general', title: 'Record system audio', sub: 'Capture other participants', macOnly: true },
  { id: 'general-silence', tab: 'general', title: 'Auto-stop on silence', sub: 'End a recording when it goes quiet' },
  { id: 'general-launch', tab: 'general', title: 'Launch on login', sub: 'Start Steno automatically' },
  // Cross-platform row (Electron's Tray covers the macOS menu bar and the
  // Windows system tray); its rendered label switches on platform, so mirror
  // that here so the title matches whatever GeneralTab shows.
  {
    id: 'general-menubar',
    tab: 'general',
    title: isMac ? 'Show in menu bar' : 'Show in system tray',
    sub: 'Quick-access icon in the menu bar or system tray',
  },
  { id: 'general-dock', tab: 'general', title: 'Hide dock icon', sub: 'Menu bar / tray icon only', macOnly: true },
  { id: 'ai-language', tab: 'ai', title: 'Language', sub: 'Transcription and summary language' },
  { id: 'ai-transcription', tab: 'ai', title: 'Transcription model', sub: 'Parakeet or Whisper' },
  { id: 'ai-save-recordings', tab: 'ai', title: 'Save recordings', sub: 'Keep the audio files after transcription' },
  { id: 'ai-autonotes', tab: 'ai', title: 'Generate notes automatically', sub: 'Summarise after transcription' },
  { id: 'ai-provider', tab: 'ai', title: 'AI provider', sub: 'Local, private server, cloud, or organisation' },
  { id: 'templates', tab: 'templates', title: 'Templates', sub: 'Custom note formats' },
  { id: 'org', tab: 'organisation', title: 'Organisation', sub: 'Sign in and back up notes to your org' },
  { id: 'advanced-storage', tab: 'advanced', title: 'Storage location', sub: 'Where notes and recordings are saved' },
  { id: 'advanced-setup', tab: 'advanced', title: 'Setup wizard', sub: 'Re-run first-time setup' },
  { id: 'advanced-clear', tab: 'advanced', title: 'Clear recording state', sub: 'Reset a stuck recording' },
  { id: 'advanced-analytics', tab: 'advanced', title: 'Anonymous usage analytics', sub: 'Opt in or out' },
  { id: 'developer', tab: 'developer', title: 'Developer', sub: 'Diagnostics and logs' },
  { id: 'about', tab: 'about', title: 'About', sub: 'Version, release notes, check for updates' },
  { id: 'about-discord', tab: 'about', title: 'Discord', sub: 'Join the community, ask questions, share feedback' },
];

// Only the settings that actually render on this platform. macOS-only rows
// ("Record system audio", "Hide dock icon") don't exist on Windows/Linux, so
// they're dropped from the index there — otherwise selecting one would jump to
// a tab where the row isn't shown (#405).
const AVAILABLE_SETTINGS = SETTINGS_INDEX.filter((s) => !s.macOnly || isMac);

/**
 * Global ⌘K search. Provides `open()` to descendants (the sidebar trigger) and
 * renders the overlay itself. Searches notes (title + summary) from any screen
 * via the shared matcher and opens the selected note. See #213.
 */
export function CommandPaletteProvider({ children }: { children: React.ReactNode }) {
  const [isOpen, setIsOpen] = React.useState(false);
  const value = React.useMemo(() => ({ open: () => setIsOpen(true) }), []);
  return (
    <PaletteContext.Provider value={value}>
      {children}
      {isOpen && <CommandPalette onClose={() => setIsOpen(false)} />}
    </PaletteContext.Provider>
  );
}

function CommandPalette({ onClose }: { onClose: () => void }) {
  // Context-aware: while the Settings page is open, ⌘K searches settings and
  // jumps to the tab each one lives on; everywhere else it searches notes.
  const currentRoute = useRoute();
  const isSettingsMode = currentRoute.startsWith('/settings');
  const meetings = useMeetings();
  // One recency sort feeds both paths: empty-query recents and search results
  // (searchNotes preserves input order, so results stay newest-first).
  const sorted = React.useMemo(
    () =>
      (meetings.data ?? [])
        // Drop the synthetic in-progress placeholders (live recording + the
        // processing row). They share the __live__/ sentinel summary_file, so
        // opening one would navigate to a detail route that doesn't exist on
        // disk. Real notes being reprocessed keep their real summary_file and
        // stay searchable.
        .filter((m) => !m.is_recording && !m.session_info.summary_file.startsWith(LIVE_SUMMARY_PREFIX))
        .slice()
        .sort((a, b) => recencyMs(b) - recencyMs(a)),
    [meetings.data],
  );
  const [query, setQuery] = React.useState('');
  const [selected, setSelected] = React.useState(0);
  const inputRef = React.useRef<HTMLInputElement>(null);
  const listRef = React.useRef<HTMLUListElement>(null);

  // Autofocus the input on open; restore focus to the previously-focused
  // element (e.g. the sidebar trigger) when the palette closes.
  React.useEffect(() => {
    const prev = document.activeElement as HTMLElement | null;
    inputRef.current?.focus();
    return () => prev?.focus?.();
  }, []);

  const settingsResults = React.useMemo<SettingsEntry[]>(() => {
    if (!isSettingsMode) return [];
    if (!query.trim()) return AVAILABLE_SETTINGS;
    const q = query.trim().toLowerCase();
    return AVAILABLE_SETTINGS.filter(
      (s) => s.title.toLowerCase().includes(q) || s.sub.toLowerCase().includes(q),
    );
  }, [isSettingsMode, query]);

  const noteResults = React.useMemo<Meeting[]>(() => {
    if (isSettingsMode) return [];
    if (!query.trim()) return sorted.slice(0, RECENT_COUNT);
    return searchNotes(sorted, query).slice(0, MAX_RESULTS);
  }, [isSettingsMode, sorted, query]);

  const resultCount = isSettingsMode ? settingsResults.length : noteResults.length;

  // Keep selection within [0, len-1]; never let it stick at -1 once results
  // appear (ArrowDown on an empty list would otherwise leave it negative).
  React.useEffect(() => {
    setSelected((s) => Math.max(0, Math.min(s, resultCount - 1)));
  }, [resultCount]);

  // Scroll the active option into view as the keyboard selection moves.
  React.useEffect(() => {
    listRef.current
      ?.querySelector(`[data-index="${selected}"]`)
      ?.scrollIntoView({ block: 'nearest' });
  }, [selected]);

  const openMeeting = (m: Meeting | undefined) => {
    if (!m) return;
    navigate(`/meetings/${encodeURIComponent(m.session_info.summary_file)}`);
    onClose();
  };

  const openSetting = (s: SettingsEntry | undefined) => {
    if (!s) return;
    navigate(`/settings?tab=${s.tab}`);
    onClose();
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Escape') {
      e.preventDefault();
      // Stop the Escape from also reaching document-level handlers (e.g. the
      // QuitDialog's), which would otherwise close both at once.
      e.stopPropagation();
      onClose();
    } else if (e.key === 'ArrowDown') {
      e.preventDefault();
      setSelected((s) => Math.min(s + 1, resultCount - 1));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setSelected((s) => Math.max(s - 1, 0));
    } else if (e.key === 'Enter') {
      e.preventDefault();
      if (isSettingsMode) openSetting(settingsResults[selected]);
      else openMeeting(noteResults[selected]);
    } else if (e.key === 'Tab') {
      // The input is the only tab stop in the dialog; trap Tab so focus can't
      // escape behind the aria-modal overlay.
      e.preventDefault();
    }
  };

  // Guard against `selected` briefly pointing past the list right after it
  // shrinks (before the clamp effect runs) — only expose activedescendant when
  // an option actually exists at that index, so aria never references a
  // nonexistent id.
  const activeId = (isSettingsMode ? settingsResults[selected] : noteResults[selected])
    ? `cmdk-opt-${selected}`
    : undefined;

  return (
    <div
      data-testid="command-palette"
      className="fixed inset-0 z-[200] flex items-start justify-center"
      onMouseDown={onClose}
    >
      <div className="absolute inset-0 bg-ink-900/40 backdrop-blur-sm" />
      <div
        role="dialog"
        aria-modal="true"
        aria-label={isSettingsMode ? 'Search settings' : 'Search notes'}
        className="relative mt-[12vh] w-[min(620px,92vw)] overflow-hidden rounded-xl shadow-[var(--shadow-md)]"
        style={{ background: 'var(--surface-raised)', border: '1px solid hsl(var(--border))' }}
        onMouseDown={(e) => e.stopPropagation()}
        onKeyDown={onKeyDown}
      >
        <div
          className="flex items-center gap-2 px-3.5 py-3"
          style={{ borderBottom: '1px solid var(--border-subtle)' }}
        >
          <Search className="size-[15px]" style={{ color: 'var(--fg-2)' }} />
          <input
            ref={inputRef}
            data-testid="command-palette-input"
            className="w-full bg-transparent text-[14px] outline-none"
            style={{ color: 'var(--fg-1)', fontFamily: 'var(--font-sans)' }}
            placeholder={isSettingsMode ? 'Search settings…' : 'Search notes…'}
            aria-label={isSettingsMode ? 'Search settings' : 'Search notes'}
            role="combobox"
            aria-expanded="true"
            aria-controls="cmdk-listbox"
            aria-activedescendant={activeId}
            value={query}
            onChange={(e) => {
              setQuery(e.target.value);
              setSelected(0);
            }}
          />
        </div>

        <ul
          ref={listRef}
          id="cmdk-listbox"
          role="listbox"
          aria-label="Search results"
          className="scrollbar-clean max-h-[50vh] overflow-auto py-1"
        >
          {resultCount === 0 ? (
            <li
              className="px-3.5 py-6 text-center text-[13px]"
              style={{ color: 'var(--fg-muted)' }}
            >
              {query.trim()
                ? `No ${isSettingsMode ? 'settings' : 'notes'} match “${query.trim()}”`
                : isSettingsMode
                  ? 'No settings'
                  : 'No notes yet'}
            </li>
          ) : isSettingsMode ? (
            settingsResults.map((s, i) => (
              <li
                key={s.id}
                id={`cmdk-opt-${i}`}
                role="option"
                aria-selected={i === selected}
                data-index={i}
                data-testid="command-palette-result"
                className="mx-1 cursor-pointer rounded-md px-2.5 py-2"
                style={i === selected ? { background: 'var(--surface-active)' } : undefined}
                onMouseEnter={() => setSelected(i)}
                onMouseDown={(e) => {
                  e.preventDefault();
                  openSetting(s);
                }}
              >
                <div className="truncate text-[13.5px]" style={{ color: 'var(--fg-1)' }}>
                  {s.title}
                </div>
                <div className="truncate text-[12px]" style={{ color: 'var(--fg-muted)' }}>
                  {s.sub}
                </div>
              </li>
            ))
          ) : (
            noteResults.map((m, i) => {
              const title = m.session_info.name || 'Untitled Meeting';
              const sub = snippet(m.summary, query);
              return (
                <li
                  key={m.session_info.summary_file}
                  id={`cmdk-opt-${i}`}
                  role="option"
                  aria-selected={i === selected}
                  data-index={i}
                  data-testid="command-palette-result"
                  className="mx-1 cursor-pointer rounded-md px-2.5 py-2"
                  style={i === selected ? { background: 'var(--surface-active)' } : undefined}
                  onMouseEnter={() => setSelected(i)}
                  onMouseDown={(e) => {
                    e.preventDefault();
                    openMeeting(m);
                  }}
                >
                  <div className="truncate text-[13.5px]" style={{ color: 'var(--fg-1)' }}>
                    {title}
                  </div>
                  {sub && (
                    <div className="truncate text-[12px]" style={{ color: 'var(--fg-muted)' }}>
                      {sub}
                    </div>
                  )}
                </li>
              );
            })
          )}
        </ul>

        <div
          className="flex items-center gap-3 px-3.5 py-2 text-[11px]"
          style={{
            color: 'var(--fg-muted)',
            borderTop: '1px solid var(--border-subtle)',
            fontFamily: 'var(--font-sans)',
          }}
        >
          <span>↑↓ navigate</span>
          <span>↵ open</span>
          <span>esc close</span>
        </div>
      </div>
    </div>
  );
}
