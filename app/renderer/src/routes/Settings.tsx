import * as React from 'react';
import { ExternalLink } from 'lucide-react';
import { AppShell } from '@/components/AppShell';
import { cn } from '@/lib/utils';
import { ipc } from '@/lib/ipc';
import { useNavigate, getLastNonSettingsRoute, useRoute, getRouteParam } from '@/lib/router';
import { useAppVersion } from '@/hooks/useSettings';
import { useRecording } from '@/hooks/useRecording';
import { SettingsNav, SETTINGS_TAB_LABELS, type SettingsTabId } from './settings/SettingsNav';
import { GeneralTab } from './settings/GeneralTab';
import { AiTab } from './settings/AiTab';
import { TemplatesTab } from './settings/TemplatesTab';
import { PeopleTab } from './settings/PeopleTab';
import { OrganisationTab } from './settings/OrganisationTab';
import { AdvancedTab } from './settings/AdvancedTab';
import { IntegrationsTab } from './settings/IntegrationsTab';
import { DeveloperTab } from './settings/DeveloperTab';
import { AboutTab } from './settings/AboutTab';

// Per-tab intro copy, shown in the page header above the divider (rather
// than repeated inside each tab's own content, which used to duplicate the
// header on Templates/Organisation). Only tabs with a page-level intro (as
// opposed to AiTab's per-section copy, or tabs with no intro at all) need an
// entry here.
const SETTINGS_TAB_DESCRIPTIONS: Partial<Record<SettingsTabId, React.ReactNode>> = {
  templates: (
    <>
      Templates are the instructions your AI follows when turning a
      transcript into a summary —{' '}
      <button
        type="button"
        onClick={() =>
          void ipc().shell.openExternal('https://docs.stenoai.co/features/report-templates')
        }
        className="inline-flex items-center gap-1 underline underline-offset-2 hover:no-underline"
        style={{ color: 'var(--fg-1)' }}
      >
        learn more
        <ExternalLink className="size-3" />
      </button>
    </>
  ),
  people:
    'Local voice profiles Steno can use to suggest people across meetings. Deleting a profile stops future matching but does not delete recordings or transcripts.',
  organisation: 'Connect to Steno Enterprise for your organisation.',
};

// Deep-linkable tab ids: the 8 SettingsTabId nav destinations, plus
// 'transcription' as a legacy alias that resolves onto 'ai' (its content
// moved into AiTab's Transcription section, which renders first on that
// page) — keeps `/settings?tab=transcription` links working unmodified.
const DEEP_LINK_IDS = [
  'general',
  'transcription',
  'ai',
  'templates',
  'people',
  'organisation',
  'integrations',
  'advanced',
  'developer',
  'about',
] as const;
type DeepLinkId = (typeof DEEP_LINK_IDS)[number];

function resolveTab(id: DeepLinkId): SettingsTabId {
  return id === 'transcription' ? 'ai' : id;
}

// Resolve the `?tab=` param of a route to a nav tab, or null when absent or
// not a known deep-link id. Single definition shared by the first-mount
// initialTab and the route-reactive sync effect so the two can't drift.
function tabFromRoute(route: string): SettingsTabId | null {
  const requested = getRouteParam(route, 'tab');
  if (requested && (DEEP_LINK_IDS as readonly string[]).includes(requested)) {
    return resolveTab(requested as DeepLinkId);
  }
  return null;
}

// ---------------------------------------------------------------------------
// Settings page — a full takeover of the main app chrome (Granola/Wispr
// style): the folder/meeting sidebar is replaced entirely by SettingsNav
// while this route is active, rather than sitting alongside it. Calls
// AppShell directly instead of going through MeetingsShell, since no
// settings tab needs the folder tree, MeetingsListProvider, or drag/drop
// context menus MeetingsShell also drags in.
// ---------------------------------------------------------------------------

