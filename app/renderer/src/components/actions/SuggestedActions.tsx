import * as React from 'react';
import { Sparkles } from 'lucide-react';
import { Button } from '@/components/ui/button';
import {
  useActionCards,
  useApproveAction,
  useDismissAction,
  useSuggestActions,
} from '@/hooks/useActions';
import { actionErrorMessage } from '@/lib/actionErrors';
import { t } from '@/i18n';
import { ActionCardView } from './ActionCardView';

/**
 * Suggested actions under a note: the cards proposed from its summary and
 * action items, plus "Suggest actions" to ask again. Renders nothing until
 * the user has a usable action connection or the note already has cards.
 */
export function SuggestedActions({
  summaryFile,
  hasNote,
}: {
  summaryFile: string;
  hasNote: boolean;
}) {
  const cardsQuery = useActionCards(summaryFile);
  const suggest = useSuggestActions(summaryFile);
  const approve = useApproveAction(summaryFile);
  const dismiss = useDismissAction(summaryFile);
  const [suggested, setSuggested] = React.useState(false);
  const [approvingId, setApprovingId] = React.useState<string | null>(null);

  const data = cardsQuery.data;
  const visible = (data?.cards ?? []).filter((c) => c.status !== 'dismissed');
  if (!data || (!data.available && visible.length === 0)) return null;

  const run = () => {
    setSuggested(true);
    suggest.mutate();
  };
  const openCount = visible.filter((c) => c.status === 'proposed' || c.status === 'failed').length;

  return (
    <section
      aria-labelledby={`actions-${summaryFile}`}
      className="flex flex-col gap-3"
      data-testid="suggested-actions"
    >
      <div className="flex items-center gap-3">
        <h2
          id={`actions-${summaryFile}`}
          className="text-[13px] font-semibold tracking-[0.01em]"
          style={{ color: 'var(--fg-2)', fontFamily: 'var(--font-sans)', margin: 0 }}
        >
          {t('actions.heading')}
        </h2>
        {data.available && hasNote && (
          <Button
            variant="ghost"
            size="sm"
            className="ml-auto h-[28px] px-2.5 text-[12.5px]"
            disabled={suggest.isPending}
            onClick={run}
          >
            <Sparkles aria-hidden />
            {suggest.isPending
              ? t('actions.suggesting')
              : openCount > 0
                ? t('actions.suggestAgain')
                : t('actions.suggest')}
          </Button>
        )}
      </div>
      {visible.length === 0 && !suggest.isPending && (
        <p className="text-[13px]" style={{ color: 'var(--fg-2)' }}>
          {suggested && suggest.isSuccess ? t('actions.noneFound') : t('actions.emptyHint')}
        </p>
      )}
      {suggest.isError && (
        <p role="alert" className="text-[13px]" style={{ color: 'var(--fg-2)' }}>
          {actionErrorMessage(suggest.error)}
        </p>
      )}
      <ul className="flex flex-col gap-3">
        {visible.map((card) => (
          <li key={card.id}>
            <ActionCardView
              card={card}
              approving={approvingId === card.id}
              onApprove={async (args, options) => {
                setApprovingId(card.id);
                try {
                  await approve.mutateAsync({ cardId: card.id, args, options });
                } finally {
                  setApprovingId(null);
                }
              }}
              onDismiss={() => dismiss.mutate(card.id)}
            />
          </li>
        ))}
      </ul>
      <p className="text-[12px] leading-relaxed" style={{ color: 'var(--fg-muted)' }}>
        {t('actions.footer')}
      </p>
    </section>
  );
}
