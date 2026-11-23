import * as React from 'react';
import { Play, Plus } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { toRecipe, useDeleteRecipe, useSaveRecipe, useUserRecipes } from '@/hooks/useRecipes';
import type { UserRecipe } from '@/lib/ipc';
import { CookbookCover, COLOUR_TONES } from '@/components/cookbooks/CookbookCover';
import type { CookbookCategory } from '@/lib/cookbooks';
import { BUILTIN_RECIPES, type Recipe } from '@/lib/recipes';
import { navigate } from '@/lib/router';
import { t } from '@/i18n';

const fieldLabel = 'mb-1 block text-[12.5px]';

/**
 * The Recipes tab on Cookbooks: saved prompts the user runs in chat. Built-ins
 * are read-only; the user's own are created and edited here and stored in
 * recipes.json. Run opens chat with the prompt filled in (/chat?recipe=<id>).
 */
export function RecipesPanel({
  editing,
  onEdit,
}: {
  /** null = closed, {} = new, a recipe = edit it. Owned by the page so its Create button can open it. */
  editing: Partial<UserRecipe> | null;
  onEdit: (recipe: Partial<UserRecipe> | null) => void;
}) {
  const mine = useUserRecipes();
  const own = React.useMemo(
    () => [...(mine.data ?? [])].sort((a, b) => b.updatedAt - a.updatedAt),
    [mine.data]
  );

  return (
    <div className="mt-8">
      <p className="max-w-[640px] text-[14px] leading-relaxed" style={{ color: 'var(--fg-2)' }}>
        {t('recipes.intro')}
      </p>

      <section aria-labelledby="recipes-mine-heading" className="mt-8">
        <h2 id="recipes-mine-heading" className="text-[15px] font-medium">
          {t('recipes.mine.heading')}
        </h2>
        <div className="mt-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {own.map((r, idx) => (
            <RecipeCard key={r.id} recipe={toRecipe(r)} index={idx} onEdit={() => onEdit(r)} />
          ))}
          <button
            type="button"
            onClick={() => onEdit({})}
            className="flex min-h-[180px] flex-col items-center justify-center gap-1.5 rounded-xl border border-dashed p-4 text-[13px] transition-colors hover:bg-[color:var(--surface-hover)]"
            style={{
              borderColor: 'var(--border-strong, var(--border-subtle))',
              color: 'var(--fg-2)',
            }}
          >
            <Plus className="size-4" aria-hidden />
            {t('recipes.create')}
          </button>
        </div>
      </section>

      <section aria-labelledby="recipes-builtin-heading" className="mt-10">
        <h2 id="recipes-builtin-heading" className="text-[15px] font-medium">
          {t('recipes.builtin.heading')}
        </h2>
        <div className="mt-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {BUILTIN_RECIPES.map((r, idx) => (
            <RecipeCard key={r.id} recipe={r} index={idx + 2} />
          ))}
        </div>
      </section>

      {editing && (
        <RecipeDialog key={editing.id ?? 'new'} editing={editing} onClose={() => onEdit(null)} />
      )}
    </div>
  );
}

const RECIPE_CATEGORIES: CookbookCategory[] = ['planning', 'briefings', 'interviews', 'everyday'];

function RecipeCard({ recipe, index, onEdit }: { recipe: Recipe; index: number; onEdit?: () => void }) {
  return (
    <section
      aria-label={recipe.label}
      className="group flex min-w-0 flex-col overflow-hidden rounded-[16px] border shadow-[var(--shadow-sm)] motion-safe:transition-[transform,box-shadow] motion-safe:duration-300 hover:shadow-[var(--shadow-lg)] motion-safe:hover:-translate-y-0.5"
      style={{ borderColor: 'var(--border-subtle)', background: 'var(--surface-raised)' }}
    >
      <div className="relative h-[88px]">
        <CookbookCover
          seedId={recipe.id}
          category={RECIPE_CATEGORIES[index % RECIPE_CATEGORIES.length]}
          tone={COLOUR_TONES[index % COLOUR_TONES.length]}
          shape="wide"
          className="absolute inset-0"
        />
        <span
          aria-hidden
          className="absolute left-3 top-3 inline-flex size-8 items-center justify-center rounded-[9px] font-mono text-[17px] font-semibold"
          style={{ background: 'var(--surface-raised)', color: 'var(--fg-1)', boxShadow: '0 6px 14px -8px rgba(0,0,0,0.5)' }}
        >
          /
        </span>
      </div>
      <div className="flex flex-1 flex-col p-4">
        <h3 className="min-w-0 truncate text-[14px] font-medium">{recipe.label}</h3>
        <p className="mt-1 line-clamp-2 flex-1 text-[12.5px] leading-snug" style={{ color: 'var(--fg-2)' }}>
          {recipe.description || recipe.prompt}
        </p>
        <div className="mt-3 flex items-center gap-1.5">
          <Button
            size="sm"
            variant="outline"
            className="h-[28px] px-2.5 text-[12.5px]"
            aria-label={t('recipes.runAria', { name: recipe.label })}
            onClick={() => navigate(`/chat?recipe=${encodeURIComponent(recipe.id)}`)}
          >
            <Play aria-hidden />
            {t('recipes.run')}
          </Button>
          {onEdit && (
            <Button
              size="sm"
              variant="ghost"
              className="h-[28px] px-2.5 text-[12.5px]"
              aria-label={t('recipes.editAria', { name: recipe.label })}
              onClick={onEdit}
            >
              {t('recipes.edit')}
            </Button>
          )}
        </div>
      </div>
    </section>
  );
}

