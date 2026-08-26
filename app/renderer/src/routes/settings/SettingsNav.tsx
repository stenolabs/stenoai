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
import { useTranslation, t } from '@/i18n';
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

export function getNavGroups(): NavGroup[] {
  return [
    {
      items: [
        { id: 'general', label: t('settings.nav.general'), icon: Settings2 },
        { id: 'ai', label: t('settings.nav.ai'), icon: Sparkles },
        { id: 'templates', label: t('settings.nav.templates'), icon: LayoutTemplate },
        { id: 'people', label: t('settings.nav.people'), icon: Users },
      ],
    },
    {
      header: t('settings.nav.workspaceHeader'),
      items: [{ id: 'organisation', label: t('settings.nav.organisation'), icon: Building2 }],
    },
    {
      header: t('settings.nav.systemHeader'),
      items: [
        { id: 'integrations', label: t('settings.nav.integrations'), icon: Plug },
        { id: 'advanced', label: t('settings.nav.advanced'), icon: Wrench },
        { id: 'developer', label: t('settings.nav.developer'), icon: Code2 },
        { id: 'about', label: t('settings.nav.about'), icon: Info },
      ],
    },
  ];
}

export function getTabLabel(id: SettingsTabId): string {
  const groups = getNavGroups();
  for (const g of groups) {
    for (const item of g.items) {
      if (item.id === id) return item.label;
    }
  }
  return id;
}

export const SETTINGS_TAB_LABELS: Record<SettingsTabId, string> = {
  general: 'Preferences',
  ai: 'AI',
  templates: 'Templates',
  people: 'People',
  organisation: 'Organisation',
  integrations: 'Integrations',
  advanced: 'Advanced',
  developer: 'Developer',
  about: 'About',
};

interface SettingsNavProps {
  activeTab: SettingsTabId;
  onSelect: (id: SettingsTabId) => void;
  onBack: () => void;
  version?: string;
}

export function SettingsNav({ activeTab, onSelect, onBack, version }: SettingsNavProps) {
  const { t } = useTranslation();
  const navGroups = getNavGroups();
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
          aria-label={t('common.back')}
          className="flex size-7 shrink-0 cursor-pointer items-center justify-center rounded-[6px] border-0 bg-transparent transition-colors hover:bg-[color:var(--surface-active)] hover:text-[color:var(--fg-1)]"
          style={{ color: 'var(--fg-2)' }}
        >
          <ArrowLeft size={14} />
        </button>
        <span
          className="text-[13px] font-medium"
          style={{ color: 'var(--fg-1)' }}
        >
          {t('common.settings')}
        </span>
      </div>

      <div
        className="flex min-h-0 flex-1 flex-col gap-px overflow-auto px-2 pb-2"
        role="group"
        aria-label="Settings sections"
      >
        {navGroups.map((group, groupIdx) => (
          <div key={group.header ?? `group-${groupIdx}`}>
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
