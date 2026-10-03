import * as React from 'react';
import { Check, Copy, ExternalLink } from 'lucide-react';
import { MeetingsShell } from '@/components/MeetingsShell';
import { Button } from '@/components/ui/button';
import { AnthropicIcon } from '@/components/ui/anthropic-icon';
import { OpenAiIcon } from '@/components/ui/openai-icon';
import { AGENTS_COPY as copy, AGENT_SKILLS } from '@/lib/agentSkills';
import { ipc } from '@/lib/ipc';

export function Agents() {
  return (
    <MeetingsShell activeSummaryFile={null}>
      <div className="mx-auto w-full max-w-[760px] py-10" style={{ color: 'var(--fg-1)' }}>
        <p className="mb-3 text-xs font-medium" style={{ color: 'var(--fg-muted)' }}>
          {copy.nav}
        </p>
        <h1
          className="text-[32px] leading-tight tracking-tight"
          style={{ fontFamily: 'var(--font-serif)' }}
        >
          {copy.title}
        </h1>
        <p className="mt-4 max-w-[580px] text-sm leading-relaxed" style={{ color: 'var(--fg-2)' }}>
          {copy.intro}
        </p>
        <div className="mt-9 border-t pt-6" style={{ borderColor: 'var(--border-subtle)' }}>
          <h2 className="text-sm font-medium">{copy.skill}</h2>
          <p className="mt-1 text-[13px]" style={{ color: 'var(--fg-2)' }}>
            {copy.setup}
          </p>
          <div className="mt-5 grid gap-4 sm:grid-cols-2">
            {AGENT_SKILLS.map((agent) => (
              <AgentCard key={agent.id} agent={agent} />
            ))}
          </div>
        </div>
        <div className="mt-7 rounded-xl p-5" style={{ background: 'var(--surface-sunken)' }}>
          <h2 className="text-xs font-medium" style={{ color: 'var(--fg-2)' }}>
            {copy.tryIt}
          </h2>
          <p className="mt-2 text-[15px] leading-relaxed">{copy.example}</p>
        </div>
        <p className="mt-6 text-xs leading-relaxed" style={{ color: 'var(--fg-muted)' }}>
          {copy.privacy}
        </p>
      </div>
    </MeetingsShell>
  );
}

function AgentCard({ agent }: { agent: (typeof AGENT_SKILLS)[number] }) {
  const [copied, setCopied] = React.useState(false);
  const [error, setError] = React.useState('');
  React.useEffect(() => {
    if (!copied) return;
    const timer = setTimeout(() => setCopied(false), 2500);
    return () => clearTimeout(timer);
  }, [copied]);
  const copyPrompt = async () => {
    try {
      await navigator.clipboard.writeText(agent.prompt);
      setError('');
      setCopied(true);
    } catch {
      setError(copy.copyError);
    }
  };
  const openDocs = async () => {
    try {
      const result = await ipc().shell.openExternal(agent.docs);
      if (!result.success) throw new Error();
      setError('');
    } catch {
      setError(copy.docsError);
    }
  };
  return (
    <section
      aria-label={agent.name}
      className="min-w-0 rounded-xl border p-5"
      style={{ borderColor: 'var(--border-subtle)', background: 'var(--surface-raised)' }}
    >
      <div className="flex items-center gap-3">
        {agent.id === 'claude' ? <AnthropicIcon size={25} /> : <OpenAiIcon size={25} />}
        <h3 className="text-sm font-medium">{agent.name}</h3>
        <code className="ml-auto text-xs" style={{ color: 'var(--fg-muted)' }}>
          {agent.invocation}
        </code>
      </div>
      <div className="mt-6 flex flex-wrap items-center gap-2">
        <Button size="sm" onClick={() => void copyPrompt()}>
          {copied ? <Check /> : <Copy />}
          {copied ? copy.copied : copy.copy}
        </Button>
        <Button variant="ghost" size="sm" onClick={() => void openDocs()}>
          <ExternalLink />
          {copy.docs}
        </Button>
      </div>
      <details className="mt-4 text-xs" open={error === copy.copyError || undefined}>
        <summary className="cursor-pointer" style={{ color: 'var(--fg-2)' }}>
          {copy.viewPrompt}
        </summary>
        <p className="mt-3 break-words leading-relaxed" style={{ color: 'var(--fg-2)' }}>
          {agent.prompt}
        </p>
      </details>
      <div role="status" className="mt-2 text-xs" style={{ color: 'var(--fg-2)' }}>
        {error}
      </div>
    </section>
  );
}
