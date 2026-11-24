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

/**
 * Coding agents (Claude Code, Codex): the Steno skill is the primary install
 * (it finds decisions, recaps the week, turns conversations into work); MCP
 * is the secondary connection, read-only and bound by "What assistants can
 * see". The status reports what the main process found on disk: Connected,
 * via the skill, MCP or both.
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
          const skill = info.data?.skills?.[a.id] === true;
          const mcp = info.data?.clients[a.id] === true;
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
                  {(mcp || skill) && (
                    <div className="mt-1.5">
                      <ConnectionStatus mcp={mcp} skill={skill} lastUsed={info.data?.lastUsed?.[a.id]} />
                    </div>
                  )}
                </div>
              </div>
              <div className="mt-auto flex flex-wrap items-center gap-1.5 pl-12 pt-4">
                <Button
                  variant={skill ? 'outline' : 'default'}
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
                  aria-label={
                    mcp
                      ? t('connect.codingAgents.viewSetupAria', { name: a.name })
                      : t('connect.codingAgents.useMcpAria', { name: a.name })
                  }
                  onClick={() => setSheet({ agent: a, kind: 'mcp' })}
                >
                  {mcp ? t('connect.codingAgents.viewSetup') : t('connect.codingAgents.connectMcp')}
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
