import * as React from 'react';
import { Check, ExternalLink, Mail, SquareTerminal } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Switch } from '@/components/ui/switch';
import { formFields, fromFormState, toFormState, type FormField, type FormState } from '@/lib/actionForm';
import { actionErrorMessage } from '@/lib/actionErrors';
import { actionPhrase, headlineValue, inlineFieldKeys } from '@/lib/actionCopy';
import { ActionValidationFailure } from '@/hooks/useActions';
import {
  ipc,
  type ActionCard,
  type ActionLocality,
  type ActionValidationError,
  type ApproveActionOptions,
} from '@/lib/ipc';
import { BrandGlyph, IconGlyph } from '@/routes/connect/ConnectGlyph';
import { brandForOrigin } from '@/routes/connect/brandLogos';
import { t } from '@/i18n';

/** One short line on where Approve sends this. */
function localityNote(
  locality: ActionLocality | null,
  connection: string,
  kind: ActionCard['connectionKind']
): string {
  if (kind === 'email') return t('actions.card.sendsTo.email');
  if (locality === 'device') return t('actions.card.sendsTo.device', { connection });
  if (locality === 'network') return t('actions.card.sendsTo.network', { connection });
  return t('actions.card.sendsTo.internet', { connection });
}

const SUMMARY_MAX_LINES = 8;
const SUMMARY_MAX_VALUE = 120;

function summaryValue(value: unknown): string {
  let text: string;
  if (value === null || value === undefined) text = '';
  else if (Array.isArray(value)) {
    text = value.every((v) => typeof v !== 'object' || v === null)
      ? value.map((v) => String(v)).join(', ')
      : t('actions.card.summaryItems', { count: value.length });
  } else if (typeof value === 'object') text = t('actions.card.summaryFields', { count: Object.keys(value).length });
  else text = String(value);
  text = text.replace(/\s+/g, ' ').trim();
  return text.length > SUMMARY_MAX_VALUE ? `${text.slice(0, SUMMARY_MAX_VALUE - 1)}…` : text;
}

/**
 * A readable, read-only view of arguments the form cannot edit (a nested or
 * undescribed schema): "key: value" lines, nested one level, truncated.
 */
export function summaryLines(args: Record<string, unknown>): { key: string; value: string }[] {
  const lines: { key: string; value: string }[] = [];
  for (const [key, value] of Object.entries(args)) {
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      for (const [sub, v] of Object.entries(value as Record<string, unknown>)) {
        lines.push({ key: `${key} › ${sub}`, value: summaryValue(v) });
      }
      continue;
    }
    lines.push({ key, value: summaryValue(value) });
  }
  return lines;
}

function FieldInput({
  field,
  value,
  onChange,
  id,
}: {
  field: FormField;
  value: string | boolean;
  onChange: (v: string | boolean) => void;
  id: string;
}) {
  if (field.kind === 'boolean') {
    return <Switch id={id} checked={value === true} onCheckedChange={(v) => onChange(v)} />;
  }
  if (field.kind === 'enum') {
    return (
      <select
        id={id}
        className="h-8 w-full rounded-md border border-border bg-transparent px-2 text-[13px]"
        value={typeof value === 'string' ? value : ''}
        onChange={(e) => onChange(e.currentTarget.value)}
      >
        {!field.required && <option value="">{t('actions.card.none')}</option>}
        {field.options.map((o) => (
          <option key={o} value={o}>
            {o}
          </option>
        ))}
      </select>
    );
  }
  if (field.kind === 'text' || field.kind === 'stringList') {
    return (
      <textarea
        id={id}
        className="min-h-[64px] w-full rounded-md border border-border bg-transparent px-3 py-2 text-[13px] leading-relaxed focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        value={typeof value === 'string' ? value : ''}
        onChange={(e) => onChange(e.currentTarget.value)}
      />
    );
  }
  return (
    <Input
      id={id}
      size="sm"
      inputMode={field.kind === 'number' || field.kind === 'integer' ? 'decimal' : undefined}
      value={typeof value === 'string' ? value : ''}
      onChange={(e) => onChange(e.currentTarget.value)}
    />
  );
}

