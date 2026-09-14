import { test, expect } from '../fixtures/electron';
import { realUserDataDir, fileSig } from '../fixtures/real-user-data';
import { mkdirSync, writeFileSync, readFileSync, existsSync, readdirSync, symlinkSync } from 'fs';
import path from 'path';

/**
 * T2 — single-summary tombstone soft-delete (#234, pivot). Deleting a note HIDES
 * only its summary (an atomic rename into `output/.pending-delete/<id>/`) so every
 * backend scan stops seeing it, while the transcript/recording/sidecars stay in
 * place until COMMIT. This spec seeds a note into the temp user-data dir, drives
 * the real preload bridge, and asserts BOTH the on-disk moves AND the backend's
 * `list-meetings` visibility (the whole point of the design):
 *
 *   (a) delete  -> summary gone from output/ (under .pending-delete/<id>/), the
 *       note vanishes from list-meetings, transcript + recording REMAIN, id set.
 *   (b) undo    -> summary back at its original path, note reappears in the list,
 *       .pending-delete/<id> cleaned.
 *   (c) commit  -> summary + transcript + recording + sidecars all gone.
 *   (d) startup recovery -> a hidden summary left under .pending-delete/ before
 *       launch is recovered to output/ (note reappears — fail-safe).
 *
 * Model-free: delete/undo/commit are pure fs ops in the Electron main process;
 * list-meetings runs the real (bundled) backend but no Ollama/model/network. The
 * keystone check proves the real ~/Library/.../stenoai dir is never touched.
 */

type Meeting = {
  session_info: {
    name: string;
    summary_file: string;
    transcript_file?: string;
    audio_file?: string;
    processed_at?: string;
  };
};
type DeleteResult = { success: boolean; error?: string; id?: string; deadline?: number; message?: string };
type UndoResult = { success: boolean; error?: string; meeting?: Meeting };
type CommitResult = { success: boolean; error?: string };
type ListResult = { success: boolean; meetings?: Meeting[]; error?: string };
type PendingListResult = {
  success: boolean;
  pending?: Array<{ id: string; summaryFile: string; deadline: number; meeting: Meeting }>;
};

type StenoWindow = Window & {
  stenoai: {
    meetings: {
      list: () => Promise<ListResult>;
      delete: (meeting: Meeting) => Promise<DeleteResult>;
      undoDelete: (id: string) => Promise<UndoResult>;
      commitDelete: (id: string) => Promise<CommitResult>;
      listPendingDeletes: () => Promise<PendingListResult>;
    };
  };
};

/**
 * Seed a note's on-disk files (a valid summary .json + the reports and original
 * sidecars in output/, transcript in transcripts/, audio .wav in recordings/).
 * The summary is a parseable meeting so the real list-meetings surfaces it.
 * session_info carries ONLY summary_file (mirrors a real note) - the transcript,
 * recording and both sidecars are derived from the stem by the delete handler.
 */
