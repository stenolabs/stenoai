/**
 * Builds the self-contained, print-quality HTML for the "Save notes as PDF…"
 * export in MeetingDetail. Pure (like buildNotesCopyText / buildTranscriptBundle)
 * so the section selection + HTML escaping are unit-testable: the renderer hands
 * the finished HTML string to the `export-note-pdf` IPC, and the main process
 * owns only the HTML→PDF render + file write (mirrors the export-transcript
 * seam, where the renderer builds the artifact and main just writes bytes).
 *
 * The document commits to Steno's light paper+ink look — a PDF is a fixed
 * printed artifact, not a themed UI surface, so it is deliberately not
 * theme-aware. Fonts + logo are embedded as base64 data URIs (brandAssets.ts)
 * so the render needs no filesystem or network access at runtime.
 */

import { OVO_FONT_WOFF2_BASE64, STENO_LOGO_SVG_BASE64 } from '@/lib/brandAssets';
import type { StructuredNoteSections } from '@/lib/notesCopy';

// The PDF builder consumes the same decomposed Standard-note shape as the
// clipboard export (one source of truth — see notesCopy.ts). `meta` is a
// pre-formatted "date · duration"-style line, omitted when empty.
export type NotesPdfInput = StructuredNoteSections;

/**
 * A generated template report, ready to drop into the branded shell.
 *
 * `contentHtml` is PRE-RENDERED by the caller, deliberately: a report is
 * free-form markdown, and the only way to guarantee the PDF matches what the
 * detail view shows is to serialise the very same renderer (react-markdown)
 * rather than grow a second markdown implementation here that would drift.
 * Keeping the markdown out of this module also keeps it pure and React-free.
 *
 * That means this one value is injected WITHOUT escaping, so its provenance
 * matters: react-markdown does not emit raw HTML from its input unless
 * rehype-raw is enabled (it is not), so note content cannot inject markup
 * through it. The document's CSP (`default-src 'none'`) is the second line of
 * defence. Never pass a hand-built or otherwise untrusted string here.
 */
export interface NotesPdfReport {
  templateName: string;
  contentHtml: string;
}

// Escape the five characters that are unsafe in HTML text/attribute context, so
// note content (a title with "&", an action item with "<", etc.) can never
// inject markup into the rendered document. Every dynamic value routes through
// this before it reaches the template.
export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

// True when there is at least one note section worth exporting. Callers disable
// the Save-as-PDF action on an empty note (a transcript-only or failed note has
// no structured content to render), matching how the .md export disables on an
// empty transcript bundle.
export function hasNotesContent(input: NotesPdfInput): boolean {
  return Boolean(
    input.summary?.trim() ||
      input.discussionAreas.length ||
      input.keyPoints.length ||
      input.actionItems.length,
  );
}

function listItems(items: string[]): string {
  return items.map((i) => `      <li>${escapeHtml(i)}</li>`).join('\n');
}

export function buildNotesHtml(input: NotesPdfInput, activeReport?: NotesPdfReport | null): string {
  // A report carries its own content, so it is exportable even when the
  // Standard note is empty (a transcript-only note can still have one).
  const reportHtml = activeReport?.contentHtml?.trim();
  if (!reportHtml && !hasNotesContent(input)) return '';

  const title = (input.name ?? '').trim() || 'Untitled note';
  const summary = input.summary?.trim();

  const sections: string[] = [];

  // When a report is open it REPLACES the Standard sections — the PDF must show
  // what's on screen, not both (matches buildNotesCopyText's short-circuit).
  if (reportHtml) {
    const label = escapeHtml((activeReport?.templateName || 'Report').trim());
    return renderDocument(title, input.meta, [
      `  <section>
    <h2>${label}</h2>
    <div class="report">
${reportHtml}
    </div>
  </section>`,
    ]);
  }

  if (summary) {
    sections.push(`  <section>
    <h2>Summary</h2>
    <p class="summary">${escapeHtml(summary)}</p>
  </section>`);
  }

  if (input.discussionAreas.length) {
    const rows = input.discussionAreas
      .map((a) => {
        const t = escapeHtml((a.title || 'Discussion topic').trim());
        const analysis = a.analysis?.trim();
        return analysis
          ? `      <li><span class="lead">${t}:</span> ${escapeHtml(analysis)}</li>`
          : `      <li><span class="lead">${t}</span></li>`;
      })
      .join('\n');
    sections.push(`  <section>
    <h2>Key Topics</h2>
    <ul>
${rows}
    </ul>
  </section>`);
  }

  if (input.keyPoints.length) {
    sections.push(`  <section>
    <h2>Key Points</h2>
    <ul>
${listItems(input.keyPoints)}
    </ul>
  </section>`);
  }

  if (input.actionItems.length) {
    sections.push(`  <section class="actions">
    <h2>Action Items</h2>
    <ul>
${listItems(input.actionItems)}
    </ul>
  </section>`);
  }

  if (input.participants.length) {
    sections.push(`  <section>
    <h2>Participants</h2>
    <p>${escapeHtml(input.participants.join(', '))}</p>
  </section>`);
  }

  return renderDocument(title, input.meta, sections);
}

