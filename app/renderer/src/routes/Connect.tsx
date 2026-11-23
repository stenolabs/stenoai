import { MeetingsShell } from '@/components/MeetingsShell';
import { t } from '@/i18n';
import { ActionsSection } from './connect/ActionsSection';
import { AiAppsSection } from './connect/AiAppsSection';
import { CodingAgentsSection } from './connect/CodingAgentsSection';
import { SyncSection } from './connect/SyncSection';

/**
 * Connect: turn meetings into actions in the apps you work in, bring them to
 * AI apps through the bundled read-only Steno MCP server (app/steno-mcp) and
 * to coding agents through the Steno skill (or MCP), and the scope controls
 * then one-way note sync (Obsidian). Managing what is connected (connections,
 * what assistants can see, recent actions) lives in Settings → Connectors.
 */
export function Connect() {
  return (
    <MeetingsShell activeSummaryFile={null}>
      <div className="mx-auto w-full max-w-[760px] py-10" style={{ color: 'var(--fg-1)' }}>
        <h1
          className="text-[32px] leading-tight tracking-tight"
          style={{ fontFamily: 'var(--font-serif)' }}
        >
          {t('connect.title')}
        </h1>
        <div className="mt-6 rounded-xl p-5" style={{ background: 'var(--surface-sunken)' }}>
          <h2 className="text-[15px] font-medium">{t('connect.intro.heading')}</h2>
          <p className="mt-1 text-[13px] leading-relaxed" style={{ color: 'var(--fg-2)' }}>
            {t('connect.intro.body')}
          </p>
        </div>
        <CodingAgentsSection />
        <AiAppsSection />
        <ActionsSection />
        <SyncSection />
      </div>
    </MeetingsShell>
  );
}
