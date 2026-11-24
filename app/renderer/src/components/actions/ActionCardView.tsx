import * as React from 'react';
import { Check, ExternalLink, Mail, SquareTerminal } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Switch } from '@/components/ui/switch';
import {
  formFields,
  fromFormState,
  parseArgumentsJson,
  toFormState,
  type FormField,
  type FormState,
} from '@/lib/actionForm';
import { actionErrorMessage } from '@/lib/actionErrors';
import { actionPhrase, headlineValue, inlineFieldKeys } from '@/lib/actionCopy';
import { fillTemplate } from '@/lib/actionTemplate';
import { ActionValidationFailure } from '@/hooks/useActions';
import { ipc, type ActionCard, type ActionLocality, type ActionValidationError } from '@/lib/ipc';
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

/**
 * One suggested action, written as a sentence ("Create page in Notion ·
 * Website content cleanup") with the two or three fields that matter
 * editable inline. The exact payload, and a raw JSON editor for everything
 * else, sit under "Show what will be sent". Nothing is sent until Approve;
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
  onApprove: (args: Record<string, unknown>) => Promise<unknown>;
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
  const formPossible = React.useMemo(
    () => formFields(card.inputSchema, {}) !== null,
    [card.inputSchema]
  );
  const [rawMode, setRawMode] = React.useState(fields === null);
  const [formState, setFormState] = React.useState<FormState>(() =>
    fields ? toFormState(fields, card.arguments) : {}
  );
  const [rawText, setRawText] = React.useState(() => JSON.stringify(card.arguments, null, 2));
  const [errors, setErrors] = React.useState<ActionValidationError[]>(card.validationErrors ?? []);
  const [message, setMessage] = React.useState('');
  const [showPayload, setShowPayload] = React.useState(fields === null);

  const args: Record<string, unknown> | null = rawMode
    ? parseArgumentsJson(rawText)
    : fields
      ? fromFormState(fields, formState, card.arguments)
      : null;
  // A simple action shows the vendor call its fields translate to: what Approve sends.
  const simple = card.sendTemplate !== undefined && card.sendTemplate !== null;
  const payload = args
    ? JSON.stringify(
        { tool: card.tool, arguments: simple ? fillTemplate(card.sendTemplate, args) : args },
        null,
        2
      )
    : '';
  const finished = card.status === 'done';
  const running = card.status === 'running' || approving;

  const inlineKeys = React.useMemo(
    // A simple action has only a few flat fields: show them all.
    () => (fields ? inlineFieldKeys(fields, card.arguments, simple ? 4 : 3) : []),
    [fields, card.arguments, simple]
  );
  // Email drafts read "Draft email · Subject": the mail app is not a place to put it "in".
  const isEmail = card.connectionKind === 'email';
  const inlineFields = fields ? fields.filter((f) => inlineKeys.includes(f.key)) : [];
  // A draft reads top to bottom like an email: To, Subject, Message.
  if (isEmail) inlineFields.sort((a, b) => inlineKeys.indexOf(a.key) - inlineKeys.indexOf(b.key));
  // Errors on fields that are not shown inline are listed in the disclosure.
  const hiddenErrors = errors.filter(
    (e) =>
      rawMode ||
      !inlineFields.some((f) => e.path === `$.${f.key}` || e.path.startsWith(`$.${f.key}[`))
  );
  // A problem in a field that is not shown inline keeps the disclosure open.
  const payloadOpen = showPayload || hiddenErrors.length > 0;

  const switchMode = () => {
    if (rawMode) {
      const parsed = parseArgumentsJson(rawText);
      const f = parsed ? formFields(card.inputSchema, parsed) : null;
      if (!parsed || !f) {
        setMessage(t('actions.card.cannotUseForm'));
        return;
      }
      setFormState(toFormState(f, parsed));
      setRawMode(false);
    } else {
      setRawText(JSON.stringify(args ?? card.arguments, null, 2));
      setRawMode(true);
    }
    setMessage('');
  };

  const approve = async () => {
    if (!args) {
      setMessage(t('actions.card.invalidJson'));
      return;
    }
    setMessage('');
    try {
      await onApprove(args);
      setErrors([]);
    } catch (e) {
      if (e instanceof ActionValidationFailure) setErrors(e.validationErrors);
      setMessage(actionErrorMessage(e));
    }
  };

  const title = card.toolTitle || card.tool;
  const phrase = actionPhrase(card.tool, card.toolTitle, card.connectionName);
  const subject = headlineValue(args ?? card.arguments);
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
          {!rawMode && inlineFields.length > 0 && (
            <div className="mt-3 flex flex-col gap-2.5">
              {inlineFields.map((f) => {
                const id = `${idBase}-${f.key}`;
                const fieldErrors = errors.filter(
                  (e) => e.path === `$.${f.key}` || e.path.startsWith(`$.${f.key}[`)
                );
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

          <details
            className="mt-3"
            open={payloadOpen}
            onToggle={(e) => setShowPayload((e.currentTarget as HTMLDetailsElement).open)}
          >
            <summary className="cursor-pointer text-[12.5px]" style={{ color: 'var(--fg-2)' }}>
              {t('actions.card.preview')}
            </summary>
            {rawMode ? (
              <label className="mt-2 block">
                <span className="mb-1 block text-[12.5px]" style={{ color: 'var(--fg-2)' }}>
                  {t('actions.card.argumentsJson')}
                </span>
                <textarea
                  className="min-h-[120px] w-full rounded-md border border-border bg-transparent px-3 py-2 font-mono text-[12px] leading-relaxed focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                  spellCheck={false}
                  value={rawText}
                  onChange={(e) => setRawText(e.currentTarget.value)}
                />
              </label>
            ) : (
              <pre
                data-testid="action-payload"
                className="mt-2 max-h-[220px] overflow-auto whitespace-pre-wrap break-all rounded-lg p-3 font-mono text-[11.5px] leading-relaxed"
                style={{ background: 'var(--surface-sunken)', color: 'var(--fg-1)' }}
              >
                {payload || t('actions.card.invalidJson')}
              </pre>
            )}
            {hiddenErrors.map((e) => (
              <p
                key={`${e.path}-${e.message}`}
                className="mt-1 text-[12px]"
                style={{ color: 'var(--fg-1)' }}
              >
                {t('actions.card.fieldError', {
                  field: e.path.replace(/^\$\.?/, ''),
                  message: e.message,
                })}
              </p>
            ))}
            <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1">
              <p className="text-[12px]" style={{ color: 'var(--fg-muted)' }}>
                {t('actions.card.previewHint', { origin: card.origin ?? card.connectionName })}
              </p>
              {formPossible && (
                <button
                  type="button"
                  className="ml-auto text-[12px] underline underline-offset-2"
                  style={{ color: 'var(--fg-muted)' }}
                  onClick={switchMode}
                >
                  {rawMode ? t('actions.card.editAsForm') : t('actions.card.editAsJson')}
                </button>
              )}
            </div>
          </details>

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
              {running
                ? t('actions.card.sending')
                : card.status === 'failed'
                  ? t('actions.card.retry')
                  : t('actions.card.approve')}
            </Button>
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