/**
 * The branded shell: masthead, title block, whatever sections it is handed, and
 * the footer. Shared by both paths (Standard note and open report) so the two
 * can never drift apart on chrome, fonts or layout.
 */
function renderDocument(title: string, meta: string | undefined, sections: string[]): string {
  const metaLine = meta?.trim()
    ? `  <div class="meta">${escapeHtml(meta.trim())}</div>`
    : '';

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src data:; font-src data:; style-src 'unsafe-inline'">
<title>${escapeHtml(title)}</title>
<style>
  @font-face {
    font-family: 'Ovo';
    src: url(data:font/woff2;base64,${OVO_FONT_WOFF2_BASE64}) format('woff2');
    font-weight: 400;
    font-style: normal;
  }
  @page { size: A4; margin: 18mm 16mm 16mm; }
  :root {
    --paper-0: #FAF9F5;
    --paper-1: #F5F3EC;
    --ink-900: #1B1B19;
    --ink-500: #6B6B66;
    --rule: #E3E0D6;
    /* Text sits inset from the content box on both sides, while the full-width
       rules, masthead/footer borders, and the action-item fill span the whole
       box — so the ink rules and paper tint overflow past the text measure
       symmetrically, left and right. */
    --inset: 11mm;
  }
  * { box-sizing: border-box; }
  html, body {
    margin: 0; padding: 0;
    background: var(--paper-0);
    color: var(--ink-900);
    font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', 'Helvetica Neue', Arial, sans-serif;
    font-size: 10.5pt;
    line-height: 1.55;
    -webkit-print-color-adjust: exact;
    print-color-adjust: exact;
  }
  .masthead {
    display: flex; align-items: center; justify-content: space-between;
    padding: 0 var(--inset) 10px; border-bottom: 1.5px solid var(--ink-900);
  }
  .brand { display: flex; align-items: center; gap: 9px; }
  .brand img { width: 26px; height: 26px; display: block; }
  .brand .wordmark { font-family: 'Ovo', Georgia, serif; font-size: 17pt; letter-spacing: 0.01em; line-height: 1; }
  .masthead-meta { text-align: right; }
  .masthead .kicker { font-size: 7.5pt; letter-spacing: 0.14em; text-transform: uppercase; color: var(--ink-500); }
  .masthead .site { margin-top: 3px; font-size: 8pt; letter-spacing: 0.02em; color: var(--ink-900); }
  .title-block { margin: 26px 0; padding: 0 var(--inset); }
  h1 {
    font-family: 'Ovo', Georgia, serif; font-size: 24pt; font-weight: 400;
    line-height: 1.18; letter-spacing: -0.005em; margin: 0 0 10px; max-width: 30ch;
  }
  .meta { font-size: 9pt; color: var(--ink-500); }
  section { margin-bottom: 22px; }
  h2 {
    font-size: 8pt; font-weight: 600; letter-spacing: 0.16em; text-transform: uppercase;
    color: var(--ink-500); margin: 0 0 9px; padding: 0 var(--inset) 5px;
    border-bottom: 1px solid var(--rule); break-after: avoid;
  }
  /* Running text insets to match the section labels; the h2 rule above spans
     the full box (border-box), so it overflows past the text on both sides. */
  section > p, section > ul { padding-left: var(--inset); padding-right: var(--inset); }
  .summary { font-family: 'Ovo', Georgia, serif; font-size: 12pt; line-height: 1.6; margin: 0; }
  p { margin: 0; }
  ul { margin: 0; padding: 0; list-style: none; }
  li { position: relative; padding-left: 16px; margin-bottom: 8px; break-inside: avoid; }
  li::before {
    content: ''; position: absolute; left: 2px; top: 0.62em;
    width: 4px; height: 4px; border-radius: 50%; background: var(--ink-900);
  }
  li .lead { font-weight: 600; }
  .actions {
    background: var(--paper-1); border: 1px solid var(--rule); border-radius: 8px;
    padding: 14px 0 8px; break-inside: avoid;
  }
  .actions h2 { border-bottom: none; padding-bottom: 0; margin-bottom: 8px; }
  .actions li::before {
    border-radius: 1px; top: 0.55em; width: 5px; height: 5px;
    background: none; border: 1.2px solid var(--ink-900);
  }
  /* An open template report is free-form markdown (react-markdown output), so
     it brings element types the structured note never emits — headings inside
     the body, ordered lists, emphasis, code, quotes, tables. Style them here;
     without this they would inherit the structured note's list rules and lose
     their numbering and hierarchy. */
  .report { padding: 0 var(--inset); }
  .report > :first-child { margin-top: 0; }
  .report h1, .report h2, .report h3, .report h4 {
    font-family: 'Ovo', Georgia, serif; font-weight: 400; color: var(--ink-900);
    letter-spacing: 0; text-transform: none; border-bottom: none;
    margin: 16px 0 7px; padding: 0; break-after: avoid;
  }
  .report h1 { font-size: 15pt; }
  .report h2 { font-size: 13pt; }
  .report h3 { font-size: 11.5pt; }
  .report h4 { font-size: 10.5pt; font-weight: 600; }
  .report p { margin: 0 0 9px; }
  .report ul, .report ol { margin: 0 0 10px; padding-left: 18px; }
  .report ul { list-style: disc; }
  .report ol { list-style: decimal; }
  .report li { padding-left: 0; margin-bottom: 5px; }
  .report li::before { content: none; }
  .report li::marker { color: var(--ink-900); }
  .report strong { font-weight: 600; }
  .report blockquote {
    margin: 0 0 10px; padding-left: 12px;
    border-left: 2px solid var(--rule); color: var(--ink-500);
  }
  .report code {
    font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 9pt;
    background: var(--paper-1); padding: 1px 4px; border-radius: 3px;
  }
  .report pre {
    margin: 0 0 10px; padding: 10px; background: var(--paper-1);
    border: 1px solid var(--rule); border-radius: 6px; overflow-wrap: break-word;
    white-space: pre-wrap; break-inside: avoid;
  }
  .report pre code { background: none; padding: 0; }
  .report table { width: 100%; border-collapse: collapse; margin: 0 0 10px; font-size: 9.5pt; }
  .report th, .report td {
    border: 1px solid var(--rule); padding: 5px 7px; text-align: left; vertical-align: top;
  }
  .report th { background: var(--paper-1); font-weight: 600; }
  .report hr { border: none; border-top: 1px solid var(--rule); margin: 14px 0; }
  /* A report that opens with YAML frontmatter puts its properties first, as
     the same <dl> the detail view shows (ReportProperties in markdown.tsx).
     Its Tailwind classes do nothing here, so the layout is restated, and its
     inline colours use the app's tokens, mapped onto the paper palette. */
  .report {
    --surface-raised: var(--paper-1);
    --border-subtle: var(--rule);
    --fg-1: var(--ink-900);
    --fg-2: var(--ink-500);
  }
  .report dl {
    display: grid; column-gap: 14px; row-gap: 3px;
    margin: 0 0 14px; padding: 8px 10px; border-radius: 6px;
    font-size: 9.5pt; break-inside: avoid;
  }
  .report dd { margin: 0; }
  footer {
    margin-top: 30px; padding: 10px var(--inset) 0; border-top: 1px solid var(--rule);
    font-size: 8pt; color: var(--ink-500); letter-spacing: 0.02em;
  }
</style>
</head>
<body>
  <div class="masthead">
    <div class="brand">
      <img src="data:image/svg+xml;base64,${STENO_LOGO_SVG_BASE64}" alt="Steno">
      <span class="wordmark">steno</span>
    </div>
    <div class="masthead-meta">
      <div class="kicker">Meeting Notes</div>
      <div class="site">www.stenoai.co</div>
    </div>
  </div>
  <div class="title-block">
    <h1>${escapeHtml(title)}</h1>
${metaLine}
  </div>
${sections.join('\n')}
  <footer>
    <span>Steno is the privacy-first AI notepad for highly sensitive conversations.</span>
  </footer>
</body>
</html>`;
}
