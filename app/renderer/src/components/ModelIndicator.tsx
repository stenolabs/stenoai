import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { formatActiveModel, shortActiveModel, type ActiveModelFields } from '@/lib/chat';
import { t } from '@/i18n';

/**
 * The chat composer's model label: a short name ("Gemma 4 E2B"), with the
 * provider, the full model id and, for local models, the context-cap note in
 * its tooltip. Local/remote windows are smaller than cloud, so the backend
 * caps the corpus to the most recent notes when it is over budget.
 */
export function ModelIndicator({ provider }: { provider: ActiveModelFields | undefined }) {
  const local = provider?.ai_provider === 'local' || provider?.ai_provider === 'remote';
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span
          data-testid="chat-model-indicator"
          tabIndex={0}
          className="cursor-default truncate rounded px-1 text-[12px] outline-none focus-visible:ring-2 focus-visible:ring-[color:var(--accent-primary)]"
          style={{ color: 'var(--fg-muted)' }}
        >
          {shortActiveModel(provider)}
        </span>
      </TooltipTrigger>
      <TooltipContent side="top">
        <div>{formatActiveModel(provider)}</div>
        {local && <div data-testid="chat-local-scope-hint">{t('chat.home.localScopeHint')}</div>}
      </TooltipContent>
    </Tooltip>
  );
}