function seedNote(userDataDir: string, stem: string, name: string) {
  const outputDir = path.join(userDataDir, 'output');
  const recordingsDir = path.join(userDataDir, 'recordings');
  const transcriptsDir = path.join(userDataDir, 'transcripts');
  mkdirSync(outputDir, { recursive: true });
  mkdirSync(recordingsDir, { recursive: true });
  mkdirSync(transcriptsDir, { recursive: true });

  const summaryFile = path.join(outputDir, `${stem}_summary.json`);
  const reportsSidecar = path.join(outputDir, `${stem}_reports.json`);
  const originalSidecar = path.join(outputDir, `${stem}_original.json`);
  const transcriptFile = path.join(transcriptsDir, `${stem}_transcript.txt`);
  const audioFile = path.join(recordingsDir, `${stem}.wav`);

  writeFileSync(
    summaryFile,
    JSON.stringify({
      session_info: { name, summary_file: summaryFile, processed_at: '2024-01-01T00:00:00Z' },
      summary: `Summary for ${name}`,
    }),
  );
  writeFileSync(reportsSidecar, JSON.stringify({ reports: [], active_report: null }));
  // The note-snapshot sidecar every generated note now carries. It holds the
  // model's own output for this meeting - summary, key points, action items,
  // discussion areas and the ATTENDEE NAMES - and no UI ever shows it, so if a
  // committed delete leaves it behind the meeting stays readable on disk
  // forever. Same undo semantics as the rest: it must survive the window.
  writeFileSync(
    originalSidecar,
    JSON.stringify({
      version: 1,
      captured_at: '2024-01-01T00:00:00Z',
      capture: 'generation',
      original: {
        summary: `Confidential summary for ${name}`,
        key_points: ['A sensitive key point'],
        action_items: ['A sensitive action item'],
        discussion_areas: [],
        participants: ['Alice Example', 'Bob Example'],
      },
      edited_fields: [],
      edited_at: null,
    }),
  );
  writeFileSync(transcriptFile, `transcript for ${name}`);
  // Minimal but non-empty "audio" payload — the handler never decodes it, so a
  // stub is enough to prove the recording survives the delete window.
  writeFileSync(audioFile, Buffer.from('RIFFstub-wav-bytes'));

  // Mirrors a real .md/.json note: session_info carries ONLY summary_file.
  const meeting: Meeting = { session_info: { name, summary_file: summaryFile } };
  return {
    meeting,
    summaryFile,
    reportsSidecar,
    originalSidecar,
    transcriptFile,
    audioFile,
    outputDir,
  };
}

/** Find the single hidden-summary path under output/.pending-delete/<id>/, if any. */
function hiddenSummaryPaths(outputDir: string): string[] {
  const root = path.join(outputDir, '.pending-delete');
  if (!existsSync(root)) return [];
  const out: string[] = [];
  for (const idDir of readdirSync(root)) {
    const full = path.join(root, idDir);
    for (const name of readdirSync(full)) out.push(path.join(full, name));
  }
  return out;
}

const listedFiles = async (page: import('@playwright/test').Page): Promise<string[]> => {
  const res = await page.evaluate(() => (window as StenoWindow).stenoai.meetings.list());
  expect(res.success).toBe(true);
  return (res.meetings ?? []).map((m) => m.session_info.summary_file);
};

test('delete hides only the summary (note vanishes from the backend); transcript + recording remain', async ({
  launchApp,
  userDataDir,
}) => {
  const realDirBefore = fileSig(realUserDataDir());
  const seed = seedNote(userDataDir, 'undo-alpha', 'Undo Alpha');

  const { page } = await launchApp();

  // The note is visible to the real backend before delete.
  expect(await listedFiles(page)).toContain(seed.summaryFile);

  const beforeDelete = Date.now();
  const del = await page.evaluate(
    (m) => (window as StenoWindow).stenoai.meetings.delete(m),
    seed.meeting,
  );
  expect(del.success).toBe(true);
  expect(del.id).toBeTruthy();
  // A real FUTURE deadline, not NaN/0: the undo window opens after we issued the
  // delete, so it must be a finite timestamp strictly after that point.
  expect(typeof del.deadline).toBe('number');
  expect(Number.isFinite(del.deadline)).toBe(true);
  expect(del.deadline!).toBeGreaterThan(beforeDelete);

  // The summary moved out of output/ into .pending-delete/<id>/ ...
  expect(existsSync(seed.summaryFile)).toBe(false);
  const hidden = hiddenSummaryPaths(seed.outputDir);
  expect(hidden.length).toBe(1);
  expect(path.basename(hidden[0])).toBe(path.basename(seed.summaryFile));

  // ... so the backend scan no longer sees the note (the whole point of #234) ...
  expect(await listedFiles(page)).not.toContain(seed.summaryFile);

  // ... but the transcript, recording AND both sidecars are STILL on disk
  // (unlinked only at commit - the audio is protected during the undo window,
  // and an undo has to hand back a COMPLETE note, snapshot included).
  expect(existsSync(seed.transcriptFile)).toBe(true);
  expect(existsSync(seed.audioFile)).toBe(true);
  expect(existsSync(seed.reportsSidecar)).toBe(true);
  expect(existsSync(seed.originalSidecar)).toBe(true);

  // main is the source of truth for the deadline: list-pending-deletes reports it.
  const pending = await page.evaluate(() =>
    (window as StenoWindow).stenoai.meetings.listPendingDeletes(),
  );
  expect(pending.success).toBe(true);
  const pendingEntry = pending.pending?.find((p) => p.id === del.id);
  expect(pendingEntry).toBeTruthy();
  expect(pendingEntry!.summaryFile).toBe(seed.summaryFile);
  // Cross-validate: the deadline main reports back on delete matches the one it
  // persists in the pending list — one authoritative future timestamp, not two.
  expect(pendingEntry!.deadline).toBe(del.deadline);
  expect(pendingEntry!.deadline).toBeGreaterThan(beforeDelete);

  expect(fileSig(realUserDataDir())).toBe(realDirBefore);
});

