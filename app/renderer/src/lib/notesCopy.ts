import { noteExportHeadings } from './notesExportHeadings';

/**
 * Builds the plain-text payload for the "Copy notes" header action in
 * MeetingDetail. Pure so the report-vs-Standard selection is unit-testable:
 * when a generated template report is open, the clipboard must carry that
 * report's markdown, not the Standard structured note — the copy always
 * matches what's on screen.
 */

/**
 * The structured Standard note shared by clipboard, Markdown and PDF exports.
 */
export interface StructuredNoteSections {
  name: string;
  meta?: string;
  outputLanguage?: string | null;
  summary?: string;
  discussionAreas: { title: string; analysis?: string }[];
  keyPoints: string[];
  actionItems: string[];
  participants: string[];
}

/** @deprecated Use StructuredNoteSections — kept as an alias for callers. */
export type NotesCopySections = StructuredNoteSections;

export function buildNotesCopyText(
  sections: StructuredNoteSections,
  activeReport: { content: string } | null,
): string {
  const lines: string[] = [sections.name];
  if (sections.meta) lines.push(sections.meta);

  if (activeReport) {
    const content = activeReport.content.trim();
    if (content) lines.push('', content);
    return lines.join('\n');
  }

  const { language, labels } = noteExportHeadings(sections.outputLanguage);
  const summary = sections.summary?.trim();
  if (summary) {
    lines.push('', labels.summary.toLocaleUpperCase(language), summary);
  }
  if (sections.discussionAreas.length) {
    lines.push('', labels.discussionAreas.toLocaleUpperCase(language));
    sections.discussionAreas.forEach((a) =>
      lines.push(`- ${a.title}${a.analysis ? `: ${a.analysis}` : ''}`),
    );
  }
  if (sections.keyPoints.length) {
    lines.push('', labels.keyPoints.toLocaleUpperCase(language));
    sections.keyPoints.forEach((p) => lines.push(`- ${p}`));
  }
  if (sections.actionItems.length) {
    lines.push('', labels.actionItems.toLocaleUpperCase(language));
    sections.actionItems.forEach((a) => lines.push(`- ${a}`));
  }
  if (sections.participants.length) {
    lines.push('', labels.participants.toLocaleUpperCase(language), sections.participants.join(', '));
  }
  return lines.join('\n');
}
