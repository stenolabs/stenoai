import { useRecentActions } from '@/hooks/useActions';
import { ipc } from '@/lib/ipc';
import { t } from '@/i18n';

const TIME_FORMAT: Intl.DateTimeFormatOptions = { dateStyle: 'short', timeStyle: 'short' };

function statusLabel(status: string): string {
  if (status === 'ok') return t('connect.actions.recent.status.ok');
  if (status === 'needs-auth') return t('connect.actions.recent.status.needsAuth');
  if (status === 'tool-error') return t('connect.actions.recent.status.toolError');
  return t('connect.actions.recent.status.failed');
}

/**
 * The local audit log (mcp-actions-audit.jsonl): every approved action, with
 * a hash of what was sent. Nothing here leaves the device.
 */
export function RecentActions() {
  const recent = useRecentActions();
  const entries = recent.data ?? [];
  if (entries.length === 0) return null;
  return (
    <section aria-labelledby="connect-recent-actions-heading" className="mt-6">
      <h3
        id="connect-recent-actions-heading"
        className="text-[13px] font-medium"
        style={{ color: 'var(--fg-2)' }}
      >
        {t('connect.actions.recent.heading')}
      </h3>
      <ul className="mt-2 flex flex-col" aria-label={t('connect.actions.recent.heading')}>
        {entries.map((e) => (
          <li
            key={`${e.time}-${e.argumentsSha256}`}
            className="flex items-baseline gap-3 py-2 text-[12.5px]"
            style={{ borderBottom: '1px solid var(--border-subtle)' }}
          >
            <span className="w-[120px] shrink-0 tabular-nums" style={{ color: 'var(--fg-muted)' }}>
              {new Date(e.time).toLocaleString(undefined, TIME_FORMAT)}
            </span>
            <span className="min-w-0 flex-1 truncate">
              <span className="font-mono text-[12px]">{e.tool}</span>
              <span style={{ color: 'var(--fg-muted)' }}>
                {t('actions.separator')}
                {e.connectionName}
              </span>
            </span>
            <span className="shrink-0" style={{ color: 'var(--fg-2)' }}>
              {statusLabel(e.status)}
            </span>
            {e.link && (
              <button
                type="button"
                className="shrink-0 underline underline-offset-2"
                onClick={() => void ipc().shell.openExternal(e.link!)}
              >
                {t('actions.card.open')}
              </button>
            )}
          </li>
        ))}
      </ul>
    </section>
  );
}
