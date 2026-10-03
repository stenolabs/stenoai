import * as React from 'react';
import { ArrowUpRight, ExternalLink } from 'lucide-react';
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
            {RELEASE_HIGHLIGHTS.map((highlight) => (
              <section key={highlight.id} className="flex gap-5 py-5">
                {highlight.visual && (
                  <div
                    aria-hidden="true"
                    className="flex h-[72px] w-[96px] shrink-0 items-center justify-center gap-3 rounded-xl"
                    style={{ background: 'var(--surface-sunken)', color: 'var(--fg-1)' }}
                  >
                    {highlight.visual === 'agents' ? (
                      <>
                        <AnthropicIcon size={26} />
                        <OpenAiIcon size={26} />
                      </>
                    ) : (
                      <svg width="72" height="46" viewBox="0 0 72 46" fill="currentColor">
                        <path d="M2 45h68" stroke="var(--border-subtle)" />
                        <rect x="8" y="24" width="11" height="20" rx="2" opacity=".45" />
                        <rect x="29" y="6" width="11" height="38" rx="2" />
                        <rect x="50" y="16" width="11" height="28" rx="2" opacity=".7" />
                      </svg>
                    )}
                  </div>
                )}
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
