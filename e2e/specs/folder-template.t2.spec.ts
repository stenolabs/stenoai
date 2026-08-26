import { test, expect } from '../fixtures/electron';
import { readUserConfig } from '../fixtures/user-config';
import { realUserDataDir, fileSig } from '../fixtures/real-user-data';
import { readFileSync, existsSync } from 'fs';
import path from 'path';

/**
 * T2 — folder default template and recurring-title routing rules.
 * Drives the preload bridge (window.stenoai.folders) and asserts both
 * the returned IPC payloads AND on-disk folders.json in the temp user-data dir.
 * Verifies that folder template configuration and recurring titles are persisted,
 * that clearing restores inheritance, and that folder-level template settings
 * remain independent of the global default_template_id in config.json.
 */

type Folder = {
  id: string;
  name: string;
  color?: string;
  order?: number;
  icon?: string;
  template_id?: string | null;
  recurring_titles?: string[];
};

type ListFoldersResult = { success: boolean; folders: Folder[] };
type CreateFolderResult = { success: boolean; folder?: Folder };
type Result = { success: boolean; error?: string };

type Template = { id: string; name: string; builtin: boolean; locked: boolean };
type ListTemplatesResult = {
  success: boolean;
  templates: Template[];
  default_template_id: string;
};

type StenoWindow = Window & {
  stenoai: {
    folders: {
      list: () => Promise<ListFoldersResult>;
      create: (name: string, color?: string) => Promise<CreateFolderResult>;
      rename: (id: string, name: string) => Promise<Result>;
      delete: (id: string) => Promise<Result>;
      reorder: (ids: string[]) => Promise<Result>;
      setTemplate: (id: string, templateId?: string | null) => Promise<Result>;
      setRecurring: (id: string, titles: string[]) => Promise<Result>;
    };
    templates: {
      list: () => Promise<ListTemplatesResult>;
      save: (t: Record<string, unknown>) => Promise<{ success: boolean; template?: { id: string } }>;
      setDefault: (id: string) => Promise<Result>;
    };
  };
};

function readFoldersJson(userDataDir: string): Folder[] {
  const p = path.join(userDataDir, 'folders.json');
  if (!existsSync(p)) return [];
  return (JSON.parse(readFileSync(p, 'utf8')).folders ?? []) as Folder[];
}

test('folder template: set and clear template_id on folder, independent of global default', async ({
  launchApp,
  userDataDir,
}) => {
  const realDirBefore = fileSig(realUserDataDir());
  const { page } = await launchApp();

  // Create a test folder.
  const createRes = await page.evaluate(
    () => (window as unknown as StenoWindow).stenoai.folders.create('Engineering', '#6366f1'),
  );
  expect(createRes.success).toBe(true);
  const folderId = createRes.folder!.id;

  // Global default template starts as 'standard'.
  const initialTemplates = await page.evaluate(
    () => (window as unknown as StenoWindow).stenoai.templates.list(),
  );
  expect(initialTemplates.success).toBe(true);
  expect(initialTemplates.default_template_id).toBe('standard');
  expect(readUserConfig(userDataDir).default_template_id ?? 'standard').toBe('standard');

  // Initially, folder has no template_id set (inherits global default).
  let onDisk = readFoldersJson(userDataDir).find((f) => f.id === folderId);
  expect(onDisk?.template_id).toBeUndefined();

  // Set folder template to 'shareable-summary'.
  const setRes = await page.evaluate(
    (id) => (window as unknown as StenoWindow).stenoai.folders.setTemplate(id, 'shareable-summary'),
    folderId,
  );
  expect(setRes.success).toBe(true);

  // Assert persisted to folders.json and returned in list-folders.
  await expect
    .poll(() => readFoldersJson(userDataDir).find((f) => f.id === folderId)?.template_id)
    .toBe('shareable-summary');

  const listAfterSet = await page.evaluate(
    () => (window as unknown as StenoWindow).stenoai.folders.list(),
  );
  expect(listAfterSet.folders.find((f) => f.id === folderId)?.template_id).toBe('shareable-summary');

  // Global default in config.json remains untouched ('standard').
  expect(readUserConfig(userDataDir).default_template_id ?? 'standard').toBe('standard');

  // Clear folder template back to null (inheriting global default).
  const clearRes = await page.evaluate(
    (id) => (window as unknown as StenoWindow).stenoai.folders.setTemplate(id, null),
    folderId,
  );
  expect(clearRes.success).toBe(true);

  // Assert template_id is removed from folders.json and list-folders.
  await expect
    .poll(() => readFoldersJson(userDataDir).find((f) => f.id === folderId)?.template_id)
    .toBeUndefined();

  const listAfterClear = await page.evaluate(
    () => (window as unknown as StenoWindow).stenoai.folders.list(),
  );
  expect(listAfterClear.folders.find((f) => f.id === folderId)?.template_id).toBeUndefined();

  // Changing global default does not mutate folder record in folders.json.
  await page.evaluate(
    () => (window as unknown as StenoWindow).stenoai.templates.setDefault('shareable-summary'),
  );
  await expect
    .poll(() => readUserConfig(userDataDir).default_template_id)
    .toBe('shareable-summary');

  onDisk = readFoldersJson(userDataDir).find((f) => f.id === folderId);
  expect(onDisk?.template_id).toBeUndefined();

  // Keystone: real user-data dir untouched.
  expect(fileSig(realUserDataDir())).toBe(realDirBefore);
});

