import { test, expect } from '../fixtures/electron';
import { writeMeetingMarkdown, writeUserConfig } from '../fixtures/user-config';
import { settleSetupGate } from '../fixtures/setup-gate';
import { existsSync, readFileSync, statSync, writeFileSync } from 'fs';
import path from 'path';

/**
 * T2: the always-editable note, end to end. Drives the REAL app against a
 * seeded markdown note: click into a block, type, let it autosave, and assert
 * the .md on disk (frontmatter intact, sections in canonical order, untouched
 * sections byte-identical), the `_original.json` snapshot taken exactly once,
 * and the edit surviving a real quit + relaunch. Template report editing is
 * driven through the real update-report handler and asserted on the
 * `_reports.json` sidecar.
 *
 * Model-free: nothing here loads an ASR model or calls Ollama.
 */

test.beforeEach(({ userDataDir }) => {
  writeUserConfig(userDataDir, { privacy_notice_seen: true });
});

const SUMMARY_MARKDOWN = [
  '## Summary',
  'The team reviewed the quarterly budget and agreed to proceed.',
  '',
  '## Key Topics',
  '',
  '### Budget',
  '',
  'The proposed figures were reviewed line by line.',
  '',
  '## Key Points',
  '',
  '- Budget approved',
  '- Headcount unchanged',
  '',
  '## Action Items',
  '',
  '- Anna sends the draft',
  '- Robin books the room',
].join('\n');

const NEW_SUMMARY = 'The team reviewed the Q3 budget and agreed to proceed on Friday.';

