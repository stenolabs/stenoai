import * as React from 'react';
import { Check, ExternalLink, FileText, Info, Search } from 'lucide-react';
import { shortModelName } from '@/lib/chat';
import { navigate } from '@/lib/router';
import { ActionCardView } from '@/components/actions/ActionCardView';
import { ActionValidationFailure } from '@/hooks/useActions';
import { actionPhrase, headlineValue } from '@/lib/actionCopy';
import { ipc, type ActionCard, type ChatActionRecord, type ChatToolStep } from '@/lib/ipc';
import { ResultError } from '@/lib/result';
import { t } from '@/i18n';

/** "Searched Linear", "Searched your notes", "Read a note". */
export function stepLabel(step: ChatToolStep): string {
  if (step.source === 'context') {
    if (step.tool === 'notes') {
      const count = step.count ?? 0;
      if (count === 0) return t('chat.trace.noNotes');
      return count === 1 ? t('chat.trace.readNotes.one', { count }) : t('chat.trace.readNotes.other', { count });
    }
    if (step.tool === 'meeting') return step.title ? t('chat.trace.readMeeting', { title: step.title }) : t('chat.trace.readThisMeeting');
    if (step.tool === 'live') return t('chat.trace.readLive');
    return '';
  }
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

/** "Gemma 4 E2B can't use your connected apps…" with a way to switch model. */
function NoticeLine({ step }: { step: ChatToolStep }) {
  const model = step.title ? shortModelName(step.title) : t('chat.trace.thisModel');
  return (
    <p
      className="flex flex-wrap items-center gap-x-2 gap-y-1 rounded-lg px-3 py-2 text-[12.5px]"
      style={{ background: 'var(--surface-sunken)', color: 'var(--fg-2)' }}
      data-testid="chat-tools-notice"
    >
      <Info aria-hidden className="size-3.5 shrink-0" />
      <span>{t('chat.trace.toolsUnavailable', { model, apps: step.connection })}</span>
      <button
        type="button"
        className="font-medium underline underline-offset-2 hover:text-[color:var(--fg-1)]"
        onClick={() => navigate('/settings?tab=ai')}
      >
        {t('chat.trace.openAiSettings')}
      </button>
    </p>
  );
}

function StepLine({ step }: { step: ChatToolStep }) {
  if (step.source === 'notice') return <NoticeLine step={step} />;
  const label = stepLabel(step);
  if (!label) return null;
  const Icon = step.source === 'context' ? FileText : Search;
  // A read on a custom URL or local command says what it asked for: the
  // server's read-only hint is its own word, so the user can see what ran.
  const detail =
    step.source === 'connection' && typeof step.detail === 'string'
      ? t('chat.agent.stepDetail', { tool: step.title ?? step.tool, args: step.detail })
      : null;
  return (
    <p className="flex items-center gap-1.5 text-[12.5px]" style={{ color: 'var(--fg-muted)' }} data-testid="chat-tool-step">
      <Icon aria-hidden className="size-3 shrink-0" />
      <span className="shrink-0">{label}</span>
      {detail !== null && (
        <span className="min-w-0 truncate font-mono text-[11.5px]" title={detail} data-testid="chat-tool-step-detail">
          {detail}
        </span>
      )}
    </p>
  );
}

/**
 * The live "Thinking · 4s" line shown until the answer's first words arrive,
 * under whatever the turn has read so far, like Claude's thinking trace.
 */
export function ThinkingLine() {
  const [started] = React.useState(() => Date.now());
  const [now, setNow] = React.useState(started);
  React.useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, []);
  const seconds = Math.floor((now - started) / 1000);
  return (
    <p
      className="flex items-center gap-1.5 py-1 text-[13px]"
      style={{ color: 'var(--fg-muted)' }}
      data-testid="chat-thinking"
      role="status"
    >
      <span>{seconds > 0 ? t('chat.trace.thinkingFor', { seconds }) : t('askBar.thinking')}</span>
      <span className="thinking-dot" />
      <span className="thinking-dot" />
      <span className="thinking-dot" />
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
  pending = false,
}: {
  queryId: string;
  steps?: ChatToolStep[];
  cards?: ActionCard[];
  /** No answer text yet: show the live thinking line under the steps. */
  pending?: boolean;
}) {
  const [busy, setBusy] = React.useState<string | null>(null);
  const waitingOnCard = cards?.some((c) => c.status !== 'done' && c.status !== 'dismissed');
  if (!steps?.length && !cards?.length && !pending) return null;
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
      {pending && !waitingOnCard && <ThinkingLine />}
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
