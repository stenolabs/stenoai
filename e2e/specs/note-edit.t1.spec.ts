import { test, expect } from '../fixtures/electron';
import { openShareMenu } from '../fixtures/share-menu';
import type { ElectronApplication, Page } from '@playwright/test';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import path from 'path';

/**
 * T1 - renderer-only, mock IPC, no backend. The INTERACTION contract of the
 * always-editable note: there is no edit mode and no Save button. The reader
 * clicks into any block and types; changes autosave (debounced, on blur, and
 * before leaving). Persistence on disk is note-editing.t2's job; what a T1 can
 * pin cheaply is that the real app shell sends exactly the right patches,
 * never sends what main would refuse, and locks the note while another writer
 * owns it.
 *
 * Seams (see app/e2e-mock-ipc.js):
 *  - STENOAI_E2E_SEED_MEETING=1 + STENOAI_E2E_EDIT_MARKDOWN=1 seed one
 *    markdown Standard note with a summary and empty key points / actions.
 *  - update-meeting overlays the note fields (they survive a page reload,
 *    the mock lives in the main process) and accumulates edited_fields like
 *    note-snapshot.js's markEdited; every call is recorded on
 *    global.__stenoaiE2eUpdateMeetingCalls (update-report likewise on
 *    __stenoaiE2eUpdateReportCalls), read back via ElectronApplication.evaluate
 *    because contextBridge's API cannot be monkey-patched from the page.
 *  - STENOAI_E2E_DEFER_NOTE_SAVE=1 holds each note write until the spec
 *    releases it, to drive the failure and retry path.
 *
 * Set STENOAI_E2E_SCREENSHOT_DIR to also capture the reading / focused /
 * saved states as PNGs (off by default, so CI writes nothing).
 */

const SUMMARY_FILE = 'epsilon_summary.md';
const ORIGINAL_SUMMARY = 'The team agreed to ship on Friday; Bob owns the release notes.';
const NEW_SUMMARY = 'The team agreed to ship on Friday, with Bob owning the release notes and QA.';
const EDIT_ENV = { STENOAI_E2E_SEED_MEETING: '1', STENOAI_E2E_EDIT_MARKDOWN: '1' };

type UpdateMeetingCall = { summaryFile: string; patch: Record<string, unknown> };
type UpdateReportCall = { summaryFile: string; reportId: string; frontmatter: string; body: string };
type ReprocessCall = { summaryFile: string };

const updateCalls = (app: ElectronApplication): Promise<UpdateMeetingCall[]> =>
  app.evaluate(
    () =>
      (global as unknown as { __stenoaiE2eUpdateMeetingCalls: UpdateMeetingCall[] })
        .__stenoaiE2eUpdateMeetingCalls,
  );

const reportCalls = (app: ElectronApplication): Promise<UpdateReportCall[]> =>
  app.evaluate(
    () =>
      (global as unknown as { __stenoaiE2eUpdateReportCalls: UpdateReportCall[] })
        .__stenoaiE2eUpdateReportCalls,
  );

const reprocessCalls = (app: ElectronApplication): Promise<ReprocessCall[]> =>
  app.evaluate(
    () =>
      (global as unknown as { __stenoaiE2eReprocessCalls: ReprocessCall[] })
        .__stenoaiE2eReprocessCalls,
  );

async function releaseNoteSave(app: ElectronApplication, success: boolean) {
  await app.evaluate((_electron, ok) => {
    const release = (global as unknown as {
      __stenoaiE2eReleaseNoteSave?: (success: boolean) => void;
    }).__stenoaiE2eReleaseNoteSave;
    if (!release) throw new Error('No note save is pending');
    release(ok);
  }, success);
}

const routeHash = (page: Page): Promise<string> => page.evaluate(() => window.location.hash);
const summaryField = (page: Page) => page.getByRole('textbox', { name: 'Summary', exact: true });
const saveStatus = (page: Page) => page.getByTestId('note-save-status');

async function openNote(page: Page, file = SUMMARY_FILE) {
  await page.evaluate((f) => {
    window.location.hash = `#/meetings/${encodeURIComponent(f)}`;
  }, file);
  await expect(page.getByTestId('meeting-detail')).toBeVisible();
}