test('folder recurring: set, update, and clear recurring_titles with trimming and empty filtering', async ({
  launchApp,
  userDataDir,
}) => {
  const realDirBefore = fileSig(realUserDataDir());
  const { page } = await launchApp();

  // Create a folder for recurring meetings.
  const createRes = await page.evaluate(
    () => (window as unknown as StenoWindow).stenoai.folders.create('Weekly Syncs', '#10b981'),
  );
  expect(createRes.success).toBe(true);
  const folderId = createRes.folder!.id;

  // Set recurring titles with leading/trailing spaces.
  const titles = ['  Engineering Standup  ', 'Design Review', ' 1:1 Sync '];
  const setRes = await page.evaluate(
    ({ id, t }) => (window as unknown as StenoWindow).stenoai.folders.setRecurring(id, t),
    { id: folderId, t: titles },
  );
  expect(setRes.success).toBe(true);

  // Assert trimmed and persisted to folders.json.
  const expectedTrimmed = ['Engineering Standup', 'Design Review', '1:1 Sync'];
  await expect
    .poll(() => readFoldersJson(userDataDir).find((f) => f.id === folderId)?.recurring_titles)
    .toEqual(expectedTrimmed);

  const listRes = await page.evaluate(
    () => (window as unknown as StenoWindow).stenoai.folders.list(),
  );
  expect(listRes.folders.find((f) => f.id === folderId)?.recurring_titles).toEqual(expectedTrimmed);

  // Update by removing one title and adding a new one.
  const updatedTitles = ['Engineering Standup', 'All Hands'];
  const updateRes = await page.evaluate(
    ({ id, t }) => (window as unknown as StenoWindow).stenoai.folders.setRecurring(id, t),
    { id: folderId, t: updatedTitles },
  );
  expect(updateRes.success).toBe(true);

  await expect
    .poll(() => readFoldersJson(userDataDir).find((f) => f.id === folderId)?.recurring_titles)
    .toEqual(updatedTitles);

  // Clearing: passing empty list or only whitespace strings removes recurring_titles from disk.
  const clearRes = await page.evaluate(
    ({ id, t }) => (window as unknown as StenoWindow).stenoai.folders.setRecurring(id, t),
    { id: folderId, t: ['   ', ''] },
  );
  expect(clearRes.success).toBe(true);

  await expect
    .poll(() => readFoldersJson(userDataDir).find((f) => f.id === folderId)?.recurring_titles)
    .toBeUndefined();

  // Keystone: real user-data dir untouched.
  expect(fileSig(realUserDataDir())).toBe(realDirBefore);
});
