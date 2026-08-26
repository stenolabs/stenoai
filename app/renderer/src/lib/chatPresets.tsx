import * as React from 'react';
import { Trash2 } from 'lucide-react';
import { cn } from '@/lib/utils';
import type { ChatRecipe } from '@/lib/ipc';
import { useSaveRecipe } from '@/hooks/useRecipes';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';

// Templated preset prompts surfaced two ways:
//   1. Chip row at the bottom of the /chat entry page (always visible).
//   2. Popover triggered by typing '/' as the first character in either
//      composer (entry page or /chat/<id> conversation page).
// Edit the list here; both call sites pick it up automatically.
export interface ChatPreset {
  label: string;
  prompt: string;
  description: string;
}

export const PRESETS: ChatPreset[] = [
  {
    label: 'List recent todos',
    prompt: 'List my action items from the last week.',
    description: 'Pulls outstanding to-dos from recent meeting notes',
  },
  {
    label: 'Coach me',
    prompt: 'Coach me on my recent meetings — patterns, blind spots, things to work on.',
    description: 'Looks for patterns and suggests areas to improve',
  },
  {
    label: 'Write weekly recap',
    prompt: 'Write a recap of this week based on my notes.',
    description: 'Summary of the week across every meeting',
  },
  {
    label: 'Blind spots',
    prompt: 'What blind spots have come up across my recent meetings?',
    description: 'Surfaces themes you may have missed',
  },
];

export const PRESET_COLORS = ['#3B82F6', '#10B981', '#F97316', '#A855F7', '#EAB308'];

/** Slash glyph used as the leading icon on every preset chip + popover
 *  row. Reinforces the "/" keyboard shortcut. Defaults to plain grey but 
 *  accepts a color prop to render a tinted background for visual variety. */
export function PresetGlyph({ color = 'var(--fg-2)', size = 18 }: { color?: string; size?: number }) {
  return (
    <span
      aria-hidden
      className="inline-flex flex-shrink-0 items-center justify-center rounded-md font-mono font-semibold leading-none"
      style={{
        width: size,
        height: size,
        fontSize: Math.round(size * 0.7),
        color,
        background: `color-mix(in srgb, ${color} 15%, transparent)`,
      }}
    >
      /
    </span>
  );
}

export interface UnifiedRecipeItem {
  id: string;
  label: string;
  prompt: string;
  description?: string;
  builtin: boolean;
}

export interface ChatRecipesMenuContentProps {
  items: UnifiedRecipeItem[];
  selectedIndex: number;
  onSelectIndex: (idx: number) => void;
  onPick: (prompt: string) => void;
  onDeleteRequest?: (item: UnifiedRecipeItem) => void;
  filterQuery?: string;
}

