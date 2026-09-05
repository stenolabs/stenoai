import { test, expect } from '../fixtures/electron';
import { realUserDataDir, fileSig } from '../fixtures/real-user-data';
import { mkdirSync, writeFileSync, readFileSync, existsSync, readdirSync, unlinkSync } from 'fs';
import path from 'path';

/**
 * T2 — Obsidian vault sync (#413). Model-free: seeds a note file directly in
 * `output/`, then drives the real app's settings + meeting bridges and asserts
 * on-disk vault state. No ASR/LLM. Needs the bundled backend (the config +
 * meeting IPCs shell `simple_recorder.py`); skips cleanly when it's absent.
 *
 * Covers the plan's acceptance criteria: backfill-on-enable writes a readable
 * note with Obsidian frontmatter and NO transcript; a title change renames the
 * vault file (no orphan); an externally-edited vault copy is preserved and
 * flagged (never clobbered); a deleted note's vault copy is removed on commit.
 */

type StenoWin = Window & {
  stenoai: {
    settings: {
      setObsidianVaultPath: (p: string) => Promise<unknown>;
      setObsidianSync: (v: boolean) => Promise<unknown>;
      getObsidianConflicts: () => Promise<{ success: boolean; conflicts: Record<string, unknown> }>;
    };
    meetings: {
      update: (f: string, patch: { name: string }) => Promise<unknown>;
      delete: (m: unknown) => Promise<{ id?: string; deleteId?: string } | null>;
      commitDelete: (id: string) => Promise<unknown>;
    };
  };
};

const BACKEND = path.resolve(
  __dirname, '..', '..', 'dist', 'stenoai',
  process.platform === 'win32' ? 'stenoai.exe' : 'stenoai',
);

const STEM = 'obsnote';
const NOTE_MD = `---
title: "Quarterly Planning"
date: 2026-07-20T10:00:00
is_diarised: true
---

## Summary

Ship the pricing page Friday. Bob owns the release notes.

## Participants

Alice, Bob

## Transcript

[You] we ship Friday.
[Others] I will prep the notes.

## User Notes

Follow up Monday.
`;

function vaultFiles(vault: string): string[] {
  try { return readdirSync(vault).filter((f) => f.endsWith('.md')); } catch { return []; }
}

test('backfill writes a transcript-free note; rename moves it; external edits and deletes are honoured', async ({
  launchApp,
  userDataDir,
}) => {
  test.setTimeout(180_000);
  test.skip(!existsSync(BACKEND), 'backend bundle not built');

  const realDirBefore = fileSig(realUserDataDir());

  // Seed a note directly in output/ (no pipeline needed).
  const outputDir = path.join(userDataDir, 'output');
  mkdirSync(outputDir, { recursive: true });
  const summaryPath = path.join(outputDir, `${STEM}_summary.md`);
  writeFileSync(summaryPath, NOTE_MD, 'utf8');

  // A throwaway vault, isolated under the test's userData dir.
  const vault = path.join(userDataDir, 'obs-vault');
  mkdirSync(vault, { recursive: true });

  const { page } = await launchApp();

  // Enable sync + point at the vault → backfill mirrors the seeded note.
  await page.evaluate(async (v) => {
    const s = (window as StenoWin).stenoai.settings;
    await s.setObsidianVaultPath(v);
    await s.setObsidianSync(true);
  }, vault);

  const targetName = '2026-07-20 Quarterly Planning.md';
  await expect
    .poll(() => vaultFiles(vault).includes(targetName), { timeout: 20_000, intervals: [250] })
    .toBe(true);

  const written = readFileSync(path.join(vault, targetName), 'utf8');
  expect(written).toContain('source: Steno');
  expect(written).toMatch(/steno_stem:\s*"obsnote"/);
  expect(written).toMatch(/participants:/);
  expect(written).not.toContain('## Transcript');
  expect(written).not.toContain('we ship Friday'); // transcript body gone

  // Rename via update-meeting → vault file renames, no orphan.
  await page.evaluate((f) => (window as StenoWin).stenoai.meetings.update(f, { name: 'Renamed Planning' }), summaryPath);
  const renamedName = '2026-07-20 Renamed Planning.md';
  // Wait for the new name to appear, then assert the old is gone — with the
  // actual vault contents in the message so a failure is diagnosable.
  let files: string[] = [];
  await expect
    .poll(async () => {
      files = vaultFiles(vault);
      if (files.includes(renamedName) && !files.includes(targetName)) return true;
      // Re-nudge a sync so a Windows file-lock that delayed the old-file unlink
      // gets drained (re-setting the vault path re-runs a backfill → drainStale).
      await page.evaluate((v) => (window as StenoWin).stenoai.settings.setObsidianVaultPath(v), vault);
      return false;
    }, { timeout: 30_000, intervals: [1000] })
    .toBe(true);

  // Externally edit the vault copy, then re-run a sync. Re-setting the vault
  // path re-triggers a backfill deterministically (an update-meeting with an
  // unchanged title is a backend no-op). The edit must be preserved + flagged.
  const renamedPath = path.join(vault, renamedName);
  writeFileSync(renamedPath, 'HAND-EDITED IN OBSIDIAN', 'utf8');
  await page.evaluate((v) => (window as StenoWin).stenoai.settings.setObsidianVaultPath(v), vault);
  await expect
    .poll(async () => {
      const c = await page.evaluate(() => (window as StenoWin).stenoai.settings.getObsidianConflicts());
      return Boolean(c?.success) && Object.keys(c.conflicts || {}).length > 0;
    }, { timeout: 20_000, intervals: [250] })
    .toBe(true);
  expect(readFileSync(renamedPath, 'utf8')).toBe('HAND-EDITED IN OBSIDIAN');

  // Clear the conflict by removing the vault copy, then re-sync to recreate a
  // clean tracked copy, so the delete below isn't blocked by the conflict.
  unlinkSync(renamedPath);
  await page.evaluate((v) => (window as StenoWin).stenoai.settings.setObsidianVaultPath(v), vault);
  await expect
    .poll(() => vaultFiles(vault).includes(renamedName), { timeout: 20_000, intervals: [250] })
    .toBe(true);

  const meeting = { session_info: { summary_file: summaryPath, name: 'Renamed Planning' } };
  const delId = await page.evaluate(async (m) => {
    const r = await (window as StenoWin).stenoai.meetings.delete(m);
    return (r && (r.id || r.deleteId)) || null;
  }, meeting);
  if (delId) {
    await page.evaluate((id) => (window as StenoWin).stenoai.meetings.commitDelete(id), delId);
  }
  await expect
    .poll(() => !vaultFiles(vault).includes(renamedName), { timeout: 20_000, intervals: [250] })
    .toBe(true);

  // Never touched the developer's real data dir.
  expect(fileSig(realUserDataDir())).toBe(realDirBefore);
});
