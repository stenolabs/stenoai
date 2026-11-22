import { Check, X } from 'lucide-react';
import { t } from '@/i18n';

export function ConnectionStatus({
  ok,
  message,
}: {
  ok: boolean | undefined;
  message?: string;
}) {
  if (ok === undefined) return null;
  return (
    <span
      className="flex items-center gap-1.5 text-[12px]"
      style={{ color: ok ? 'var(--fg-1)' : 'var(--danger)' }}
    >
      {ok ? <Check className="size-3.5" /> : <X className="size-3.5" />}
      {message ?? (ok ? t('settings.ai.connected') : t('settings.ai.failed'))}
    </span>
  );
}
