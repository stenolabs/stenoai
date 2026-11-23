import * as React from 'react';
import type { Recipe } from '@/lib/recipes';

/** Recipes whose name or description contains every word typed after the slash. */
export function filterRecipes(recipes: Recipe[], query: string): Recipe[] {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (!words.length) return recipes;
  return recipes.filter((r) => {
    const hay = `${r.label} ${r.description}`.toLowerCase();
    return words.every((w) => hay.includes(w));
  });
}

/**
 * The `/` recipe menu for a chat composer: typing "/" opens it, the text
 * after the slash filters it ("/rec" -> "Write weekly recap"), arrow keys
 * move, Enter or Tab picks, Escape closes. Picking replaces the input with
 * the recipe's prompt.
 */
export function useSlashMenu({
  recipes,
  input,
  setInput,
  enabled,
}: {
  recipes: Recipe[];
  input: string;
  setInput: (value: string) => void;
  enabled: boolean;
}) {
  const [dismissedFor, setDismissedFor] = React.useState<string | null>(null);
  const [selected, setSelected] = React.useState(0);
  const typingSlash = enabled && input.startsWith('/') && !input.includes('\n');
  const open = typingSlash && dismissedFor !== input;
  const filtered = React.useMemo(
    () => (open ? filterRecipes(recipes, input.slice(1)) : []),
    [open, recipes, input],
  );

  // A new filter starts at the top of the list.
  React.useEffect(() => setSelected(0), [input]);

  const pick = (recipe: Recipe) => {
    setInput(recipe.prompt);
    setDismissedFor(null);
  };

  /** Handle a composer key press; true when the menu consumed it. */
  const onKeyDown = (e: React.KeyboardEvent): boolean => {
    if (!open) return false;
    if (e.key === 'Escape') {
      e.preventDefault();
      setDismissedFor(input);
      return true;
    }
    if (!filtered.length) return false;
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      const step = e.key === 'ArrowDown' ? 1 : -1;
      setSelected((i) => (i + step + filtered.length) % filtered.length);
      return true;
    }
    if ((e.key === 'Enter' && !e.shiftKey) || e.key === 'Tab') {
      e.preventDefault();
      pick(filtered[Math.min(selected, filtered.length - 1)]);
      return true;
    }
    return false;
  };

  return {
    open,
    filtered,
    selected,
    setSelected,
    pick,
    onKeyDown,
    close: () => setDismissedFor(input),
  };
}
