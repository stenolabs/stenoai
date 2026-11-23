import { TriangleAlert } from 'lucide-react';
import { Input } from '@/components/ui/input';
import { t } from '@/i18n';

const fieldLabel = 'mb-1 block text-[12.5px]';

/**
 * The "Command on this computer" half of the add dialog: a command line and
 * optional environment variables, under a plain warning that this runs a
 * program with the user's permissions. The parent owns the state and saving.
 */
export function LocalCommandFields({
  ids,
  command,
  onCommand,
  env,
  onEnv,
}: {
  ids: string;
  command: string;
  onCommand: (v: string) => void;
  env: string;
  onEnv: (v: string) => void;
}) {
  return (
    <>
      <div
        role="note"
        className="flex gap-2 rounded-lg p-3 text-[12.5px] leading-relaxed"
        style={{ background: 'var(--surface-sunken)', color: 'var(--fg-1)' }}
      >
        <TriangleAlert aria-hidden className="mt-0.5 size-4 shrink-0" />
        <p>{t('connect.actions.add.local.warning')}</p>
      </div>
      <div>
        <label htmlFor={`${ids}-command`} className={fieldLabel} style={{ color: 'var(--fg-2)' }}>
          {t('connect.actions.add.local.command')}
        </label>
        <Input
          id={`${ids}-command`}
          value={command}
          onChange={(e) => onCommand(e.currentTarget.value)}
          placeholder={t('connect.actions.add.local.commandPlaceholder')}
          className="font-mono text-[12.5px]"
          spellCheck={false}
          autoComplete="off"
          autoCapitalize="off"
        />
        <p className="mt-1 text-[12px] leading-relaxed" style={{ color: 'var(--fg-muted)' }}>
          {t('connect.actions.add.local.commandHint')}
        </p>
      </div>
      <div>
        <label htmlFor={`${ids}-env`} className={fieldLabel} style={{ color: 'var(--fg-2)' }}>
          {t('connect.actions.add.local.env')}
        </label>
        <textarea
          id={`${ids}-env`}
          className="min-h-[64px] w-full rounded-md border border-border bg-transparent px-3 py-2 font-mono text-[12.5px] leading-relaxed focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          value={env}
          onChange={(e) => onEnv(e.currentTarget.value)}
          placeholder={t('connect.actions.add.local.envPlaceholder')}
          spellCheck={false}
          autoComplete="off"
        />
        <p className="mt-1 text-[12px] leading-relaxed" style={{ color: 'var(--fg-muted)' }}>
          {t('connect.actions.add.local.envHint')}
        </p>
      </div>
    </>
  );
}
