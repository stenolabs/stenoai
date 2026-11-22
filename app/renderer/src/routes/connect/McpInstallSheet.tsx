import * as React from 'react';
import { Check, Copy } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { useConnectInfo } from '@/hooks/useConnect';
import { ipc, type ConnectClientId } from '@/lib/ipc';
import { t } from '@/i18n';

export interface McpTarget {
  id: ConnectClientId;
  name: string;
}

/** The MCP install steps for one assistant (Claude, Claude Code, Codex, Cursor). */
export function McpInstallSheet({ assistant }: { assistant: McpTarget }) {
  const info = useConnectInfo();
  const snippets = info.data?.snippets;
  return (
    <>
      <DialogHeader>
        <DialogTitle>{t('connect.sheet.title', { name: assistant.name })}</DialogTitle>
        <DialogDescription>{sheetIntro(assistant.id)}</DialogDescription>
      </DialogHeader>
      {info.data && !info.data.serverAvailable && (
        <p role="alert" className="text-[13px]" style={{ color: 'var(--fg-2)' }}>
          {t('connect.sheet.serverMissing')}
        </p>
      )}
      {assistant.id === 'claudeDesktop' && (
        <ClaudeDesktopStep bundleAvailable={info.data?.claudeBundleAvailable} />
      )}
      {assistant.id === 'claudeCode' && snippets && (
        <CopyBlock label={t('connect.sheet.claudeCode.copyLabel')} text={snippets.claudeCode} />
      )}
      {assistant.id === 'codex' && snippets && (
        <CopyBlock label={t('connect.sheet.codex.copyLabel')} text={snippets.codexToml} />
      )}
      {assistant.id === 'cursor' && snippets && (
        <>
          <OpenButton
            label={t('connect.sheet.cursor.open')}
            failure={t('connect.sheet.cursor.openError')}
            open={() => ipc().connect.openCursor()}
          />
          <CopyBlock label={t('connect.sheet.cursor.copyLabel')} text={snippets.cursorJson} />
        </>
      )}
      <p className="text-[12px] leading-relaxed" style={{ color: 'var(--fg-muted)' }}>
        {t('connect.sheet.footer')}
      </p>
    </>
  );
}

function sheetIntro(id: ConnectClientId): string {
  switch (id) {
    case 'claudeDesktop':
      return t('connect.sheet.claudeDesktop.intro');
    case 'claudeCode':
      return t('connect.sheet.claudeCode.intro');
    case 'codex':
      return t('connect.sheet.codex.intro');
    case 'cursor':
      return t('connect.sheet.cursor.intro');
  }
}

function ClaudeDesktopStep({ bundleAvailable }: { bundleAvailable?: boolean }) {
  if (bundleAvailable === false) {
    return (
      <p role="alert" className="text-[13px]" style={{ color: 'var(--fg-2)' }}>
        {t('connect.sheet.claudeDesktop.bundleMissing')}
      </p>
    );
  }
  return (
    <OpenButton
      label={t('connect.sheet.claudeDesktop.open')}
      failure={t('connect.sheet.claudeDesktop.openError')}
      open={() => ipc().connect.openClaudeDesktop()}
    />
  );
}

function OpenButton({
  label,
  failure,
  open,
}: {
  label: string;
  failure: string;
  open: () => Promise<{ success: boolean }>;
}) {
  const [error, setError] = React.useState('');
  const run = async () => {
    try {
      const result = await open();
      setError(result.success ? '' : failure);
    } catch {
      setError(failure);
    }
  };
  return (
    <div>
      <Button size="sm" onClick={() => void run()}>
        {label}
      </Button>
      <div role="status" className="mt-2 text-[12.5px]" style={{ color: 'var(--fg-2)' }}>
        {error}
      </div>
    </div>
  );
}

export function CopyBlock({ label, text }: { label: string; text: string }) {
  const [copied, setCopied] = React.useState(false);
  const [error, setError] = React.useState('');
  React.useEffect(() => {
    if (!copied) return;
    const timer = setTimeout(() => setCopied(false), 2500);
    return () => clearTimeout(timer);
  }, [copied]);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(text);
      setError('');
      setCopied(true);
    } catch {
      setCopied(false);
      setError(t('connect.sheet.copyError'));
    }
  };
  return (
    <div className="min-w-0">
      <div className="mb-1.5 flex items-center justify-between gap-3">
        <span className="text-[12.5px]" style={{ color: 'var(--fg-2)' }}>
          {label}
        </span>
        <Button
          variant="ghost"
          size="sm"
          className="h-[26px] px-2 text-[12.5px]"
          onClick={() => void copy()}
        >
          {copied ? <Check aria-hidden /> : <Copy aria-hidden />}
          {copied ? t('connect.sheet.copied') : t('connect.sheet.copy')}
        </Button>
      </div>
      <pre
        className="max-h-[180px] select-all overflow-auto whitespace-pre-wrap break-all rounded-lg p-3 font-mono text-[11.5px] leading-relaxed"
        style={{ background: 'var(--surface-sunken)', color: 'var(--fg-1)' }}
      >
        {text}
      </pre>
      <div role="status" className="mt-1 text-[12px]" style={{ color: 'var(--fg-2)' }}>
        {error}
      </div>
    </div>
  );
}