test('undo renames the summary back — the note reappears and the scaffold is cleaned', async ({
  launchApp,
  userDataDir,
}) => {
  const realDirBefore = fileSig(realUserDataDir());
  const seed = seedNote(userDataDir, 'undo-beta', 'Undo Beta');

  const { page } = await launchApp();

  const del = await page.evaluate(
    (m) => (window as StenoWindow).stenoai.meetings.delete(m),
    seed.meeting,
  );
  expect(del.success).toBe(true);
  expect(existsSync(seed.summaryFile)).toBe(false);

  const undo = await page.evaluate(
    (id) => (window as StenoWindow).stenoai.meetings.undoDelete(id),
    del.id!,
  );
  expect(undo.success).toBe(true);
  expect(undo.meeting?.session_info?.summary_file).toBe(seed.summaryFile);

  // Summary is back at its original path; the note is visible to the backend again.
  expect(existsSync(seed.summaryFile)).toBe(true);
  expect(await listedFiles(page)).toContain(seed.summaryFile);
  // The .pending-delete scaffold is cleaned up entirely.
  expect(existsSync(path.join(seed.outputDir, '.pending-delete'))).toBe(false);
  // The ancillaries never moved, so they're all still present - an undone
  // delete gives back the whole note, snapshot sidecar included.
  expect(existsSync(seed.transcriptFile)).toBe(true);
  expect(existsSync(seed.audioFile)).toBe(true);
  expect(existsSync(seed.reportsSidecar)).toBe(true);
  expect(existsSync(seed.originalSidecar)).toBe(true);

  // Nothing left pending.
  const pending = await page.evaluate(() =>
    (window as StenoWindow).stenoai.meetings.listPendingDeletes(),
  );
  expect(pending.pending?.length).toBe(0);

  expect(fileSig(realUserDataDir())).toBe(realDirBefore);
});

