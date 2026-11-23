import { t } from '@/i18n';
import * as React from 'react';
import ReactMarkdown from 'react-markdown';
import { useUpdateReportBody } from '@/hooks/useMeetings';
import { createSaveQueue, type SaveQueue } from '@/lib/saveQueue';
import { validateReportBody } from '@/lib/noteDraft';
import { IDLE_SAVE_STATE, type InlineEditorHandle, type InlineSaveState } from './InlineNote';

/** Unsaved report bodies that outlived their editor; see InlineNote's draftCache. */
const reportDraftCache = new Map<string, string>();

const errorText = (error: unknown) =>
  (error instanceof Error ? error.message : String(error ?? '')).trim() || t('noteEditor.saveError');

interface InlineReportProps {
  summaryFile: string;
  cacheKey: string;
  reportId: string;
  /** The frontmatter block shown as properties, sent back unchanged ('' for none). */
  frontmatter: string;
  /** The report body as the view shows it (reasoning stripped, properties split off). */
  body: string;
  handleRef: React.Ref<InlineEditorHandle>;
  onStateChange: (state: InlineSaveState) => void;
}

/**
 * A template report, editable as one freeform Markdown block: rendered as
 * Markdown until it is clicked (or focused and Enter pressed), then the same
 * text as an auto-growing textarea. Autosaves through update-report, which
 * rewrites only this report's body and keeps its frontmatter byte for byte.
 */
