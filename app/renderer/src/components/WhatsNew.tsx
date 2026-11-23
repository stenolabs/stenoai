import * as React from 'react';
import {
  ArrowUpRight,
  AudioLines,
  Cable,
  CalendarClock,
  ChartColumn,
  CircleDot,
  ExternalLink,
  Languages,
  PenLine,
  Slash,
  Sparkles,
  type LucideIcon,
} from 'lucide-react';
import { CookbookCover, type CoverTone } from '@/components/cookbooks/CookbookCover';
import type { CookbookCategory } from '@/lib/cookbooks';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { AnthropicIcon } from '@/components/ui/anthropic-icon';
import { OpenAiIcon } from '@/components/ui/openai-icon';
import { useAppVersion } from '@/hooks/useSettings';
import { ipc } from '@/lib/ipc';
import { navigate } from '@/lib/router';
import {
  CHANGELOG_URL,
  LAST_SEEN_RELEASE_KEY,
  RELEASE_HIGHLIGHTS,
  RELEASE_VERSION,
  WHATS_NEW_COPY as copy,
  isUnseenRelease,
  type ReleaseHighlight,
} from '@/lib/releaseHighlights';

const WhatsNewContext = React.createContext({ available: false, show: () => {} });
export const useWhatsNew = () => React.useContext(WhatsNewContext);

function subscribeForeground(listener: () => void) {
  window.addEventListener('focus', listener);
  window.addEventListener('blur', listener);
  document.addEventListener('visibilitychange', listener);
  return () => {
    window.removeEventListener('focus', listener);
    window.removeEventListener('blur', listener);
    document.removeEventListener('visibilitychange', listener);
  };
}

function readSeenRelease() {
  try {
    return localStorage.getItem(LAST_SEEN_RELEASE_KEY);
  } catch {
    return null;
  }
}

export function WhatsNewProvider({
  children,
  blocked,
  onboarding,
  initializeBaseline,
  suppressed,
}: {
  children: React.ReactNode;
  blocked: boolean;
  onboarding: boolean;
  initializeBaseline: boolean;
  suppressed: boolean;
}) {
  const version = useAppVersion().data?.version;
  const [seen, setSeen] = React.useState(readSeenRelease);
  const [manual, setManual] = React.useState(false);
  const [automaticallyOpened, setAutomaticallyOpened] = React.useState(false);
  const [error, setError] = React.useState('');
  const foreground = React.useSyncExternalStore(
    subscribeForeground,
    () => document.visibilityState === 'visible' && document.hasFocus()
  );
  const available = version === RELEASE_VERSION && RELEASE_HIGHLIGHTS.length > 0;
  const acknowledge = React.useCallback(() => {
    if (!version) return;
    // Keep the highest acknowledged version when viewing notes after a downgrade.
    if (isUnseenRelease(version, readSeenRelease())) {
      try {
        localStorage.setItem(LAST_SEEN_RELEASE_KEY, version);
      } catch {
        /* Still dismiss for this session. */
      }
    }
    setSeen(version);
    setManual(false);
    setError('');
  }, [version]);

  // Fresh installs see onboarding; establish a baseline without another popup.
  React.useEffect(() => {
    if (initializeBaseline && version && !readSeenRelease()) {
      try {
        localStorage.setItem(LAST_SEEN_RELEASE_KEY, version);
      } catch {
        /* Best effort. */
      }
    }
  }, [initializeBaseline, version]);

  const automatic =
    available &&
    !onboarding &&
    !suppressed &&
    !blocked &&
    !(initializeBaseline && !readSeenRelease()) &&
    isUnseenRelease(version, seen) &&
    isUnseenRelease(version, readSeenRelease());
  // Foreground is the initial trigger. Retain the open dialog across Alt-Tab
  // without acknowledging the release or restarting its entry animation.
  if (automatic && foreground && !automaticallyOpened) {
    setAutomaticallyOpened(true);
  }
  // An explicit About click can open immediately even during a recording.
  // Only unsolicited announcements wait for idle.
  const open =
    available && !onboarding && !suppressed && (manual || (automatic && automaticallyOpened));
  const context = React.useMemo(
    () => ({
      available,
      show: () => {
        setError('');
        setManual(true);
      },
    }),
    [available]
  );
  const openNotes = async () => {
    try {
      const result = await ipc().shell.openExternal(CHANGELOG_URL);
      if (!result.success) throw new Error();
      acknowledge();
    } catch {
      setError(copy.linkError);
    }
  };

  return (
    <WhatsNewContext.Provider value={context}>
      {children}
      <Dialog
        open={open}
        onOpenChange={(next) => {
          if (!next) acknowledge();
        }}
      >
        <DialogContent className="max-h-[85vh] w-[calc(100%-32px)] max-w-[580px] overflow-y-auto p-7">
          <DialogHeader>
            <p className="mb-1 text-xs tabular-nums" style={{ color: 'var(--fg-muted)' }}>
              {version}
            </p>
            <DialogTitle className="text-[28px]">{copy.title}</DialogTitle>
            <DialogDescription>{copy.subtitle}</DialogDescription>
          </DialogHeader>
          <div className="divide-y" style={{ borderColor: 'var(--border-subtle)' }}>
            {RELEASE_HIGHLIGHTS.map((highlight, index) => (
              <section key={highlight.id} className="flex items-start justify-between gap-5 py-5">
                <div className="min-w-0">
                  <h3 className="text-sm font-medium">{highlight.title}</h3>
                  <p
                    className="mt-1.5 text-[13px] leading-relaxed"
                    style={{ color: 'var(--fg-2)' }}
                  >
                    {highlight.description}
                  </p>
                  <button
                    className="mt-3 inline-flex items-center gap-1 text-xs font-medium underline underline-offset-4"
                    onClick={() => {
                      acknowledge();
                      navigate(highlight.route);
                    }}
                  >
                    {highlight.action}
                    <ArrowUpRight size={13} />
                  </button>
                </div>
                <HighlightCover highlight={highlight} index={index} />
              </section>
            ))}
          </div>
          {error && (
            <p role="status" className="text-xs">
              {error}
            </p>
          )}
          <DialogFooter className="sm:justify-between">
            <Button variant="ghost" size="sm" onClick={() => void openNotes()}>
              <ExternalLink />
              {copy.fullNotes}
            </Button>
            <Button size="sm" onClick={acknowledge}>
              {copy.done}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </WhatsNewContext.Provider>
  );
}

