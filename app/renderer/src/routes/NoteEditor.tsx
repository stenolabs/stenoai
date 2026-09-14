import { t } from '@/i18n';
import * as React from 'react';
import { Plus, X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import type { UpdateMeetingPatch } from '@/lib/ipc';

/**
 * The editable shape of a generated (Standard) note, in the renderer's
 * camelCase vocabulary. Mapped to the snake_case `UpdateMeetingPatch` only at
 * the moment of saving, so the component never has to think in wire keys.
 */
export interface NoteDraft {
  summary: string;
  keyPoints: string[];
  actionItems: string[];
  discussionAreas: { title: string; analysis?: string }[];
}

interface NoteEditorProps {
  value: NoteDraft;
  /** Rejects on a failed write; the editor stays open and shows the reason. */
  onSave: (patch: UpdateMeetingPatch) => Promise<void>;
  onCancel: () => void;
  /**
   * Reports whether there is anything to lose. The host uses it to decide
   * whether leaving the view needs a confirmation. Must be referentially
   * stable (a `useState` setter is).
   */
  onDirtyChange?: (dirty: boolean) => void;
}

/**
 * Mirrors `STRUCTURAL_LINE` in app/note-sections.js. A value that starts a line
 * with `#`..`######` would forge a section heading and re-partition the note on
 * the next parse, so main rejects it. Checking it here too turns a round-trip
 * failure into an inline message next to the field the user is looking at.
 * Main stays the authority, this is only the faster answer.
 */
const STRUCTURAL_LINE = /^\s*#{1,6}\s/m;

/**
 * Single-line fields only. `renderBulletList` writes one `- ` line per entry
 * and the parsers keep only lines starting with `- `, so an embedded newline
 * silently drops everything after it on the next read. A newline in a topic
 * title doesn't lose text but moves the remainder into that topic's analysis,
 * and a lone `\r` makes the JS and Python parsers disagree about the title.
 * Both are drift, so both are refused before they reach disk.
 */
const LINE_BREAK = /[\r\n]/;

export type NoteSection = 'summary' | 'key_points' | 'action_items' | 'discussion_areas';

/**
 * A rejected field, located precisely enough to point at the row that has to be
 * retyped. `index` is the row's position in the patch (so, among the non-blank
 * rows); the editor maps it back to its own draft index before highlighting.
 */
export interface NotePatchProblem {
  section: NoteSection;
  /** Row within the section, or null for the summary. */
  index: number | null;
  /** Which half of a discussion area is at fault. */
  part?: 'title' | 'analysis';
  /** The row's own name, as the editor labels it. */
  fieldLabel: string;
  /**
   * What is wrong, as a sentence tail ("can't contain a line break."). Kept
   * separate from `fieldLabel` so the component can re-label the message with
   * the DRAFT row number, which is the one the user can see.
   */
  reason: string;
  /**
   * Ready to show: names the field and says what is wrong with it. Numbered
   * from the PATCH, so use it only where there is no draft to locate the row
   * in (validateNotePatch's own callers and tests); the editor rebuilds it
   * from the draft index instead.
   */
  message: string;
}

interface CandidateField {
  section: NoteSection;
  index: number | null;
  part?: 'title' | 'analysis';
  label: string;
  value: string;
  /** Single-line fields additionally refuse a line break. */
  singleLine: boolean;
}

/**
 * How the editor names one row, given a POSITION. The same function serves the
 * patch (where validation happens) and the draft (where the user is looking);
 * those two positions differ as soon as a blank row precedes the offending one,
 * which is exactly why the label has to be rebuildable from either.
 */
function labelFor(
  section: NoteSection,
  index: number | null,
  part?: 'title' | 'analysis',
): string {
  if (section === 'summary') return t('noteEditor.summarySubject');
  const n = (index ?? 0) + 1;
  if (section === 'key_points') return t('noteEditor.keyPointNumber', { n: n });
  if (section === 'action_items') return t('noteEditor.actionItemNumber', { n: n });
  return part === 'analysis' ? t('noteEditor.topicNotes', { n: n }) : t('noteEditor.topicTitle', { n: n });
}

function candidateFields(patch: UpdateMeetingPatch): CandidateField[] {
  const fields: CandidateField[] = [];

  if (typeof patch.summary === 'string') {
    fields.push({
      section: 'summary',
      index: null,
      label: labelFor('summary', null),
      value: patch.summary,
      singleLine: false,
    });
  }
  (patch.key_points ?? []).forEach((value, index) => {
    fields.push({
      section: 'key_points',
      index,
      label: labelFor('key_points', index),
      value,
      singleLine: true,
    });
  });
  (patch.action_items ?? []).forEach((value, index) => {
    fields.push({
      section: 'action_items',
      index,
      label: labelFor('action_items', index),
      value,
      singleLine: true,
    });
  });
  (patch.discussion_areas ?? []).forEach((area, index) => {
    fields.push({
      section: 'discussion_areas',
      index,
      part: 'title',
      label: labelFor('discussion_areas', index, 'title'),
      value: area.title,
      singleLine: true,
    });
    if (typeof area.analysis === 'string') {
      fields.push({
        section: 'discussion_areas',
        index,
        part: 'analysis',
        label: labelFor('discussion_areas', index, 'analysis'),
        value: area.analysis,
        singleLine: false,
      });
    }
  });

  return fields;
}

function problemFor(field: CandidateField, reason: string): NotePatchProblem {
  return {
    section: field.section,
    index: field.index,
    part: field.part,
    fieldLabel: field.label,
    reason,
    message: `${field.label} ${reason}`,
  };
}

/**
 * Client-side mirror of the main-process gate. Returns the offending field, or
 * null when the patch is safe to send. Exported because the single-line inputs
 * make the line-break case unreachable through the UI (browsers and jsdom strip
 * CR/LF from `input[type=text]`) while it remains perfectly reachable from a
 * note that already has one on disk.
 */
export function validateNotePatch(patch: UpdateMeetingPatch): NotePatchProblem | null {
  const fields = candidateFields(patch);
  // Headings first, across every field: they are the case main also refuses, so
  // a patch carrying both should report the one that would fail the write.
  for (const field of fields) {
    if (STRUCTURAL_LINE.test(field.value)) {
      return problemFor(field, "can't contain a markdown heading.");
    }
  }
  for (const field of fields) {
    if (field.singleLine && LINE_BREAK.test(field.value)) {
      return problemFor(field, "can't contain a line break.");
    }
  }
  return null;
}

interface NormalizedDraft {
  summary: string;
  keyPoints: string[];
  actionItems: string[];
  discussionAreas: { title: string; analysis: string }[];
}

/**
 * The draft as it would land on disk: trimmed, with blank rows dropped (the
 * writers drop them anyway). Both sides of the dirty comparison run through
 * this, so an added-but-still-empty row, or a stray trailing space, is
 * correctly "no change" rather than a write that changes nothing.
 */
function normalize(draft: NoteDraft): NormalizedDraft {
  return {
    summary: draft.summary.trim(),
    keyPoints: draft.keyPoints.map((entry) => entry.trim()).filter(Boolean),
    actionItems: draft.actionItems.map((entry) => entry.trim()).filter(Boolean),
    discussionAreas: draft.discussionAreas
      .map((area) => ({ title: area.title.trim(), analysis: (area.analysis ?? '').trim() }))
      .filter((area) => area.title !== ''),
  };
}

function sameList(a: string[], b: string[]): boolean {
  return a.length === b.length && a.every((entry, i) => entry === b[i]);
}

function sameAreas(a: NormalizedDraft['discussionAreas'], b: NormalizedDraft['discussionAreas']) {
  return (
    a.length === b.length &&
    a.every((area, i) => area.title === b[i].title && area.analysis === b[i].analysis)
  );
}

/** Only the sections that actually changed, in wire keys. */
function buildPatch(base: NormalizedDraft, next: NormalizedDraft): UpdateMeetingPatch {
  const patch: UpdateMeetingPatch = {};
  if (next.summary !== base.summary) patch.summary = next.summary;
  if (!sameList(next.keyPoints, base.keyPoints)) patch.key_points = next.keyPoints;
  if (!sameList(next.actionItems, base.actionItems)) patch.action_items = next.actionItems;
  if (!sameAreas(next.discussionAreas, base.discussionAreas)) {
    patch.discussion_areas = next.discussionAreas;
  }
  return patch;
}

type DraftLocation =
  | { kind: 'summary' }
  | { kind: 'keyPoints' | 'actionItems'; index: number }
  | { kind: 'discussionAreas'; index: number; part: 'title' | 'analysis' };

/** The draft index of the nth non-blank entry, or -1 if there is no such row. */
function nthNonBlank(entries: string[], wanted: number): number {
  let seen = -1;
  for (let i = 0; i < entries.length; i += 1) {
    if (entries[i].trim() === '') continue;
    seen += 1;
    if (seen === wanted) return i;
  }
  return -1;
}

/**
 * The patch is built from the normalized draft, which has the blank rows
 * dropped, so a patch index is not a draft index once the user has added an
 * empty row above the offending one. Count back to the row the user can see.
 */
function locateInDraft(draft: NoteDraft, problem: NotePatchProblem): DraftLocation | null {
  if (problem.section === 'summary') return { kind: 'summary' };
  if (problem.index === null) return null;

  if (problem.section === 'key_points') {
    const index = nthNonBlank(draft.keyPoints, problem.index);
    return index < 0 ? null : { kind: 'keyPoints', index };
  }
  if (problem.section === 'action_items') {
    const index = nthNonBlank(draft.actionItems, problem.index);
    return index < 0 ? null : { kind: 'actionItems', index };
  }
  const index = nthNonBlank(
    draft.discussionAreas.map((area) => area.title),
    problem.index
  );
  return index < 0 ? null : { kind: 'discussionAreas', index, part: problem.part ?? 'title' };
}

function errorMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error ?? '');
  return message.trim() || t('noteEditor.saveError');
}

