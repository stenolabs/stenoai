import { Button } from '@/components/ui/button';
import { Switch } from '@/components/ui/switch';
import { useActionsOverview, useSetAutoSuggest } from '@/hooks/useActions';
import { navigate } from '@/lib/router';
import { ActionConnectionCard } from '@/routes/connect/ActionConnectionCard';
import { SectionHeading } from '@/routes/connect/ConnectionStatus';
import { RecentActions } from '@/routes/connect/RecentActions';
import { ScopeSection } from '@/routes/connect/ScopeSection';
import { SettingRow } from './primitives';
import { t } from '@/i18n';

/**
 * Settings → Connectors: managing what Connect set up. The connected action
 * endpoints (enable, refresh, sign in, disconnect), whether Steno suggests
 * actions after each meeting, what MCP assistants can read, and the local
 * log of approved actions. Adding new connections stays on Connect.
 */
export function ConnectorsTab() {
  const overview = useActionsOverview();
  const setAutoSuggest = useSetAutoSuggest();
  const data = overview.data;
  const disabled = data?.policy ? !data.policy.actionsEnabled : false;
  const connections = data?.connections ?? [];

  return (
    <section data-settings-tab="connectors" className="pt-4">
      <section aria-labelledby="settings-connections-heading">
        <SectionHeading
          id="settings-connections-heading"
          title={t('connect.actions.connectionsHeading')}
          intro={t('settings.connectors.connectionsIntro')}
        />
        {connections.length === 0 ? (
          <div
            className="mt-4 flex items-center justify-between gap-4 rounded-xl border p-4"
            style={{ borderColor: 'var(--border-subtle)' }}
          >
            <p className="text-[13px]" style={{ color: 'var(--fg-2)' }}>
              {t('settings.connectors.empty')}
            </p>
            <Button
              variant="outline"
              size="sm"
              className="h-[30px] shrink-0 px-3 text-[13px]"
              onClick={() => navigate('/connect')}
            >
              {t('settings.connectors.openConnect')}
            </Button>
          </div>
        ) : (
          <>
            <ul className="mt-4 flex flex-col gap-3">
              {connections.map((c) => (
                <li key={c.id}>
                  <ActionConnectionCard connection={c} disabled={disabled} />
                </li>
              ))}
            </ul>
            <SettingRow
              label={t('connect.actions.autoSuggest.label')}
              description={t('connect.actions.autoSuggest.description')}
              noBorder
            >
              <Switch
                checked={data?.autoSuggest ?? true}
                disabled={disabled}
                aria-label={t('connect.actions.autoSuggest.label')}
                onCheckedChange={(v) => setAutoSuggest.mutate([v])}
              />
            </SettingRow>
          </>
        )}
      </section>
      <ScopeSection />
      <RecentActions />
    </section>
  );
}