const HIGHLIGHT_ICONS: Record<NonNullable<ReleaseHighlight['icon']>, LucideIcon> = {
  edit: PenLine,
  language: Languages,
  speakers: AudioLines,
  calendar: CalendarClock,
  record: CircleDot,
  connect: Cable,
  recipes: Slash,
  chart: ChartColumn,
  sparkles: Sparkles,
};
const COVER_CATEGORIES: CookbookCategory[] = ['planning', 'briefings', 'interviews', 'everyday'];
// Ink and paper only, so the dialog stays calm next to the colourful Cookbooks.
const COVER_TONES: CoverTone[] = ['stone', 'paper', 'ink'];

/**
 * A generated picture for each highlight, beside its text: the Cookbooks
 * cover art in ink and paper tones, with the feature's icon (or its bespoke visual) on a
 * paper chip. No image assets, so every release gets art for free.
 */
function HighlightCover({ highlight, index }: { highlight: ReleaseHighlight; index: number }) {
  const Icon = HIGHLIGHT_ICONS[highlight.icon ?? 'sparkles'];
  return (
    <div aria-hidden="true" className="relative h-[84px] w-[112px] shrink-0 overflow-hidden rounded-xl">
      <CookbookCover
        seedId={`whats-new-${highlight.id}`}
        category={COVER_CATEGORIES[index % COVER_CATEGORIES.length]}
        tone={COVER_TONES[index % COVER_TONES.length]}
        shape="wide"
        className="absolute inset-0"
      />
      <div className="absolute inset-0 flex items-center justify-center">
        <div
          className="flex items-center justify-center gap-2 rounded-[10px] px-2.5 py-2"
          style={{ background: 'var(--surface-raised)', color: 'var(--fg-1)', boxShadow: '0 8px 18px -10px rgba(0,0,0,0.5)' }}
        >
          {highlight.visual === 'agents' ? (
            <>
              <AnthropicIcon size={20} />
              <OpenAiIcon size={20} />
            </>
          ) : (
            <Icon size={20} strokeWidth={1.7} />
          )}
        </div>
      </div>
    </div>
  );
}