const fieldMatches = (f: FormField, e: ActionValidationError) =>
  e.path === `$.${f.key}` || e.path.startsWith(`$.${f.key}[`) || e.path.startsWith(`$.${f.key}.`);

/**
 * One suggested action, written as a sentence ("Create page in Notion ·
 * Website content cleanup") with the two or three fields that matter
 * editable inline; a field with a problem is shown too. Arguments the form
 * cannot edit are summarised read-only. Nothing is sent until Approve (or
 * "Always allow for <app>", which approves and trusts the app from then on);
 * the main process validates the arguments again.
 */
export function ActionCardView({
  card,
  onApprove,
  onDismiss,
  approving,
  compact = false,
}: {
  card: ActionCard;
  onApprove: (args: Record<string, unknown>, options?: ApproveActionOptions) => Promise<unknown>;
  onDismiss: () => void;
  approving: boolean;
  /** Tighter spacing for the chat thread. */
  compact?: boolean;
}) {
  const idBase = React.useId();
  const fields = React.useMemo(
    () => formFields(card.inputSchema, card.arguments),
    [card.inputSchema, card.arguments]
  );
  const [formState, setFormState] = React.useState<FormState>(() =>
    fields ? toFormState(fields, card.arguments) : {}
  );
  const [errors, setErrors] = React.useState<ActionValidationError[]>(card.validationErrors ?? []);
  const [message, setMessage] = React.useState('');
  const [alwaysAllowing, setAlwaysAllowing] = React.useState(false);

  // No form for this schema: the arguments go exactly as proposed.
  const args: Record<string, unknown> = fields
    ? fromFormState(fields, formState, card.arguments)
    : card.arguments;
  // A simple action has only a few flat fields: show them all.
  const simple = card.sendTemplate !== undefined && card.sendTemplate !== null;
  const finished = card.status === 'done';
  const running = card.status === 'running' || approving;

  const inlineKeys = React.useMemo(() => {
    if (!fields) return [];
    const keys = inlineFieldKeys(fields, card.arguments, simple ? 4 : 3);
    // A field with a problem is shown so it can be fixed.
    for (const f of fields) {
      if (!keys.includes(f.key) && errors.some((e) => fieldMatches(f, e))) keys.push(f.key);
    }
    return keys;
  }, [fields, card.arguments, simple, errors]);
  // Email drafts read "Draft email · Subject": the mail app is not a place to put it "in".
  const isEmail = card.connectionKind === 'email';
  const inlineFields = fields ? fields.filter((f) => inlineKeys.includes(f.key)) : [];
  // A draft reads top to bottom like an email: To, Subject, Message.
  if (isEmail) inlineFields.sort((a, b) => inlineKeys.indexOf(a.key) - inlineKeys.indexOf(b.key));
  // Problems on nothing shown above are listed on their own.
  const otherErrors = errors.filter((e) => !inlineFields.some((f) => fieldMatches(f, e)));
  const summary = fields ? [] : summaryLines(card.arguments);

  const approve = async (options?: ApproveActionOptions) => {
    setMessage('');
    if (options?.alwaysAllow) setAlwaysAllowing(true);
    try {
      await onApprove(args, options);
      setErrors([]);
    } catch (e) {
      if (e instanceof ActionValidationFailure) setErrors(e.validationErrors);
      setMessage(actionErrorMessage(e));
    } finally {
      setAlwaysAllowing(false);
    }
  };

  const title = card.toolTitle || card.tool;
  const phrase = actionPhrase(card.tool, card.toolTitle, card.connectionName);
  const subject = headlineValue(args);
  return (
    <article
      aria-label={t('actions.card.aria', { tool: title, connection: card.connectionName })}
      data-testid="action-card"
      className={compact ? 'rounded-xl border p-3' : 'rounded-xl border p-4'}
      style={{ borderColor: 'var(--border-subtle)', background: 'var(--surface-raised)' }}
    >
      <header className={finished ? 'flex items-center gap-3' : 'flex items-start gap-3'}>
        <AppMark origin={card.origin} name={card.connectionName} kind={card.connectionKind} />
        <h4 className="min-w-0 flex-1 text-[14px] leading-snug">
          <span className="font-medium">
            {isEmail
              ? phrase
              : t('actions.card.sentence', { action: phrase, connection: card.connectionName })}
          </span>
          {subject && (
            <span style={{ color: 'var(--fg-2)' }}>{t('actions.card.subject', { subject })}</span>
          )}
        </h4>
        {finished && (
          <span
            className="inline-flex shrink-0 items-center gap-2 text-[12.5px]"
            style={{ color: 'var(--fg-2)' }}
          >
            <Check aria-hidden className="size-3.5" />
            {isEmail
              ? card.result?.clipboard
                ? t('actions.card.draftOpenedClipboard')
                : t('actions.card.draftOpened')
              : t('actions.card.done')}
            {card.result?.link && (
              <button
                type="button"
                className="inline-flex items-center gap-1 underline underline-offset-2 hover:text-[color:var(--fg-1)]"
                onClick={() => void ipc().shell.openExternal(card.result!.link!)}
              >
                <ExternalLink aria-hidden className="size-3" />
                {t('actions.card.open')}
              </button>
            )}
          </span>
        )}
      </header>
      {/* A finished action is one line; where it came from only matters before approving. */}
      {!finished && card.actionItem && (
        <p className="mt-1 text-[12.5px] leading-relaxed" style={{ color: 'var(--fg-muted)' }}>
          {t('actions.card.from', { item: card.actionItem })}
        </p>
      )}
      {!finished && card.reason && (
        <p className="mt-1 text-[13px] leading-relaxed" style={{ color: 'var(--fg-2)' }}>
          {card.reason}
        </p>
      )}

      {finished ? null : (
        <>
          {inlineFields.length > 0 && (
            <div className="mt-3 flex flex-col gap-2.5">
              {inlineFields.map((f) => {
                const id = `${idBase}-${f.key}`;
                const fieldErrors = errors.filter((e) => fieldMatches(f, e));
                return (
                  <div
                    key={f.key}
                    className={
                      f.kind === 'boolean' ? 'flex items-center justify-between gap-3' : ''
                    }
                  >
                    <label
                      htmlFor={id}
                      className="mb-1 block text-[12.5px]"
                      style={{ color: 'var(--fg-2)' }}
                    >
                      {f.required ? t('actions.card.requiredLabel', { label: f.label }) : f.label}
                    </label>
                    <FieldInput
                      id={id}
                      field={f}
                      value={formState[f.key] ?? ''}
                      onChange={(v) => setFormState((s) => ({ ...s, [f.key]: v }))}
                    />
                    {fieldErrors.map((e) => (
                      <p
                        key={e.message}
                        className="mt-1 text-[12px]"
                        style={{ color: 'var(--fg-1)' }}
                      >
                        {t('actions.card.fieldError', { field: f.label, message: e.message })}
                      </p>
                    ))}
                  </div>
                );
              })}
            </div>
          )}

          {summary.length > 0 && (
            <dl
              data-testid="action-summary"
              className="mt-3 flex flex-col gap-1 text-[12.5px] leading-relaxed"
              style={{ color: 'var(--fg-2)' }}
            >
              {summary.slice(0, SUMMARY_MAX_LINES).map((line) => (
                <div key={line.key} className="flex min-w-0 gap-1.5">
                  <dt className="shrink-0" style={{ color: 'var(--fg-muted)' }}>
                    {t('actions.card.summaryKey', { key: line.key })}
                  </dt>
                  <dd className="min-w-0 truncate" style={{ color: 'var(--fg-1)' }}>
                    {line.value}
                  </dd>
                </div>
              ))}
              {summary.length > SUMMARY_MAX_LINES && (
                <div style={{ color: 'var(--fg-muted)' }}>
                  {t('actions.card.summaryMore', { count: summary.length - SUMMARY_MAX_LINES })}
                </div>
              )}
            </dl>
          )}

          {otherErrors.map((e) => (
            <p
              key={`${e.path}-${e.message}`}
              className="mt-2 text-[12px]"
              style={{ color: 'var(--fg-1)' }}
            >
              {t('actions.card.fieldError', {
                field: e.path.replace(/^\$\.?/, ''),
                message: e.message,
              })}
            </p>
          ))}

          {card.status === 'failed' && (
            <div role="alert" className="mt-2 text-[12.5px]" style={{ color: 'var(--fg-1)' }}>
              <p>
                {card.result?.status === 'needs-auth'
                  ? t('actions.error.needsAuth')
                  : t('actions.card.failed')}
              </p>
              {card.result?.detail && (
                <details className="mt-1">
                  <summary className="cursor-pointer" style={{ color: 'var(--fg-2)' }}>
                    {t('actions.card.details')}
                  </summary>
                  <p
                    className="mt-1 break-words rounded-md p-2 font-mono text-[11.5px] leading-relaxed"
                    style={{ background: 'var(--surface-sunken)', color: 'var(--fg-2)' }}
                  >
                    {card.result.detail}
                  </p>
                </details>
              )}
            </div>
          )}
          {!card.connectionAvailable && (
            <p className="mt-2 text-[12.5px]" style={{ color: 'var(--fg-2)' }}>
              {t('actions.error.connectionUnavailable')}
            </p>
          )}

          <div className="mt-3 flex flex-wrap items-center gap-2">
            <Button
              size="sm"
              className="h-[30px] px-3 text-[13px]"
              disabled={running || !card.connectionAvailable}
              onClick={() => void approve()}
            >
              {running && !alwaysAllowing
                ? t('actions.card.sending')
                : card.status === 'failed'
                  ? t('actions.card.retry')
                  : t('actions.card.approve')}
            </Button>
            {card.autoApproveOffered && card.status !== 'failed' && (
              <Button
                variant="outline"
                size="sm"
                className="h-[30px] px-3 text-[13px]"
                disabled={running || !card.connectionAvailable}
                onClick={() => void approve({ alwaysAllow: true })}
              >
                {alwaysAllowing
                  ? t('actions.card.sending')
                  : t('actions.card.alwaysAllow', { connection: card.connectionName })}
              </Button>
            )}
            <Button
              variant="ghost"
              size="sm"
              className="h-[30px] px-3 text-[13px]"
              disabled={running}
              onClick={onDismiss}
            >
              {t('actions.card.dismiss')}
            </Button>
            <span className="ml-auto text-[12px]" style={{ color: 'var(--fg-muted)' }}>
              {localityNote(card.locality, card.connectionName, card.connectionKind)}
            </span>
          </div>
          <div role="status" className="mt-1 text-[12.5px]" style={{ color: 'var(--fg-2)' }}>
            {message}
          </div>
        </>
      )}
    </article>
  );
}

/** The app an action goes to, as its logo (or initials for a custom server). */
function AppMark({
  origin,
  name,
  kind,
}: {
  origin: string | null | undefined;
  name: string;
  kind?: ActionCard['connectionKind'];
}) {
  if (kind === 'email') return <IconGlyph icon={Mail} size={28} />;
  if (kind === 'local') return <IconGlyph icon={SquareTerminal} size={28} />;
  const brand = brandForOrigin(origin);
  if (brand) return <BrandGlyph brand={brand} size={28} />;
  const initials = name
    .trim()
    .split(/\s+/)
    .slice(0, 2)
    .map((w) => w[0]?.toUpperCase() ?? '')
    .join('');
  return (
    <span
      aria-hidden
      className="flex size-7 shrink-0 items-center justify-center rounded-lg border text-[11px] font-medium"
      style={{ background: 'var(--surface-raised)', borderColor: 'var(--border-subtle)' }}
    >
      {initials || '•'}
    </span>
  );
}
