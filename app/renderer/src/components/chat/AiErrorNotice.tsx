import * as React from 'react';
import { AlertCircle, ArrowUpRight, RotateCw } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { useAiProvider } from '@/hooks/useAi';
import { aiErrorCopy, type AiErrorCode } from '@/lib/aiError';
import { ipc } from '@/lib/ipc';
import { navigate } from '@/lib/router';
import { t } from '@/i18n';

/**
 * A failed chat answer, said plainly with the one thing to do about it:
 * restart Ollama, open AI settings, update the key, open billing or retry.
 * Shown in place of the generic "Unable to answer" for a classified failure
 * (lib/aiError.ts). `onRetry` is offered only where asking again makes sense
 * (the latest turn); without it a retry-type notice shows no button.
 */
export function AiErrorNotice({
  code,
  onRetry,
  compact = false,
}: {
  code: AiErrorCode;
  onRetry?: () => void;
  compact?: boolean;
}) {
  const provider = useAiProvider();
  const copy = aiErrorCopy(code, provider.data);
  const [restart, setRestart] = React.useState<'idle' | 'starting' | 'failed'>('idle');

  const restartOllama = async () => {
    setRestart('starting');
    try {
      const result = await ipc().setup.ollamaAndModel();
      if (!result.success) throw new Error('not started');
      setRestart('idle');
      onRetry?.();
    } catch {
      setRestart('failed');
    }
  };

  const action = copy.action;
  let button: React.ReactNode = null;
  if (action.kind === 'restart-ollama') {
    button = restart === 'failed' ? (
      <Button size="sm" variant="outline" className="h-7 rounded-full px-3 text-[12.5px]" onClick={() => navigate('/settings?tab=ai')}>
        {t('aiError.action.openAiSettings')}
      </Button>
    ) : (
      <Button
        size="sm"
        variant="outline"
        className="h-7 rounded-full px-3 text-[12.5px]"
        disabled={restart === 'starting'}
        onClick={() => void restartOllama()}
      >
        <RotateCw aria-hidden className={restart === 'starting' ? 'motion-safe:animate-spin' : undefined} />
        {restart === 'starting' ? t('aiError.action.restarting') : t('aiError.action.restartOllama')}
      </Button>
    );
  } else if (action.kind === 'settings') {
    button = (
      <Button size="sm" variant="outline" className="h-7 rounded-full px-3 text-[12.5px]" onClick={() => navigate(action.route)}>
        {action.label}
      </Button>
    );
  } else if (action.kind === 'billing') {
    button = (
      <Button
        size="sm"
        variant="outline"
        className="h-7 rounded-full px-3 text-[12.5px]"
        onClick={() => void ipc().shell.openExternal(action.url)}
      >
        {t('aiError.action.openBilling')}
        <ArrowUpRight aria-hidden />
      </Button>
    );
  } else if (action.kind === 'retry' && onRetry) {
    button = (
      <Button size="sm" variant="outline" className="h-7 rounded-full px-3 text-[12.5px]" onClick={onRetry}>
        <RotateCw aria-hidden />
        {t('aiError.action.retry')}
      </Button>
    );
  }

  return (
    <div
      role="alert"
      data-testid="ai-error"
      data-ai-error={code}
      className={`flex items-start gap-3 rounded-xl border ${compact ? 'px-3 py-2.5' : 'px-4 py-3'}`}
      style={{ borderColor: 'var(--border-subtle)', background: 'var(--surface-sunken)', color: 'var(--fg-1)' }}
    >
      <AlertCircle aria-hidden className="mt-0.5 size-[15px] shrink-0" style={{ color: 'var(--fg-2)' }} />
      <div className="min-w-0 flex-1">
        <p className="text-[13.5px] font-medium leading-snug">{copy.title}</p>
        <p className="mt-0.5 text-[12.5px] leading-snug" style={{ color: 'var(--fg-2)' }}>
          {restart === 'failed' ? t('aiError.action.restartFailed') : copy.body}
        </p>
        {button && <div className="mt-2.5">{button}</div>}
      </div>
    </div>
  );
}
