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

export const CHAT_COMPOSER_LABEL = 'Ask about your notes';

export const PRESETS: ChatPreset[] = [
  {
    label: 'Chart my notes',
    prompt: 'Create a bar chart of action item counts by meeting from my recent notes. Explain which notes are included and any missing information.',
    description: 'Visualizes numbers supported by your meeting notes',
  },
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
