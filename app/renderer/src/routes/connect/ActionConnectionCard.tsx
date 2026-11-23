import * as React from 'react';
import { Button } from '@/components/ui/button';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import { Switch } from '@/components/ui/switch';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import {
  useAuthorizeConnection,
  useRefreshConnection,
  useRemoveConnection,
  useSetConnectionEnabled,
} from '@/hooks/useActions';
import { actionErrorMessage } from '@/lib/actionErrors';
import type { ActionConnection, ActionLocality } from '@/lib/ipc';
import { t } from '@/i18n';

const TOOL_LIST_MAX = 40;

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
        {actionTools.length > 0 ? (
          // The actions themselves are a hover away: a long vendor list
          // (Notion offers ~40) would otherwise dominate the card.
          <Tooltip>
            <TooltipTrigger asChild>
              <span
                tabIndex={0}
                className="cursor-default underline decoration-dotted underline-offset-2 outline-none focus-visible:ring-2 focus-visible:ring-[color:var(--accent-primary)]"
              >
                {statusText}
              </span>
            </TooltipTrigger>
            <TooltipContent side="bottom" align="start" className="max-w-[320px]">
              <ul
                className="max-h-[260px] overflow-y-auto"
                aria-label={t('connect.actions.connection.toolsAria', { name: c.name })}
              >
                {actionTools.slice(0, TOOL_LIST_MAX).map((tool) => (
                  <li key={tool.name} className="py-0.5">
                    {tool.title || tool.name}
                  </li>
                ))}
                {actionTools.length > TOOL_LIST_MAX && (
                  <li className="py-0.5 opacity-70">
                    {t('connect.actions.connection.moreTools', {
                      count: actionTools.length - TOOL_LIST_MAX,
                    })}
                  </li>
                )}
              </ul>
            </TooltipContent>
          </Tooltip>
        ) : (
          statusText
        )}
        {t('actions.separator')}
        {localityLabel(c.locality)}
      </p>
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
