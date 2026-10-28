import { version } from '../../../package.json';

// Release preparation updates this list alongside the public changelog.
// The renderer build binds the content to package.json's version.
export const RELEASE_VERSION = version;
type ReleaseHighlight = {
  id: string;
  title: string;
  description: string;
  action: string;
  route: string;
  visual?: 'agents' | 'chart';
};
export const RELEASE_HIGHLIGHTS: readonly ReleaseHighlight[] = [
  {
    id: 'note-editing',
    title: 'Edit a generated note',
    description:
      'Change generated sections in a saved note. The original model output stays available.',
    action: 'Browse notes',
    route: '/',
  },
  {
    id: 'speaker-engine',
    title: 'Choose speaker detection',
    description:
      'On macOS, keep Sortformer or select optional Nemotron 3 in AI settings.',
    action: 'Open AI settings',
    route: '/settings?tab=ai',
  },
  {
    id: 'open-meetings',
    title: 'Open meetings on time',
    description:
      'With a calendar connected, Steno can open the meeting link shortly before it starts, or ask first.',
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
