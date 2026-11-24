import { t } from '@/i18n';
import * as React from 'react';
import { Plus } from 'lucide-react';
import { useAutosaveNote } from '@/hooks/useMeetings';
import { createSaveQueue, type SaveQueue, type SaveStatus } from '@/lib/saveQueue';
import {
  backspaceBullet,
  buildNotePatch,
  normalizeDraft,
  pasteIntoBullet,
  patchSections,
  rebaseDraft,
  sameNormalized,
  splitBullet,
  validateNoteDraft,
  type BulletEdit,
  type NormalizedDraft,
  type NoteDraft,
  type NoteDraftProblem,
} from '@/lib/noteDraft';

/**
 * What the host (MeetingDetail) needs from whichever inline editor is mounted:
 * the Standard note below, or a template report (InlineReport). Everything
 * that leaves the view (navigation, regenerate, export) asks through this.
 */
export interface InlineEditorHandle {
  /** Write anything unsaved now. Resolves false when that is impossible
   *  (invalid text, or the write failed); the editor then shows why. */
  flush(): Promise<boolean>;
  /** Is there anything on screen that is not on disk yet. */
  hasUnsaved(): boolean;
  /** Did this editor write at least one edit since it opened. */
  savedEditsThisSession(): boolean;
  /** Forget the unsaved draft (the user chose to leave without it). */
  discard(): void;
}

export interface InlineSaveState {
  status: SaveStatus;
  /** Main's (or the IPC's) reason for the last failed write. */
  error: string | null;
  /** The draft holds text that cannot be saved as it stands. */
  invalid: boolean;
}

export const IDLE_SAVE_STATE: InlineSaveState = { status: 'idle', error: null, invalid: false };

/**
 * Unsaved drafts that outlived their editor: a write refused because Steno
 * started rewriting the note (refining, a recording, a rebuild), a failed save
 * while navigating, a tab switch. Keyed by note (and report). The editor
 * restores from here on its next mount, re-applying only the sections the user
 * changed on top of whatever the note now says, and saves them. A successful
 * write removes the entry.
 */
const draftCache = new Map<string, { draft: NoteDraft; base: NormalizedDraft }>();

export function hasCachedNoteDraft(cacheKey: string): boolean {
  return draftCache.has(cacheKey);
}

const errorText = (error: unknown) =>
  (error instanceof Error ? error.message : String(error ?? '')).trim() || t('noteEditor.saveError');

const cloneDraft = (d: NoteDraft): NoteDraft => ({
  summary: d.summary,
  keyPoints: [...d.keyPoints],
  actionItems: [...d.actionItems],
  discussionAreas: d.discussionAreas.map((a) => ({ title: a.title, analysis: a.analysis ?? '' })),
});

type ListKey = 'keyPoints' | 'actionItems';

/** Section keys, named once so JSX does not carry string literals. */
const SECTION = {
  summary: 'summary',
  discussion_areas: 'discussion_areas',
  key_points: 'key_points',
  action_items: 'action_items',
} as const;

interface InlineNoteProps {
  /** The backend identity of the note (info.summary_file). */
  summaryFile: string;
  /** The route identity the detail query is cached under. */
  cacheKey: string;
  value: NoteDraft;
  handleRef: React.Ref<InlineEditorHandle>;
  onStateChange: (state: InlineSaveState) => void;
}

/**
 * The Standard note, always editable (no edit mode, no Save). Every section is
 * a borderless field typeset like the read-only note, so reading and editing
 * are the same view; a field shows a faint surface only while focused.
 * Changes autosave through a per-note SaveQueue (debounced, serialized,
 * coalesced). Nothing main would refuse is ever sent: the draft is validated
 * first and the offending field is marked with the reason.
 */
