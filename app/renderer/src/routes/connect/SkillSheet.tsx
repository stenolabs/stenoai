import * as React from 'react';
import { Check, Copy, ExternalLink } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { AGENT_SKILLS } from '@/lib/agentSkills';
import { ipc, type ConnectSkillAgentId } from '@/lib/ipc';
import { t } from '@/i18n';

/**
 * Install the Steno skill in a coding agent: copy a prompt that asks the
 * agent to fetch skills/steno into its personal skills folder. Steno never
 * writes into another tool's config itself.
 */
export function SkillSheet({ agent, name }: { agent: ConnectSkillAgentId; name: string }) {
  const skill = AGENT_SKILLS.find((s) => s.id === agent);
  const [copied, setCopied] = React.useState(false);
  const [error, setError] = React.useState('');
  const [promptOpen, setPromptOpen] = React.useState(false);
  React.useEffect(() => {
    if (!copied) return;
    const timer = setTimeout(() => setCopied(false), 2500);
    return () => clearTimeout(timer);
  }, [copied]);
  if (!skill) return null;

  const copyPrompt = async () => {
    try {
      await navigator.clipboard.writeText(skill.prompt);
      setError('');
      setCopied(true);
    } catch {
      setCopied(false);
      setError(t('connect.skill.copyError'));
      setPromptOpen(true);
    }
  };
  const openDocs = async () => {
    try {
      const result = await ipc().shell.openExternal(skill.docs);
      if (!result.success) throw new Error();
      setError('');
    } catch {
      setError(t('connect.skill.docsError'));
    }
  };

  return (
    <>
      <DialogHeader>
        <DialogTitle>{t('connect.skill.title', { name })}</DialogTitle>
        <DialogDescription>{t('connect.skill.setup')}</DialogDescription>
      </DialogHeader>
      <div className="flex flex-wrap items-center gap-2">
        <Button size="sm" onClick={() => void copyPrompt()}>
          {copied ? <Check aria-hidden /> : <Copy aria-hidden />}
          {copied ? t('connect.skill.copied') : t('connect.skill.copy')}
        </Button>
        <Button variant="ghost" size="sm" onClick={() => void openDocs()}>
          <ExternalLink aria-hidden />
          {t('connect.skill.docs')}
        </Button>
      </div>
      <details
        className="text-[12.5px]"
        open={promptOpen}
        onToggle={(event) => setPromptOpen(event.currentTarget.open)}
      >
        <summary className="cursor-pointer" style={{ color: 'var(--fg-2)' }}>
          {t('connect.skill.viewPrompt')}
        </summary>
        <p
          className="mt-2 select-all break-words rounded-lg p-3 leading-relaxed"
          style={{ background: 'var(--surface-sunken)', color: 'var(--fg-1)' }}
        >
          {skill.prompt}
        </p>
      </details>
      <div role="status" className="-mt-2 text-[12.5px] empty:hidden" style={{ color: 'var(--fg-2)' }}>
        {error}
      </div>
      <div className="rounded-lg p-3" style={{ background: 'var(--surface-sunken)' }}>
        <p className="text-[12px] font-medium" style={{ color: 'var(--fg-2)' }}>
          {t('connect.skill.tryIt')}
        </p>
        <p className="mt-1 text-[13.5px] leading-relaxed">{t('connect.skill.example')}</p>
      </div>
      <p className="text-[12px] leading-relaxed" style={{ color: 'var(--fg-muted)' }}>
        {t('connect.skill.privacy')}
      </p>
    </>
  );
}
