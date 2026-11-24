import { t } from '@/i18n';
import type { UpdateMeetingPatch } from '@/lib/ipc';

/**
 * The editable shape of a generated (Standard) note, in the renderer's
 * camelCase vocabulary. Mapped to the snake_case `UpdateMeetingPatch` only at
 * the moment of saving, so the editor never has to think in wire keys.
 */
export interface NoteDraft {
  summary: string;
  keyPoints: string[];
  actionItems: string[];
  discussionAreas: { title: string; analysis?: string }[];
}

/**
 * Mirrors `STRUCTURAL_LINE` in app/note-sections.js. A value that starts a line
 * with `#`..`######` would forge a section heading and re-partition the note on
 * the next parse, so main rejects it. Checking it here too turns a round-trip
 * failure into an inline message next to the field the user is looking at.
 * Main stays the authority, this is only the faster answer.
 */
const STRUCTURAL_LINE = /^\s*#{1,6}\s/m;
// Main's normalizeMarkdownForParsing exposes headings glued to reasoning
// close-tags. Validate the same representation without changing the draft.
const REASONING_TAG_HEADER = /(<\/(?:think|thought|thinking|reasoning)>)\s*(#{1,6}\s)/gi;

/** My notes permits Markdown; only the parser's H2 section boundaries are unsafe. */
export function hasUserNotesSectionBoundary(value: string): boolean {
  return /^## /m.test(value.replace(REASONING_TAG_HEADER, '$1\n$2'));
}

/**
 * Single-line fields only. `renderBulletList` writes one `- ` line per entry
 * and the parsers keep only lines starting with `- `, so an embedded newline
 * silently drops everything after it on the next read. A newline in a topic
 * title moves the remainder into that topic's analysis. Both are drift, so
 * both are refused before they reach disk.
 */
const LINE_BREAK = /[\r\n]/;

export type NoteSection = 'summary' | 'key_points' | 'action_items' | 'discussion_areas';

/** A rejected field, located precisely enough to mark the block to retype. */
export interface NoteDraftProblem {
  section: NoteSection;
  /** Row within the section as the user sees it (draft index), null for the summary. */
  index: number | null;
  part?: 'title' | 'analysis';
  /** Ready to show: names the field and says what is wrong with it. */
  message: string;
}

export function labelFor(section: NoteSection, index: number | null, part?: 'title' | 'analysis'): string {
  if (section === 'summary') return t('noteEditor.summarySubject');
  const n = (index ?? 0) + 1;
  if (section === 'key_points') return t('noteEditor.keyPointNumber', { n });
  if (section === 'action_items') return t('noteEditor.actionItemNumber', { n });
  return part === 'analysis'
    ? t('noteEditor.topicNotes', { n })
    : t('noteEditor.topicTitle', { n });
}

const hasHeading = (value: string) =>
  STRUCTURAL_LINE.test(value.replace(REASONING_TAG_HEADER, '$1\n$2'));

interface CandidateField {
  section: NoteSection;
  index: number | null;
  part?: 'title' | 'analysis';
  value: string;
  singleLine: boolean;
}

function draftFields(draft: NoteDraft): CandidateField[] {
  const fields: CandidateField[] = [
    { section: 'summary', index: null, value: draft.summary, singleLine: false },
  ];
  draft.discussionAreas.forEach((area, index) => {
    fields.push({ section: 'discussion_areas', index, part: 'title', value: area.title, singleLine: true });
    fields.push({
      section: 'discussion_areas',
      index,
      part: 'analysis',
      value: area.analysis ?? '',
      singleLine: false,
    });
  });
  draft.keyPoints.forEach((value, index) =>
    fields.push({ section: 'key_points', index, value, singleLine: true })
  );
  draft.actionItems.forEach((value, index) =>
    fields.push({ section: 'action_items', index, value, singleLine: true })
  );
  return fields;
}

function problem(field: CandidateField, reason: string): NoteDraftProblem {
  return {
    section: field.section,
    index: field.index,
    part: field.part,
    message: `${labelFor(field.section, field.index, field.part)} ${reason}`,
  };
}

/**
 * The first field of the draft that main would refuse (or that would silently
 * lose text on the way to disk), numbered the way the user sees the rows.
 * Null when the whole draft is safe to save.
 */
export function validateNoteDraft(
  draft: NoteDraft,
  sections?: ReadonlySet<NoteSection>
): NoteDraftProblem | null {
  // Only the sections being written are checked: a section the user did not
  // touch is not part of the patch, so text already on disk there (a model's
  // own "### " line, say) must not block saving an edit somewhere else.
  const fields = draftFields(draft).filter((f) => !sections || sections.has(f.section));
  // Headings first, across every field: they are the case main also refuses.
  for (const field of fields) {
    if (hasHeading(field.value)) return problem(field, t('noteEditor.headingReason'));
  }
  for (const field of fields) {
    if (field.singleLine && LINE_BREAK.test(field.value)) {
      return problem(field, t('noteEditor.lineBreakReason'));
    }
  }
  // normalize() drops a topic with no title, which would silently throw away
  // whatever its analysis still says. Ask for a title instead.
  for (let i = 0; i < draft.discussionAreas.length && (!sections || sections.has('discussion_areas')); i += 1) {
    const area = draft.discussionAreas[i];
    if (area.title.trim() === '' && (area.analysis ?? '').trim() !== '') {
      return {
        section: 'discussion_areas',
        index: i,
        part: 'title',
        message: t('noteEditor.topicNeedsTitle', { n: i + 1 }),
      };
    }
  }
  return null;
}

/** The sections a patch writes, for validateNoteDraft. */
export function patchSections(patch: UpdateMeetingPatch): Set<NoteSection> {
  return new Set(
    (['summary', 'key_points', 'action_items', 'discussion_areas'] as const).filter(
      (key) => patch[key] !== undefined
    )
  );
}

/**
 * Validation of a wire patch, for callers that only have one. The same rules
 * as validateNoteDraft; indices are patch positions.
 */
export function validateNotePatch(patch: UpdateMeetingPatch): NoteDraftProblem | null {
  return validateNoteDraft(
    {
    summary: patch.summary ?? '',
    keyPoints: patch.key_points ?? [],
    actionItems: patch.action_items ?? [],
    discussionAreas: (patch.discussion_areas ?? []).map((a) => ({
      title: a.title,
      analysis: a.analysis ?? '',
    })),
    },
    patchSections(patch)
  );
}

export interface NormalizedDraft {
  summary: string;
  keyPoints: string[];
  actionItems: string[];
  discussionAreas: { title: string; analysis: string }[];
}

/**
 * The draft as it would land on disk: trimmed, with blank rows dropped (the
 * writers drop them anyway). Both sides of a dirty comparison run through
 * this, so an added-but-still-empty bullet, or a stray trailing space, is
 * correctly "no change" rather than a write that changes nothing.
 */
export function normalizeDraft(draft: NoteDraft): NormalizedDraft {
  return {
    summary: draft.summary.trim(),
    keyPoints: draft.keyPoints.map((entry) => entry.trim()).filter(Boolean),
    actionItems: draft.actionItems.map((entry) => entry.trim()).filter(Boolean),
    discussionAreas: draft.discussionAreas
      .map((area) => ({ title: area.title.trim(), analysis: (area.analysis ?? '').trim() }))
      .filter((area) => area.title !== ''),
  };
}

const sameList = (a: string[], b: string[]) =>
  a.length === b.length && a.every((entry, i) => entry === b[i]);

const sameAreas = (a: NormalizedDraft['discussionAreas'], b: NormalizedDraft['discussionAreas']) =>
  a.length === b.length &&
  a.every((area, i) => area.title === b[i].title && area.analysis === b[i].analysis);

/** Only the sections that actually changed, in wire keys. */
export function buildNotePatch(base: NormalizedDraft, next: NormalizedDraft): UpdateMeetingPatch {
  const patch: UpdateMeetingPatch = {};
  if (next.summary !== base.summary) patch.summary = next.summary;
  if (!sameAreas(next.discussionAreas, base.discussionAreas)) {
    patch.discussion_areas = next.discussionAreas;
  }
  if (!sameList(next.keyPoints, base.keyPoints)) patch.key_points = next.keyPoints;
  if (!sameList(next.actionItems, base.actionItems)) patch.action_items = next.actionItems;
  return patch;
}

export const sameNormalized = (a: NormalizedDraft, b: NormalizedDraft) =>
  Object.keys(buildNotePatch(a, b)).length === 0;

/**
 * Re-apply the sections a user changed (draft vs the baseline it was edited
 * from) on top of a fresher note. Used to restore an unsaved draft after the
 * note was rewritten underneath it: only the sections the user touched win.
 */
export function rebaseDraft(fresh: NoteDraft, draft: NoteDraft, draftBase: NormalizedDraft): NoteDraft {
  const changed = buildNotePatch(draftBase, normalizeDraft(draft));
  return {
    summary: changed.summary !== undefined ? draft.summary : fresh.summary,
    keyPoints: changed.key_points !== undefined ? [...draft.keyPoints] : [...fresh.keyPoints],
    actionItems: changed.action_items !== undefined ? [...draft.actionItems] : [...fresh.actionItems],
    discussionAreas:
      changed.discussion_areas !== undefined
        ? draft.discussionAreas.map((a) => ({ ...a }))
        : fresh.discussionAreas.map((a) => ({ ...a })),
  };
}

// ---------------------------------------------------------------------------
// Bullet-list editing. Pure functions over (items, caret) so the keyboard
// behaviour is unit-testable without a DOM. Every function returns the new
// list plus where the caret should land, or null to let the browser act.
// ---------------------------------------------------------------------------

export interface BulletEdit {
  items: string[];
  focus: { index: number; caret: number } | null;
}

/** Enter: split the bullet at the caret; the text after it becomes the next bullet. */
export function splitBullet(items: string[], index: number, start: number, end: number = start): BulletEdit {
  const text = items[index] ?? '';
  const before = text.slice(0, start);
  const after = text.slice(end);
  const next = [...items];
  next.splice(index, 1, before, after);
  return { items: next, focus: { index: index + 1, caret: 0 } };
}

/**
 * Backspace with the caret at the very start of a bullet. An empty bullet is
 * removed and the caret moves to the end of the one above; a non-empty one is
 * joined onto the bullet above. Null on the first bullet unless it is empty
 * and others follow (so the list never loses its last row by accident).
 */
export function backspaceBullet(items: string[], index: number): BulletEdit | null {
  const text = items[index] ?? '';
  if (index === 0) {
    if (text !== '' || items.length < 2) return null;
    return { items: items.slice(1), focus: { index: 0, caret: 0 } };
  }
  const prev = items[index - 1];
  const next = [...items];
  next.splice(index - 1, 2, prev + text);
  return { items: next, focus: { index: index - 1, caret: prev.length } };
}

// A leading list marker on a pasted line: "- ", "* ", "• ", "1. ", "2) ".
const LIST_MARKER = /^\s*(?:[-*+•‣◦]|\d{1,3}[.)])\s+/;