export function InlineReport({
  summaryFile,
  cacheKey,
  reportId,
  frontmatter,
  body,
  handleRef,
  onStateChange,
}: InlineReportProps) {
  const draftKey = `${cacheKey}#${reportId}`;
  const { mutateAsync } = useUpdateReportBody();
  const [initial] = React.useState(() => reportDraftCache.get(draftKey));
  const [text, setTextState] = React.useState(initial ?? body);
  const textRef = React.useRef(initial ?? body);
  const baselineRef = React.useRef(body.trim());
  const savedEditsRef = React.useRef(false);
  const [problem, setProblem] = React.useState<string | null>(null);
  const problemRef = React.useRef<string | null>(null);
  const [editing, setEditing] = React.useState(false);
  const stateRef = React.useRef<InlineSaveState>(IDLE_SAVE_STATE);
  const textareaRef = React.useRef<HTMLTextAreaElement | null>(null);

  const report = React.useCallback(
    (patch: Partial<InlineSaveState>) => {
      stateRef.current = { ...stateRef.current, ...patch };
      onStateChange(stateRef.current);
    },
    [onStateChange]
  );

  const queueRef = React.useRef<SaveQueue<string> | null>(null);
  if (!queueRef.current) {
    queueRef.current = createSaveQueue<string>({
      save: async (next) => {
        if (next.trim() === baselineRef.current) return;
        await mutateAsync({ summaryFile, cacheKey, reportId, frontmatter, body: next });
        baselineRef.current = next.trim();
        savedEditsRef.current = true;
        if (textRef.current.trim() === baselineRef.current) reportDraftCache.delete(draftKey);
      },
      onStatus: (status, error) =>
        report({ status, error: status === 'error' ? errorText(error) : null }),
    });
  }
  const queue = queueRef.current;
  const isDirty = () => textRef.current.trim() !== baselineRef.current;

  const applyText = React.useCallback(
    (next: string) => {
      textRef.current = next;
      setTextState(next);
      const found = validateReportBody(next, frontmatter, body);
      problemRef.current = found;
      setProblem(found);
      if (next.trim() === baselineRef.current) reportDraftCache.delete(draftKey);
      else reportDraftCache.set(draftKey, next);
      if (found) {
        queue.cancel();
        report({ invalid: true });
        return;
      }
      report({ invalid: false });
      queue.schedule(next);
    },
    [frontmatter, body, draftKey, queue, report]
  );

  const flush = React.useCallback(async () => {
    if (problemRef.current) return false;
    if (isDirty()) queue.schedule(textRef.current);
    return queue.flush();
  }, [queue]);

  React.useImperativeHandle(
    handleRef,
    () => ({
      flush,
      hasUnsaved: () => Boolean(problemRef.current) || queue.hasUnsaved() || isDirty(),
      savedEditsThisSession: () => savedEditsRef.current,
      discard: () => {
        queue.cancel();
        reportDraftCache.delete(draftKey);
        textRef.current = body;
        problemRef.current = null;
      },
    }),
    [flush, queue, draftKey, body]
  );

  // A fresh editor starts with a clean status line (the host keeps the last
  // one across an unmount, e.g. while the note was locked).
  React.useEffect(() => {
    onStateChange(IDLE_SAVE_STATE);
  }, [onStateChange]);

  React.useEffect(() => {
    if (initial !== undefined) applyText(initial);
  }, [initial, applyText]);

  React.useEffect(() => {
    const onUnload = () => void flush();
    window.addEventListener('beforeunload', onUnload);
    return () => {
      window.removeEventListener('beforeunload', onUnload);
      void flush();
    };
  }, [flush]);

  // A fresher report from disk replaces the text only when nothing is unsaved.
  React.useEffect(() => {
    if (body.trim() === baselineRef.current) return;
    if (problemRef.current || queue.hasUnsaved() || isDirty()) return;
    baselineRef.current = body.trim();
    textRef.current = body;
    setTextState(body);
  }, [body, queue]);

  React.useLayoutEffect(() => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = 'auto';
    if (el.scrollHeight > 0) el.style.height = `${el.scrollHeight}px`;
  }, [text, editing]);

  const startEditing = () => setEditing(true);
  // Focus lands in the same commit that swaps the textarea in, so keys typed
  // right after the click are not lost; the caret starts at the end.
  React.useLayoutEffect(() => {
    const el = textareaRef.current;
    if (!editing || !el) return;
    el.focus();
    el.setSelectionRange(el.value.length, el.value.length);
  }, [editing]);

  const ids = React.useId();
  const messageId = `${ids}-problem`;

  return (
    <section className="flex flex-col gap-2" style={{ maxWidth: '72ch' }}>
      {editing ? (
        <textarea
          ref={textareaRef}
          rows={4}
          value={text}
          aria-label={t('noteInline.report')}
          aria-invalid={problem ? true : undefined}
          aria-describedby={problem ? messageId : undefined}
          placeholder={t('noteInline.reportPlaceholder')}
          spellCheck
          data-testid="report-editor"
          className="note-inline-field text-[14.5px] leading-[1.65]"
          style={{ color: 'var(--fg-1)', fontFamily: 'var(--font-sans)' }}
          onChange={(e) => applyText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Escape') e.currentTarget.blur();
          }}
          onBlur={() => {
            setEditing(false);
            void flush();
          }}
        />
      ) : (
        // Reads as rendered Markdown; focusing it (click or Tab) swaps in the
        // textarea holding the same text, caret ready.
        <div
          role="textbox"
          aria-multiline="true"
          tabIndex={0}
          aria-label={t('noteInline.report')}
          className="stream-markdown note-inline-report"
          data-testid="report-content"
          style={{ color: 'var(--fg-1)' }}
          onMouseDown={(e) => {
            // A link in the report stays a link.
            if (e.target instanceof HTMLElement && e.target.closest('a')) e.preventDefault();
          }}
          onFocus={startEditing}
        >
          {text.trim() ? (
            <ReactMarkdown>{text}</ReactMarkdown>
          ) : (
            <p style={{ color: 'var(--fg-2)' }}>{t('noteInline.reportPlaceholder')}</p>
          )}
        </div>
      )}
      {problem && (
        <p id={messageId} role="alert" className="text-[13px] leading-[1.5]" style={{ color: 'var(--danger)' }}>
          {problem}
        </p>
      )}
    </section>
  );
}
