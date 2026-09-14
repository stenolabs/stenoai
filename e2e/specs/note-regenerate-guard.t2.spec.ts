import { test, expect } from '../fixtures/electron';
import { writeUserConfig } from '../fixtures/user-config';
import { startMockOllama } from '../fixtures/mock-ollama';
import { mkdirSync, writeFileSync, readFileSync, existsSync } from 'fs';
import path from 'path';

/**
 * T2 - the data the regenerate guard runs on, driven through the REAL preload
 * bridge against the REAL get-meeting/update-meeting handlers.
 *
 * The guard in MeetingDetail only ever fires on `meeting.edited_fields`. If that
 * field never leaves main, the confirm dialog is decorative and a regenerate
 * still silently discards the user's corrections - a failure that looks exactly
 * like a working guard from inside the renderer's own unit tests, because those
 * hand the component the field directly. So this spec asserts the whole chain:
 * edit a note through update-meeting, then read it back through get-meeting and
 * check what actually arrives.
 *
 * The other half is the false positive. A note with no sidecar, a note whose
 * sidecar is corrupt, and a note that was generated but never edited must all
 * come back with an empty list, or the dialog fires on notes with nothing to
 * lose and users learn to click through it.
 *
 * Model-free: a seeded note plus the note IPCs, no ASR and no Ollama.
 */

const NOTE = [
  '---',
  'title: "Quarterly Review"',
  'date: "2026-07-28T10:00:00"',
  'duration_seconds: 600',
  'language: "en"',
  'is_diarised: false',
  '---',
  '',
  '## Summary',
  '',
  'The team agreed to ship on Friday.',
  '',
  '## Key Topics',
  '',
  '### Billing',
  '',
  'The migration is blocked on the vendor.',
  '',
  '## Key Points',
  '',
  '- Ship Friday',
  '',
  '## Action Items',
  '',
  '- Alice pings the vendor',
  '',
  '## Transcript',
  '',
  'Alice: we ship Friday.',
  '',
].join('\n');

function seedNote(userDataDir: string, stem: string) {
  const outputDir = path.join(userDataDir, 'output');
  mkdirSync(outputDir, { recursive: true });
  const summaryPath = path.join(outputDir, `${stem}_summary.md`);
  writeFileSync(summaryPath, NOTE, 'utf-8');
  return { summaryPath, sidecarPath: path.join(outputDir, `${stem}_original.json`) };
}

test('an edited note reports its edited sections to the renderer', async ({
  launchApp,
  userDataDir,
}) => {
  test.setTimeout(60_000);
  const { summaryPath, sidecarPath } = seedNote(userDataDir, 'edited');

  const { page } = await launchApp();
  const get = (f: string) =>
    page.evaluate(async (file) => {
      const r = await window.stenoai.meetings.get(file as string);
      return r.success ? r.meeting : { error: r.error };
    }, f);
  const update = (patch: Record<string, unknown>) =>
    page.evaluate(
      ([f, p]) => window.stenoai.meetings.update(f as string, p as object),
      [summaryPath, patch] as const,
    );

  // Before any edit: the note has no sidecar at all.
  expect(existsSync(sidecarPath)).toBe(false);
  expect((await get(summaryPath)).edited_fields).toEqual([]);

  expect(await update({ summary: 'The team agreed to ship on Monday.' })).toMatchObject({
    success: true,
  });
  expect((await get(summaryPath)).edited_fields).toEqual(['summary']);

  expect(await update({ action_items: ['Alice calls the vendor'] })).toMatchObject({
    success: true,
  });
  // Accumulates, and the renderer sees exactly what the sidecar holds.
  expect(((await get(summaryPath)).edited_fields as string[]).slice().sort()).toEqual([
    'action_items',
    'summary',
  ]);
  const onDisk = JSON.parse(readFileSync(sidecarPath, 'utf8'));
  expect(onDisk.edited_fields.slice().sort()).toEqual(['action_items', 'summary']);
  // The sidecar is the diff base a later regenerate would warn against
  // discarding - it has to hold the PRE-edit values, not the edited ones, and
  // be marked as captured at the moment of a first edit (not at generation,
  // since this note predates the sidecar and was snapshotted lazily by main).
  expect(onDisk.original.summary).toBe('The team agreed to ship on Friday.');
  expect(onDisk.original.action_items).toEqual(['Alice pings the vendor']);
  expect(onDisk.capture).toBe('first_edit');
});

