export const STENO_SKILL_URL = 'https://github.com/stenolabs/stenoai/tree/main/skills/steno';
export const STENO_AGENTS_DOCS_URL = 'https://github.com/stenolabs/stenoai/blob/main/docs/features/agents.mdx';

export const AGENTS_COPY = {
  nav: 'Agents',
  title: 'Your notes, in your agent.',
  intro:
    'Give your agent the context from your meetings. The Steno skill helps it find decisions, recap your week, and turn conversations into work.',
  skill: 'The Steno skill',
  setup: 'Copy the install prompt and paste it into your agent on this computer.',
  copy: 'Copy install prompt',
  viewPrompt: 'View install prompt',
  copied: 'Copied',
  copyError: 'Could not copy. Select and copy the prompt below.',
  docs: 'Setup instructions',
  docsError: 'Could not open the instructions. Try again.',
  privacy:
    'The skill reads your local notes. Content you ask your agent to use is handled under that agent’s data and privacy settings.',
  tryIt: 'After installing, try asking',
  example: 'Use the Steno skill to recap this week’s meetings and list my next steps.',
};

export const AGENT_SKILLS = [
  {
    id: 'claude',
    name: 'Claude Code',
    invocation: '/steno',
    docs: `${STENO_AGENTS_DOCS_URL}#claude-code`,
    prompt: `Install the Steno skill from ${STENO_SKILL_URL} into my personal Claude Code skills directory (~/.claude/skills/steno). Include the whole folder, including scripts and references. If it already exists, ask before replacing it. Then explain how to use /steno with my local meeting notes.`,
  },
  {
    id: 'codex',
    name: 'Codex',
    invocation: '$steno',
    docs: `${STENO_AGENTS_DOCS_URL}#codex`,
    prompt: `$skill-installer install the Steno skill from ${STENO_SKILL_URL}. Include the whole folder, including scripts and references. If it already exists, ask before replacing it. Then explain how to use $steno with my local meeting notes.`,
  },
] as const;
