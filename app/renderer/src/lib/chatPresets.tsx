import { t } from '@/i18n';

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

export function getPresets(): ChatPreset[] {
  return [
    {
      label: t('chat.presetListTodos'),
      prompt: t('chat.presetListTodosPrompt'),
      description: t('chat.presetListTodosDesc'),
    },
    {
      label: t('chat.presetCoachMe'),
      prompt: t('chat.presetCoachMePrompt'),
      description: t('chat.presetCoachMeDesc'),
    },
    {
      label: t('chat.presetWeeklyRecap'),
      prompt: t('chat.presetWeeklyRecapPrompt'),
      description: t('chat.presetWeeklyRecapDesc'),
    },
    {
      label: t('chat.presetBlindSpots'),
      prompt: t('chat.presetBlindSpotsPrompt'),
      description: t('chat.presetBlindSpotsDesc'),
    },
  ];
}

export const PRESETS: ChatPreset[] = [
  {
    get label() { return t('chat.presetListTodos'); },
    get prompt() { return t('chat.presetListTodosPrompt'); },
    get description() { return t('chat.presetListTodosDesc'); },
  },
  {
    get label() { return t('chat.presetCoachMe'); },
    get prompt() { return t('chat.presetCoachMePrompt'); },
    get description() { return t('chat.presetCoachMeDesc'); },
  },
  {
    get label() { return t('chat.presetWeeklyRecap'); },
    get prompt() { return t('chat.presetWeeklyRecapPrompt'); },
    get description() { return t('chat.presetWeeklyRecapDesc'); },
  },
  {
    get label() { return t('chat.presetBlindSpots'); },
    get prompt() { return t('chat.presetBlindSpotsPrompt'); },
    get description() { return t('chat.presetBlindSpotsDesc'); },
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