/**
 * One measure for the whole editor body, and one gutter to the right of it for
 * the per-row remove buttons.
 *
 * Deliberately NOT `ch` per field: `ch` is font-relative, so the same `64ch` on
 * a 15.5px summary, a 14.5px input and a 14px topic body resolves to three
 * different pixel widths, and once the fields have borders those three right
 * edges read as ragged. (The read-only note can use `ch` per element precisely
 * because nothing there is boxed.) The padding-right reserves the gutter inside
 * the wrapper, and each row cancels it again with a negative margin, so a
 * window narrower than the measure shrinks everything together instead of
 * pushing the rows out of their container.
 */
const EDITOR_BODY_STYLE = {
  '--note-measure': '35rem',
  '--note-gutter': '2.25rem',
  width: '100%',
  maxWidth: 'calc(var(--note-measure) + var(--note-gutter))',
  paddingRight: 'var(--note-gutter)',
} as React.CSSProperties;

/** A field plus its remove button, with the field ending on the shared measure. */
const ROW_STYLE: React.CSSProperties = {
  gridTemplateColumns: 'minmax(0, 1fr) var(--note-gutter)',
  marginRight: 'calc(-1 * var(--note-gutter))',
};

/**
 * The generated note, editable (decision D9). The read-only note is a document;
 * this is that same document with its sections opened up, reached through one
 * explicit "Edit" affordance and left again through Save or Cancel. Nothing is
 * written until Save, and a failed write keeps the editor, and the typing,
 * exactly where it was.
 */