test('undo REFUSES when the original path was re-occupied — tombstone kept, the new note NOT clobbered (#234 P0)', async ({
  launchApp,
  userDataDir,
}) => {
  const realDirBefore = fileSig(realUserDataDir());
  const seed = seedNote(userDataDir, 'undo-collide', 'Undo Collide');

  const { page } = await launchApp();

  const del = await page.evaluate(
    (m) => (window as StenoWindow).stenoai.meetings.delete(m),
    seed.meeting,
  );
  expect(del.success).toBe(true);
  expect(existsSync(seed.summaryFile)).toBe(false);
  // The summary is hidden under .pending-delete/<id>/ (the tombstone).
  expect(hiddenSummaryPaths(seed.outputDir).length).toBe(1);

  // During the undo window a NEW note lands at the SAME original summary path
  // (the user re-recorded / re-processed to the same stem). Undo must refuse
  // rather than rename the hidden summary back OVER it — that would silently
  // destroy the new note. This is the exact P0 the no-clobber lstat guard closes.
  const newNoteBody = JSON.stringify({
    session_info: {
      name: 'Fresh Note',
      summary_file: seed.summaryFile,
      processed_at: '2025-05-05T00:00:00Z',
    },
    summary: 'A different, newer note now living at the original path',
  });
  writeFileSync(seed.summaryFile, newNoteBody);

  const undo = await page.evaluate(
    (id) => (window as StenoWindow).stenoai.meetings.undoDelete(id),
    del.id!,
  );
  expect(undo.success).toBe(false);
  expect(undo.error).toContain('restore target already exists');

  // The NEW note at the original path is byte-for-byte intact (never clobbered).
  expect(readFileSync(seed.summaryFile, 'utf8')).toBe(newNoteBody);
  // The tombstone is KEPT — the hidden summary still sits under .pending-delete,
  // so nothing was lost (undo can be retried once the collision is resolved, and
  // commit still owns final cleanup).
  expect(hiddenSummaryPaths(seed.outputDir).length).toBe(1);
  const pending = await page.evaluate(() =>
    (window as StenoWindow).stenoai.meetings.listPendingDeletes(),
  );
  expect(pending.pending?.some((p) => p.id === del.id)).toBe(true);

  expect(fileSig(realUserDataDir())).toBe(realDirBefore);
});

test('commit (explicit dismiss) permanently removes the summary + transcript + recording + sidecars', async ({
  launchApp,
  userDataDir,
}) => {
  const realDirBefore = fileSig(realUserDataDir());
  const seed = seedNote(userDataDir, 'undo-gamma', 'Undo Gamma');
  // The original-snapshot sidecar is in this list for a privacy reason, not a
  // tidiness one: it holds the meeting's substance and its attendee names, so a
  // "deleted" meeting whose sidecar survives is still readable on disk.
  const all = [
    seed.summaryFile,
    seed.transcriptFile,
    seed.audioFile,
    seed.reportsSidecar,
    seed.originalSidecar,
  ];

  const { page } = await launchApp();

  const del = await page.evaluate(
    (m) => (window as StenoWindow).stenoai.meetings.delete(m),
    seed.meeting,
  );
  expect(del.success).toBe(true);

  const commit = await page.evaluate(
    (id) => (window as StenoWindow).stenoai.meetings.commitDelete(id),
    del.id!,
  );
  expect(commit.success).toBe(true);

  // Everything is gone for good, and the scaffold is removed.
  for (const f of all) expect(existsSync(f)).toBe(false);
  expect(existsSync(path.join(seed.outputDir, '.pending-delete'))).toBe(false);

  // commit is idempotent — a second call on the same id still succeeds.
  const commitAgain = await page.evaluate(
    (id) => (window as StenoWindow).stenoai.meetings.commitDelete(id),
    del.id!,
  );
  expect(commitAgain.success).toBe(true);

  expect(fileSig(realUserDataDir())).toBe(realDirBefore);
});

test('a second delete of the same note (already pending) is rejected', async ({
  launchApp,
  userDataDir,
}) => {
  const realDirBefore = fileSig(realUserDataDir());
  const seed = seedNote(userDataDir, 'undo-delta', 'Undo Delta');

  const { page } = await launchApp();

  const del = await page.evaluate(
    (m) => (window as StenoWindow).stenoai.meetings.delete(m),
    seed.meeting,
  );
  expect(del.success).toBe(true);

  // The renderer no longer has the file (hidden), but a stale view could re-fire
  // the same delete — it must be rejected, not create a second pending entry.
  const again = await page.evaluate(
    (m) => (window as StenoWindow).stenoai.meetings.delete(m),
    seed.meeting,
  );
  expect(again.success).toBe(false);
  expect(again.error).toContain('already pending');

  expect(fileSig(realUserDataDir())).toBe(realDirBefore);
});

