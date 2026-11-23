import { t } from '@/i18n';

// Recipes: saved prompts the user runs in chat. Surfaced three ways:
//   1. The popover opened by typing '/' as the first character in either chat
//      composer (entry page or /chat/<id> conversation page).
//   2. The typewriter suggestion on the /chat entry page (built-ins only).
//   3. The Recipes tab on the Cookbooks page, where the user's own are made.
// Built-ins are translated copy defined here; the user's own come from
// recipes.json through useRecipes (hooks/useRecipes.ts).
export interface Recipe {
  id: string;
  label: string;
  prompt: string;
  description: string;
  builtin: boolean;
}

export const BUILTIN_RECIPES: Recipe[] = [
  {
    id: 'chart-notes',
    builtin: true,
    get label() {
      return t('chat.presets.chartNotes.label');
    },
    get prompt() {
      return t('chat.presets.chartNotes.prompt');
    },
    get description() {
      return t('chat.presets.chartNotes.description');
    },
  },
  {
    id: 'recent-todos',
    builtin: true,
    get label() {
      return t('chat.presets.recentTodos.label');
    },
    get prompt() {
      return t('chat.presets.recentTodos.prompt');
    },
    get description() {
      return t('chat.presets.recentTodos.description');
    },
  },
  {
    id: 'coach',
    builtin: true,
    get label() {
      return t('chat.presets.coach.label');
    },
    get prompt() {
      return t('chat.presets.coach.prompt');
    },
    get description() {
      return t('chat.presets.coach.description');
    },
  },
  {
    id: 'weekly-recap',
    builtin: true,
    get label() {
      return t('chat.presets.weeklyRecap.label');
    },
    get prompt() {
      return t('chat.presets.weeklyRecap.prompt');
    },
    get description() {
      return t('chat.presets.weeklyRecap.description');
    },
  },
  {
    id: 'blind-spots',
    builtin: true,
    get label() {
      return t('chat.presets.blindSpots.label');
    },
    get prompt() {
      return t('chat.presets.blindSpots.prompt');
    },
    get description() {
      return t('chat.presets.blindSpots.description');
    },
  },
  {
    id: 'owe-people',
    builtin: true,
    get label() {
      return t('chat.presets.owePeople.label');
    },
    get prompt() {
      return t('chat.presets.owePeople.prompt');
    },
    get description() {
      return t('chat.presets.owePeople.description');
    },
  },
  {
    id: 'prep-next',
    builtin: true,
    get label() {
      return t('chat.presets.prepNext.label');
    },
    get prompt() {
      return t('chat.presets.prepNext.prompt');
    },
    get description() {
      return t('chat.presets.prepNext.description');
    },
  },
  {
    id: 'follow-up',
    builtin: true,
    get label() {
      return t('chat.presets.followUp.label');
    },
    get prompt() {
      return t('chat.presets.followUp.prompt');
    },
    get description() {
      return t('chat.presets.followUp.description');
    },
  },
  {
    id: 'decision-log',
    builtin: true,
    get label() {
      return t('chat.presets.decisionLog.label');
    },
    get prompt() {
      return t('chat.presets.decisionLog.prompt');
    },
    get description() {
      return t('chat.presets.decisionLog.description');
    },
  },
  {
    id: 'prd',
    builtin: true,
    get label() {
      return t('chat.presets.prd.label');
    },
    get prompt() {
      return t('chat.presets.prd.prompt');
    },
    get description() {
      return t('chat.presets.prd.description');
    },
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
