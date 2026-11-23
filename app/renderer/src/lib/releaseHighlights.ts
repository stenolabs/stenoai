import { version } from '../../../package.json';

// Release preparation updates this list alongside the public changelog.
// The renderer build binds the content to package.json's version.
export const RELEASE_VERSION = version;
export type ReleaseHighlight = {
  id: string;
  title: string;
  description: string;
  action: string;
  route: string;
  visual?: 'agents' | 'chart';
  /** The icon on the highlight's generated cover (components/WhatsNew.tsx). */
  icon?: 'edit' | 'language' | 'speakers' | 'calendar' | 'record' | 'connect' | 'recipes' | 'chart' | 'sparkles';
};
export const RELEASE_HIGHLIGHTS: readonly ReleaseHighlight[] = [
  {
    id: 'connect',
    icon: 'connect',
    title: 'Connect your AI apps',
    description:
      'Claude, Cursor, Claude Code and Codex can read your meetings through a read-only connection on this computer.',
    action: 'Open Connect',
    route: '/connect',
  },
  {
    id: 'actions',
    icon: 'sparkles',
    title: 'Approve follow-ups after each note',
    description:
      'Connect Linear, Notion or Jira, and Steno suggests follow-ups. Nothing is sent until you approve it.',
    action: 'Connect an app',
    route: '/connect',
  },
  {
    id: 'instant-transcripts',
    icon: 'speakers',
    title: 'Read your transcript right after Stop',
    description:
      'With the Parakeet engine, the transcript and a first summary are ready at once. Steno refines both in the background.',
    action: 'Open AI settings',
    route: '/settings?tab=ai',
  },
  {
    id: 'recipes',
    icon: 'recipes',
    title: 'Run a recipe with /',
    description:
      'Recipes are saved chat prompts, such as a weekly recap or a decision log. Type / in Chat to run one.',
    action: 'Browse recipes',
    route: '/cookbooks?tab=recipes',
  },
  {
    id: 'editable-notes',
    icon: 'edit',
    title: 'Click a note to edit it',
    description:
      'Every note is editable in place, with no edit mode. Changes save automatically.',
    action: 'Browse notes',
    route: '/',
  },
  {
    id: 'record-shortcut',
    icon: 'record',
    title: 'A new record shortcut',
    description:
      'The default is now ⌃⌥R (Ctrl+Alt+R on Windows and Linux), because ⌘⇧R clashed with refresh. Set your own in Preferences.',
    action: 'Open Preferences',
    route: '/settings?tab=general',
  },
];

export const WHATS_NEW_COPY = {
  title: 'What’s new in Steno',
  subtitle: 'A quick look at this update.',
  settingsLabel: 'What’s new',
  settingsDescription: 'Explore the highlights of this version',
  view: 'View highlights',
  done: 'Done',
  fullNotes: 'Full release notes',
  linkError: 'Could not open the release notes. Try again.',
};

export const LAST_SEEN_RELEASE_KEY = 'steno-last-seen-release';
export const CHANGELOG_URL = `https://github.com/stenolabs/stenoai/releases/tag/v${RELEASE_VERSION}`;

/** Stable releases only. Downgrades and same-version restarts stay quiet. */
export function isUnseenRelease(current: string, seen: string | null): boolean {
  const parts = (value: string) =>
    /^\d+\.\d+\.\d+$/.test(value) ? value.split('.').map(Number) : null;
  const next = parts(current);
  if (!next) return false;
  const previous = seen ? parts(seen) : null;
  if (!previous) return true;
  for (let i = 0; i < next.length; i++) {
    if (next[i] !== previous[i]) return next[i] > previous[i];
  }
  return false;
}
