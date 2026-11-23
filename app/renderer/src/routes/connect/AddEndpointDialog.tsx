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
import { useAddCustomEndpoint, useAddLocalServer } from '@/hooks/useActions';
import { parseEnvLines, splitCommandLine } from '@/lib/commandLine';
import { actionErrorMessage } from '@/lib/actionErrors';
import type { ActionAuth, ActionLocality } from '@/lib/ipc';
import { t } from '@/i18n';
import { LocalCommandFields } from './LocalCommandFields';

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

type Mode = 'url' | 'local';
const MODES: readonly Mode[] = ['url', 'local'];

/**
 * Add any MCP endpoint: n8n's MCP Server Trigger (bearer), a Zapier MCP
 * connection token, Make, or a server that signs in with OAuth. The token is
 * handed to the main process once and stored with safeStorage; it is never
 * read back into the renderer. The parent remounts it (key) for each open,
 * so every add starts from an empty form.
 *
 * "Command on this computer" adds a local MCP server instead (stdio): a
 * command line and optional KEY=value variables. The main process confirms
 * it in a native dialog before saving, and stores the variables like tokens.
 */
export function AddEndpointDialog({
  open,
  onOpenChange,
  allowLocal = true,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** False when the org does not allow local commands: URL servers only. */
  allowLocal?: boolean;
}) {
  const add = useAddCustomEndpoint();
  const addLocal = useAddLocalServer();
  const [mode, setMode] = React.useState<Mode>('url');
  const [commandLine, setCommandLine] = React.useState('');
  const [envText, setEnvText] = React.useState('');
  const [name, setName] = React.useState('');
  const [url, setUrl] = React.useState('');
  const [auth, setAuth] = React.useState<ActionAuth>('bearer');
  const [headerName, setHeaderName] = React.useState('');
  const [token, setToken] = React.useState('');
  const [error, setError] = React.useState('');
  const locality = guessLocality(url);
  const ids = React.useId();

  const needsToken = auth === 'bearer' || auth === 'header';
  const pending = add.isPending || addLocal.isPending;
  const canSave =
    mode === 'local'
      ? commandLine.trim() !== ''
      : url.trim() !== '' &&
        (!needsToken || token !== '') &&
        (auth !== 'header' || headerName.trim() !== '');

  const saveLocal = () => {
    const words = splitCommandLine(commandLine.trim());
    if (!words || words.length === 0) {
      setError(t('connect.actions.add.local.badCommand'));
      return;
    }
    const parsed = parseEnvLines(envText);
    if ('error' in parsed) {
      setError(t('connect.actions.add.local.badEnv', { line: parsed.error }));
      return;
    }
    const [command, ...args] = words;
    addLocal.mutate([{ name: name.trim(), command: command!, args, env: parsed.env }], {
      onSuccess: () => onOpenChange(false),
      onError: (e) => setError(actionErrorMessage(e)),
    });
  };

  const save = () => {
    setError('');
    if (mode === 'local') {
      saveLocal();
      return;
    }
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

  const modeButton = (value: Mode) => (
    <button
      key={value}
      type="button"
      role="radio"
      aria-checked={mode === value}
      className="h-7 flex-1 rounded-md px-3 text-[12.5px] font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      style={
        mode === value
          ? {
              background: 'var(--surface-raised)',
              color: 'var(--fg-1)',
              boxShadow: '0 1px 2px rgba(0,0,0,0.08)',
            }
          : { color: 'var(--fg-2)' }
      }
      disabled={pending}
      onClick={() => {
        setMode(value);
        setError('');
      }}
    >
      {value === 'local' ? t('connect.actions.add.mode.local') : t('connect.actions.add.mode.url')}
    </button>
  );

  return (
    <Dialog open={open} onOpenChange={(v) => !pending && onOpenChange(v)}>
      <DialogContent className="max-w-[520px]">
        <DialogHeader>
          <DialogTitle>{t('connect.actions.add.title')}</DialogTitle>
          <DialogDescription>
            {mode === 'local'
              ? t('connect.actions.add.local.intro')
              : t('connect.actions.add.intro')}
          </DialogDescription>
        </DialogHeader>
        <form
          className="flex flex-col gap-3"
          onSubmit={(e) => {
            e.preventDefault();
            if (canSave && !pending) save();
          }}
        >
          {allowLocal && (
            <div
              role="radiogroup"
              aria-label={t('connect.actions.add.modeAria')}
              className="flex gap-1 rounded-lg p-1"
              style={{ background: 'var(--surface-sunken)' }}
            >
              {MODES.map((m) => modeButton(m))}
            </div>
          )}
          <div>
            <label htmlFor={`${ids}-name`} className={fieldLabel} style={{ color: 'var(--fg-2)' }}>
              {t('connect.actions.add.name')}
            </label>
            <Input
              id={`${ids}-name`}
              value={name}
              onChange={(e) => setName(e.currentTarget.value)}
              placeholder={
                mode === 'local'
                  ? t('connect.actions.add.local.namePlaceholder')
                  : t('connect.actions.add.namePlaceholder')
              }
              maxLength={80}
            />
          </div>
          {mode === 'local' ? (
            <LocalCommandFields
              ids={ids}
              command={commandLine}
              onCommand={setCommandLine}
              env={envText}
              onEnv={setEnvText}
            />
          ) : (
            <>
              <div>
                <label
                  htmlFor={`${ids}-url`}
                  className={fieldLabel}
                  style={{ color: 'var(--fg-2)' }}
                >
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
                <label
                  htmlFor={`${ids}-auth`}
                  className={fieldLabel}
                  style={{ color: 'var(--fg-2)' }}
                >
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
            </>
          )}
          <div role="status" className="text-[12.5px]" style={{ color: 'var(--fg-2)' }}>
            {add.isPending && auth === 'oauth'
              ? t('connect.actions.waitingForSignIn')
              : addLocal.isPending
                ? t('connect.actions.add.local.confirming')
                : error}
          </div>
          <DialogFooter>
            <Button
              type="button"
              variant="ghost"
              onClick={() => onOpenChange(false)}
              disabled={pending}
            >
              {t('actions.cancel')}
            </Button>
            <Button type="submit" disabled={!canSave || pending}>
              {pending
                ? t('connect.actions.add.connecting')
                : mode === 'local'
                  ? t('connect.actions.add.local.save')
                  : t('connect.actions.add.save')}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
