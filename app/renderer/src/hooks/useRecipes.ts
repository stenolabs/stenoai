import * as React from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ipc, type RecipeInput, type UserRecipe } from '@/lib/ipc';
import { unwrap } from '@/lib/result';
import { BUILTIN_RECIPES, type Recipe } from '@/lib/recipes';

const recipesKey = ['recipes'] as const;

export function toRecipe(r: UserRecipe): Recipe {
  return { id: r.id, label: r.name, prompt: r.prompt, description: r.description, builtin: false };
}

/** The user's own recipes, as stored in recipes.json. */
export function useUserRecipes() {
  return useQuery({
    queryKey: recipesKey,
    queryFn: async () => unwrap(await ipc().recipes.list()).recipes,
  });
}

/** Every recipe for the `/` menu: the user's own first (newest first), then the built-ins. */
export function useRecipes(): Recipe[] {
  const mine = useUserRecipes();
  return React.useMemo(
    () => [
      ...[...(mine.data ?? [])].sort((a, b) => b.updatedAt - a.updatedAt).map(toRecipe),
      ...BUILTIN_RECIPES,
    ],
    [mine.data],
  );
}

export function useSaveRecipe() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: RecipeInput) => unwrap(await ipc().recipes.save(input)).recipe,
    onSuccess: () => qc.invalidateQueries({ queryKey: recipesKey }),
  });
}

export function useDeleteRecipe() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (id: string) => unwrap(await ipc().recipes.remove(id)),
    onSuccess: () => qc.invalidateQueries({ queryKey: recipesKey }),
  });
}