test('undo/commit reject a traversal / invalid id and touch nothing', async ({
  launchApp,
  userDataDir,
}) => {
  const realDirBefore = fileSig(realUserDataDir());
  const seed = seedNote(userDataDir, 'undo-epsilon', 'Undo Epsilon');
  const files = [seed.summaryFile, seed.transcriptFile, seed.audioFile, seed.reportsSidecar];

  const { page } = await launchApp();

  const badIds = ['../evil', 'a/b', '', '..', 'foo/../bar'];
  for (const id of badIds) {
    const u = await page.evaluate(
      (bad) => (window as StenoWindow).stenoai.meetings.undoDelete(bad),
      id,
    );
    expect(u.success).toBe(false);
    const c = await page.evaluate(
      (bad) => (window as StenoWindow).stenoai.meetings.commitDelete(bad),
      id,
    );
    expect(c.success).toBe(false);
  }

  // The seeded note is completely untouched by the rejected calls.
  for (const f of files) expect(existsSync(f)).toBe(true);
  expect(fileSig(realUserDataDir())).toBe(realDirBefore);
});

test('startup recovery restores a hidden summary left by a crash mid-window', async ({
  launchApp,
  userDataDir,
}) => {
  const realDirBefore = fileSig(realUserDataDir());
  // Pre-seed the on-disk state a crashed prior session would leave: the summary
  // hidden under output/.pending-delete/<id>/ (its ancillaries still in place).
  const outputDir = path.join(userDataDir, 'output');
  const transcriptsDir = path.join(userDataDir, 'transcripts');
  const recordingsDir = path.join(userDataDir, 'recordings');
  const hiddenDir = path.join(outputDir, '.pending-delete', '1700000000000-deadbeef');
  mkdirSync(hiddenDir, { recursive: true });
  mkdirSync(transcriptsDir, { recursive: true });
  mkdirSync(recordingsDir, { recursive: true });

  const stem = 'undo-zeta';
  const summaryName = `${stem}_summary.json`;
  const recoveredSummary = path.join(outputDir, summaryName);
  writeFileSync(
    path.join(hiddenDir, summaryName),
    JSON.stringify({
      session_info: {
        name: 'Undo Zeta',
        summary_file: recoveredSummary,
        processed_at: '2024-01-01T00:00:00Z',
      },
      summary: 'Summary for Undo Zeta',
    }),
  );
  writeFileSync(path.join(transcriptsDir, `${stem}_transcript.txt`), 'transcript for zeta');
  writeFileSync(path.join(recordingsDir, `${stem}.wav`), Buffer.from('RIFFstub'));

  const { page } = await launchApp();

  // On launch the hidden summary is renamed back to output/ (note REAPPEARS —
  // a lost window must never vanish a note), and the scaffold is cleaned.
  expect(existsSync(recoveredSummary)).toBe(true);
  expect(existsSync(path.join(outputDir, '.pending-delete'))).toBe(false);
  // The backend sees the recovered note.
  expect(await listedFiles(page)).toContain(recoveredSummary);

  expect(fileSig(realUserDataDir())).toBe(realDirBefore);
});

