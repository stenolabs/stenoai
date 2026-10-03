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
    id: 'agents',
    title: 'Your meeting notes, in your agent',
    description:
      'Connect Claude Code or Codex to Steno with a copyable install prompt and a setup guide.',
    action: 'Try Agents',
    route: '/agents',
    visual: 'agents',
  },
  {
    id: 'charts',
    title: 'See the numbers in your notes',
    description:
      'Ask Chat for a bar or line chart based on your meeting notes. Open View data to inspect the values.',
    action: 'Open Chat',
    route: '/chat',
    visual: 'chart',
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
export const CHANGELOG_URL = 'https://docs.stenoai.co/changelog';

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
