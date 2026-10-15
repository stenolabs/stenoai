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

export const PRESETS: ChatPreset[] = [
  {
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
