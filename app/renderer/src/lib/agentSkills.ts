import type { ConnectSkillAgentId } from '@/lib/ipc';

export const STENO_SKILL_URL = 'https://github.com/stenolabs/stenoai/tree/main/skills/steno';
export const STENO_AGENTS_DOCS_URL = 'https://github.com/stenolabs/stenoai/blob/main/docs/features/agents.mdx';

/**
 * The Steno skill install prompts for coding agents (Connect → Coding agents).
 * The prompt is what the user pastes into their agent, so it stays English
 * agent instructions rather than interface copy. The install paths it names
 * are the ones the main process checks to show "Connected · via skill"
 * (steno-mcp-install.js skillPaths) — keep the two in step.
 */
export const AGENT_SKILLS: readonly {
  id: ConnectSkillAgentId;
  invocation: string;
  docs: string;
  prompt: string;
}[] = [
  {
    id: 'claudeCode',
    invocation: '/steno',
    docs: `${STENO_AGENTS_DOCS_URL}#claude-code`,
    prompt: `Install the Steno skill from ${STENO_SKILL_URL} into my personal Claude Code skills directory (~/.claude/skills/steno). Include the whole folder, including scripts and references. If it already exists, ask before replacing it. Then explain how to use /steno with my local meeting notes.`,
  },
  {
    id: 'codex',
    invocation: '$steno',
    docs: `${STENO_AGENTS_DOCS_URL}#codex`,
    prompt: `$skill-installer install the Steno skill from ${STENO_SKILL_URL}. Include the whole folder, including scripts and references. If it already exists, ask before replacing it. Then explain how to use $steno with my local meeting notes.`,
  },
];