async function shot(page: Page, name: string) {
  const dir = process.env.STENOAI_E2E_SCREENSHOT_DIR;
  if (!dir) return;
  mkdirSync(dir, { recursive: true });
  await page.screenshot({ path: path.join(dir, name) });
}

test('the note reads as a document and is editable in place, with no edit mode', async ({
  launchApp,
}) => {
  const { app, page } = await launchApp({ mockIpc: true, env: EDIT_ENV });
  await openNote(page);
  await expect(summaryField(page)).toHaveValue(ORIGINAL_SUMMARY);
  await expect(page.getByRole('button', { name: 'Edit note' })).toHaveCount(0);
  await expect(page.getByRole('button', { name: /^save$/i })).toHaveCount(0);
  // Empty sections still offer a place to type.
  await expect(page.getByRole('textbox', { name: 'Key point 1', exact: true })).toHaveValue('');
  await expect(saveStatus(page)).toHaveText('');
  await shot(page, 'inline-note-1-reading.png');
  // Merely opening or focusing the note writes nothing.
  await summaryField(page).click();
  await page.keyboard.press('Escape');
  await page.waitForTimeout(1100);
  expect(await updateCalls(app)).toHaveLength(0);
});

test('typing autosaves only the changed section and survives a reload', async ({ launchApp }) => {
  const { app, page } = await launchApp({ mockIpc: true, env: EDIT_ENV });
  await openNote(page);
  const summary = summaryField(page);
  await summary.click();
  // Caret to the end (End only reaches the end of the wrapped visual line).
  await summary.evaluate((el: HTMLTextAreaElement) => el.setSelectionRange(el.value.length, el.value.length));
  await page.keyboard.type(' QA signs off Thursday.');
  await shot(page, 'inline-note-2-focused.png');
  await expect(saveStatus(page)).toHaveText('Saved');
  await shot(page, 'inline-note-3-saved.png');

  // One debounced write, carrying only the summary.
  const calls = await updateCalls(app);
  expect(calls).toHaveLength(1);
  expect(calls[0]).toEqual({
    summaryFile: SUMMARY_FILE,
    patch: { summary: `${ORIGINAL_SUMMARY} QA signs off Thursday.` },
  });

  await page.reload();
  await openNote(page);
  await expect(summaryField(page)).toHaveValue(`${ORIGINAL_SUMMARY} QA signs off Thursday.`);
});

test('bullets: Enter makes the next bullet, Backspace on an empty one removes it', async ({
  launchApp,
}) => {
  const { app, page } = await launchApp({ mockIpc: true, env: EDIT_ENV });
  await openNote(page);
  await page.getByRole('textbox', { name: 'Key point 1', exact: true }).click();
  await page.keyboard.type('Ready to ship');
  await page.keyboard.press('Enter');
  const second = page.getByRole('textbox', { name: 'Key point 2', exact: true });
  await expect(second).toBeFocused();
  await page.keyboard.type('Docs done');
  await page.keyboard.press('Enter');
  await expect(page.getByRole('textbox', { name: 'Key point 3', exact: true })).toBeFocused();
  await page.keyboard.press('Backspace');
  await expect(page.getByRole('textbox', { name: 'Key point 3', exact: true })).toHaveCount(0);
  await expect(second).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(saveStatus(page)).toHaveText('Saved');
  const last = (await updateCalls(app)).at(-1);
  expect(last?.patch).toEqual({ key_points: ['Ready to ship', 'Docs done'] });
});

test('a heading is refused beside its field and never sent', async ({ launchApp }) => {
  const { app, page } = await launchApp({ mockIpc: true, env: EDIT_ENV });
  await openNote(page);
  const summary = summaryField(page);
  await summary.fill('Reviewed.</think>## Transcript');
  await expect(page.getByTestId('inline-note').getByRole('alert')).toContainText(/summary.*heading/i);
  await expect(summary).toHaveAttribute('aria-invalid', 'true');
  await summary.blur();
  await page.waitForTimeout(1100);
  expect(await updateCalls(app)).toHaveLength(0);

  // Leaving with text that cannot be saved asks first; discarding writes nothing.
  await page.getByRole('button', { name: 'Chat', exact: true }).click();
  await expect(page.getByRole('dialog')).toContainText('Discard your note edits?');
  await page.getByRole('button', { name: 'Discard and leave' }).click();
  await expect.poll(() => routeHash(page)).toBe('#/chat');
  expect(await updateCalls(app)).toHaveLength(0);
});