export function NoteEditor({ value, onSave, onCancel, onDirtyChange }: NoteEditorProps) {
  // Snapshot both the working copy and the comparison baseline once, at open.
  // A background refetch of the meeting must not silently redefine "changed"
  // underneath an open editor, and the prop is never mutated.
  const [draft, setDraft] = React.useState<NoteDraft>(() => ({
    summary: value.summary,
    keyPoints: [...value.keyPoints],
    actionItems: [...value.actionItems],
    discussionAreas: value.discussionAreas.map((area) => ({ ...area })),
  }));
  const [baseline] = React.useState<NormalizedDraft>(() => normalize(value));
  const [problem, setProblem] = React.useState<NotePatchProblem | null>(null);
  const [saveError, setSaveError] = React.useState<string | null>(null);
  const [saving, setSaving] = React.useState(false);

  const mounted = React.useRef(true);
  React.useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  const patch = React.useMemo(() => buildPatch(baseline, normalize(draft)), [baseline, draft]);
  const dirty = Object.keys(patch).length > 0;

  React.useEffect(() => {
    onDirtyChange?.(dirty);
  }, [dirty, onDirtyChange]);

  // Every edit goes through here so that any keystroke retires the previous
  // verdict: a highlight left on a row the user has since fixed is worse than
  // no highlight at all. A save rejection does not touch the draft, so its
  // message stays until the user does something about it.
  const applyEdit = (updater: (prev: NoteDraft) => NoteDraft) => {
    setProblem(null);
    setSaveError(null);
    setDraft(updater);
  };

  const invalid = React.useMemo(
    () => (problem ? locateInDraft(draft, problem) : null),
    [problem, draft]
  );
  // Number the row the way the user counts it. `problem.index` is a PATCH
  // index, which skips blank rows, so on a draft with a blank row above the
  // offending one the sentence would say "Key point 2" while the highlight sat
  // on the third field - the two disagreeing is worse than not naming the row
  // at all. The highlight is always right, so the label follows it. Falls back
  // to the patch-numbered label only when the row can no longer be located.
  const message = React.useMemo(() => {
    if (!problem) return saveError;
    if (!invalid) return problem.message;
    const draftIndex = 'index' in invalid ? invalid.index : null;
    return `${labelFor(problem.section, draftIndex, problem.part)} ${problem.reason}`;
  }, [problem, invalid, saveError]);

  const ids = React.useId();
  const summaryId = `${ids}-summary`;

  const setList = (key: 'keyPoints' | 'actionItems', next: string[]) =>
    applyEdit((prev) => ({ ...prev, [key]: next }));

  const handleSave = () => {
    if (!dirty || saving) return;
    const found = validateNotePatch(patch);
    if (found) {
      setProblem(found);
      setSaveError(null);
      return;
    }
    setProblem(null);
    setSaveError(null);
    setSaving(true);
    let pending: Promise<void>;
    try {
      pending = Promise.resolve(onSave(patch));
    } catch (thrown) {
      setSaving(false);
      setSaveError(errorMessage(thrown));
      return;
    }
    void pending.then(
      () => {
        if (mounted.current) setSaving(false);
      },
      (rejection: unknown) => {
        if (!mounted.current) return;
        setSaving(false);
        setSaveError(errorMessage(rejection));
      }
    );
  };

  return (
    <div className="flex flex-col gap-9" data-testid="note-editor">
      {/* The alert lives INSIDE the sticky bar: the Save button that produced it
          stays pinned, so on a long note the reason must stay pinned with it. */}
      <div
        className="sticky top-0 z-10 -mx-2 flex flex-col gap-2 px-2 py-2.5"
        style={{
          background: 'var(--surface-translucent)',
          backdropFilter: 'saturate(180%) blur(12px)',
          borderBottom: '1px solid var(--border-subtle)',
        }}
      >
        <div className="flex flex-wrap items-center justify-between gap-3">
          <span className="text-[13px]" style={{ color: 'var(--fg-2)' }}>
            {t('noteEditor.editing')}
          </span>
          <div className="flex items-center gap-2">
            <Button variant="ghost" size="sm" onClick={onCancel} disabled={saving}>
              {t('noteEditor.cancel')}
            </Button>
            <Button size="sm" onClick={handleSave} disabled={!dirty || saving}>
              {saving ? t('noteEditor.saving') : t('noteEditor.save')}
            </Button>
          </div>
        </div>
        {message && (
          <p role="alert" className="text-[13px] leading-[1.5]" style={{ color: 'var(--danger)' }}>
            {message}
          </p>
        )}
      </div>

      <div className="flex flex-col gap-9" style={EDITOR_BODY_STYLE}>
        <section className="flex flex-col gap-3">
          <FieldLabel htmlFor={summaryId}>{t('noteEditor.summary')}</FieldLabel>
          <GrowingTextarea
            id={summaryId}
            value={draft.summary}
            onChange={(next) => applyEdit((prev) => ({ ...prev, summary: next }))}
            placeholder={t('noteEditor.writeSummary')}
            minHeight={110}
            fontSize={15.5}
            invalid={invalid?.kind === 'summary'}
          />
        </section>

        <section className="flex flex-col gap-3">
          <FieldLabel>{t('noteEditor.topics')}</FieldLabel>
          <div className="flex flex-col gap-5">
            {draft.discussionAreas.map((area, i) => (
              <div key={i} className="flex flex-col gap-2">
                <Row>
                  <RowInput
                    aria-label={t('noteEditor.topicTitle', { n: i + 1 })}
                    value={area.title}
                    onChange={(next) =>
                      applyEdit((prev) => ({
                        ...prev,
                        discussionAreas: prev.discussionAreas.map((a, j) =>
                          j === i ? { ...a, title: next } : a
                        ),
                      }))
                    }
                    placeholder={t('noteEditor.topic')}
                    weight={600}
                    invalid={
                      invalid?.kind === 'discussionAreas' &&
                      invalid.index === i &&
                      invalid.part === 'title'
                    }
                  />
                  <RemoveButton
                    label={t('noteEditor.removeTopic', { n: i + 1 })}
                    onClick={() =>
                      applyEdit((prev) => ({
                        ...prev,
                        discussionAreas: prev.discussionAreas.filter((_, j) => j !== i),
                      }))
                    }
                  />
                </Row>
                <GrowingTextarea
                  aria-label={t('noteEditor.topicNotes', { n: i + 1 })}
                  value={area.analysis ?? ''}
                  onChange={(next) =>
                    applyEdit((prev) => ({
                      ...prev,
                      discussionAreas: prev.discussionAreas.map((a, j) =>
                        j === i ? { ...a, analysis: next } : a
                      ),
                    }))
                  }
                  placeholder={t('noteEditor.discussed')}
                  minHeight={64}
                  fontSize={14}
                  invalid={
                    invalid?.kind === 'discussionAreas' &&
                    invalid.index === i &&
                    invalid.part === 'analysis'
                  }
                />
              </div>
            ))}
            <AddButton
              label={t('noteEditor.addTopic')}
              onClick={() =>
                applyEdit((prev) => ({
                  ...prev,
                  discussionAreas: [...prev.discussionAreas, { title: '', analysis: '' }],
                }))
              }
            />
          </div>
        </section>

        <ListSection
          title={t('noteEditor.keyPoints')}
          entryLabel={t('noteEditor.keyPoint')}
          addLabel={t('noteEditor.addKeyPoint')}
          placeholder={t('noteEditor.pointPlaceholder')}
          entries={draft.keyPoints}
          invalidIndex={invalid?.kind === 'keyPoints' ? invalid.index : null}
          onChange={(next) => setList('keyPoints', next)}
        />

        <ListSection
          title={t('noteEditor.actionItems')}
          entryLabel={t('noteEditor.actionItem')}
          addLabel={t('noteEditor.addActionItem')}
          placeholder={t('noteEditor.actionPlaceholder')}
          entries={draft.actionItems}
          invalidIndex={invalid?.kind === 'actionItems' ? invalid.index : null}
          onChange={(next) => setList('actionItems', next)}
        />
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Pieces
// ---------------------------------------------------------------------------

/**
 * Same type treatment as `SectionTitle` in the read-only note, so switching
 * into edit mode doesn't move or restyle a single section heading. Rendered as
 * a real <label> when it names one field, and as a plain heading for the lists
 * (whose rows carry their own labels).
 */
function FieldLabel({ htmlFor, children }: { htmlFor?: string; children: React.ReactNode }) {
  const className = 'text-[13px] font-semibold tracking-[0.01em]';
  const style = { color: 'var(--fg-2)', fontFamily: 'var(--font-sans)', margin: 0 } as const;
  if (htmlFor) {
    return (
      <label htmlFor={htmlFor} className={className} style={style}>
        {children}
      </label>
    );
  }
  return (
    <h2 className={className} style={style}>
      {children}
    </h2>
  );
}

const FIELD_CLASS =
  'w-full rounded-lg px-2.5 py-2 outline-none transition-shadow focus:ring-2 focus:ring-[color:var(--focus-ring)]';

function fieldStyle(fontSize: number, weight = 400, invalid = false): React.CSSProperties {
  return {
    background: 'var(--surface-raised)',
    border: `1px solid ${invalid ? 'var(--danger)' : 'var(--border-subtle)'}`,
    color: 'var(--fg-1)',
    fontFamily: 'var(--font-sans)',
    fontSize,
    fontWeight: weight,
    lineHeight: 1.6,
  };
}

/** Field + remove button, laid out so the field ends on the shared measure. */
function Row({ children }: { children: React.ReactNode }) {
  return (
    <div className="grid items-center gap-0" style={ROW_STYLE}>
      {children}
    </div>
  );
}

/** Single-line by construction, see LINE_BREAK above for why this is not a textarea. */
function RowInput({
  value,
  onChange,
  placeholder,
  weight,
  invalid,
  ...rest
}: {
  value: string;
  onChange: (next: string) => void;
  placeholder?: string;
  weight?: number;
  invalid?: boolean;
  'aria-label': string;
}) {
  return (
    <input
      {...rest}
      type="text"
      value={value}
      placeholder={placeholder}
      spellCheck
      aria-invalid={invalid || undefined}
      onChange={(e) => onChange(e.target.value)}
      className={FIELD_CLASS}
      style={fieldStyle(14.5, weight, invalid)}
    />
  );
}

/** Grows to fit its content so a long summary is never a 3-line peephole. */
function GrowingTextarea({
  value,
  onChange,
  placeholder,
  minHeight,
  fontSize,
  invalid,
  ...rest
}: {
  value: string;
  onChange: (next: string) => void;
  placeholder?: string;
  minHeight: number;
  fontSize: number;
  invalid?: boolean;
  id?: string;
  'aria-label'?: string;
}) {
  const ref = React.useRef<HTMLTextAreaElement | null>(null);
  React.useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.style.height = 'auto';
    // scrollHeight is 0 under jsdom; the CSS minHeight keeps it sane there.
    el.style.height = `${Math.max(el.scrollHeight, minHeight)}px`;
  }, [value, minHeight]);

  return (
    <textarea
      {...rest}
      ref={ref}
      value={value}
      placeholder={placeholder}
      spellCheck
      rows={2}
      aria-invalid={invalid || undefined}
      onChange={(e) => onChange(e.target.value)}
      className={`${FIELD_CLASS} resize-none`}
      style={{ ...fieldStyle(fontSize, 400, invalid), minHeight }}
    />
  );
}

