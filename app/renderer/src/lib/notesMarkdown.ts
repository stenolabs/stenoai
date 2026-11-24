import type { StructuredNoteSections } from './notesCopy';
import { noteExportHeadings } from './notesExportHeadings';

function hasText(value: string | undefined): value is string {
  return Boolean(value?.trim());
}

export function buildNotesMarkdown(
  sections: StructuredNoteSections,
  activeReport: { content: string } | null,
): string {
  const titleBlock = [`# ${sections.name}`];
  if (sections.meta) titleBlock.push(sections.meta);

  const blocks: string[] = [titleBlock.join('\n')];

  if (activeReport) {
    if (hasText(activeReport.content)) blocks.push(activeReport.content);
    return blocks.join('\n\n');
  }

  const { labels } = noteExportHeadings(sections.outputLanguage);
  if (hasText(sections.summary)) {
    blocks.push(`## ${labels.summary}\n\n${sections.summary}`);
  }

  if (sections.discussionAreas.length) {
    const topics = sections.discussionAreas
      .map((area) => {
        const topic = [`### ${area.title}`];
        if (hasText(area.analysis)) topic.push('', area.analysis);
        return topic.join('\n');
      })
      .join('\n\n');
    blocks.push(`## ${labels.discussionAreas}\n\n${topics}`);
  }

  if (sections.keyPoints.length) {
    blocks.push(`## ${labels.keyPoints}\n\n${sections.keyPoints.map((point) => `- ${point}`).join('\n')}`);
  }

  if (sections.actionItems.length) {
    blocks.push(`## ${labels.actionItems}\n\n${sections.actionItems.map((item) => `- ${item}`).join('\n')}`);
  }

  if (sections.participants.length) {
    blocks.push(`## ${labels.participants}\n\n${sections.participants.join(', ')}`);
  }

  return blocks.join('\n\n');
}