test('a note that was never edited reports no edited sections', async ({
  launchApp,
  userDataDir,
}) => {
  test.setTimeout(60_000);
  // A generated-but-unedited note: a version-1 sidecar with an empty list, the
  // shape simple_recorder.py writes after every generation and regeneration.
  const { summaryPath, sidecarPath } = seedNote(userDataDir, 'pristine');
  writeFileSync(
    sidecarPath,
    JSON.stringify({
      version: 1,
      captured_at: '2026-07-28T10:00:00',
      capture: 'generation',
      original: {
        summary: 'The team agreed to ship on Friday.',
        key_points: ['Ship Friday'],
        action_items: ['Alice pings the vendor'],
        discussion_areas: [],
        participants: [],
      },
      edited_fields: [],
      edited_at: null,
    }),
    'utf-8',
  );

  const { page } = await launchApp();
  const meeting = await page.evaluate(async (file) => {
    const r = await window.stenoai.meetings.get(file as string);
    return r.success ? r.meeting : { error: r.error };
  }, summaryPath);
  expect(meeting.edited_fields).toEqual([]);
});

/**
 * The other half of the guard's life cycle. Firing is only half a working
 * confirm: it also has to STOP firing once the thing it warns about is gone.
 * A regenerate discards the edits (the user confirmed it, or there was nothing
 * open to protect), so the note is unedited again and the next regenerate must
 * go through in silence. Without the reset the dialog would appear on every
 * later regenerate forever, and a warning that always appears is one people
 * learn to click through - which costs exactly the edits it exists to protect.
 *
 * Driven through the REAL reprocess against the capturing mock Ollama (the
 * `summarize-contract.t2` pattern): no ASR, no real model, but the actual
 * `_write_original_snapshot` call that performs the reset.
 */
test('a regenerate clears the edits, so the next one does not warn', async ({
  launchApp,
  userDataDir,
}) => {
  test.setTimeout(90_000);
  const { summaryPath, sidecarPath } = seedNote(userDataDir, 'relooped');

  const ollama = await startMockOllama({
    port: 0,
    chatReply: [
      '## Summary',
      'A freshly generated summary.',
      '',
      '## Key Points',
      '- Ship Friday',
      '',
      '## Action Items',
      '- Alice pings the vendor',
      '',
    ].join('\n'),
  });
  try {
    writeUserConfig(userDataDir, { ai_provider: 'remote', remote_ollama_url: ollama.url, privacy_notice_seen: true });
    const { page } = await launchApp();
    const editedFields = () =>
      page.evaluate(async (file) => {
        const r = await window.stenoai.meetings.get(file as string);
        return r.success ? r.meeting.edited_fields : { error: r.error };
      }, summaryPath);

    // 1. Edit it. The guard now has something to warn about.
    const saved = await page.evaluate(
      ([f, p]) => window.stenoai.meetings.update(f as string, p as object),
      [summaryPath, { summary: 'A correction the user typed.' }] as const,
    );
    expect(saved).toMatchObject({ success: true });
    expect(await editedFields()).toEqual(['summary']);

    // 2. Regenerate. This is the run that discards the correction.
    const res = await page.evaluate(
      (f) => window.stenoai.meetings.reprocess(f as string, false, 'Quarterly Review'),
      summaryPath,
    );
    expect(res.success).toBe(true);
    await expect
      .poll(() => readFileSync(summaryPath, 'utf8'), { timeout: 60_000 })
      .toContain('A freshly generated summary.');

    // 3. The record of the edit is gone, so the NEXT regenerate would not
    //    prompt: `edited_fields` is the only input the confirm fires on, and
    //    the renderer only ever sees it through this call.
    await expect.poll(() => editedFields(), { timeout: 30_000 }).toEqual([]);
    const onDisk = JSON.parse(readFileSync(sidecarPath, 'utf8'));
    expect(onDisk.edited_fields).toEqual([]);
    expect(onDisk.edited_at).toBeNull();
    // And the diff base moved on with the note: the snapshot describes the text
    // that is in the file now, not the pre-edit text it replaced.
    expect(onDisk.original.summary).toBe('A freshly generated summary.');

    // 4. A fresh edit re-arms it, so the reset is a reset and not a fuse that
    //    can only blow once.
    expect(
      await page.evaluate(
        ([f, p]) => window.stenoai.meetings.update(f as string, p as object),
        [summaryPath, { summary: 'Corrected again.' }] as const,
      ),
    ).toMatchObject({ success: true });
    expect(await editedFields()).toEqual(['summary']);
  } finally {
    await ollama.close();
  }
});

test('a corrupt sidecar reports no edited sections instead of failing the note', async ({
  launchApp,
  userDataDir,
}) => {
  test.setTimeout(60_000);
  const { summaryPath, sidecarPath } = seedNote(userDataDir, 'corrupt');
  writeFileSync(sidecarPath, '{ not json', 'utf-8');

  const { page } = await launchApp();
  const meeting = await page.evaluate(async (file) => {
    const r = await window.stenoai.meetings.get(file as string);
    return r.success ? r.meeting : { error: r.error };
  }, summaryPath);
  // The note itself still opens - the sidecar is a diff base, not a dependency.
  expect(meeting.summary).toBe('The team agreed to ship on Friday.');
  expect(meeting.edited_fields).toEqual([]);
});