export function ChatRecipesMenuContent({
  items,
  selectedIndex,
  onSelectIndex,
  onPick,
  onDeleteRequest,
  filterQuery = '',
}: ChatRecipesMenuContentProps) {
  if (items.length === 0) {
    return (
      <div
        className="px-3 py-4 text-center text-[13px]"
        style={{ color: 'var(--fg-muted)' }}
        data-testid="recipes-empty-state"
      >
        No matching recipes or skills{filterQuery ? ` for "/${filterQuery}"` : ''}
      </div>
    );
  }

  const customItems = items.filter((it) => !it.builtin);
  const builtinItems = items.filter((it) => it.builtin);

  return (
    <div className="flex max-h-[320px] flex-col overflow-y-auto p-1" data-testid="chat-recipes-menu">
      {customItems.length > 0 && (
        <div className="flex flex-col mb-1">
          <div
            className="px-2 pb-1 pt-1 text-[11px] font-medium tracking-wide uppercase"
            style={{ color: 'var(--fg-muted)' }}
          >
            Recipes
          </div>
          {customItems.map((item) => {
            const globalIndex = items.indexOf(item);
            const isSelected = globalIndex === selectedIndex;
            return (
              <div
                key={item.id}
                data-testid={`recipe-item-${item.id}`}
                className={cn(
                  'group flex items-center justify-between gap-1 rounded-md px-2 py-1.5 text-left transition-colors hover:bg-[color:var(--surface-hover)] cursor-pointer',
                  isSelected ? 'bg-[color:var(--surface-hover)]' : ''
                )}
                onMouseEnter={() => onSelectIndex(globalIndex)}
                onClick={() => onPick(item.prompt)}
              >
                <div className="flex flex-1 flex-col items-start gap-0.5 text-left outline-none min-w-0">
                  <div
                    className="flex items-center gap-2 text-[13px] font-medium truncate w-full"
                    style={{ color: 'var(--fg-1)' }}
                  >
                    <PresetGlyph color="var(--fg-1)" />
                    <span className="truncate">{item.label}</span>
                  </div>
                  <div
                    className="pl-[26px] text-[12px] truncate w-full"
                    style={{ color: 'var(--fg-2)' }}
                  >
                    {item.prompt}
                  </div>
                </div>
                {onDeleteRequest && (
                  <button
                    type="button"
                    onClick={(e) => {
                      e.stopPropagation();
                      onDeleteRequest(item);
                    }}
                    className="inline-flex size-6 shrink-0 items-center justify-center rounded text-[color:var(--fg-muted)] opacity-0 transition-opacity hover:bg-[color:var(--danger-bg)] hover:text-[color:var(--danger)] group-hover:opacity-100 group-focus-within:opacity-100 focus:opacity-100"
                    aria-label={`Delete recipe "${item.label}"`}
                    data-testid={`delete-recipe-btn-${item.id}`}
                    title="Delete recipe"
                  >
                    <Trash2 size={13} />
                  </button>
                )}
              </div>
            );
          })}
        </div>
      )}

      {builtinItems.length > 0 && (
        <div className="flex flex-col">
          <div
            className="px-2 pb-1 pt-1 text-[11px] font-medium tracking-wide uppercase"
            style={{ color: 'var(--fg-muted)' }}
          >
            Presets
          </div>
          {builtinItems.map((item) => {
            const globalIndex = items.indexOf(item);
            const isSelected = globalIndex === selectedIndex;
            const presetColor = PRESET_COLORS[globalIndex % PRESET_COLORS.length];
            return (
              <div
                key={item.id}
                data-testid={`recipe-item-${item.id}`}
                className={cn(
                  'group flex items-center justify-between gap-1 rounded-md px-2 py-1.5 text-left transition-colors hover:bg-[color:var(--surface-hover)] cursor-pointer',
                  isSelected ? 'bg-[color:var(--surface-hover)]' : ''
                )}
                onMouseEnter={() => onSelectIndex(globalIndex)}
                onClick={() => onPick(item.prompt)}
              >
                <div className="flex flex-1 flex-col items-start gap-0.5 text-left outline-none min-w-0">
                  <div
                    className="flex items-center gap-2 text-[13px] font-medium truncate w-full"
                    style={{ color: 'var(--fg-1)' }}
                  >
                    <PresetGlyph color={presetColor} />
                    <span className="truncate">{item.label}</span>
                  </div>
                  <div
                    className="pl-[26px] text-[12px] truncate w-full"
                    style={{ color: 'var(--fg-2)' }}
                  >
                    {item.description || item.prompt}
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

export interface SaveRecipeDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  defaultPrompt: string;
  onSaved?: (recipe: ChatRecipe) => void;
}

export function SaveRecipeDialog({
  open,
  onOpenChange,
  defaultPrompt,
  onSaved,
}: SaveRecipeDialogProps) {
  const [label, setLabel] = React.useState('');
  const [prompt, setPrompt] = React.useState(defaultPrompt);
  const [error, setError] = React.useState<string | null>(null);
  const saveRecipe = useSaveRecipe();

  React.useEffect(() => {
    if (open) {
      setLabel('');
      setPrompt(defaultPrompt);
      setError(null);
    }
  }, [open, defaultPrompt]);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    const cleanLabel = label.trim();
    const cleanPrompt = prompt.trim();
    if (!cleanLabel) {
      setError('Recipe needs a name.');
      return;
    }
    if (!cleanPrompt) {
      setError('Recipe needs a prompt.');
      return;
    }
    try {
      setError(null);
      const res = await saveRecipe.mutateAsync({
        label: cleanLabel,
        prompt: cleanPrompt,
      });
      onOpenChange(false);
      if (res && typeof res === 'object' && 'recipe' in res) {
        onSaved?.((res as { recipe: ChatRecipe }).recipe);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to save recipe');
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md" data-testid="save-recipe-dialog">
        <DialogHeader>
          <DialogTitle>Save as Recipe</DialogTitle>
          <DialogDescription>
            Save this prompt to quickly reuse it by typing / in chat.
          </DialogDescription>
        </DialogHeader>
        <form onSubmit={handleSubmit} className="flex flex-col gap-4">
          {error && (
            <div
              role="alert"
              className="rounded-md border px-3 py-2 text-[13px]"
              style={{
                borderColor: 'var(--border-subtle)',
                background: 'var(--danger-bg)',
                color: 'var(--danger)',
              }}
            >
              {error}
            </div>
          )}
          <div className="flex flex-col gap-1.5">
            <label
              htmlFor="recipe-label"
              className="text-[13px] font-medium"
              style={{ color: 'var(--fg-1)' }}
            >
              Name
            </label>
            <input
              id="recipe-label"
              type="text"
              value={label}
              onChange={(e) => setLabel(e.target.value)}
              placeholder="e.g. Weekly action items"
              autoFocus
              className="rounded-lg border px-3 py-2 text-sm outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring"
              style={{
                borderColor: 'var(--border-subtle)',
                background: 'var(--surface-raised)',
                color: 'var(--fg-1)',
              }}
              data-testid="recipe-label-input"
            />
          </div>
          <div className="flex flex-col gap-1.5">
            <label
              htmlFor="recipe-prompt"
              className="text-[13px] font-medium"
              style={{ color: 'var(--fg-1)' }}
            >
              Prompt
            </label>
            <textarea
              id="recipe-prompt"
              rows={3}
              value={prompt}
              onChange={(e) => setPrompt(e.target.value)}
              placeholder="Prompt to fill in chat..."
              className="rounded-lg border px-3 py-2 text-sm outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring resize-none"
              style={{
                borderColor: 'var(--border-subtle)',
                background: 'var(--surface-raised)',
                color: 'var(--fg-1)',
              }}
              data-testid="recipe-prompt-input"
            />
          </div>
          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              onClick={() => onOpenChange(false)}
              disabled={saveRecipe.isPending}
            >
              Cancel
            </Button>
            <Button
              type="submit"
              disabled={saveRecipe.isPending || !label.trim() || !prompt.trim()}
              data-testid="save-recipe-submit"
            >
              {saveRecipe.isPending ? 'Saving...' : 'Save recipe'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
