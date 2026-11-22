import * as React from 'react';
import { Check, ExternalLink, Search } from 'lucide-react';
import { ActionCardView } from '@/components/actions/ActionCardView';
import { ActionValidationFailure } from '@/hooks/useActions';
import { actionPhrase, headlineValue } from '@/lib/actionCopy';
import { ipc, type ActionCard, type ChatActionRecord, type ChatToolStep } from '@/lib/ipc';
import { ResultError } from '@/lib/result';
import { t } from '@/i18n';

/** "Searched Linear", "Searched your notes", "Read a note". */
export function stepLabel(step: ChatToolStep): string {
  if (step.source === 'steno') {
    return step.tool === 'get_note' ? t('chat.agent.readNote') : t('chat.agent.searchedNotes');
  }
  return /search|find|list|query|lookup/i.test(step.tool)
    ? t('chat.agent.searched', { connection: step.connection })
    : t('chat.agent.checked', { connection: step.connection });
}

/** "Create page in Notion · Website content cleanup", as kept in the chat history. */
export function actionSentence(card: ActionCard): string {
  const phrase = t('actions.card.sentence', {
    action: actionPhrase(card.tool, card.toolTitle, card.connectionName),
    connection: card.connectionName,
  });
  const subject = headlineValue(card.arguments);
  return subject ? phrase + t('actions.card.subject', { subject }) : phrase;
}

export function actionRecords(cards: ActionCard[] | undefined): ChatActionRecord[] | undefined {
  if (!cards?.length) return undefined;
  return cards.map((c) => ({ id: c.id, sentence: actionSentence(c), status: c.status, link: c.result?.link ?? null }));
}

function StepLine({ step }: { step: ChatToolStep }) {
  return (
    <p className="flex items-center gap-1.5 text-[12.5px]" style={{ color: 'var(--fg-muted)' }} data-testid="chat-tool-step">
      <Search aria-hidden className="size-3" />
      {stepLabel(step)}
    </p>
  );
}

/**
 * A chat-agent turn in progress: the read steps it took and the action cards
 * it is waiting on. Approve and Dismiss go to main's chat-action-* handlers,
 * which use the same approval path as a note's cards.
 */
export function LiveAgentTrail({
  queryId,
  steps,
  cards,
}: {
  queryId: string;
  steps?: ChatToolStep[];
  cards?: ActionCard[];
}) {
  const [busy, setBusy] = React.useState<string | null>(null);
  if (!steps?.length && !cards?.length) return null;
  const approve = async (card: ActionCard, args: Record<string, unknown>) => {
    setBusy(card.id);
    try {
      const res = await ipc().query.approveAction(queryId, card.id, args);
      if (!res.success) {
        if ('validationErrors' in res && res.validationErrors) {
          throw new ActionValidationFailure(res.error, res.validationErrors);
        }
        throw new ResultError(res.error, res.error_code);
      }
    } finally {
      setBusy(null);
    }
  };
  return (
    <div className="mb-2 flex flex-col gap-2" data-testid="chat-agent-trail">
      {steps?.map((s) => <StepLine key={s.id} step={s} />)}
      {cards?.map((card) =>
        card.status === 'dismissed' ? (
          <p key={card.id} className="text-[12.5px]" style={{ color: 'var(--fg-muted)' }}>
            {t('chat.agent.dismissed', { action: actionSentence(card) })}
          </p>
        ) : (
          <ActionCardView
            key={card.id}
            card={card}
            compact
            approving={busy === card.id}
            onApprove={(args) => approve(card, args)}
            onDismiss={() => void ipc().query.dismissAction(queryId, card.id)}
          />
        )
      )}
    </div>
  );
}

/** What a finished chat-agent turn keeps: its steps and each action's outcome. */
export function AgentRecord({ steps, actions }: { steps?: ChatToolStep[]; actions?: ChatActionRecord[] }) {
  if (!steps?.length && !actions?.length) return null;
  return (
    <div className="mb-2 flex flex-col gap-1">
      {steps?.map((s) => <StepLine key={s.id} step={s} />)}
      {actions?.map((a) => (
        <p key={a.id} className="flex flex-wrap items-center gap-1.5 text-[12.5px]" style={{ color: 'var(--fg-2)' }}>
          {a.status === 'done' && <Check aria-hidden className="size-3" />}
          <span>
            {a.status === 'done'
              ? a.sentence
              : a.status === 'dismissed'
                ? t('chat.agent.dismissed', { action: a.sentence })
                : t('chat.agent.notDone', { action: a.sentence })}
          </span>
          {a.status === 'done' && a.link && (
            <button
              type="button"
              className="inline-flex items-center gap-1 underline underline-offset-2"
              onClick={() => void ipc().shell.openExternal(a.link!)}
            >
              <ExternalLink aria-hidden className="size-3" />
              {t('actions.card.open')}
            </button>
          )}
        </p>
      ))}
    </div>
  );
}
