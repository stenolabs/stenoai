import * as React from 'react';
import { Check, Copy } from 'lucide-react';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { useConnectInfo } from '@/hooks/useConnect';
import { ipc, type ConnectClientId } from '@/lib/ipc';
import { t } from '@/i18n';
import { BrandGlyph, ConnectGlyph, type GlyphKind } from './ConnectGlyph';
import type { BrandSlug } from './brandLogos';

type AssistantId = ConnectClientId | 'chatgpt';

interface Assistant {
  id: AssistantId;
  name: string;
  description: string;
  glyph: GlyphKind;
  brand?: BrandSlug;
  comingSoon?: boolean;
}

function assistants(): Assistant[] {
  return [
    {
      id: 'claudeDesktop',
      name: t('connect.assistants.claudeDesktop.name'),
      description: t('connect.assistants.claudeDesktop.description'),
      glyph: 'anthropic',
      brand: 'claude',
    },
    {
      id: 'claudeCode',
      name: t('connect.assistants.claudeCode.name'),
      description: t('connect.assistants.claudeCode.description'),
      glyph: 'anthropic',
      brand: 'claude',
    },
    {
      id: 'codex',
      name: t('connect.assistants.codex.name'),
      description: t('connect.assistants.codex.description'),
      glyph: 'openai',
    },
    {
      id: 'cursor',
      name: t('connect.assistants.cursor.name'),
      description: t('connect.assistants.cursor.description'),
      glyph: 'cursor',
      brand: 'cursor',
    },
    {
      id: 'chatgpt',
      name: t('connect.assistants.chatgpt.name'),
      description: t('connect.assistants.chatgpt.description'),
      glyph: 'openai',
      comingSoon: true,
    },
  ];
}

export function AssistantsSection() {
  const info = useConnectInfo();
  const [open, setOpen] = React.useState<Assistant | null>(null);
  const list = assistants();

  return (
    <section aria-labelledby="connect-assistants-heading" className="mt-10">
      <h2 id="connect-assistants-heading" className="text-sm font-medium">
        {t('connect.assistants.heading')}
      </h2>
      <div className="mt-4 grid gap-3 sm:grid-cols-2">
        {list.map((a) => {
          const connected = a.id !== 'chatgpt' && info.data?.clients[a.id] === true;
          return (
            <section
              key={a.id}
              aria-label={a.name}
              className="flex min-w-0 items-start gap-3 rounded-xl border p-4"
              style={{ borderColor: 'var(--border-subtle)', background: 'var(--surface-raised)' }}
            >
              {a.brand ? <BrandGlyph brand={a.brand} /> : <ConnectGlyph kind={a.glyph} />}
              <div className="min-w-0 flex-1">
                <h3 className="text-[14px] font-medium">{a.name}</h3>
                <p className="mt-0.5 text-[12.5px] leading-snug" style={{ color: 'var(--fg-2)' }}>
                  {a.description}
                </p>
              </div>
              {a.comingSoon ? (
                <span
                  className="shrink-0 rounded-full px-2 py-0.5 text-[11.5px]"
                  style={{ background: 'var(--surface-sunken)', color: 'var(--fg-2)' }}
                >
                  {t('connect.comingSoon')}
                </span>
              ) : (
                <Button
                  variant={connected ? 'ghost' : 'outline'}
                  size="sm"
                  className="h-[30px] shrink-0 px-3 text-[13px]"
                  aria-label={t('connect.assistants.connectAria', { name: a.name })}
                  onClick={() => setOpen(a)}
                >
                  {connected && <Check aria-hidden />}
                  {connected ? t('connect.connected') : t('connect.connect')}
                </Button>
              )}
            </section>
          );
        })}
      </div>
      <Dialog open={open !== null} onOpenChange={(v) => !v && setOpen(null)}>
        <DialogContent className="max-w-[520px]">
          {open && <InstallSheet assistant={open} />}
        </DialogContent>
      </Dialog>
    </section>
  );
}

function InstallSheet({ assistant }: { assistant: Assistant }) {
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

function sheetIntro(id: AssistantId): string {
  switch (id) {
    case 'claudeDesktop':
      return t('connect.sheet.claudeDesktop.intro');
    case 'claudeCode':
      return t('connect.sheet.claudeCode.intro');
    case 'codex':
      return t('connect.sheet.codex.intro');
    case 'cursor':
      return t('connect.sheet.cursor.intro');
    default:
      return t('connect.assistants.chatgpt.description');
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

function CopyBlock({ label, text }: { label: string; text: string }) {
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
