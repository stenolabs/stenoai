import { test, expect } from '../fixtures/electron';
import { realUserDataDir, fileSig } from '../fixtures/real-user-data';
import { startMockOllama } from '../fixtures/mock-ollama';
import { writeMeetingMarkdown, writeUserConfig } from '../fixtures/user-config';
import { mkdirSync, writeFileSync, readFileSync, existsSync, readdirSync, unlinkSync } from 'fs';
import path from 'path';

/**
 * T2 - Obsidian vault sync (#413). The first scenario seeds a note file directly
 * in `output/`; the reprocess scenario uses deterministic mock Ollama responses.
 * Both drive the real app bridges and assert on-disk vault state without a real
 * ASR/LLM. Needs the bundled backend (the config + meeting IPCs shell
 * `simple_recorder.py`); skips cleanly when it is absent.
 *
 * Covers the plan's acceptance criteria: backfill-on-enable writes a readable
 * note with Obsidian frontmatter and NO transcript; a title change renames the
 * vault file (no orphan); an externally-edited vault copy is preserved and
 * flagged (never clobbered); a deleted note's vault copy is removed on commit.
 */

type ObsidianConflictInfo = {
  vaultRelPath: string;
  replacementVaultRelPath?: string;
  reason: string;
};

type StenoWin = Window & {
  stenoai: {
    settings: {
      setObsidianVaultPath: (p: string) => Promise<unknown>;
      setObsidianSync: (v: boolean) => Promise<unknown>;
      getObsidianConflicts: () => Promise<{
        success: boolean;
        conflicts: Record<string, ObsidianConflictInfo>;
      }>;
    };
    meetings: {
      reprocess: (
        summaryFile: string,
        regenerateTitle: boolean,
        name: string,
      ) => Promise<{ success: boolean; error?: string }>;
      update: (f: string, patch: { name: string }) => Promise<unknown>;
      delete: (m: unknown) => Promise<{ id?: string; deleteId?: string } | null>;
      commitDelete: (id: string) => Promise<unknown>;
    };
  };
};

const REGENERATED_REPLY = [
  '## Summary',
  'The regenerated Steno summary reached the vault.',
  '',
  '## Key Points',
  '- The edited Obsidian copy stays untouched',
  '',
  '## Action Items',
  '- Review the separate Steno copy',
  '',
].join('\n');

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

test('reprocess preserves an Obsidian edit and writes the regenerated note separately', async ({
  launchApp,
  userDataDir,
}) => {
  test.setTimeout(180_000);
  test.skip(!existsSync(BACKEND), 'backend bundle not built');

  const realDirBefore = fileSig(realUserDataDir());
  const vault = path.join(userDataDir, 'obs-reprocess-vault');
  mkdirSync(vault, { recursive: true });
  writeUserConfig(userDataDir, {
    ai_provider: 'local',
    obsidian_sync_enabled: true,
    obsidian_vault_path: vault,
  });
  const summaryPath = writeMeetingMarkdown(userDataDir, 'obs-reprocess', {
    name: 'Reprocess Conflict',
    summaryMarkdown: '## Summary\n\nOriginal summary.',
    transcript: 'Alice: regenerate this note with the current template.',
  });

  const ollama = await startMockOllama({ chatReply: REGENERATED_REPLY });
  try {
    const { app, page } = await launchApp();

    await expect
      .poll(() => vaultFiles(vault).length, { timeout: 20_000, intervals: [250] })
      .toBe(1);
    const originalName = vaultFiles(vault)[0];
    const originalPath = path.join(vault, originalName);

    // The vault write and its ownership index are separate atomic writes. Wait
    // for both before simulating an external edit so a slow Windows filesystem
    // cannot make the edit race the initial index commit.
    const statePath = path.join(userDataDir, '.obsidian-sync-state.json');
    await expect
      .poll(() => {
        try {
          const state = JSON.parse(readFileSync(statePath, 'utf8'));
          return state.notes?.['obs-reprocess']?.vaultRelPath === originalName;
        } catch {
          return false;
        }
      }, { timeout: 20_000, intervals: [250] })
      .toBe(true);
    writeFileSync(originalPath, 'HAND-EDITED IN OBSIDIAN', 'utf8');

    const result = await page.evaluate(
      (f) =>
        (window as StenoWin).stenoai.meetings.reprocess(f, false, 'Reprocess Conflict'),
      summaryPath,
    );
    expect(result.success).toBe(true);

    // Assert the short-lived toast immediately. The remaining disk and settings
    // checks can legitimately take longer than its 15-second lifetime on CI.
    const findNotificationWindow = async () => {
      // A fast duplicate completion can briefly leave the superseded toast in
      // ElectronApplication.windows() while its replacement mounts. Search
      // newest-first and require the expected payload, rather than selecting a
      // stale blank `/notification` page by URL alone.
      for (const candidate of app.windows().slice().reverse()) {
        if (candidate.isClosed()) continue;
        try {
          if (new URL(candidate.url()).hash !== '#/notification') continue;
        } catch {
          continue;
        }
        if (
          await candidate
            .getByText('Obsidian edit preserved', { exact: true })
            .isVisible()
            .catch(() => false)
        ) {
          return candidate;
        }
      }
      return undefined;
    };
    let notification: typeof page | undefined;
    await expect
      .poll(async () => {
        notification = await findNotificationWindow();
        return Boolean(notification);
      }, {
        timeout: 14_000,
        intervals: [100],
      })
      .toBe(true);
    await expect(notification!.getByText(/^Latest version saved as .+\.$/)).toBeVisible();
    await notification!.getByText('Obsidian edit preserved', { exact: true }).click();
    await expect
      .poll(() => page.evaluate(() => window.location.hash), {
        timeout: 10_000,
        intervals: [100],
      })
      .toBe(`#/meetings/${encodeURIComponent(summaryPath)}`);

    await expect
      .poll(() => vaultFiles(vault).length, { timeout: 20_000, intervals: [250] })
      .toBe(2);
    expect(readFileSync(originalPath, 'utf8')).toBe('HAND-EDITED IN OBSIDIAN');

    const replacementName = vaultFiles(vault).find((name) => name !== originalName);
    expect(replacementName).toBeTruthy();
    expect(replacementName).toContain('(obs-reprocess)');
    expect(readFileSync(path.join(vault, replacementName!), 'utf8')).toContain(
      'The regenerated Steno summary reached the vault.',
    );

    const conflicts = await page.evaluate(
      () => (window as StenoWin).stenoai.settings.getObsidianConflicts(),
    );
    expect(conflicts.success).toBe(true);
    const preservedConflict = Object.values(conflicts.conflicts).find(
      (conflict) =>
        conflict.reason === 'external-edit-preserved' && conflict.vaultRelPath === originalName,
    );
    expect(preservedConflict).toMatchObject({
      vaultRelPath: originalName,
      replacementVaultRelPath: replacementName,
      reason: 'external-edit-preserved',
    });

    await page.evaluate(() => {
      window.location.hash = '/settings?tab=integrations';
    });
    const integrations = page.locator('[data-settings-tab="integrations"]');
    await expect(integrations).toBeVisible();
    await expect(integrations.getByText(originalName, { exact: true })).toBeVisible();
    await expect(integrations.getByText(replacementName!, { exact: true })).toBeVisible();
    await expect(
      integrations.getByText(
        'Edited vault file kept on the left. Its regenerated Steno copy was saved on the right.',
      ),
    ).toBeVisible();

    expect(fileSig(realUserDataDir())).toBe(realDirBefore);
  } finally {
    await ollama.close();
  }
});