test('ancillaries are bound to the summary stem — an unrelated file named in the meeting object survives', async ({
  launchApp,
  userDataDir,
}) => {
  const realDirBefore = fileSig(realUserDataDir());
  const seed = seedNote(userDataDir, 'bind-alpha', 'Bind Alpha');
  // A second, unrelated note whose files a crafted delete of bind-alpha tries to
  // name as ITS transcript/audio. The handler must derive ancillaries from
  // bind-alpha's own stem only and never touch the victim's files.
  const victim = seedNote(userDataDir, 'bind-victim', 'Bind Victim');

  // Renderer-supplied (arbitrary) transcript_file/audio_file pointing at the
  // victim — exactly the cross-note-destruction the fix closes.
  const crafted: Meeting = {
    session_info: {
      name: 'Bind Alpha',
      summary_file: seed.summaryFile,
      transcript_file: victim.transcriptFile,
      audio_file: victim.audioFile,
    },
  };

  const { page } = await launchApp();

  const del = await page.evaluate(
    (m) => (window as StenoWindow).stenoai.meetings.delete(m),
    crafted,
  );
  expect(del.success).toBe(true);
  const commit = await page.evaluate(
    (id) => (window as StenoWindow).stenoai.meetings.commitDelete(id),
    del.id!,
  );
  expect(commit.success).toBe(true);

  // bind-alpha's OWN stem-derived ancillaries are permanently gone ...
  expect(existsSync(seed.summaryFile)).toBe(false);
  expect(existsSync(seed.transcriptFile)).toBe(false);
  expect(existsSync(seed.audioFile)).toBe(false);
  // ... but the victim's files (named in the meeting object) are UNTOUCHED.
  expect(existsSync(victim.summaryFile)).toBe(true);
  expect(existsSync(victim.transcriptFile)).toBe(true);
  expect(existsSync(victim.audioFile)).toBe(true);

  expect(fileSig(realUserDataDir())).toBe(realDirBefore);
});

test('the anomalous .json+.md twin edge FAILS SAFE — only the named summary is hidden, nothing is lost', async ({
  launchApp,
  userDataDir,
}) => {
  const realDirBefore = fileSig(realUserDataDir());
  // A note names EXACTLY ONE summary_file; the tombstone hides only that file.
  // If a stem somehow has BOTH variants (anomalous — the app's own writers only
  // ever produce <stem>_summary.md), hiding the named one leaves the other, so
  // the note stays VISIBLE (under-hides) — it NEVER over-deletes. That fail-safe
  // direction (a summary can only ever REAPPEAR, never vanish) is the whole point
  // of reverting the multi-file twin handling for user AUDIO.
  const seed = seedNote(userDataDir, 'twin-alpha', 'Twin Alpha');
  const mdTwin = path.join(seed.outputDir, 'twin-alpha_summary.md');
  writeFileSync(mdTwin, '# Twin Alpha\n\nMarkdown summary');

  const { page } = await launchApp();

  const del = await page.evaluate(
    (m) => (window as StenoWindow).stenoai.meetings.delete(m),
    seed.meeting, // names the .json summary
  );
  expect(del.success).toBe(true);

  // ONLY the named .json is hidden (one file under .pending-delete/<id>/); the
  // .md twin stays put — nothing was destroyed.
  expect(existsSync(seed.summaryFile)).toBe(false);
  expect(existsSync(mdTwin)).toBe(true);
  expect(hiddenSummaryPaths(seed.outputDir).length).toBe(1);
  // The surviving twin keeps the note VISIBLE to the backend scan (fail-safe:
  // under-hide, never over-delete).
  expect(await listedFiles(page)).toContain(mdTwin);

  // Undo restores the hidden .json; both variants are present and the scaffold
  // is cleaned. (No data was ever at risk.)
  const undo = await page.evaluate(
    (id) => (window as StenoWindow).stenoai.meetings.undoDelete(id),
    del.id!,
  );
  expect(undo.success).toBe(true);
  expect(existsSync(seed.summaryFile)).toBe(true);
  expect(existsSync(mdTwin)).toBe(true);
  expect(existsSync(path.join(seed.outputDir, '.pending-delete'))).toBe(false);

  expect(fileSig(realUserDataDir())).toBe(realDirBefore);
});

