'use strict';

// Rewriting the BODY of one generated template report (a `content` string in
// the <stem>_reports.json sidecar), leaving its YAML frontmatter byte-for-byte
// alone. Pure string logic so it is unit-testable (report-body.test.js); the
// IPC handler in main.js does the path checks and the atomic write.
//
// What the renderer shows, and therefore what the user edits, is
//   splitFrontmatter(stripReasoning(content)).body
// (app/renderer/src/lib/markdown.tsx). This module mirrors both halves of that
// so the saved report reads back as exactly what was typed:
//   * reasoning blocks are hidden by the view, so they are not part of the
//     edit. A save drops them (they were never visible) rather than keeping
//     text the user can neither see nor remove.
//   * the frontmatter the view folded into "properties" is sent back verbatim
//     by the renderer and must be a prefix of the stored report, so a save can
//     keep it but never invent or alter it.

const MAX_REPORT_BODY = 512 * 1024;

// Same expression as stripReasoning in the renderer.
const REASONING_BLOCK = /(?:^[ \t]*)?<(think|thought|thinking|reasoning)>[\s\S]*?(?:<\/\1>|$(?![\s\S]))\n?/gim;
const STARTS_WITH_REASONING = /^\s*<(think|thought|thinking|reasoning)>/i;
// Any reasoning tag the user types would make the view hide part of the body.
const REASONING_TAG = /<\/?(?:think|thought|thinking|reasoning)>/i;

function stripReasoning(text) {
  if (!text) return text;
  let result = text.replace(REASONING_BLOCK, '');
  if (STARTS_WITH_REASONING.test(text)) result = result.replace(/^\n+/, '');
  return result;
}

const normalizeNewlines = (text) => String(text ?? '').replace(/\r\n?/g, '\n');

// The leading `---` ... `---` block, by delimiters only (the renderer adds a
// YAML check on top; see frontmatterBlock's callers for why delimiters are the
// right test here). Returns '' when the text does not open with one.
function leadingFrontmatterBlock(text) {
  const open = /^---[ \t]*\n/.exec(text);
  if (!open) return '';
  const rest = text.slice(open[0].length);
  const close = /^---[ \t]*$/m.exec(rest);
  if (!close) return '';
  return text.slice(0, open[0].length + close.index + close[0].length);
}

/**
 * Build the new report content, or explain why not.
 *
 * @param {string} current     the report's stored content
 * @param {string} frontmatter the block the renderer showed as properties ('' for none)
 * @param {string} body        the edited body
 * @returns {{ ok: true, content: string } | { ok: false, error: string }}
 */
function rewriteReportBody(current, frontmatter, body) {
  if (typeof current !== 'string') return { ok: false, error: 'Report has no content.' };
  if (typeof frontmatter !== 'string' || typeof body !== 'string') {
    return { ok: false, error: 'Report body must be a string.' };
  }
  if (body.length > MAX_REPORT_BODY) return { ok: false, error: 'Report is too long to save.' };
  if (REASONING_TAG.test(body)) {
    return { ok: false, error: 'A report may not contain reasoning tags like <think>.' };
  }

  const visible = normalizeNewlines(stripReasoning(current));
  const fm = normalizeNewlines(frontmatter);
  const nextBody = normalizeNewlines(body).replace(/^\n+/, '').replace(/\s+$/, '');

  if (fm) {
    // Kept frontmatter must be exactly the report's own leading block.
    if (leadingFrontmatterBlock(visible) !== fm) {
      return { ok: false, error: "The report's properties changed; reopen it and try again." };
    }
    return { ok: true, content: nextBody ? `${fm}\n\n${nextBody}\n` : `${fm}\n` };
  }

  // No properties shown: the body must not grow a frontmatter block of its own
  // (that would turn the user's text into properties on the next read). A
  // block the report ALREADY opened with, shown in the body because it was not
  // valid properties, may stay exactly as it was.
  const newBlock = leadingFrontmatterBlock(nextBody);
  if (newBlock && newBlock !== leadingFrontmatterBlock(visible)) {
    return {
      ok: false,
      error: 'A report may not start with a "---" block; it would be read as properties.',
    };
  }
  return { ok: true, content: nextBody ? `${nextBody}\n` : '' };
}

/**
 * Apply rewriteReportBody to one report of a parsed sidecar. Every other
 * report, and every other field of this one, is left as it was; `edited_at`
 * records the edit. Returns a new object, never mutates the input.
 */
function updateReportInSidecar(sidecar, reportId, frontmatter, body, now = new Date()) {
  if (!sidecar || typeof sidecar !== 'object' || !Array.isArray(sidecar.reports)) {
    return { ok: false, error: 'This note has no reports.' };
  }
  if (typeof reportId !== 'string' || !reportId) return { ok: false, error: 'Unknown report' };
  const index = sidecar.reports.findIndex((r) => r && typeof r === 'object' && r.id === reportId);
  if (index === -1) return { ok: false, error: 'Unknown report' };
  const report = sidecar.reports[index];
  const result = rewriteReportBody(report.content, frontmatter, body);
  if (!result.ok) return result;
  const reports = [...sidecar.reports];
  reports[index] = { ...report, content: result.content, edited_at: now.toISOString() };
  return { ok: true, sidecar: { ...sidecar, reports }, content: result.content };
}

module.exports = {
  MAX_REPORT_BODY,
  updateReportInSidecar,
  stripReasoning,
  leadingFrontmatterBlock,
  rewriteReportBody,
};