function RecipeDialog({ editing, onClose }: { editing: Partial<UserRecipe>; onClose: () => void }) {
  const save = useSaveRecipe();
  const remove = useDeleteRecipe();
  const [name, setName] = React.useState(editing.name ?? '');
  const [description, setDescription] = React.useState(editing.description ?? '');
  const [prompt, setPrompt] = React.useState(editing.prompt ?? '');
  const [error, setError] = React.useState('');
  const [confirmDelete, setConfirmDelete] = React.useState(false);
  const ids = React.useId();
  const busy = save.isPending || remove.isPending;
  const canSave = name.trim() !== '' && prompt.trim() !== '';

  const submit = async () => {
    setError('');
    try {
      await save.mutateAsync({
        ...(editing.id ? { id: editing.id } : {}),
        name,
        description,
        prompt,
      });
      onClose();
    } catch {
      setError(t('recipes.saveError'));
    }
  };

  return (
    <>
      <Dialog open onOpenChange={(v) => !v && !busy && onClose()}>
        <DialogContent className="max-w-[560px]">
          <DialogHeader>
            <DialogTitle>
              {editing.id ? t('recipes.dialog.editTitle') : t('recipes.dialog.newTitle')}
            </DialogTitle>
            <DialogDescription>{t('recipes.dialog.intro')}</DialogDescription>
          </DialogHeader>
          <form
            className="flex flex-col gap-3"
            onSubmit={(e) => {
              e.preventDefault();
              if (canSave && !busy) void submit();
            }}
          >
            <div>
              <label
                htmlFor={`${ids}-name`}
                className={fieldLabel}
                style={{ color: 'var(--fg-2)' }}
              >
                {t('recipes.dialog.name')}
              </label>
              <Input
                id={`${ids}-name`}
                value={name}
                onChange={(e) => setName(e.currentTarget.value)}
                placeholder={t('recipes.dialog.namePlaceholder')}
                maxLength={60}
                autoFocus
              />
            </div>
            <div>
              <label
                htmlFor={`${ids}-description`}
                className={fieldLabel}
                style={{ color: 'var(--fg-2)' }}
              >
                {t('recipes.dialog.description')}
              </label>
              <Input
                id={`${ids}-description`}
                value={description}
                onChange={(e) => setDescription(e.currentTarget.value)}
                placeholder={t('recipes.dialog.descriptionPlaceholder')}
                maxLength={160}
              />
            </div>
            <div>
              <label
                htmlFor={`${ids}-prompt`}
                className={fieldLabel}
                style={{ color: 'var(--fg-2)' }}
              >
                {t('recipes.dialog.prompt')}
              </label>
              <textarea
                id={`${ids}-prompt`}
                value={prompt}
                onChange={(e) => setPrompt(e.currentTarget.value)}
                placeholder={t('recipes.dialog.promptPlaceholder')}
                maxLength={4000}
                rows={6}
                className="w-full resize-y rounded-md border border-border bg-transparent px-3 py-2 text-sm outline-none focus-visible:ring-2 focus-visible:ring-[color:var(--accent-primary)]"
              />
            </div>
            <div
              role="status"
              className="min-h-[18px] text-[12.5px]"
              style={{ color: 'var(--danger)' }}
            >
              {error}
            </div>
            <DialogFooter className="sm:justify-between">
              <div>
                {editing.id && (
                  <Button
                    type="button"
                    variant="ghost"
                    disabled={busy}
                    onClick={() => setConfirmDelete(true)}
                  >
                    {t('recipes.dialog.delete')}
                  </Button>
                )}
              </div>
              <div className="flex gap-2">
                <Button type="button" variant="ghost" disabled={busy} onClick={onClose}>
                  {t('actions.cancel')}
                </Button>
                <Button type="submit" disabled={!canSave || busy}>
                  {t('recipes.dialog.save')}
                </Button>
              </div>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
      {editing.id && (
        <ConfirmDialog
          open={confirmDelete}
          onOpenChange={setConfirmDelete}
          title={t('recipes.deleteConfirm.title', { name: editing.name ?? '' })}
          description={t('recipes.deleteConfirm.description')}
          confirmLabel={t('recipes.dialog.delete')}
          destructive
          isPending={remove.isPending}
          onConfirm={async () => {
            await remove.mutateAsync(editing.id as string);
            setConfirmDelete(false);
            onClose();
          }}
        />
      )}
    </>
  );
}
