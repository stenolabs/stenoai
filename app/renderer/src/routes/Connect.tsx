import { MeetingsShell } from '@/components/MeetingsShell';
import { t } from '@/i18n';
import { ActionsSection } from './connect/ActionsSection';
import { AiAppsSection } from './connect/AiAppsSection';
import { CodingAgentsSection } from './connect/CodingAgentsSection';
import { ScopeSection } from './connect/ScopeSection';

/**
 * Connect: bring meetings to coding agents and AI apps through the bundled
 * read-only Steno MCP server (app/steno-mcp; coding agents can add the Steno
 * skill too), the scope controls every MCP connection obeys, and turning
 * meetings into actions in other tools.
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
        <ScopeSection />
        <ActionsSection />
      </div>
    </MeetingsShell>
  );
}
