import { test, expect } from '../fixtures/electron';
import { readFileSync } from 'fs';
import path from 'path';

/**
 * T2 — recipes persist through the real main-process store (recipes-store.js)
 * to <userData>/recipes.json: create, update, list, delete, and bad input
 * refused. Model-free; the UI is covered by recipes.t1.
 */

type Recipe = { id: string; name: string; description: string; prompt: string; updatedAt: number };
type Bridge = {
  recipes: {
    list: () => Promise<{ success: boolean; recipes: Recipe[] }>;
    save: (r: Partial<Recipe>) => Promise<{ success: boolean; recipe?: Recipe; error?: string }>;
    remove: (id: string) => Promise<{ success: boolean; deleted?: boolean }>;
  };
};

test('recipes round-trip to recipes.json', async ({ launchApp, userDataDir }) => {
  const { page } = await launchApp();
  const call = <T,>(fn: (b: Bridge) => Promise<T>) =>
    page.evaluate(`(${fn.toString()})(window.stenoai)`) as Promise<T>;
  const onDisk = () =>
    JSON.parse(readFileSync(path.join(userDataDir, 'recipes.json'), 'utf8')).recipes as Recipe[];

  const made = await call((b) => b.recipes.save({ name: 'Standup digest', prompt: 'Summarise standups.' }));
  expect(made.success).toBe(true);
  const id = made.recipe!.id;
  expect(onDisk()).toEqual([expect.objectContaining({ id, name: 'Standup digest', prompt: 'Summarise standups.' })]);

  const updated = await page.evaluate(
    (rid) => (window as unknown as { stenoai: Bridge }).stenoai.recipes.save({ id: rid, name: 'Standups', prompt: 'New.' }),
    id,
  );
  expect(updated.success).toBe(true);
  expect(onDisk()[0]).toEqual(expect.objectContaining({ id, name: 'Standups', prompt: 'New.' }));
  expect((await call((b) => b.recipes.list())).recipes.map((r) => r.name)).toEqual(['Standups']);

  const bad = await call((b) => b.recipes.save({ name: '', prompt: 'x' }));
  expect(bad.success).toBe(false);

  const removed = await page.evaluate(
    (rid) => (window as unknown as { stenoai: Bridge }).stenoai.recipes.remove(rid),
    id,
  );
  expect(removed).toEqual({ success: true, deleted: true });
  expect(onDisk()).toEqual([]);
});
