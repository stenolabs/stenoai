import * as React from 'react';
import { Button } from '@/components/ui/button';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import { Switch } from '@/components/ui/switch';
import {
  useAuthorizeConnection,
  useRefreshConnection,
  useRemoveConnection,
  useSetConnectionEnabled,
} from '@/hooks/useActions';
import { actionErrorMessage } from '@/lib/actionErrors';
import type { ActionConnection, ActionLocality } from '@/lib/ipc';
import { t } from '@/i18n';

const TOOL_PREVIEW = 6;

export function localityLabel(locality: ActionLocality | null): string {
  if (locality === 'device') return t('actions.locality.device');
  if (locality === 'network') return t('actions.locality.network');
  return t('actions.locality.internet');
}

/** One connected endpoint: status, enable toggle, tools, refresh / sign in / disconnect. */
export function ActionConnectionCard({
  connection: c,
  disabled,
}: {
  connection: ActionConnection;
  disabled: boolean;
}) {
  const setEnabled = useSetConnectionEnabled();
  const refresh = useRefreshConnection();
  const authorize = useAuthorizeConnection();
  const remove = useRemoveConnection();
  const [confirmOpen, setConfirmOpen] = React.useState(false);
  const [error, setError] = React.useState('');

  const actionTools = c.tools.filter((tool) => !tool.readOnly);
  const preview = actionTools.slice(0, TOOL_PREVIEW);
  const busy = refresh.isPending || authorize.isPending;

  const statusText = c.blockedByPolicy
    ? t('connect.actions.connection.blocked')
    : c.status === 'needs-auth'
      ? t('connect.actions.connection.needsAuth')
      : c.status === 'error'
        ? t('connect.actions.connection.unreachable')
        : actionTools.length === 0
          ? t('connect.actions.connection.noTools')
          : actionTools.length === 1
            ? t('connect.actions.connection.toolCount.one', { count: 1 })
            : t('connect.actions.connection.toolCount.other', { count: actionTools.length });

  return (
    <section
      aria-label={c.name}
      className="rounded-xl border p-4"
      style={{ borderColor: 'var(--border-subtle)', background: 'var(--surface-raised)' }}
    >
      <div className="flex items-start gap-3">
        <div className="min-w-0 flex-1">
          <h4 className="truncate text-[14px] font-medium">{c.name}</h4>
          <p className="mt-0.5 truncate text-[12px]" style={{ color: 'var(--fg-muted)' }}>
            {c.account
              ? t('connect.actions.connection.account', {
                  account: c.account,
                  origin: c.origin ?? '',
                })
              : c.origin}
          </p>
        </div>
        <Switch
          checked={c.enabled}
          disabled={disabled}
          aria-label={t('connect.actions.connection.enableAria', { name: c.name })}
          onCheckedChange={(v) => setEnabled.mutate([c.id, v])}
        />
      </div>
      <p className="mt-2 text-[12.5px]" style={{ color: 'var(--fg-2)' }}>
        {statusText}
        {t('actions.separator')}
        {localityLabel(c.locality)}
      </p>
      {c.locality === 'internet' && (
        <p className="mt-1 text-[12px] leading-relaxed" style={{ color: 'var(--fg-muted)' }}>
          {t('actions.leavesDevice')}
        </p>
      )}
      {preview.length > 0 && (
        <ul
          className="mt-2 flex flex-wrap gap-1.5"
          aria-label={t('connect.actions.connection.toolsAria', { name: c.name })}
        >
          {preview.map((tool) => (
            <li
              key={tool.name}
              title={tool.description}
              className="rounded-md px-1.5 py-0.5 font-mono text-[11.5px]"
              style={{ background: 'var(--surface-sunken)', color: 'var(--fg-2)' }}
            >
              {tool.title || tool.name}
            </li>
          ))}
          {actionTools.length > TOOL_PREVIEW && (
            <li className="px-1 py-0.5 text-[11.5px]" style={{ color: 'var(--fg-muted)' }}>
              {t('connect.actions.connection.moreTools', {
                count: actionTools.length - TOOL_PREVIEW,
              })}
            </li>
          )}
        </ul>
      )}
      <div className="mt-3 flex flex-wrap gap-2">
        {c.auth === 'oauth' && c.status === 'needs-auth' ? (
          <Button
            size="sm"
            className="h-[28px] px-3 text-[12.5px]"
            disabled={disabled || busy}
            onClick={() => {
              setError('');
              authorize.mutate([c.id], { onError: (e) => setError(actionErrorMessage(e)) });
            }}
          >
            {t('connect.actions.connection.signIn')}
          </Button>
        ) : (
          <Button
            variant="outline"
            size="sm"
            className="h-[28px] px-3 text-[12.5px]"
            disabled={disabled || busy}
            onClick={() => {
              setError('');
              refresh.mutate([c.id], { onError: (e) => setError(actionErrorMessage(e)) });
            }}
          >
            {refresh.isPending
              ? t('connect.actions.connection.refreshing')
              : t('connect.actions.connection.refresh')}
          </Button>
        )}
        <Button
          variant="ghost"
          size="sm"
          className="h-[28px] px-3 text-[12.5px]"
          onClick={() => setConfirmOpen(true)}
        >
          {t('connect.actions.connection.disconnect')}
        </Button>
      </div>
      <div role="status" className="mt-1 text-[12px]" style={{ color: 'var(--fg-2)' }}>
        {error}
      </div>
      <ConfirmDialog
        open={confirmOpen}
        onOpenChange={setConfirmOpen}
        title={t('connect.actions.connection.disconnectTitle', { name: c.name })}
        description={t('connect.actions.connection.disconnectDescription')}
        confirmLabel={t('connect.actions.connection.disconnect')}
        cancelLabel={t('actions.cancel')}
        destructive
        onConfirm={async () => {
          await remove.mutateAsync([c.id]);
          setConfirmOpen(false);
        }}
      />
    </section>
  );
}