export function Settings() {
  const navigate = useNavigate();
  // Deep-link support: /settings?tab=<id> opens the matching tab on mount.
  // Used by the sidebar's "Sign in to organisation" CTA to land users
  // directly on the org sign-in form rather than the General tab.
  const route = useRoute();
  const initialTab = React.useMemo<SettingsTabId>(
    () => tabFromRoute(route) ?? 'general',
    [], // Intentional — only consume the URL param on first mount.
  );
  const [tab, setTab] = React.useState<SettingsTabId>(initialTab);
  // Keep the visible tab in sync when the `?tab=` param changes AFTER mount —
  // e.g. the ⌘K settings search navigates to /settings?tab=<id> while Settings
  // is already open. initialTab (above) only consumes the param on first mount,
  // so without this the hash would update but the tab wouldn't switch.
  //
  // A bare `/settings` (no param) resets to General — the same meaning the
  // absent param has on first mount. This matters for browser Back: nav-rail
  // clicks push `?tab=` entries onto the hash history (route is the single
  // source of truth since #411), so Back can land on the bare route and must
  // not leave a stale tab visible.
  React.useEffect(() => {
    setTab(tabFromRoute(route) ?? 'general');
  }, [route]);
  const version = useAppVersion();
  // Templates' own editor is a full-page takeover with its own header/back
  // button — while it's open, the outer "Templates" title/description/divider
  // would just be a leftover from the list view carried over on top of it.
  const [templateEditorOpen, setTemplateEditorOpen] = React.useState(false);
  // Leaving the Templates tab (via the nav rail OR the ⌘K settings search)
  // unmounts TemplatesTab, but its editor-open flag lived on here — a stale
  // `true` would suppress the page header when Templates is reopened. Reset it
  // whenever the active tab isn't Templates.
  React.useEffect(() => {
    if (tab !== 'templates' && templateEditorOpen) setTemplateEditorOpen(false);
  }, [tab, templateEditorOpen]);
  const showPageHeader = !(tab === 'templates' && templateEditorOpen);

  // Supplies AppShell's recordingStatus/onToggleRecording props directly —
  // previously supplied by MeetingsShell, now that Settings no longer
  // wraps in it. Same toggle behavior MeetingsShell uses everywhere else:
  // recording/paused → open the live recording view (stop only happens
  // from there); otherwise → start a new one.
  const recording = useRecording();
  const isRecording = recording.status === 'recording' || recording.status === 'paused';
  const onToggleRecording = () => {
    if (isRecording) {
      navigate('/recording');
    } else {
      void recording.startRecording();
    }
  };

  return (
    <AppShell
      recordingStatus={recording.status}
      recordingElapsed={recording.elapsed}
      onToggleRecording={onToggleRecording}
      sidebarWidth={224}
      sidebarCollapsed={false}
      onToggleSidebar={() => {}}
      settingsMode
      bleed
      sidebar={
        <SettingsNav
          activeTab={tab}
          // The route is the single source of truth for the visible tab: a nav
          // click navigates `?tab=<id>` and the route→tab effect below switches
          // the tab. Calling setTab directly instead would leave the URL's
          // `?tab=` stale, so a later ⌘K search to that same tab would bail on
          // router's unchanged-hash early-return and silently do nothing (#405).
          onSelect={(id) => navigate(`/settings?tab=${id}`)}
          onBack={() => navigate(getLastNonSettingsRoute() || '/')}
          version={version.data?.version}
        />
      }
    >
      <div
        data-testid="settings-page"
        className="flex h-full min-h-0 flex-1 flex-col overflow-hidden"
        style={{ background: 'var(--page)' }}
      >
        {/* Same max-width/padding the rest of the app's reading column uses
            (max-w-[720px] px-10) — but left-anchored near the nav rather
            than mx-auto-centered: AppShell's own wrapper centers because its
            sidebar can be quite wide (up to 480px) and the column is the
            main event; here the nav is a fixed narrow 224px and Settings is
            a panel, not a document, so centering just pushes it away from
            the nav with a large empty gap. Settings uses `bleed` to own its
            own header+scroll split, but the width/padding still matches. */}
        {showPageHeader && (
          <header style={{ borderBottom: '1px solid var(--border-subtle)' }}>
            <div
              className={cn(
                'mb-6 flex flex-col gap-3 px-10 pt-7',
                tab === 'templates' ? 'max-w-full' : 'w-full max-w-[720px]',
              )}
            >
              <h1
                className="m-0 text-[28px] font-normal"
                style={{
                  fontFamily: 'var(--font-serif)',
                  letterSpacing: '-0.02em',
                  color: 'var(--fg-1)',
                }}
              >
                {SETTINGS_TAB_LABELS[tab]}
              </h1>
              {SETTINGS_TAB_DESCRIPTIONS[tab] && (
                <p
                  className="m-0 text-[13px] leading-[1.5]"
                  style={{ color: 'var(--fg-2)' }}
                >
                  {SETTINGS_TAB_DESCRIPTIONS[tab]}
                </p>
              )}
            </div>
          </header>
        )}

        <div className="scrollbar-clean min-h-0 flex-1 overflow-y-auto">
          <div
            className={cn(
              'px-10 pb-36',
              // Tabs whose content opens with a bordered box (Organisation's
              // sign-in card, Templates' row list) need more breathing room
              // than the bare pt-2 the row-based tabs use — their own
              // SettingRow padding already puts daylight between the divider
              // and the first label, but a box's border sits right at the
              // wrapper's edge and reads as cramped against the divider above it.
              // The template editor supplies its own top padding as a full
              // page, so it gets the header's own pt-7 instead.
              !showPageHeader
                ? 'pt-7'
                : tab === 'organisation' || tab === 'templates'
                  ? 'pt-6'
                  : 'pt-2',
              tab === 'templates'
                ? 'h-full max-w-full flex flex-col'
                : 'w-full max-w-[720px]',
            )}
          >
            {tab === 'general' && <GeneralTab />}
            {tab === 'ai' && <AiTab />}
            {tab === 'templates' && <TemplatesTab onEditingChange={setTemplateEditorOpen} />}
            {tab === 'people' && <PeopleTab />}
            {tab === 'organisation' && <OrganisationTab />}
            {tab === 'integrations' && <IntegrationsTab />}
            {tab === 'advanced' && <AdvancedTab />}
            {tab === 'developer' && <DeveloperTab />}
            {tab === 'about' && <AboutTab />}
          </div>
        </div>
      </div>
    </AppShell>
  );
}
