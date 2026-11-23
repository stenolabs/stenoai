import * as React from 'react';
import { Lightbulb } from 'lucide-react';
import { dismissTip, readDismissedTips, tipForRoute } from '@/lib/tips';
import { t } from '@/i18n';

const WIDTH = 300;
const GAP = 10;
const MARGIN = 16;
const EDGE = 'var(--border-subtle)';

interface Placement {
  top: number;
  left: number;
  /** Arrow x offset inside the card, and which edge it sits on. */
  arrowX: number;
  /** 'inside': a tall anchor (a whole note) gets the tip over its top corner. */
  side: 'above' | 'below' | 'inside';
}

function place(anchor: DOMRect, height: number): Placement {
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  const width = Math.min(WIDTH, vw - 2 * MARGIN);
  const clampLeft = (x: number) => Math.max(MARGIN, Math.min(x, vw - MARGIN - width));
  const fitsBelow = anchor.bottom + GAP + height <= vh - MARGIN;
  const fitsAbove = anchor.top - GAP - height >= MARGIN;
  if (!fitsBelow && !fitsAbove) {
    return {
      top: Math.max(anchor.top, MARGIN) + 12,
      left: clampLeft(anchor.right - width - 12),
      arrowX: 0,
      side: 'inside',
    };
  }
  const left = clampLeft(anchor.left + 12);
  const target = anchor.left + Math.min(anchor.width / 2, 40);
  return {
    top: fitsBelow ? anchor.bottom + GAP : anchor.top - GAP - height,
    left,
    arrowX: Math.max(14, Math.min(target - left, width - 22)),
    side: fitsBelow ? 'below' : 'above',
  };
}

/**
 * At most one first-run tip at a time, anchored next to the UI it explains
 * (lib/tips.ts). Mounted once at App level; never during onboarding, while
 * recording, or over an open dialog. Dismissal is remembered per tip.
 */
export function FirstRunTips({ route, blocked }: { route: string; blocked: boolean }) {
  const enabled = typeof window !== 'undefined' && window.stenoai?.app?.firstRunTips !== false;
  const [dismissed, setDismissed] = React.useState(readDismissedTips);
  const tip = enabled && !blocked && route !== '/setup' ? tipForRoute(route, dismissed) : null;
  const [placement, setPlacement] = React.useState<Placement | null>(null);
  const cardRef = React.useRef<HTMLDivElement>(null);

  // Follow the anchor: it can mount late (route data loading), move (scroll,
  // resize) or disappear (a dialog opens). A light poll covers all of these
  // without threading refs through the pages.
  React.useEffect(() => {
    setPlacement(null);
    if (!tip) return;
    let frame = 0;
    const measure = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        const anchor = document.querySelector(tip.anchor);
        const dialogOpen = document.querySelector('[role="dialog"], [role="alertdialog"]');
        if (!anchor || dialogOpen) { setPlacement(null); return; }
        const rect = anchor.getBoundingClientRect();
        // Only beside an anchor the viewer can see: off-screen, it waits for a scroll.
        if ((rect.width === 0 && rect.height === 0) || rect.bottom < 0 || rect.top > window.innerHeight) {
          setPlacement(null);
          return;
        }
        const next = place(rect, cardRef.current?.offsetHeight ?? 110);
        setPlacement((prev) =>
          prev && prev.top === next.top && prev.left === next.left && prev.side === next.side && prev.arrowX === next.arrowX ? prev : next);
      });
    };
    measure();
    const timer = window.setInterval(measure, 400);
    window.addEventListener('resize', measure);
    window.addEventListener('scroll', measure, true);
    return () => {
      cancelAnimationFrame(frame);
      window.clearInterval(timer);
      window.removeEventListener('resize', measure);
      window.removeEventListener('scroll', measure, true);
    };
  }, [tip]);

  if (!tip) return null;

  const dismiss = () => setDismissed(dismissTip(tip.id));

  return (
    <div
      ref={cardRef}
      role="note"
      aria-label={t('tips.label')}
      data-testid="first-run-tip"
      data-tip-id={tip.id}
      onKeyDown={(e) => { if (e.key === 'Escape') dismiss(); }}
      className="fixed z-[60] rounded-[14px] border p-3.5 pr-4 motion-safe:animate-in motion-safe:fade-in-0 motion-safe:slide-in-from-bottom-1 motion-safe:duration-200"
      style={{
        top: placement?.top ?? -9999,
        left: placement?.left ?? -9999,
        width: `min(${WIDTH}px, calc(100vw - ${2 * MARGIN}px))`,
        visibility: placement ? 'visible' : 'hidden',
        background: 'var(--surface-raised)',
        borderColor: 'var(--border-subtle)',
        boxShadow: 'var(--shadow-lg)',
        color: 'var(--fg-1)',
      }}
    >
      {placement && placement.side !== 'inside' && (
        <span
          aria-hidden
          className="absolute size-2.5 rotate-45 border"
          style={{
            left: placement.arrowX,
            // The two edges facing the anchor show; the others melt into the card.
            ...(placement.side === 'below'
              ? { top: -6, borderTopColor: EDGE, borderLeftColor: EDGE, borderRightColor: 'transparent', borderBottomColor: 'transparent' }
              : { bottom: -6, borderTopColor: 'transparent', borderLeftColor: 'transparent', borderRightColor: EDGE, borderBottomColor: EDGE }),
            background: 'var(--surface-raised)',
          }}
        />
      )}
      <div className="flex items-start gap-2.5">
        <Lightbulb aria-hidden className="mt-[1px] size-[15px] shrink-0" style={{ color: 'var(--fg-2)' }} />
        <div className="min-w-0">
          <p className="text-[14px] leading-snug" style={{ fontFamily: 'var(--font-serif)' }}>{tip.title()}</p>
          <p className="mt-1 text-[12.5px] leading-snug" style={{ color: 'var(--fg-2)' }}>{tip.body()}</p>
          <button
            type="button"
            onClick={dismiss}
            className="mt-2.5 inline-flex h-7 items-center rounded-full px-3 text-[12.5px] font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[color:var(--accent-primary)]"
            style={{ background: 'var(--fg-1)', color: 'var(--page)' }}
          >
            {t('tips.dismiss')}
          </button>
        </div>
      </div>
    </div>
  );
}
