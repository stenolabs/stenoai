import {
  ArrowLeft,
  Building2,
  Code2,
  Info,
  LayoutTemplate,
  Plug,
  Settings2,
  Sparkles,
  Users,
  Wrench,
  type LucideIcon,
} from 'lucide-react';
import { cn } from '@/lib/utils';

// The full set of nav rail destinations. Distinct from Settings.tsx's
// deep-linkable TabId, which additionally accepts the legacy 'transcription'
// id as an alias that resolves onto 'ai' — the nav rail itself only ever
// renders/highlights the ids listed here.
export type SettingsTabId =
  | 'general'
  | 'ai'
  | 'templates'
  | 'people'
  | 'organisation'
  | 'integrations'
  | 'advanced'
  | 'developer'
  | 'about';

interface NavItem {
  id: SettingsTabId;
  label: string;
  icon: LucideIcon;
}

interface NavGroup {
  header?: string;
  items: NavItem[];
}

const NAV_GROUPS: NavGroup[] = [
  {
    items: [
      { id: 'general', label: 'Preferences', icon: Settings2 },
      { id: 'ai', label: 'AI', icon: Sparkles },
      { id: 'templates', label: 'Templates', icon: LayoutTemplate },
      { id: 'people', label: 'People', icon: Users },
    ],
  },
  {
    header: 'Workspace',
    items: [{ id: 'organisation', label: 'Organisation', icon: Building2 }],
  },
  {
    header: 'System',
    items: [
      { id: 'integrations', label: 'Integrations', icon: Plug },
      { id: 'advanced', label: 'Advanced', icon: Wrench },
      { id: 'developer', label: 'Developer', icon: Code2 },
      { id: 'about', label: 'About', icon: Info },
    ],
  },
];

// Flat id -> label lookup so Settings.tsx can show the active tab's own name
// as the page title (matches the Granola reference: the header names the
// section, it isn't a static "Settings" caption).
export const SETTINGS_TAB_LABELS: Record<SettingsTabId, string> = Object.fromEntries(
  NAV_GROUPS.flatMap((g) => g.items).map((item) => [item.id, item.label]),
) as Record<SettingsTabId, string>;

interface SettingsNavProps {
  activeTab: SettingsTabId;
  onSelect: (id: SettingsTabId) => void;
  onBack: () => void;
  version?: string;
}

export function SettingsNav({ activeTab, onSelect, onBack, version }: SettingsNavProps) {
  return (
    <nav
      // fixed, like the main Sidebar's <aside> (Sidebar.tsx) — AppShell
      // renders `sidebar` as a normal child AND applies marginLeft:
      // sidebarWidth to <main>, on the assumption the sidebar itself is
      // taken out of flex flow via fixed positioning (zero real layout
      // width). Without `fixed` here, the nav occupied real 224px of flex
      // space *and* <main> got the same 224px added again as marginLeft —
      // content was shifted a full extra 224px right of where it should be.
      className="fixed inset-y-0 left-0 z-20 flex flex-col overflow-y-auto"
      style={{
        width: 224,
        // Matches the main Sidebar's <aside> background exactly
        // (surface-sunken, not surface — they read as different shades).
        background: 'var(--surface-sunken)',
        borderRight: '1px solid var(--border-subtle)',
      }}
    >
      {/* Same traffic-light spacer as the main Sidebar (sb-top, globals.css) —
          without it, the nav's first row sits directly under the macOS
          traffic lights. */}
      <div className="sb-top">
        <div style={{ height: 26 }} aria-hidden />
      </div>

      {/* Nav-rail header — back-to-app control + "Settings" label, playing
          the same role the Brand row (dragonfly + "Steno") plays in the main
          Sidebar. Lives here instead of the content header so the content
          header is just the active tab's own title. */}
      <div className="flex items-center gap-2 px-2 pb-2.5 pt-1">
        <button
          type="button"
          onClick={onBack}
          aria-label="Back"
          className="flex size-7 shrink-0 cursor-pointer items-center justify-center rounded-[6px] border-0 bg-transparent transition-colors hover:bg-[color:var(--surface-active)] hover:text-[color:var(--fg-1)]"
          style={{ color: 'var(--fg-2)' }}
        >
          <ArrowLeft size={14} />
        </button>
        <span
          className="text-[13px] font-medium"
          style={{ color: 'var(--fg-1)' }}
        >
          Settings
        </span>
      </div>

      <div
        className="flex min-h-0 flex-1 flex-col gap-px overflow-auto px-2 pb-2"
        role="group"
        aria-label="Settings sections"
      >
        {NAV_GROUPS.map((group, i) => (
          <div key={group.header ?? `group-${i}`}>
            {group.header && (
              // Matches the main Sidebar's own group label (.sb-group-head on
              // the "Folders" header) exactly — sentence case, fg-2, no
              // uppercase/letter-spacing treatment — rather than reusing the
              // uppercase SectionHeading primitive used inside tab content.
              <div
                className="mt-3.5 px-2.5 py-1.5 text-[11.5px] font-medium tracking-[0.02em]"
                style={{ color: 'var(--fg-2)' }}
              >
                {group.header}
              </div>
            )}
            {group.items.map((item) => {
              const Icon = item.icon;
              const active = activeTab === item.id;
              return (
                <button
                  key={item.id}
                  type="button"
                  aria-current={active ? 'page' : undefined}
                  data-settings-nav={item.id}
                  onClick={() => onSelect(item.id)}
                  className={cn('sb-row', active && 'active')}
                >
                  <Icon size={14} />
                  <span className="flex-1 truncate">{item.label}</span>
                </button>
              );
            })}
          </div>
        ))}
      </div>

      <div
        className="mt-auto px-3 py-3 text-[11px]"
        style={{ color: 'var(--fg-muted)' }}
      >
        Steno {version ?? ''}
      </div>
    </nav>
  );
}