export function InlineNote({ summaryFile, cacheKey, value, handleRef, onStateChange }: InlineNoteProps) {
  const { mutateAsync } = useAutosaveNote();

  // Seeded once. A restored draft keeps only the sections the user changed.
  const [initial] = React.useState(() => {
    const base = normalizeDraft(value);
    const cached = draftCache.get(cacheKey);
    const draft = cached ? rebaseDraft(value, cached.draft, cached.base) : cloneDraft(value);
    return { draft, base, restored: Boolean(cached) };
  });
  const [draft, setDraftState] = React.useState<NoteDraft>(initial.draft);
  const draftRef = React.useRef(initial.draft);
  const baselineRef = React.useRef<NormalizedDraft>(initial.base);
  const savedEditsRef = React.useRef(false);
  const [problem, setProblem] = React.useState<NoteDraftProblem | null>(null);
  const problemRef = React.useRef<NoteDraftProblem | null>(null);
  const stateRef = React.useRef<InlineSaveState>(IDLE_SAVE_STATE);

  const report = React.useCallback(
    (patch: Partial<InlineSaveState>) => {
      stateRef.current = { ...stateRef.current, ...patch };
      onStateChange(stateRef.current);
    },
    [onStateChange]
  );

  const queueRef = React.useRef<SaveQueue<NoteDraft> | null>(null);
  if (!queueRef.current) {
    queueRef.current = createSaveQueue<NoteDraft>({
      delayMs: 800,
      save: async (next) => {
        const target = normalizeDraft(next);
        const patch = buildNotePatch(baselineRef.current, target);
        if (Object.keys(patch).length === 0) return;
        await mutateAsync({ summaryFile, cacheKey, patch });
        baselineRef.current = target;
        savedEditsRef.current = true;
        if (sameNormalized(normalizeDraft(draftRef.current), target)) draftCache.delete(cacheKey);
      },
      onStatus: (status, error) =>
        report({ status, error: status === 'error' ? errorText(error) : null }),
    });
  }
  const queue = queueRef.current;

  const isDirty = () => !sameNormalized(normalizeDraft(draftRef.current), baselineRef.current);

  const applyDraft = React.useCallback(
    (next: NoteDraft) => {
      draftRef.current = next;
      setDraftState(next);
      const patch = buildNotePatch(baselineRef.current, normalizeDraft(next));
      const found = validateNoteDraft(next, patchSections(patch));
      problemRef.current = found;
      setProblem(found);
      if (Object.keys(patch).length === 0) draftCache.delete(cacheKey);
      else draftCache.set(cacheKey, { draft: next, base: baselineRef.current });
      if (found) {
        // Never write what main would refuse; an older valid value still
        // queued would only flash "Saved" over a field marked invalid.
        queue.cancel();
        report({ invalid: true });
        return;
      }
      report({ invalid: false });
      queue.schedule(next);
    },
    [cacheKey, queue, report]
  );

  const flush = React.useCallback(async () => {
    if (problemRef.current) return false;
    if (isDirty()) queue.schedule(draftRef.current);
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
        draftCache.delete(cacheKey);
        draftRef.current = cloneDraft(value);
        baselineRef.current = normalizeDraft(value);
        problemRef.current = null;
      },
    }),
    [flush, queue, cacheKey, value]
  );

  // A fresh editor starts with a clean status line (the host keeps the last
  // one across an unmount, e.g. while the note was locked).
  React.useEffect(() => {
    onStateChange(IDLE_SAVE_STATE);
  }, [onStateChange]);

  // A restored draft is written as soon as the note is editable again.
  React.useEffect(() => {
    if (initial.restored) applyDraft(initial.draft);
  }, [initial, applyDraft]);

  // Leaving the note (unmount, tab switch, window close) writes what is left.
  React.useEffect(() => {
    const onUnload = () => void flush();
    window.addEventListener('beforeunload', onUnload);
    return () => {
      window.removeEventListener('beforeunload', onUnload);
      void flush();
    };
  }, [flush]);

  // The note changed on disk underneath an editor that holds nothing unsaved
  // (a refetch after another writer finished): show the new text. Our own
  // saves come back equal to the baseline and are ignored, so an empty bullet
  // the user just added is never swept away by the echo of an earlier save.
  React.useEffect(() => {
    const incoming = normalizeDraft(value);
    if (sameNormalized(incoming, baselineRef.current)) return;
    if (problemRef.current || queue.hasUnsaved() || isDirty()) return;
    baselineRef.current = incoming;
    const next = cloneDraft(value);
    draftRef.current = next;
    setDraftState(next);
  }, [value, queue]);

  // ---- focus placement after structural bullet edits ----------------------
  const rootRef = React.useRef<HTMLDivElement | null>(null);
  const pendingFocus = React.useRef<{ key: string; caret: number } | null>(null);
  React.useLayoutEffect(() => {
    const want = pendingFocus.current;
    if (!want) return;
    pendingFocus.current = null;
    const el = rootRef.current?.querySelector<HTMLTextAreaElement>(`[data-field="${want.key}"]`);
    if (!el) return;
    el.focus();
    const caret = Math.min(want.caret, el.value.length);
    el.setSelectionRange(caret, caret);
  });

  const applyListEdit = (key: ListKey, edit: BulletEdit) => {
    if (edit.focus) pendingFocus.current = { key: `${key}-${edit.focus.index}`, caret: edit.focus.caret };
    applyDraft({ ...draftRef.current, [key]: edit.items });
  };

  const onBlurNote = (e: React.FocusEvent<HTMLDivElement>) => {
    if (rootRef.current && e.relatedTarget instanceof Node && rootRef.current.contains(e.relatedTarget)) {
      return;
    }
    void flush();
  };

  const onKeyDownNote = (e: React.KeyboardEvent<HTMLDivElement>) => {
    if (e.key === 'Escape' && e.target instanceof HTMLElement && e.target.tagName === 'TEXTAREA') {
      e.target.blur();
    }
  };

  const invalidAt = (section: NoteDraftProblem['section'], index: number | null, part?: 'title' | 'analysis') =>
    problem !== null &&
    problem.section === section &&
    problem.index === index &&
    (part === undefined || problem.part === part);

  const ids = React.useId();
  const messageId = `${ids}-problem`;
  const message = (section: NoteDraftProblem['section']) =>
    problem && problem.section === section ? (
      <p id={messageId} role="alert" className="text-[13px] leading-[1.5]" style={{ color: 'var(--danger)' }}>
        {problem.message}
      </p>
    ) : null;

  const areas = draft.discussionAreas;

  return (
    <div
      ref={rootRef}
      className="flex flex-col gap-9"
      data-testid="inline-note"
      onBlur={onBlurNote}
      onKeyDown={onKeyDownNote}
    >
      <section className="flex flex-col gap-3">
        <SectionHeading>{t('meeting.summary')}</SectionHeading>
        <div data-testid="tab-summary-content">
          <InlineField
            label={t('noteEditor.summary')}
            value={draft.summary}
            placeholder={t('noteEditor.writeSummary')}
            className="text-[15.5px] leading-[1.65]"
            style={{ color: 'var(--fg-1)', maxWidth: '64ch' }}
            invalid={invalidAt('summary', null)}
            describedBy={invalidAt('summary', null) ? messageId : undefined}
            onChange={(summary) => applyDraft({ ...draftRef.current, summary })}
          />
        </div>
        {message(SECTION.summary)}
      </section>

      <section className="note-inline-section flex flex-col gap-3">
        <SectionHeading>{t('meeting.keyTopics')}</SectionHeading>
        {areas.length > 0 && (
        <div className="mv-topics">
          {areas.map((area, i) => (
            <div key={i} className="flex flex-col gap-1">
              <InlineField
                singleLine
                dataField={`topic-${i}-title`}
                label={t('noteEditor.topicTitle', { n: i + 1 })}
                value={area.title}
                placeholder={t('noteEditor.topic')}
                className="mv-topic-title"
                invalid={invalidAt('discussion_areas', i, 'title')}
                describedBy={invalidAt('discussion_areas', i, 'title') ? messageId : undefined}
                onChange={(title) =>
                  applyDraft({
                    ...draftRef.current,
                    discussionAreas: draftRef.current.discussionAreas.map((a, j) =>
                      j === i ? { ...a, title } : a
                    ),
                  })
                }
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && !e.nativeEvent.isComposing) {
                    e.preventDefault();
                    pendingFocus.current = { key: `topic-${i}-analysis`, caret: 0 };
                    // Re-render so the layout effect places the caret.
                    setDraftState({ ...draftRef.current });
                  } else if (
                    e.key === 'Backspace' &&
                    area.title === '' &&
                    (area.analysis ?? '') === ''
                  ) {
                    e.preventDefault();
                    const prev = i - 1;
                    if (prev >= 0) {
                      pendingFocus.current = {
                        key: `topic-${prev}-analysis`,
                        caret: (areas[prev].analysis ?? '').length,
                      };
                    }
                    applyDraft({
                      ...draftRef.current,
                      discussionAreas: draftRef.current.discussionAreas.filter((_, j) => j !== i),
                    });
                  }
                }}
              />
              <InlineField
                dataField={`topic-${i}-analysis`}
                label={t('noteEditor.topicNotes', { n: i + 1 })}
                value={area.analysis ?? ''}
                placeholder={t('noteEditor.discussed')}
                className="mv-topic-body"
                invalid={invalidAt('discussion_areas', i, 'analysis')}
                describedBy={invalidAt('discussion_areas', i, 'analysis') ? messageId : undefined}
                onChange={(analysis) =>
                  applyDraft({
                    ...draftRef.current,
                    discussionAreas: draftRef.current.discussionAreas.map((a, j) =>
                      j === i ? { ...a, analysis } : a
                    ),
                  })
                }
              />
            </div>
          ))}
        </div>
        )}
        <AddButton
          // With no topics yet the button is the section's only content, so
          // it stays visible instead of waiting for hover.
          prominent={areas.length === 0}
          label={t('noteEditor.addTopic')}
          onClick={() => {
            pendingFocus.current = { key: `topic-${areas.length}-title`, caret: 0 };
            applyDraft({
              ...draftRef.current,
              discussionAreas: [...draftRef.current.discussionAreas, { title: '', analysis: '' }],
            });
          }}
        />
        {message(SECTION.discussion_areas)}
      </section>

      <BulletSection
        listKey="keyPoints"
        title={t('meeting.keyPoints')}
        entryLabel={(n) => t('noteEditor.keyPointNumber', { n })}
        placeholder={t('noteEditor.pointPlaceholder')}
        items={draft.keyPoints}
        invalidIndex={problem?.section === 'key_points' ? problem.index : null}
        messageId={messageId}
        onItems={(items) => applyDraft({ ...draftRef.current, keyPoints: items })}
        onEdit={(edit) => applyListEdit('keyPoints', edit)}
      >
        {message(SECTION.key_points)}
      </BulletSection>

      <BulletSection
        listKey="actionItems"
        title={t('meeting.actionItems')}
        entryLabel={(n) => t('noteEditor.actionItemNumber', { n })}
        placeholder={t('noteEditor.actionPlaceholder')}
        items={draft.actionItems}
        invalidIndex={problem?.section === 'action_items' ? problem.index : null}
        messageId={messageId}
        onItems={(items) => applyDraft({ ...draftRef.current, actionItems: items })}
        onEdit={(edit) => applyListEdit('actionItems', edit)}
      >
        {message(SECTION.action_items)}
      </BulletSection>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Pieces