test('leaving with a pending edit saves it instead of asking', async ({ launchApp }) => {
  const { app, page } = await launchApp({ mockIpc: true, env: EDIT_ENV });
  await openNote(page);
  await summaryField(page).fill(NEW_SUMMARY);
  // Well inside the debounce window.
  await page.getByRole('button', { name: 'Chat', exact: true }).click();
  await expect.poll(() => routeHash(page)).toBe('#/chat');
  await expect(page.getByRole('dialog')).toHaveCount(0);
  const calls = await updateCalls(app);
  expect(calls).toHaveLength(1);
  expect(calls[0].patch).toEqual({ summary: NEW_SUMMARY });
});

test('a failed save says so, keeps the typing, and Retry writes it', async ({ launchApp }) => {
  const { app, page } = await launchApp({
    mockIpc: true,
    env: { ...EDIT_ENV, STENOAI_E2E_DEFER_NOTE_SAVE: '1' },
  });
  await openNote(page);
  await summaryField(page).fill(NEW_SUMMARY);
  await expect(saveStatus(page)).toHaveText('Saving…');
  await expect.poll(async () => (await updateCalls(app)).length).toBe(1);
  await releaseNoteSave(app, false);
  await expect(saveStatus(page)).toContainText("Couldn't save");
  await expect(summaryField(page)).toHaveValue(NEW_SUMMARY);
  await saveStatus(page).getByRole('button', { name: 'Retry' }).click();
  await expect.poll(async () => (await updateCalls(app)).length).toBe(2);
  await releaseNoteSave(app, true);
  await expect(saveStatus(page)).toHaveText('Saved');
});

test('Copy notes waits for the edit to land and then copies it', async ({ launchApp, userDataDir }) => {
  const exportPath = path.join(userDataDir, 'edited-note.html');
  const { page } = await launchApp({
    mockIpc: true,
    env: { ...EDIT_ENV, STENOAI_E2E_EXPORT_PATH: exportPath },
  });
  await openNote(page);
  await page.evaluate(() => {
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: {
      writeText: async (text: string) => { document.body.dataset.copiedNote = text; },
    } });
  });
  await summaryField(page).fill(NEW_SUMMARY);
  // Opening the menu flushes the autosave; the entries enable once it lands.
  const menu = await openShareMenu(page);
  await expect(menu.getByRole('button', { name: 'Copy notes', exact: true })).toBeEnabled();
  await menu.getByRole('button', { name: 'Copy notes', exact: true }).click();
  await expect(page.locator('body')).toHaveAttribute('data-copied-note', /release notes and QA/);
  const saveMenu = await openShareMenu(page);
  await saveMenu.getByRole('button', { name: 'Save notes as PDF…' }).click();
  await expect.poll(() => existsSync(exportPath)).toBe(true);
  expect(readFileSync(exportPath, 'utf8')).toContain(NEW_SUMMARY);
});

test('a processing placeholder renders read-only', async ({ launchApp }) => {
  const { app, page } = await launchApp({
    mockIpc: true,
    env: { STENOAI_E2E_SEED_PROCESSING_NOTE: '1' },
  });
  await openNote(page, 'processing_summary.md');
  await expect(page.getByTestId('note-processing')).toBeVisible();
  await expect(summaryField(page)).toHaveCount(0);
  expect(await updateCalls(app)).toHaveLength(0);
});

test('a refining note renders read-only with a hint', async ({ launchApp }) => {
  const { page } = await launchApp({
    mockIpc: true,
    env: { STENOAI_E2E_SEED_REFINING_NOTE: '1', STENOAI_E2E_MOCK_PARAKEET_INSTALLED: '1' },
  });
  await openNote(page, 'refining_summary.md');
  await expect(page.getByTestId('tab-summary-content')).toContainText('Early summary');
  await expect(summaryField(page)).toHaveCount(0);
  await expect(page.getByTestId('note-readonly-hint')).toContainText('still updating this note');
});

