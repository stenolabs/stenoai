import { describe, expect, it } from 'vitest';
import { filterRecipes } from './useSlashMenu';
import type { Recipe } from '@/lib/recipes';

const r = (id: string, label: string, description = ''): Recipe => ({ id, label, description, prompt: id, builtin: true });
const recipes = [r('recap', 'Write weekly recap', 'Summary of the week'), r('follow', 'Draft the follow-up', 'A recap email'), r('log', 'Decision log')];

describe('slash filter', () => {
  it('shows everything for a bare slash', () => {
    expect(filterRecipes(recipes, '')).toHaveLength(3);
  });
  it('matches every typed word against the name and description, ignoring case', () => {
    expect(filterRecipes(recipes, 'REC').map((x) => x.id)).toEqual(['recap', 'follow']);
    expect(filterRecipes(recipes, 'recap email').map((x) => x.id)).toEqual(['follow']);
    expect(filterRecipes(recipes, 'zzz')).toEqual([]);
  });
});
