import * as React from 'react';
import { Check, ExternalLink } from 'lucide-react';
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
import { ActionValidationFailure } from '@/hooks/useActions';
import { ipc, type ActionCard, type ActionLocality, type ActionValidationError } from '@/lib/ipc';
import { t } from '@/i18n';

function localityNote(locality: ActionLocality | null): string {
  if (locality === 'device') return t('actions.locality.device');
  if (locality === 'network') return t('actions.locality.network');
  return t('actions.leavesDevice');
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
 * One suggested action: the tool and where it goes, editable arguments, the
 * exact payload that Approve will send, and Approve / Dismiss. Nothing is
 * sent until Approve; the main process validates the arguments again.
 */
export function ActionCardView({
  card,
  onApprove,
  onDismiss,
  approving,
}: {
  card: ActionCard;
  onApprove: (args: Record<string, unknown>) => Promise<unknown>;
  onDismiss: () => void;
  approving: boolean;
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

  const args: Record<string, unknown> | null = rawMode
    ? parseArgumentsJson(rawText)
    : fields
      ? fromFormState(fields, formState, card.arguments)
      : null;
  const payload = args ? JSON.stringify({ tool: card.tool, arguments: args }, null, 2) : '';
  const finished = card.status === 'done';
  const running = card.status === 'running' || approving;

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
  return (
    <article
      aria-label={t('actions.card.aria', { tool: title, connection: card.connectionName })}
      className="rounded-xl border p-4"
      style={{ borderColor: 'var(--border-subtle)', background: 'var(--surface-raised)' }}
    >
      <header className="flex items-start gap-3">
        <div className="min-w-0 flex-1">
          <h4 className="text-[14px] font-medium">{title}</h4>
          <p className="mt-0.5 text-[12px]" style={{ color: 'var(--fg-muted)' }}>
            {t('actions.card.via', { connection: card.connectionName, tool: card.tool })}
          </p>
        </div>
        {finished && (
          <span
            className="inline-flex items-center gap-1 text-[12.5px]"
            style={{ color: 'var(--fg-2)' }}
          >
            <Check aria-hidden className="size-3.5" />
            {t('actions.card.done')}
          </span>
        )}
      </header>
      {card.actionItem && (
        <p className="mt-2 text-[12.5px] leading-relaxed" style={{ color: 'var(--fg-muted)' }}>
          {t('actions.card.from', { item: card.actionItem })}
        </p>
      )}
      {card.reason && (
        <p className="mt-1 text-[13px] leading-relaxed" style={{ color: 'var(--fg-2)' }}>
          {card.reason}
        </p>
      )}

      {finished ? (
        <div
          className="mt-3 flex flex-wrap items-center gap-3 text-[12.5px]"
          style={{ color: 'var(--fg-2)' }}
        >
          {card.result?.link ? (
            <Button
              variant="outline"
              size="sm"
              className="h-[28px] px-3 text-[12.5px]"
              onClick={() => void ipc().shell.openExternal(card.result!.link!)}
            >
              <ExternalLink aria-hidden />
              {t('actions.card.open')}
            </Button>
          ) : (
            <span>{t('actions.card.sent')}</span>
          )}
        </div>
      ) : (
        <>
          <div className="mt-3 flex flex-col gap-2.5">
            {!rawMode && fields ? (
              fields.map((f) => {
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
              })
            ) : (
              <label className="block">
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
            )}
            {rawMode &&
              errors.map((e) => (
                <p
                  key={`${e.path}-${e.message}`}
                  className="text-[12px]"
                  style={{ color: 'var(--fg-1)' }}
                >
                  {t('actions.card.fieldError', {
                    field: e.path.replace(/^\$\.?/, ''),
                    message: e.message,
                  })}
                </p>
              ))}
          </div>

          <details className="mt-3">
            <summary className="cursor-pointer text-[12.5px]" style={{ color: 'var(--fg-2)' }}>
              {t('actions.card.preview')}
            </summary>
            <pre
              data-testid="action-payload"
              className="mt-2 max-h-[220px] overflow-auto whitespace-pre-wrap break-all rounded-lg p-3 font-mono text-[11.5px] leading-relaxed"
              style={{ background: 'var(--surface-sunken)', color: 'var(--fg-1)' }}
            >
              {payload || t('actions.card.invalidJson')}
            </pre>
            <p className="mt-1 text-[12px]" style={{ color: 'var(--fg-muted)' }}>
              {t('actions.card.previewHint', { origin: card.origin ?? card.connectionName })}
            </p>
          </details>

          <p className="mt-2 text-[12px] leading-relaxed" style={{ color: 'var(--fg-muted)' }}>
            {localityNote(card.locality)}
          </p>
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
          <div role="status" className="mt-1 text-[12.5px]" style={{ color: 'var(--fg-2)' }}>
            {message}
          </div>
        </>
      )}
    </article>
  );
}