/**
 * Paste of multi-line text into a bullet: each non-blank line becomes its own
 * bullet (list markers stripped). Single-line text returns null, so the
 * browser's own paste (and its undo entry) handles it.
 */
export function pasteIntoBullet(
  items: string[],
  index: number,
  start: number,
  end: number,
  pasted: string
): BulletEdit | null {
  const lines = pasted
    .split(/\r\n|\r|\n/)
    .map((line) => line.replace(LIST_MARKER, '').trim())
    .filter((line) => line !== '');
  if (!/[\r\n]/.test(pasted) || lines.length === 0) return null;
  const text = items[index] ?? '';
  const before = text.slice(0, start);
  const after = text.slice(end);
  // A paste that opens with a line break starts a new bullet rather than
  // gluing its first line onto the text before the caret.
  const startsOnNewLine = /^\s*[\r\n]/.test(pasted) && before.trim() !== '';
  const inserted = startsOnNewLine ? [before, ...lines] : [...lines];
  if (!startsOnNewLine) inserted[0] = before + inserted[0];
  const lastIndex = inserted.length - 1;
  const caret = inserted[lastIndex].length;
  inserted[lastIndex] = inserted[lastIndex] + after;
  const next = [...items];
  next.splice(index, 1, ...inserted);
  return { items: next, focus: { index: index + lastIndex, caret } };
}