test('an active paused recording locks only its own note', async ({ launchApp, userDataDir }) => {
  const queuePath = path.join(userDataDir, 'paused-recording.json');
  writeFileSync(queuePath, JSON.stringify({
    hasRecording: true, isPaused: true, sessionName: 'Synthetic paused note',
    recordingSummaryFile: SUMMARY_FILE,
  }));
  const { page } = await launchApp({
    mockIpc: true,
    env: { ...EDIT_ENV, STENOAI_E2E_QUEUE_STATE_PATH: queuePath },
  });
  await openNote(page);
  await expect(page.getByTestId('note-readonly-hint')).toBeVisible();
  await expect(summaryField(page)).toHaveCount(0);
  writeFileSync(queuePath, JSON.stringify({
    hasRecording: true, isPaused: true, sessionName: 'Another synthetic note',
    recordingSummaryFile: 'another_summary.md',
  }));
  await page.reload();
  await expect(page.getByTestId('meeting-detail-title')).toContainText('Epsilon Planning');
  await expect(summaryField(page)).toBeVisible();
  await expect(page.getByTestId('note-readonly-hint')).toHaveCount(0);
});

test('the regenerate confirm appears once the note carries a saved edit', async ({ launchApp }) => {
  const { page } = await launchApp({ mockIpc: true, env: EDIT_ENV });
  await openNote(page);
  await summaryField(page).fill(NEW_SUMMARY);
  await expect(saveStatus(page)).toHaveText('Saved');
  await page.getByRole('button', { name: 'Generate notes' }).click();
  const dialog = page.locator('[data-confirm-dialog]');
  await expect(dialog).toContainText('Regenerate notes and replace your edits?');
  await expect(dialog).toContainText('Summary');
  await page.getByRole('button', { name: 'Keep my edits' }).click();
  await expect(dialog).toHaveCount(0);
  await expect(summaryField(page)).toHaveValue(NEW_SUMMARY);
});

/**
 * The floating GenerateNotesBar calls the detail's published startReprocess.
 * An edit still inside its debounce must be written BEFORE a rebuild starts,
 * and then counts as an edit to confirm - otherwise the rebuild would run
 * over text the user had on screen but not on disk.
 */
test("the floating bar writes a pending edit first, then asks before rebuilding", async ({
  launchApp,
}) => {
  const { app, page } = await launchApp({ mockIpc: true, env: { STENOAI_E2E_SEED_STALE_NOTE: '1' } });
  await openNote(page, 'stale_summary.md');
  const dock = page.getByTestId('generate-notes-dock-button');
  await expect(dock).toBeVisible();
  await summaryField(page).fill('A draft the user typed a moment ago.');
  await dock.click();
  await expect.poll(async () => (await updateCalls(app)).length).toBe(1);
  expect((await updateCalls(app))[0].patch).toEqual({ summary: 'A draft the user typed a moment ago.' });
  const dialog = page.locator('[data-confirm-dialog]');
  await expect(dialog).toContainText('Regenerate notes and replace your edits?');
  expect(await reprocessCalls(app)).toHaveLength(0);
  await page.getByRole('button', { name: 'Regenerate notes' }).click();
  await expect.poll(async () => (await reprocessCalls(app)).length).toBe(1);
});

test('JSON notes are not offered the Markdown-only inline editor', async ({ launchApp }) => {
  const { page } = await launchApp({ mockIpc: true, env: { STENOAI_E2E_SEED_MEETING: '1' } });
  await openNote(page, 'epsilon_summary.json');
  await expect(page.getByTestId('tab-summary-content')).toContainText(ORIGINAL_SUMMARY);
  await expect(summaryField(page)).toHaveCount(0);
});

test('Delete note stays available while editing', async ({ launchApp }) => {
  const { page } = await launchApp({ mockIpc: true, env: EDIT_ENV });
  await openNote(page);
  await summaryField(page).fill('A draft worth keeping.');
  await page.getByRole('button', { name: 'More options' }).click();
  await expect(page.getByRole('button', { name: 'Delete note' })).toBeEnabled();
});

