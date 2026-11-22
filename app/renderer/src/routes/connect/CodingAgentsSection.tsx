import * as React from 'react';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent } from '@/components/ui/dialog';
import { useConnectInfo } from '@/hooks/useConnect';
import type { ConnectSkillAgentId } from '@/lib/ipc';
import { t } from '@/i18n';
import { BrandGlyph, ConnectGlyph } from './ConnectGlyph';
import { ConnectionStatus, SectionHeading } from './ConnectionStatus';
import { McpInstallSheet } from './McpInstallSheet';
import { SkillSheet } from './SkillSheet';

interface CodingAgent {
  id: ConnectSkillAgentId;
  name: string;
  description: string;
}

function codingAgents(): CodingAgent[] {
  return [
    {
      id: 'claudeCode',
      name: t('connect.assistants.claudeCode.name'),
      description: t('connect.assistants.claudeCode.description'),
    },
    {
      id: 'codex',
      name: t('connect.assistants.codex.name'),
      description: t('connect.assistants.codex.description'),
    },
  ];
}

type Sheet = { agent: CodingAgent; kind: 'skill' | 'mcp' };
type Via = 'skill' | 'mcp';

/** The skill wins the hint when both are installed: it is the default path. */
function connectedVia(skill: boolean, mcp: boolean): Via | undefined {
  if (skill) return 'skill';
  if (mcp) return 'mcp';
  return undefined;
}

/**
 * Coding agents (Claude Code, Codex): the Steno skill is the default install,
 * with the MCP server as the alternative. Either one, found on disk by the
 * main process, reads as Connected.
 */
export function CodingAgentsSection() {
  const info = useConnectInfo();
  const [sheet, setSheet] = React.useState<Sheet | null>(null);

  return (
    <section aria-labelledby="connect-coding-heading" className="mt-10">
      <SectionHeading
        id="connect-coding-heading"
        title={t('connect.codingAgents.heading')}
        intro={t('connect.codingAgents.intro')}
      />
      <div className="mt-4 grid gap-3 sm:grid-cols-2">
        {codingAgents().map((a) => {
          const viaSkill = info.data?.skills?.[a.id] === true;
          const viaMcp = info.data?.clients[a.id] === true;
          const via = connectedVia(viaSkill, viaMcp);
          return (
            <section
              key={a.id}
              aria-label={a.name}
              className="flex min-w-0 flex-col rounded-xl border p-4"
              style={{ borderColor: 'var(--border-subtle)', background: 'var(--surface-raised)' }}
            >
              <div className="flex min-w-0 items-start gap-3">
                {a.id === 'claudeCode' ? <BrandGlyph brand="claude" /> : <ConnectGlyph kind="openai" />}
                <div className="min-w-0 flex-1">
                  <h3 className="text-[14px] font-medium">{a.name}</h3>
                  <p className="mt-0.5 text-[12.5px] leading-snug" style={{ color: 'var(--fg-2)' }}>
                    {a.description}
                  </p>
                  {via && (
                    <div className="mt-1.5">
                      <ConnectionStatus via={via} />
                    </div>
                  )}
                </div>
              </div>
              <div className="mt-auto flex flex-wrap items-center gap-1.5 pl-12 pt-4">
                <Button
                  variant={via ? 'outline' : 'default'}
                  size="sm"
                  className="h-[30px] px-3 text-[13px]"
                  aria-label={t('connect.codingAgents.installSkillAria', { name: a.name })}
                  onClick={() => setSheet({ agent: a, kind: 'skill' })}
                >
                  {t('connect.codingAgents.installSkill')}
                </Button>
                <Button
                  variant="ghost"
                  size="sm"
                  className="h-[30px] px-2.5 text-[12.5px]"
                  style={{ color: 'var(--fg-2)' }}
                  aria-label={t('connect.codingAgents.useMcpAria', { name: a.name })}
                  onClick={() => setSheet({ agent: a, kind: 'mcp' })}
                >
                  {t('connect.codingAgents.useMcp')}
                </Button>
              </div>
            </section>
          );
        })}
      </div>
      <Dialog open={sheet !== null} onOpenChange={(v) => !v && setSheet(null)}>
        <DialogContent className="max-w-[520px]">
          {sheet?.kind === 'skill' && <SkillSheet agent={sheet.agent.id} name={sheet.agent.name} />}
          {sheet?.kind === 'mcp' && <McpInstallSheet assistant={sheet.agent} />}
        </DialogContent>
      </Dialog>
    </section>
  );
}
