import * as React from 'react';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { useAddCustomEndpoint } from '@/hooks/useActions';
import { actionErrorMessage } from '@/lib/actionErrors';
import type { ActionAuth, ActionLocality } from '@/lib/ipc';
import { t } from '@/i18n';

/** Client-side hint only; the main process re-validates every URL. */
function guessLocality(raw: string): ActionLocality | null {
  try {
    const host = new URL(raw.trim()).hostname.replace(/^\[|\]$/g, '').toLowerCase();
    if (host === 'localhost' || host === '::1' || /^127\./.test(host)) return 'device';
    if (
      /^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(host) ||
      /\.(local|lan|internal|home\.arpa)$/.test(host)
    ) {
      return 'network';
    }
    return 'internet';
  } catch {
    return null;
  }
}

const fieldLabel = 'mb-1 block text-[12.5px]';

/**
 * Add any MCP endpoint: n8n's MCP Server Trigger (bearer), a Zapier MCP
 * connection token, Make, or a server that signs in with OAuth. The token is
 * handed to the main process once and stored with safeStorage; it is never
 * read back into the renderer. The parent remounts it (key) for each open,
 * so every add starts from an empty form.
 */
export function AddEndpointDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const add = useAddCustomEndpoint();
  const [name, setName] = React.useState('');
  const [url, setUrl] = React.useState('');
  const [auth, setAuth] = React.useState<ActionAuth>('bearer');
  const [headerName, setHeaderName] = React.useState('');
  const [token, setToken] = React.useState('');
  const [error, setError] = React.useState('');
  const locality = guessLocality(url);
  const ids = React.useId();

  const needsToken = auth === 'bearer' || auth === 'header';
  const canSave =
    url.trim() !== '' &&
    (!needsToken || token !== '') &&
    (auth !== 'header' || headerName.trim() !== '');

  const save = () => {
    setError('');
    add.mutate(
      [
        {
          name: name.trim(),
          url: url.trim(),
          auth,
          headerName: headerName.trim() || undefined,
          token: needsToken ? token : undefined,
        },
      ],
      {
        onSuccess: () => onOpenChange(false),
        onError: (e) => setError(actionErrorMessage(e)),
      }
    );
  };

  return (
    <Dialog open={open} onOpenChange={(v) => !add.isPending && onOpenChange(v)}>
      <DialogContent className="max-w-[520px]">
        <DialogHeader>
          <DialogTitle>{t('connect.actions.add.title')}</DialogTitle>
          <DialogDescription>{t('connect.actions.add.intro')}</DialogDescription>
        </DialogHeader>
        <form
          className="flex flex-col gap-3"
          onSubmit={(e) => {
            e.preventDefault();
            if (canSave && !add.isPending) save();
          }}
        >
          <div>
            <label htmlFor={`${ids}-name`} className={fieldLabel} style={{ color: 'var(--fg-2)' }}>
              {t('connect.actions.add.name')}
            </label>
            <Input
              id={`${ids}-name`}
              value={name}
              onChange={(e) => setName(e.currentTarget.value)}
              placeholder={t('connect.actions.add.namePlaceholder')}
              maxLength={80}
            />
          </div>
          <div>
            <label htmlFor={`${ids}-url`} className={fieldLabel} style={{ color: 'var(--fg-2)' }}>
              {t('connect.actions.add.url')}
            </label>
            <Input
              id={`${ids}-url`}
              value={url}
              onChange={(e) => setUrl(e.currentTarget.value)}
              placeholder={t('connect.actions.add.urlPlaceholder')}
              spellCheck={false}
              autoComplete="off"
              inputMode="url"
            />
          </div>
          {locality === 'internet' && (
            <p className="text-[12px] leading-relaxed" style={{ color: 'var(--fg-2)' }}>
              {t('actions.leavesDevice')}
            </p>
          )}
          <div>
            <label htmlFor={`${ids}-auth`} className={fieldLabel} style={{ color: 'var(--fg-2)' }}>
              {t('connect.actions.add.auth')}
            </label>
            <select
              id={`${ids}-auth`}
              className="h-9 w-full rounded-md border border-border bg-transparent px-2 text-sm"
              value={auth}
              onChange={(e) => setAuth(e.currentTarget.value as ActionAuth)}
            >
              <option value="bearer">{t('connect.actions.add.auth.bearer')}</option>
              <option value="header">{t('connect.actions.add.auth.header')}</option>
              <option value="oauth">{t('connect.actions.add.auth.oauth')}</option>
              <option value="none">{t('connect.actions.add.auth.none')}</option>
            </select>
          </div>
          {auth === 'header' && (
            <div>
              <label
                htmlFor={`${ids}-headerName`}
                className={fieldLabel}
                style={{ color: 'var(--fg-2)' }}
              >
                {t('connect.actions.add.headerName')}
              </label>
              <Input
                id={`${ids}-headerName`}
                value={headerName}
                onChange={(e) => setHeaderName(e.currentTarget.value)}
                placeholder={t('connect.actions.add.headerPlaceholder')}
                spellCheck={false}
                autoComplete="off"
              />
            </div>
          )}
          {needsToken && (
            <div>
              <label
                htmlFor={`${ids}-token`}
                className={fieldLabel}
                style={{ color: 'var(--fg-2)' }}
              >
                {t('connect.actions.add.token')}
              </label>
              <Input
                id={`${ids}-token`}
                type="password"
                value={token}
                onChange={(e) => setToken(e.currentTarget.value)}
                spellCheck={false}
                autoComplete="off"
              />
            </div>
          )}
          <p className="text-[12px] leading-relaxed" style={{ color: 'var(--fg-muted)' }}>
            {auth === 'oauth'
              ? t('connect.actions.add.oauthHint')
              : t('connect.actions.add.n8nHint')}
          </p>
          <div role="status" className="text-[12.5px]" style={{ color: 'var(--fg-2)' }}>
            {add.isPending && auth === 'oauth' ? t('connect.actions.waitingForSignIn') : error}
          </div>
          <DialogFooter>
            <Button
              type="button"
              variant="ghost"
              onClick={() => onOpenChange(false)}
              disabled={add.isPending}
            >
              {t('actions.cancel')}
            </Button>
            <Button type="submit" disabled={!canSave || add.isPending}>
              {add.isPending ? t('connect.actions.add.connecting') : t('connect.actions.add.save')}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