// ---------------------------------------------------------------------------
// Template reports. Mirrors app/report-body.js (main is the authority): the
// renderer refuses the same bodies first so the message sits under the field.
// ---------------------------------------------------------------------------

const REPORT_REASONING_TAG = /<\/?(?:think|thought|thinking|reasoning)>/i;

/** The leading `---` ... `---` block of a text, by delimiters only ('' if none). */
export function leadingFrontmatterBlock(text: string): string {
  const source = text.replace(/\r\n?/g, '\n');
  const open = /^---[ \t]*\n/.exec(source);
  if (!open) return '';
  const rest = source.slice(open[0].length);
  const close = /^---[ \t]*$/m.exec(rest);
  if (!close) return '';
  return source.slice(0, open[0].length + close.index + close[0].length);
}

/**
 * Why a report body cannot be saved, or null. `frontmatter` is the block the
 * view shows as properties ('' for none); `original` is the body as it was
 * loaded, so a leading block the report already showed as text may stay.
 */
export function validateReportBody(body: string, frontmatter: string, original: string): string | null {
  if (REPORT_REASONING_TAG.test(body)) return t('noteInline.reportReasoningTag');
  if (!frontmatter) {
    const block = leadingFrontmatterBlock(body.replace(/^\n+/, ''));
    if (block && block !== leadingFrontmatterBlock(original.replace(/^\n+/, ''))) {
      return t('noteInline.reportFrontmatter');
    }
  }
  return null;
}