// ---------------------------------------------------------------------------

function SectionHeading({ children }: { children: React.ReactNode }) {
  return (
    <h2
      className="text-[13px] font-semibold tracking-[0.01em]"
      style={{ color: 'var(--fg-2)', fontFamily: 'var(--font-sans)', margin: 0 }}
    >
      {children}
    </h2>
  );
}

function BulletSection({
  listKey,
  title,
  entryLabel,
  placeholder,
  items,
  invalidIndex,
  messageId,
  onItems,
  onEdit,
  children,
}: {
  listKey: ListKey;
  title: string;
  entryLabel: (n: number) => string;
  placeholder: string;
  items: string[];
  invalidIndex: number | null;
  messageId: string;
  onItems: (items: string[]) => void;
  onEdit: (edit: BulletEdit) => void;
  children?: React.ReactNode;
}) {
  // An empty list still offers one bullet to type into.
  const rows = items.length > 0 ? items : [''];
  return (
    <section className="flex flex-col gap-3">
      <SectionHeading>{title}</SectionHeading>
      <ul className="mv-bullets">
        {rows.map((entry, i) => (
          <li key={i}>
            <InlineField
              singleLine
              dataField={`${listKey}-${i}`}
              label={entryLabel(i + 1)}
              value={entry}
              placeholder={rows.length === 1 && entry === '' ? placeholder : undefined}
              invalid={invalidIndex === i}
              describedBy={invalidIndex === i ? messageId : undefined}
              onChange={(next) => onItems(rows.map((e, j) => (j === i ? next : e)))}
              onKeyDown={(e) => {
                const el = e.currentTarget;
                if (e.key === 'Enter' && !e.nativeEvent.isComposing) {
                  e.preventDefault();
                  onEdit(splitBullet(rows, i, el.selectionStart, el.selectionEnd));
                } else if (
                  e.key === 'Backspace' &&
                  el.selectionStart === 0 &&
                  el.selectionEnd === 0
                ) {
                  const edit = backspaceBullet(rows, i);
                  if (edit) {
                    e.preventDefault();
                    onEdit(edit);
                  }
                }
              }}
              onPaste={(e) => {
                const el = e.currentTarget;
                const text = e.clipboardData.getData('text/plain');
                const edit = pasteIntoBullet(rows, i, el.selectionStart, el.selectionEnd, text);
                if (edit) {
                  e.preventDefault();
                  onEdit(edit);
                }
              }}
            />
          </li>
        ))}
      </ul>
      {children}
    </section>
  );
}

