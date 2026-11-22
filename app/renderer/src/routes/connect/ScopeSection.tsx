import { Switch } from '@/components/ui/switch';
import { useConnectSettings, useSetConnectSettings } from '@/hooks/useConnect';
import { useFolders } from '@/hooks/useFolders';
import { SettingRow } from '@/routes/settings/primitives';
import { t } from '@/i18n';

/**
 * What the Steno MCP server lets assistants read. Both controls are stored in
 * config.json and enforced by the server itself on every tool call, so they
 * apply to assistants that are already connected.
 */
export function ScopeSection() {
  const settings = useConnectSettings();
  const setSettings = useSetConnectSettings();
  const folders = useFolders();
  const allowlist = settings.data?.folderAllowlist ?? null;
  const loading = settings.data === undefined;
  const folderList = folders.data ?? [];

  const toggleFolder = (id: string, on: boolean) => {
    const current = allowlist ?? [];
    const next = on ? [...current.filter((f) => f !== id), id] : current.filter((f) => f !== id);
    setSettings.mutate({ folderAllowlist: next });
  };

  return (
    <section aria-labelledby="connect-scope-heading" className="mt-10">
      <h2 id="connect-scope-heading" className="text-sm font-medium">
        {t('connect.scope.heading')}
      </h2>
      <div className="mt-1">
        <SettingRow
          label={t('connect.scope.allMeetings.label')}
          description={
            allowlist === null
              ? t('connect.scope.allMeetings.on')
              : t('connect.scope.allMeetings.off')
          }
        >
          <Switch
            checked={allowlist === null}
            disabled={loading}
            aria-label={t('connect.scope.allMeetings.label')}
            onCheckedChange={(v) => setSettings.mutate({ folderAllowlist: v ? null : [] })}
          />
        </SettingRow>
        {allowlist !== null && (
          <div
            className="py-3"
            style={{ borderBottom: '1px solid var(--border-subtle)' }}
            role="group"
            aria-label={t('connect.scope.folders.aria')}
          >
            {folderList.length === 0 ? (
              <p className="text-[13px]" style={{ color: 'var(--fg-2)' }}>
                {t('connect.scope.folders.empty')}
              </p>
            ) : (
              <ul className="grid gap-1.5 sm:grid-cols-2">
                {folderList.map((f) => (
                  <li key={f.id}>
                    <label className="flex cursor-pointer items-center gap-2 text-[13px]">
                      <input
                        type="checkbox"
                        className="size-3.5"
                        style={{ accentColor: 'var(--fg-1)' }}
                        checked={allowlist.includes(f.id)}
                        onChange={(e) => toggleFolder(f.id, e.currentTarget.checked)}
                      />
                      <span className="truncate">{f.name}</span>
                    </label>
                  </li>
                ))}
              </ul>
            )}
          </div>
        )}
        <SettingRow
          label={t('connect.scope.summariesOnly.label')}
          description={t('connect.scope.summariesOnly.description')}
        >
          <Switch
            checked={settings.data?.excludeTranscripts ?? false}
            disabled={loading}
            aria-label={t('connect.scope.summariesOnly.label')}
            onCheckedChange={(v) => setSettings.mutate({ excludeTranscripts: v })}
          />
        </SettingRow>
      </div>
      {setSettings.isError && (
        <p role="alert" className="mt-2 text-[12.5px]" style={{ color: 'var(--fg-2)' }}>
          {t('connect.scope.saveError')}
        </p>
      )}
      <p className="mt-3 text-[12px] leading-relaxed" style={{ color: 'var(--fg-muted)' }}>
        {t('connect.scope.privacy')}
      </p>
    </section>
  );
}
