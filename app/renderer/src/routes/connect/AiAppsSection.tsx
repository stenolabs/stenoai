import * as React from 'react';
import { Check } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent } from '@/components/ui/dialog';
import { useConnectInfo } from '@/hooks/useConnect';
import type { ConnectClientId } from '@/lib/ipc';
import { t } from '@/i18n';
import { BrandGlyph, ConnectGlyph } from './ConnectGlyph';
import { ComingSoonBadge, SectionHeading, lastUsedLabel } from './ConnectionStatus';
import { McpInstallSheet, type McpTarget } from './McpInstallSheet';

interface AiApp {
  id: ConnectClientId | 'chatgpt';
  name: string;
  description: string;
}

function aiApps(): AiApp[] {
  return [
    {
      id: 'claudeDesktop',
      name: t('connect.assistants.claudeDesktop.name'),
      description: t('connect.assistants.claudeDesktop.description'),
    },
    {
      id: 'cursor',
      name: t('connect.assistants.cursor.name'),
      description: t('connect.assistants.cursor.description'),
    },
    {
      id: 'chatgpt',
      name: t('connect.assistants.chatgpt.name'),
      description: t('connect.assistants.chatgpt.description'),
    },
  ];
}

function AppGlyph({ id }: { id: AiApp['id'] }) {
  if (id === 'claudeDesktop') return <BrandGlyph brand="claude" />;
  if (id === 'cursor') return <BrandGlyph brand="cursor" />;
  return <ConnectGlyph kind="openai" />;
}

/**
 * AI apps that read meetings over the bundled Steno MCP server (Claude
 * desktop via its .mcpb extension, Cursor via deep link). The scope controls
 * (ScopeSection) sit below both sections, since they govern every MCP
 * connection.
 */
export function AiAppsSection() {
  const info = useConnectInfo();
  const [open, setOpen] = React.useState<McpTarget | null>(null);

  return (
    <section aria-labelledby="connect-apps-heading" className="mt-10">
      <SectionHeading
        id="connect-apps-heading"
        title={t('connect.aiApps.heading')}
        intro={t('connect.aiApps.intro')}
      />
      <div className="mt-4 grid gap-3 sm:grid-cols-2">
        {aiApps().map((a) => {
          const id = a.id;
          const connected = id !== 'chatgpt' && info.data?.clients[id] === true;
          const used = connected ? lastUsedLabel(info.data?.lastUsed?.[id]) : null;
          return (
            <section
              key={id}
              aria-label={a.name}
              className="flex min-w-0 items-start gap-3 rounded-xl border p-4"
              style={{ borderColor: 'var(--border-subtle)', background: 'var(--surface-raised)' }}
            >
              <AppGlyph id={id} />
              <div className="min-w-0 flex-1">
                <h3 className="text-[14px] font-medium">{a.name}</h3>
                <p className="mt-0.5 text-[12.5px] leading-snug" style={{ color: 'var(--fg-2)' }}>
                  {a.description}
                </p>
                {used && (
                  <p className="mt-1 text-[11.5px]" style={{ color: 'var(--fg-muted)' }}>
                    {used}
                  </p>
                )}
              </div>
              {id === 'chatgpt' ? (
                <ComingSoonBadge />
              ) : (
                <Button
                  variant={connected ? 'ghost' : 'outline'}
                  size="sm"
                  className="h-[30px] shrink-0 px-3 text-[13px]"
                  aria-label={t('connect.assistants.connectAria', { name: a.name })}
                  onClick={() => setOpen({ id, name: a.name })}
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
          {open && <McpInstallSheet assistant={open} />}
        </DialogContent>
      </Dialog>
    </section>
  );
}
