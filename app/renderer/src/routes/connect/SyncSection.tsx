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
import { t } from '@/i18n';
import { BrandGlyph } from './ConnectGlyph';
import { SectionHeading } from './ConnectionStatus';

/**
 * Note sync (#413): Obsidian vault sync, a one-way mirror of notes into a
 * chosen vault folder. Unlike Actions it runs on every saved note with no
 * approval step, so it gets its own section.
 */
export function SyncSection() {
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

  const path = vaultPath.data || '';
  const conflictCount = conflicts.data ? Object.keys(conflicts.data).length : 0;

  return (
    <section aria-labelledby="connect-sync-heading" className="mt-10">
      <SectionHeading
        id="connect-sync-heading"
        title={t('connect.sync.heading')}
        intro={t('connect.sync.intro')}
      />
      <section
        aria-label={t('connect.obsidian.name')}
        className="mt-4 rounded-xl border p-4"
        style={{ borderColor: 'var(--border-subtle)', background: 'var(--surface-raised)' }}
      >
        <div className="flex min-w-0 items-start gap-3">
          <BrandGlyph brand="obsidian" />
          <div className="min-w-0 flex-1">
            <h3 className="text-[14px] font-medium">{t('connect.obsidian.name')}</h3>
            <p className="mt-0.5 text-[12.5px] leading-snug" style={{ color: 'var(--fg-2)' }}>
              {t('connect.obsidian.description')}
            </p>
          </div>
          <Switch
            checked={enabled.data ?? false}
            onCheckedChange={(v) => setEnabled.mutate(v)}
            disabled={enabled.data === undefined}
            aria-label={t('connect.obsidian.aria')}
            className="mt-1 shrink-0"
          />
        </div>

        <div
          className="mt-4 flex items-start justify-between gap-6 pt-4"
          style={{ borderTop: '1px solid var(--border-subtle)' }}
        >
          <div className="min-w-0 flex-1">
            <div className="text-[13px] font-medium">{t('connect.obsidian.vaultFolder.label')}</div>
            <div className="mt-0.5 text-[12.5px]" style={{ color: 'var(--fg-2)' }}>
              {path
                ? t('connect.obsidian.vaultFolder.withPath')
                : t('connect.obsidian.vaultFolder.noPath')}
            </div>
            {path && (
              <code
                className="mt-1.5 block max-w-full truncate select-all font-mono text-[12px]"
                style={{ color: 'var(--fg-2)' }}
                title={path}
              >
                {path}
              </code>
            )}
          </div>
          <div className="flex shrink-0 gap-2">
            <Button
              variant="outline"
              size="sm"
              className="h-[30px] px-3 text-[13px]"
              onClick={chooseFolder}
            >
              {t('connect.obsidian.vaultFolder.choose')}
            </Button>
            {path && (
              <Button
                variant="ghost"
                size="sm"
                className="h-[30px] px-3 text-[13px]"
                onClick={() => setVaultPath.mutate('')}
              >
                {t('connect.obsidian.vaultFolder.clear')}
              </Button>
            )}
          </div>
        </div>

        {enabled.data && !path && (
          <p className="mt-3 text-[12.5px]" style={{ color: 'var(--fg-2)' }}>
            {t('connect.obsidian.noVaultWarning')}
          </p>
        )}

        {conflictCount > 0 && (
          <p className="mt-3 text-[12.5px]" style={{ color: 'var(--fg-2)' }}>
            <span style={{ color: 'var(--fg-1)' }}>
              {conflictCount === 1
                ? t('connect.obsidian.conflicts.skipped.one', { count: conflictCount })
                : t('connect.obsidian.conflicts.skipped.other', { count: conflictCount })}
            </span>{' '}
            {t('connect.obsidian.conflicts.afterCount')}
          </p>
        )}
      </section>
    </section>
  );
}
