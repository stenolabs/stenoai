'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const {
  MAX_REPORT_BODY,
  leadingFrontmatterBlock,
  rewriteReportBody,
  updateReportInSidecar,
} = require('./report-body');

const FM = '---\ntitle: "Call"\nclient: Erika\n---';
const WITH_FM = `${FM}\n\n## Summary\nThe Bcc field stayed empty.`;

test('a report without frontmatter gets exactly the new body', () => {
  const r = rewriteReportBody('## Status\n\n- ok', '', '## Status\n\n- ok\n- shipped\n\n');
  assert.deepStrictEqual(r, { ok: true, content: '## Status\n\n- ok\n- shipped\n' });
});

test('frontmatter is kept byte for byte and only the body changes', () => {
  const r = rewriteReportBody(WITH_FM, FM, '## Summary\nFixed by recreating the signature.');
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.content, `${FM}\n\n## Summary\nFixed by recreating the signature.\n`);
  assert.strictEqual(leadingFrontmatterBlock(r.content), FM);
});

test('a frontmatter the report does not have is refused', () => {
  const r = rewriteReportBody('## Status', '---\ninjected: true\n---', 'text');
  assert.strictEqual(r.ok, false);
});

test('an altered frontmatter is refused', () => {
  const r = rewriteReportBody(WITH_FM, FM.replace('Erika', 'Mallory'), 'text');
  assert.strictEqual(r.ok, false);
});

test('a body cannot open a new frontmatter block', () => {
  const r = rewriteReportBody('## Status', '', '---\nclient: forged\n---\nbody');
  assert.strictEqual(r.ok, false);
  assert.match(r.error, /properties/);
});

test('with properties kept, a "---" block at the top of the body stays body text', () => {
  const r = rewriteReportBody(WITH_FM, FM, '---\nclient: forged\n---\nbody');
  assert.strictEqual(r.ok, true);
  assert.strictEqual(leadingFrontmatterBlock(r.content), FM);
});

test('a leading block the view showed as body text may stay as it was', () => {
  const nested = '---\nsymptoms:\n  nested: {a: 1}\n---\n## Body';
  const r = rewriteReportBody(nested, '', '---\nsymptoms:\n  nested: {a: 1}\n---\n## Body edited');
  assert.strictEqual(r.ok, true);
});

test('reasoning hidden by the view is dropped, and typed reasoning tags are refused', () => {
  const r = rewriteReportBody('<think>secret</think>\n## Status\n\n- ok', '', '## Status\n\n- ok!');
  assert.deepStrictEqual(r, { ok: true, content: '## Status\n\n- ok!\n' });
  assert.strictEqual(rewriteReportBody('## Status', '', 'a <think>b</think>').ok, false);
});

test('frontmatter after a leading reasoning block is matched the way the view sees it', () => {
  const r = rewriteReportBody(`<think>x</think>\n${WITH_FM}`, FM, 'new');
  assert.deepStrictEqual(r, { ok: true, content: `${FM}\n\nnew\n` });
});

test('CRLF content is compared and written with LF', () => {
  const crlf = WITH_FM.replace(/\n/g, '\r\n');
  const r = rewriteReportBody(crlf, FM, 'line one\r\nline two');
  assert.strictEqual(r.content, `${FM}\n\nline one\nline two\n`);
});

test('wrong types and oversize bodies are refused', () => {
  assert.strictEqual(rewriteReportBody(undefined, '', 'x').ok, false);
  assert.strictEqual(rewriteReportBody('x', null, 'x').ok, false);
  assert.strictEqual(rewriteReportBody('x', '', 42).ok, false);
  assert.strictEqual(rewriteReportBody('x', '', 'a'.repeat(MAX_REPORT_BODY + 1)).ok, false);
});

test('updateReportInSidecar rewrites only the named report', () => {
  const sidecar = {
    active_report: 'b',
    reports: [
      { id: 'a', template_name: 'A', content: 'keep me' },
      { id: 'b', template_name: 'B', content: WITH_FM, model: 'm' },
    ],
  };
  const now = new Date('2026-11-23T10:00:00Z');
  const r = updateReportInSidecar(sidecar, 'b', FM, 'edited', now);
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.sidecar.active_report, 'b');
  assert.deepStrictEqual(r.sidecar.reports[0], sidecar.reports[0]);
  assert.strictEqual(r.sidecar.reports[1].content, `${FM}\n\nedited\n`);
  assert.strictEqual(r.sidecar.reports[1].model, 'm');
  assert.strictEqual(r.sidecar.reports[1].edited_at, now.toISOString());
  assert.strictEqual(sidecar.reports[1].content, WITH_FM);
});

test('updateReportInSidecar refuses an unknown report or a malformed sidecar', () => {
  assert.strictEqual(updateReportInSidecar({ reports: [] }, 'x', '', 'b').ok, false);
  assert.strictEqual(updateReportInSidecar(null, 'x', '', 'b').ok, false);
  assert.strictEqual(updateReportInSidecar({ reports: 'no' }, 'x', '', 'b').ok, false);
});