function RemoveButton({ label, onClick }: { label: string; onClick: () => void }) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      onClick={onClick}
      className="inline-flex size-7 shrink-0 items-center justify-center justify-self-center rounded-md transition-colors hover:bg-[color:var(--surface-hover)] hover:text-[color:var(--fg-1)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[color:var(--focus-ring)]"
      style={{ color: 'var(--fg-2)' }}
    >
      <X className="size-[14px]" />
    </button>
  );
}

function AddButton({ label, onClick }: { label: string; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="inline-flex w-fit items-center gap-1.5 rounded-md px-2 py-1 text-[13px] transition-colors hover:bg-[color:var(--surface-hover)] hover:text-[color:var(--fg-1)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[color:var(--focus-ring)]"
      style={{ color: 'var(--fg-2)' }}
    >
      <Plus className="size-[13px]" />
      {label}
    </button>
  );
}

function ListSection({
  title,
  entryLabel,
  addLabel,
  placeholder,
  entries,
  invalidIndex,
  onChange,
}: {
  title: string;
  entryLabel: string;
  addLabel: string;
  placeholder: string;
  entries: string[];
  invalidIndex: number | null;
  onChange: (next: string[]) => void;
}) {
  return (
    <section className="flex flex-col gap-3">
      <FieldLabel>{title}</FieldLabel>
      <div className="flex flex-col gap-2">
        {entries.map((entry, i) => (
          <Row key={i}>
            <RowInput
              aria-label={`${entryLabel} ${i + 1}`}
              value={entry}
              placeholder={placeholder}
              invalid={invalidIndex === i}
              onChange={(next) => onChange(entries.map((e, j) => (j === i ? next : e)))}
            />
            <RemoveButton
              label={t('noteEditor.removeEntry', { entry: entryLabel.toLowerCase(), n: i + 1 })}
              onClick={() => onChange(entries.filter((_, j) => j !== i))}
            />
          </Row>
        ))}
        <AddButton label={addLabel} onClick={() => onChange([...entries, ''])} />
      </div>
    </section>
  );
}
