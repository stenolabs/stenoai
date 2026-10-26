import { ArrowRight, Gem } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Switch } from '@/components/ui/switch';
import {
  useObsidianConflicts,
  useObsidianSyncSetting,
  useObsidianVaultPath,
  usePickObsidianVaultFolder,
  useSetObsidianSync,
  useSetObsidianVaultPath,
} from '@/hooks/useSettings';
import { COMPACT_BTN } from './primitives';
import { t } from '@/i18n';

/**
 * Integrations settings (#413). Currently: Obsidian vault sync — a one-way
 * mirror of notes into a chosen vault folder. More integrations (e.g. Zapier,
 * #414) will join this tab.
 */
export function IntegrationsTab() {
  const enabled = useObsidianSyncSetting();
  const setEnabled = useSetObsidianSync();
  const vaultPath = useObsidianVaultPath();
  const setVaultPath = useSetObsidianVaultPath();
  const pickFolder = usePickObsidianVaultFolder();
  const conflicts = useObsidianConflicts();

  const chooseFolder = async () => {
    try {
      const folder = await pickFolder.mutateAsync();
      if (folder) setVaultPath.mutate(folder);
    } catch {
      // cancelled
    }
  };
  const clearFolder = () => setVaultPath.mutate('');

  const path = vaultPath.data || '';
  const conflictEntries = Object.entries(conflicts.data || {});
  const conflictCount = conflictEntries.length;

  return (
    <section data-settings-tab="integrations">
      <div
        className="flex items-start justify-between gap-6 py-4"
        style={{ borderBottom: '1px solid var(--border-subtle)' }}
      >
        <div className="min-w-0 flex-1">
          <div
            className="flex items-center gap-1.5 text-[14px] font-normal"
            style={{ color: 'var(--fg-1)' }}
          >
            {t('settings.integrations.obsidian.label')}
            {/* Obsidian's crystal motif, inline after the name — the app's icon
                system is lucide, so use its Gem rather than a one-off brand SVG. */}
            <Gem size={14} style={{ color: '#7c6cf5' }} aria-hidden />
          </div>
          <div className="mt-[2px] text-[13px]" style={{ color: 'var(--fg-2)' }}>
            {t('settings.integrations.obsidian.description')}
          </div>
        </div>
        <Switch
          checked={enabled.data ?? false}
          onCheckedChange={(v) => setEnabled.mutate(v)}
          disabled={enabled.data === undefined}
          aria-label={t('settings.integrations.obsidian.aria')}
          className="mt-1 shrink-0"
        />
      </div>

      <div
        className="flex items-start justify-between gap-6 py-4"
        style={{ borderBottom: '1px solid var(--border-subtle)' }}
      >
        <div className="min-w-0 flex-1">
          <div
            className="text-[14px] font-normal"
            style={{ color: 'var(--fg-1)', marginBottom: 2 }}
          >
            {t('settings.integrations.vaultFolder.label')}
          </div>
          <div className="mb-2 text-[13px]" style={{ color: 'var(--fg-2)' }}>
            {path
              ? t('settings.integrations.vaultFolder.withPath')
              : t('settings.integrations.vaultFolder.noPath')}
          </div>
          {path && (
            <code
              className="block max-w-full truncate select-all font-mono text-[12px]"
              style={{ color: 'var(--fg-2)' }}
              title={path}
            >
              {path}
            </code>
          )}
        </div>
        <div className="flex shrink-0 gap-2 pt-1">
          <Button variant="outline" size="sm" className={COMPACT_BTN} onClick={chooseFolder}>
            {t('settings.integrations.vaultFolder.choose')}
          </Button>
          {path && (
            <Button variant="ghost" size="sm" className={COMPACT_BTN} onClick={clearFolder}>
              {t('settings.integrations.vaultFolder.clear')}
            </Button>
          )}
        </div>
      </div>

      {enabled.data && !path && (
        <div className="py-3 text-[13px]" style={{ color: 'var(--fg-2)' }}>
          {t('settings.integrations.noVaultWarning')}
        </div>
      )}

      {conflictCount > 0 && (
        <div className="space-y-2 py-3 text-[13px]" style={{ color: 'var(--fg-2)' }}>
          <div>
            <span style={{ color: 'var(--fg-1)' }}>
              {conflictCount === 1
                ? t('settings.integrations.conflicts.preserved.one', { count: conflictCount })
                : t('settings.integrations.conflicts.preserved.other', { count: conflictCount })}
            </span>{' '}
            {t('settings.integrations.conflicts.preserved.description')}
          </div>
          <div className="space-y-1.5">
            {conflictEntries.map(([stem, conflict]) => (
              <div
                key={stem}
                className="rounded-lg border px-2.5 py-2"
                style={{ borderColor: 'var(--border-subtle)' }}
              >
                <div className="flex min-w-0 items-center gap-2">
                  <code
                    className="min-w-0 flex-1 truncate font-mono text-[12px]"
                    title={conflict.vaultRelPath}
                    style={{ color: 'var(--fg-1)' }}
                  >
                    {conflict.vaultRelPath}
                  </code>
                  {conflict.replacementVaultRelPath ? (
                    <>
                      <ArrowRight className="size-3.5 shrink-0" aria-hidden />
                      <code
                        className="min-w-0 flex-1 truncate font-mono text-[12px]"
                        title={conflict.replacementVaultRelPath}
                        style={{ color: 'var(--fg-1)' }}
                      >
                        {conflict.replacementVaultRelPath}
                      </code>
                    </>
                  ) : (
                    <span className="shrink-0 text-[12px]">
                      {conflict.reason === 'external-edit-on-delete'
                        ? t('settings.integrations.conflicts.reason.delete')
                        : conflict.reason === 'external-edit-preserved'
                          ? t('settings.integrations.conflicts.reason.removed')
                          : t('settings.integrations.conflicts.reason.update')}
                    </span>
                  )}
                </div>
                {conflict.replacementVaultRelPath && (
                  <div className="mt-1 text-[11px]">
                    {t('settings.integrations.conflicts.replacementDescription')}
                  </div>
                )}
              </div>
            ))}
          </div>
        </div>
      )}
    </section>
  );
}
