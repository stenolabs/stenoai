import { t } from '@/i18n';

/**
 * First-run tips: one short hint per feature, shown once near the UI it is
 * about until the viewer dismisses it (components/FirstRunTips.tsx).
 *
 * A tip only shows when its route matches AND its anchor is on screen, so a
 * page opts in by rendering `data-tip-anchor="<anchor>"` on the element the
 * tip points at. A page that does not render the anchor simply gets no tip.
 */
export interface TipDefinition {
  id: string;
  matches: (route: string) => boolean;
  /** CSS selector of the element the tip points at. */
  anchor: string;
  title: () => string;
  body: () => string;
}

const isChatRoute = (route: string) => route === '/chat' || route.startsWith('/chat?') || route.startsWith('/chat/');

export const TIPS: readonly TipDefinition[] = [
  {
    id: 'chat-slash',
    matches: isChatRoute,
    anchor: '[data-tip-anchor="chat-composer"]',
    title: () => t('tips.chatSlash.title'),
    body: () => t('tips.chatSlash.body'),
  },
  {
    id: 'connect-actions',
    matches: (route) => route === '/connect',
    anchor: '[data-tip-anchor="connect-actions"]',
    title: () => t('tips.connectActions.title'),
    body: () => t('tips.connectActions.body'),
  },
  {
    // The note's click-to-edit body (routes/InlineNote.tsx renders
    // data-testid="inline-note"); data-tip-anchor="note-body" also works.
    id: 'note-edit',
    matches: (route) => route.startsWith('/meetings/') && route !== '/meetings/processing',
    anchor: '[data-tip-anchor="note-body"], [data-testid="inline-note"]',
    title: () => t('tips.noteEdit.title'),
    body: () => t('tips.noteEdit.body'),
  },
];

// Per-viewer UX only: browser storage is enough, and every access is guarded
// (it can throw or come back empty in a private window or a locked profile).
const STORAGE_KEY = 'steno-tips-dismissed';

export function readDismissedTips(): Set<string> {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    const parsed: unknown = raw ? JSON.parse(raw) : [];
    return new Set(Array.isArray(parsed) ? parsed.filter((v): v is string => typeof v === 'string') : []);
  } catch {
    return new Set();
  }
}

export function dismissTip(id: string): Set<string> {
  const next = readDismissedTips();
  next.add(id);
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify([...next]));
  } catch {
    /* Still dismissed for this session. */
  }
  return next;
}

/** The first undismissed tip for this route, if any. */
export function tipForRoute(route: string, dismissed: ReadonlySet<string>): TipDefinition | null {
  return TIPS.find((tip) => !dismissed.has(tip.id) && tip.matches(route)) ?? null;
}