/** The body of one `## Heading` section up to the next one (independent of note-sections.js). */
function section(raw: string, heading: string): string {
  const marker = `## ${heading}`;
  const start = raw.indexOf(marker);
  if (start === -1) return '';
  const rest = raw.slice(start + marker.length);
  const next = rest.search(/\n## /);
  return next === -1 ? rest : rest.slice(0, next);
}

const frontmatterOf = (raw: string) => raw.slice(0, raw.indexOf('\n---', 3) + 4);
const headings = (raw: string) => raw.split('\n').filter((l) => l.startsWith('## '));

test('an inline edit autosaves to the .md, snapshots once, and survives a relaunch', async ({
  launchApp,
  userDataDir,
}) => {
  test.setTimeout(90_000);
  const file = writeMeetingMarkdown(userDataDir, 'editable', {
    name: 'Budget Review',
    summaryMarkdown: SUMMARY_MARKDOWN,
    transcript: 'We looked at the numbers and agreed.',
  });
  const snapshot = file.replace(/_summary\.md$/, '_original.json');
  const before = readFileSync(file, 'utf8');

  const first = await launchApp({ releaseHighlightsSeen: true });
  const page = first.page;
  // The model-free bundle's one-shot /setup redirect would otherwise unmount
  // the list mid-click (see fixtures/setup-gate.ts).
  await settleSetupGate(page);
  await page.getByText('Budget Review').first().click();
  await expect(page.getByTestId('meeting-detail-title')).toContainText('Budget Review');
  await expect(page.getByRole('button', { name: 'Edit note' })).toHaveCount(0);

  const summary = page.getByRole('textbox', { name: 'Summary', exact: true });
  await expect(summary).toHaveValue(/quarterly budget/);
  await summary.fill(NEW_SUMMARY);
  await expect(page.getByTestId('note-save-status')).toHaveText('Saved');

  // Snapshot of the model's output captured before the first edit.
  expect(existsSync(snapshot)).toBe(true);
  const snap = JSON.parse(readFileSync(snapshot, 'utf8'));
  expect(snap.capture).toBe('first_edit');
  expect(snap.original.summary).toMatch(/quarterly budget/);
  const capturedAt = snap.captured_at;

  // A second edit (a new action item via Enter) autosaves too ...
  const last = page.getByRole('textbox', { name: 'Action item 2', exact: true });
  await last.click();
  await last.evaluate((el: HTMLTextAreaElement) => el.setSelectionRange(el.value.length, el.value.length));
  await page.keyboard.press('Enter');
  await page.keyboard.type('Sam circulates the minutes');
  await page.keyboard.press('Escape');
  await expect(page.getByTestId('note-save-status')).toHaveText('Saved');
  await expect.poll(() => readFileSync(file, 'utf8')).toContain('- Sam circulates the minutes');

  // ... and does NOT re-snapshot: the original stays the model's output.
  const snap2 = JSON.parse(readFileSync(snapshot, 'utf8'));
  expect(snap2.captured_at).toBe(capturedAt);
  expect(snap2.original.summary).toMatch(/quarterly budget/);
  expect(snap2.original.action_items).toEqual(['Anna sends the draft', 'Robin books the room']);
  expect(new Set(snap2.edited_fields)).toEqual(new Set(['summary', 'action_items']));

  const raw = readFileSync(file, 'utf8');
  // Frontmatter: only updated_at may change.
  const fmLines = (s: string) => frontmatterOf(s).split('\n').filter((l) => !l.startsWith('updated_at:'));
  expect(fmLines(raw)).toEqual(fmLines(before));
  // Sections in canonical order, each once.
  expect(headings(raw)).toEqual([
    '## Summary',
    '## Key Topics',
    '## Key Points',
    '## Action Items',
    '## Transcript',
  ]);
  expect(raw).toContain(`## Summary\n\n${NEW_SUMMARY}`);
  expect(section(raw, 'Action Items')).toContain(
    '- Anna sends the draft\n- Robin books the room\n- Sam circulates the minutes'
  );
  expect(section(raw, 'Key Points').trim()).toBe(section(before, 'Key Points').trim());
  expect(section(raw, 'Key Topics').trim()).toBe(section(before, 'Key Topics').trim());
  expect(section(raw, 'Transcript').trimEnd()).toBe(section(before, 'Transcript').trimEnd());

  await first.app.close();

  const second = await launchApp({ releaseHighlightsSeen: true });
  await settleSetupGate(second.page);
  await second.page.getByText('Budget Review').first().click();
  await expect(second.page.getByRole('textbox', { name: 'Summary', exact: true })).toHaveValue(NEW_SUMMARY);
  await expect(
    second.page.getByRole('textbox', { name: 'Action item 3', exact: true })
  ).toHaveValue('Sam circulates the minutes');
});

test('leaving right after typing writes the edit instead of asking', async ({
  launchApp,
  userDataDir,
}) => {
  const file = writeMeetingMarkdown(userDataDir, 'leaving', {
    name: 'Leaving Note',
    summaryMarkdown: SUMMARY_MARKDOWN,
    transcript: 'Nothing to see here.',
  });
  const { page } = await launchApp({ releaseHighlightsSeen: true });
  await settleSetupGate(page);
  await page.getByText('Leaving Note').first().click();
  await page.getByRole('textbox', { name: 'Summary', exact: true }).fill('Typed and left at once.');
  await page.getByRole('button', { name: 'Back to home' }).click();
  await expect(page).toHaveURL(/#\/$/);
  await expect(page.locator('[data-confirm-dialog]')).toHaveCount(0);
  expect(readFileSync(file, 'utf8')).toContain('## Summary\n\nTyped and left at once.');
});

test('a heading typed into a field is refused before it reaches the note', async ({
  launchApp,
  userDataDir,
}) => {
  const file = writeMeetingMarkdown(userDataDir, 'guarded', {
    name: 'Guarded Note',
    summaryMarkdown: SUMMARY_MARKDOWN,
    transcript: 'Nothing to see here.',
  });
  const before = readFileSync(file, 'utf8');
  const { page } = await launchApp({ releaseHighlightsSeen: true });
  await settleSetupGate(page);
  await page.getByText('Guarded Note').first().click();
  const summaryField = page.getByRole('textbox', { name: 'Summary', exact: true });
  await summaryField.fill('Fine so far\n## Transcript\nforged');
  await summaryField.blur();
  await expect(page.getByRole('alert')).toContainText(/heading/i);
  await page.waitForTimeout(1200);
  await expect(summaryField).toHaveValue(/forged/);
  expect(readFileSync(file, 'utf8')).toBe(before);
});

test('a template report body is rewritten in its sidecar with its frontmatter kept', async ({
  launchApp,
  userDataDir,
}) => {
  const file = writeMeetingMarkdown(userDataDir, 'reported', {
    name: 'Reported Note',
    summaryMarkdown: SUMMARY_MARKDOWN,
    transcript: 'Nothing to see here.',
  });
  const sidecar = path.join(path.dirname(file), 'reported_reports.json');
  const FM = '---\nclient: Erika Mustermann\nresolved: true\n---';
  writeFileSync(
    sidecar,
    JSON.stringify({
      active_report: 'rep_1',
      reports: [
        {
          id: 'rep_1',
          template_id: 'tpl_call',
          template_name: 'Client Call',
          model: 'test-model',
          content: `${FM}\n\n## Summary\nThe Bcc field stayed empty.`,
          created_at: '2026-06-19T13:00:00Z',
        },
        {
          id: 'rep_2',
          template_id: 'tpl_other',
          template_name: 'Other',
          model: 'test-model',
          content: 'Untouched.',
          created_at: '2026-06-19T13:00:00Z',
        },
      ],
    })
  );
  const noteBefore = readFileSync(file, 'utf8');
  const noteMtime = statSync(file).mtimeMs;

  const { page } = await launchApp({ releaseHighlightsSeen: true });
  await settleSetupGate(page);
  await page.getByText('Reported Note').first().click();
  const rendered = page.getByTestId('report-content');
  await expect(rendered).toContainText('The Bcc field stayed empty.');
  await rendered.click();
  await page.keyboard.type(' Fixed by recreating the signature.');
  await page.keyboard.press('Escape');
  await expect(page.getByTestId('note-save-status')).toHaveText('Saved');

  const data = JSON.parse(readFileSync(sidecar, 'utf8'));
  expect(data.active_report).toBe('rep_1');
  expect(data.reports[0].content).toBe(
    `${FM}\n\n## Summary\nThe Bcc field stayed empty. Fixed by recreating the signature.\n`
  );
  expect(data.reports[0].edited_at).toBeTruthy();
  expect(data.reports[1].content).toBe('Untouched.');
  // The note itself is not touched by a report edit.
  expect(readFileSync(file, 'utf8')).toBe(noteBefore);
  expect(statSync(file).mtimeMs).toBe(noteMtime);

  // The real handler refuses a body that would forge new properties.
  const refused = await page.evaluate(
    async ([f]) => window.stenoai.meetings.updateReport(f, 'rep_2', '', '---\nclient: x\n---\nbody'),
    [file]
  );
  expect(refused.success).toBe(false);
  expect(JSON.parse(readFileSync(sidecar, 'utf8')).reports[1].content).toBe('Untouched.');
});