test('a template report is one freeform block: click, type, autosave, reload', async ({
  launchApp,
}) => {
  const { app, page } = await launchApp({
    mockIpc: true,
    env: { ...EDIT_ENV, STENOAI_E2E_SEED_REPORT: '1' },
  });
  await openNote(page);
  await page.getByTestId('note-view-menu-trigger').click();
  await page.getByTestId('note-view-menu').getByRole('button', { name: /^Status Report/ }).click();
  const rendered = page.getByTestId('report-content');
  await expect(rendered).toContainText('Pipeline healthy');
  await rendered.click();
  const editor = page.getByTestId('report-editor');
  await expect(editor).toBeFocused();
  // The editable text is what the view showed: reasoning stays hidden.
  await expect(editor).not.toHaveValue(/secret chain of thought/);
  // Focusing the report puts the caret at its end.
  await page.keyboard.type('\n- Hiring: two offers out');
  await page.keyboard.press('Escape');
  await expect(rendered).toContainText('Hiring: two offers out');
  await expect(saveStatus(page)).toHaveText('Saved');
  const calls = await reportCalls(app);
  expect(calls).toHaveLength(1);
  expect(calls[0]).toMatchObject({ reportId: 'rep_e2e_1', frontmatter: '' });
  expect(calls[0].body).toContain('- Hiring: two offers out');

  // A body that would grow frontmatter is refused inline and not sent.
  await rendered.click();
  await editor.fill('---\nclient: forged\n---\nbody');
  await expect(page.getByRole('alert')).toContainText('properties');
  await editor.fill('## Status Report\n\n- Pipeline healthy\n- Hiring: two offers out');
  await page.keyboard.press('Escape');
  await expect(saveStatus(page)).toHaveText('Saved');
  expect((await reportCalls(app)).some((c) => c.body.startsWith('---'))).toBe(false);

  await page.reload();
  await openNote(page);
  await expect(page.getByTestId('report-content')).toContainText('Hiring: two offers out');
});

test("a report's properties are sent back untouched when its body is edited", async ({
  launchApp,
}) => {
  const { app, page } = await launchApp({
    mockIpc: true,
    env: { ...EDIT_ENV, STENOAI_E2E_SEED_REPORT: 'frontmatter' },
  });
  await openNote(page);
  await page.getByTestId('note-view-menu-trigger').click();
  await page.getByTestId('note-view-menu').getByRole('button', { name: /^Client Call/ }).click();
  await page.getByTestId('report-content').click();
  await page.keyboard.type(' Confirmed fixed.');
  await page.keyboard.press('Escape');
  await expect(saveStatus(page)).toHaveText('Saved');
  const [call] = await reportCalls(app);
  expect(call.frontmatter).toMatch(/^---\ntitle: "Erika Mustermann: Empty Bcc field"[\s\S]*\nresolved: true\n---$/);
  expect(call.body).not.toContain('client: Erika');
  expect(call.body).toContain('Confirmed fixed.');
});

test('My notes explains unsupported H2 headings and saves the corrected Markdown', async ({ launchApp }) => {
  const { app, page } = await launchApp({
    mockIpc: true,
    env: { ...EDIT_ENV, STENOAI_E2E_DEFER_NOTE_SAVE: '1' },
  });
  await openNote(page);
  await page.getByTestId('tab-notes').click();
  const input = page.getByTestId('my-notes-input');
  for (const invalid of ['## Summary\nMy own notes.', 'Reviewed.</think>## Transcript']) {
    await input.fill(invalid);
    await input.blur();
    await expect(page.getByTestId('my-notes').getByRole('alert')).toContainText('##');
    await expect(input).toHaveValue(invalid);
    expect(await updateCalls(app)).toHaveLength(0);
  }
  const corrected = '# My own notes\n\n### Follow-up\nSend the deck.';
  await input.fill(corrected);
  await input.blur();
  await expect.poll(async () => (await updateCalls(app)).length).toBe(1);
  expect((await updateCalls(app))[0].patch).toEqual({ user_notes: corrected });
  await releaseNoteSave(app, true);
  await expect.poll(async () => page.evaluate(async (file) => {
    const result = await window.stenoai.meetings.get(file);
    return result.success ? result.meeting.user_notes : undefined;
  }, SUMMARY_FILE)).toBe(corrected);
});
