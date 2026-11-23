import * as React from 'react';
import { PresetGlyph, PRESET_COLORS, type Recipe } from '@/lib/recipes';
import { navigate } from '@/lib/router';
import { t } from '@/i18n';

/**
 * The `/` recipe list shared by both chat composers (entry page and
 * conversation). The composer owns open state and keyboard selection; this
 * renders the rows, keeps the selected one in view, and links to the Recipes
 * tab where the user's own are made.
 */
export function RecipeMenu({
  recipes,
  selectedIndex,
  onHover,
  onPick,
}: {
  recipes: Recipe[];
  selectedIndex?: number;
  onHover?: (index: number) => void;
  onPick: (recipe: Recipe) => void;
}) {
  const listRef = React.useRef<HTMLDivElement>(null);
  React.useEffect(() => {
    if (selectedIndex === undefined) return;
    listRef.current
      ?.querySelector<HTMLElement>(`[data-recipe-index="${selectedIndex}"]`)
      ?.scrollIntoView({ block: 'nearest' });
  }, [selectedIndex]);

  return (
    <div role="menu" aria-label={t('chat.home.skills')}>
      <div className="px-2 pb-1 pt-0.5 text-[11px] font-medium" style={{ color: 'var(--fg-muted)' }}>
        {t('chat.home.skills')}
      </div>
      <div ref={listRef} className="scrollbar-clean flex max-h-[300px] flex-col overflow-y-auto">
        {recipes.map((r, idx) => (
          <button
            key={r.id}
            type="button"
            role="menuitem"
            data-recipe-index={idx}
            onMouseEnter={() => onHover?.(idx)}
            onClick={() => onPick(r)}
            className={`flex flex-col items-start gap-0.5 rounded-md px-2 py-1.5 text-left transition-colors hover:bg-[color:var(--surface-hover)] ${idx === selectedIndex ? 'bg-[color:var(--surface-hover)]' : ''}`}
          >
            <div className="flex items-center gap-2 text-[13px]" style={{ color: 'var(--fg-1)' }}>
              <PresetGlyph color={PRESET_COLORS[idx % PRESET_COLORS.length]} />
              {r.label}
              {!r.builtin && (
                <span
                  className="rounded-full px-1.5 text-[10.5px] leading-[16px]"
                  style={{ background: 'var(--surface-sunken)', color: 'var(--fg-2)' }}
                >
                  {t('recipes.yours')}
                </span>
              )}
            </div>
            {r.description && (
              <div className="pl-[26px] text-[12px]" style={{ color: 'var(--fg-2)' }}>
                {r.description}
              </div>
            )}
          </button>
        ))}
      </div>
      <div className="mt-1 px-1 pb-0.5 pt-1" style={{ borderTop: '1px solid var(--border-subtle)' }}>
        <button
          type="button"
          onClick={() => navigate('/cookbooks?tab=recipes')}
          className="w-full rounded-md px-1.5 py-1 text-left text-[12px] transition-colors hover:bg-[color:var(--surface-hover)]"
          style={{ color: 'var(--fg-2)' }}
        >
          {t('recipes.manage')}
        </button>
      </div>
    </div>
  );
}
