import * as React from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ipc, type ChatRecipe } from '@/lib/ipc';
import { unwrap } from '@/lib/result';

export const recipesKeys = {
  all: ['recipes'] as const,
  list: () => [...recipesKeys.all, 'list'] as const,
};

type RecipesListData = { recipes: ChatRecipe[] };

export function useRecipes() {
  const q = useQuery({
    queryKey: recipesKeys.list(),
    queryFn: async () => {
      const res = await ipc().recipes.list();
      return unwrap(res);
    },
  });
  return {
    recipes: (q.data?.recipes ?? []) as ChatRecipe[],
    isLoading: q.isLoading,
    error: q.error,
  };
}

export function useSaveRecipe() {
  const qc = useQueryClient();
  const latestAttempt = React.useRef(0);
  return useMutation({
    mutationFn: async (r: { id?: string; label: string; prompt: string }) => {
      const res = await ipc().recipes.save(r);
      return unwrap(res);
    },
    onMutate: async (newRecipe) => {
      const attempt = ++latestAttempt.current;
      await qc.cancelQueries({ queryKey: recipesKeys.list() });
      const previous = qc.getQueryData<RecipesListData>(recipesKeys.list());
      qc.setQueryData<RecipesListData>(recipesKeys.list(), (old) => {
        const existing = old?.recipes ?? [];
        const id =
          newRecipe.id ??
          (newRecipe.label.toLowerCase().replace(/[^a-z0-9]+/g, '-') || 'recipe');
        const updatedItem: ChatRecipe = {
          id,
          label: newRecipe.label,
          prompt: newRecipe.prompt,
        };
        const idx = existing.findIndex((r) => r.id === id);
        const nextList =
          idx >= 0
            ? existing.map((r, i) => (i === idx ? updatedItem : r))
            : [...existing, updatedItem];
        return { recipes: nextList };
      });
      return { previous, attempt };
    },
    onError: (_err, _vars, context) => {
      if (context?.previous && context.attempt === latestAttempt.current) {
        qc.setQueryData(recipesKeys.list(), context.previous);
      }
    },
    onSettled: (_data, _err, _vars, context) => {
      if (context && context.attempt !== latestAttempt.current) return;
      return qc.invalidateQueries({ queryKey: recipesKeys.all });
    },
  });
}

export function useDeleteRecipe() {
  const qc = useQueryClient();
  const latestAttempt = React.useRef(0);
  return useMutation({
    mutationFn: async (id: string) => {
      const res = await ipc().recipes.delete(id);
      return unwrap(res);
    },
    onMutate: async (id: string) => {
      const attempt = ++latestAttempt.current;
      await qc.cancelQueries({ queryKey: recipesKeys.list() });
      const previous = qc.getQueryData<RecipesListData>(recipesKeys.list());
      qc.setQueryData<RecipesListData>(recipesKeys.list(), (old) => {
        const existing = old?.recipes ?? [];
        return { recipes: existing.filter((r) => r.id !== id) };
      });
      return { previous, attempt };
    },
    onError: (_err, _id, context) => {
      if (context?.previous && context.attempt === latestAttempt.current) {
        qc.setQueryData(recipesKeys.list(), context.previous);
      }
    },
    onSettled: (_data, _err, _id, context) => {
      if (context && context.attempt !== latestAttempt.current) return;
      return qc.invalidateQueries({ queryKey: recipesKeys.all });
    },
  });
}
