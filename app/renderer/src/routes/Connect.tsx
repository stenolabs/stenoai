import { MeetingsShell } from '@/components/MeetingsShell';
import { navigate } from '@/lib/router';
import { t } from '@/i18n';
import { ActionsSection } from './connect/ActionsSection';
import { AssistantsSection } from './connect/AssistantsSection';
import { ScopeSection } from './connect/ScopeSection';

/**
 * Connect: bring meetings to AI assistants through the bundled, read-only
 * Steno MCP server (app/steno-mcp), choose what they can see, and (later)
 * turn meetings into actions.
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
        <AssistantsSection />
        <ScopeSection />
        <ActionsSection />
        <p className="mt-10 text-[12px]" style={{ color: 'var(--fg-muted)' }}>
          {t('connect.skillHint')}{' '}
          <button
            type="button"
            className="underline underline-offset-2 hover:text-[color:var(--fg-1)]"
            onClick={() => navigate('/agents')}
          >
            {t('connect.skillLink')}
          </button>
        </p>
      </div>
    </MeetingsShell>
  );
}