/**
 * An auto-growing, borderless textarea that inherits the note's typography,
 * so an unfocused field reads exactly like the read-only note. Single-line
 * fields still wrap visually; their Enter is handled by the caller and a
 * pasted or dropped line break is caught by validation.
 */
function InlineField({
  label,
  value,
  onChange,
  placeholder,
  className,
  style,
  invalid,
  describedBy,
  singleLine,
  dataField,
  onKeyDown,
  onPaste,
}: {
  label: string;
  value: string;
  onChange: (next: string) => void;
  placeholder?: string;
  className?: string;
  style?: React.CSSProperties;
  invalid?: boolean;
  describedBy?: string;
  singleLine?: boolean;
  dataField?: string;
  onKeyDown?: (e: React.KeyboardEvent<HTMLTextAreaElement>) => void;
  onPaste?: (e: React.ClipboardEvent<HTMLTextAreaElement>) => void;
}) {
  const ref = React.useRef<HTMLTextAreaElement | null>(null);
  React.useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.style.height = 'auto';
    // scrollHeight is 0 under jsdom; rows=1 keeps it sane there.
    if (el.scrollHeight > 0) el.style.height = `${el.scrollHeight}px`;
  }, [value]);

  return (
    <textarea
      ref={ref}
      rows={1}
      value={value}
      aria-label={label}
      aria-invalid={invalid || undefined}
      aria-describedby={describedBy}
      aria-multiline={singleLine ? false : undefined}
      data-field={dataField}
      placeholder={placeholder}
      spellCheck
      onChange={(e) => onChange(e.target.value)}
      onKeyDown={onKeyDown}
      onPaste={onPaste}
      className={`note-inline-field ${className ?? ''}`}
      style={style}
    />
  );
}

function AddButton({
  label,
  onClick,
  prominent,
}: {
  label: string;
  onClick: () => void;
  prominent?: boolean;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={prominent ? 'note-inline-add note-inline-add--shown' : 'note-inline-add'}
    >
      <Plus className="size-[13px]" />
      {label}
    </button>
  );
}