test('committing a delete does NOT unlink a same-titled OTHER note draft (_notes.txt is excluded from the delete set)', async ({
  launchApp,
  userDataDir,
}) => {
  const realDirBefore = fileSig(realUserDataDir());
  // Two notes share a display TITLE. Draft notes are stored as
  // `<safeTitle>_notes.txt` — named from the (renderer-controlled) title, NOT the
  // stem, so both notes would resolve to the SAME _notes.txt. It is therefore NOT
  // bound to the delete set: committing one note's delete must never unlink the
  // shared draft (that would silently destroy the OTHER note's notes).
  const seed = seedNote(userDataDir, 'notes-alpha', 'Shared Title');
  const safeTitle = 'Shared_Title'; // sessionName.replace(/[^a-zA-Z0-9_-]/g,'_')
  const sharedNotes = path.join(seed.outputDir, `${safeTitle}_notes.txt`);
  writeFileSync(sharedNotes, 'draft notes belonging to a same-titled note');

  const { page } = await launchApp();

  const del = await page.evaluate(
    (m) => (window as StenoWindow).stenoai.meetings.delete(m),
    seed.meeting,
  );
  expect(del.success).toBe(true);
  const commit = await page.evaluate(
    (id) => (window as StenoWindow).stenoai.meetings.commitDelete(id),
    del.id!,
  );
  expect(commit.success).toBe(true);

  // The deleted note's own stem-derived files are gone ...
  expect(existsSync(seed.summaryFile)).toBe(false);
  expect(existsSync(seed.transcriptFile)).toBe(false);
  expect(existsSync(seed.audioFile)).toBe(false);
  // ... but the title-named draft notes SURVIVE (fail-safe: orphaned, not lost).
  expect(existsSync(sharedNotes)).toBe(true);

  expect(fileSig(realUserDataDir())).toBe(realDirBefore);
});

test('delete refuses when the .pending-delete root is a symlink (fail-closed, nothing moved)', async ({
  launchApp,
  userDataDir,
}) => {
  const realDirBefore = fileSig(realUserDataDir());
  const seed = seedNote(userDataDir, 'symlink-alpha', 'Symlink Alpha');

  // Pre-plant a SYMLINK where .pending-delete would be. mkdirSync(recursive)
  // would follow it and move the summary OUT of the sandbox; the handler must
  // refuse (lstat sees a non-directory) and touch nothing.
  const pendingRoot = path.join(seed.outputDir, '.pending-delete');
  const escapeTarget = path.join(userDataDir, 'escape-target');
  mkdirSync(escapeTarget, { recursive: true });
  let symlinkOk = true;
  try {
    symlinkSync(escapeTarget, pendingRoot);
  } catch {
    symlinkOk = false;
  }
  test.skip(!symlinkOk, 'symlink creation not permitted on this OS/user');

  const { page } = await launchApp();

  const del = await page.evaluate(
    (m) => (window as StenoWindow).stenoai.meetings.delete(m),
    seed.meeting,
  );
  expect(del.success).toBe(false);
  expect(del.error).toContain('invalid pending-delete root');

  // Nothing moved: the summary + ancillaries stay put, and the escape target is
  // empty (the summary was never renamed through the symlink).
  expect(existsSync(seed.summaryFile)).toBe(true);
  expect(existsSync(seed.transcriptFile)).toBe(true);
  expect(existsSync(seed.audioFile)).toBe(true);
  expect(readdirSync(escapeTarget).length).toBe(0);

  expect(fileSig(realUserDataDir())).toBe(realDirBefore);
});

/**
 * NOTE — delete-while-busy guard (recording/queued/processing/reprocessing): main
 * refuses the delete with `note is busy (recording/processing)` when the note's
 * summary matches an active pipeline (activeReprocessJobs / processingQueue /
 * currentProcessingJob / currentRecordingAppendTarget). Simulating a genuinely
 * in-flight job here needs a real recording or a model-bearing reprocess, which
 * is out of scope for this model-free T2 lane. The guard is pure identity logic
 * (isSummaryBusy) exercised in code review; the on-disk safety it protects is
 * covered by the delete/commit tests above.
 *
 * The `regen-meeting-title` handler now registers its summaryFile in
 * activeReprocessJobs for the job's duration (like reprocess/generate-report), so
 * isSummaryBusy() blocks a delete during a title-regen model wait too. That
 * registration is model-bearing to drive end-to-end, so it's covered by the
 * source-level guard in app/regen-title-busy-guard.test.js instead.
 */
