import * as React from 'react';
import {
  ArrowRight,
  BookOpen,
  Calendar,
  FileAudio,
  MessageSquare,
  Mic,
  Plus,
  Square,
  type LucideIcon,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { ShortcutKeys } from '@/components/ShortcutKeys';
import { Mascot } from '@/components/Mascot';
import { CookbookCover, COLOUR_TONES, type CoverTone } from '@/components/cookbooks/CookbookCover';
import type { CookbookCategory } from '@/lib/cookbooks';
import { useImportAudio } from '@/hooks/useImportAudio';
import { navigate } from '@/lib/router';
import { cn } from '@/lib/utils';
import { t } from '@/i18n';

const FOCUS_RING =
  'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[color:var(--focus-ring)] focus-visible:ring-offset-2 focus-visible:ring-offset-[color:var(--page)]';

export interface WelcomeCalendar {
  pendingProvider: 'google' | 'outlook' | null;
  error: string | undefined;
  connect: (provider: 'google' | 'outlook') => void;
  cancel: () => void;
}

/**
 * Home with no notes yet: a welcome card in the Cookbooks style (serif
 * headline, the one primary action, the quick-start keys, the consent line;
 * the dragonfly on an ink cover) and a row of ways to start, each an action
 * that already exists elsewhere in the app.
 */
export function WelcomeEmpty({
  isRecording,
  onToggleRecording,
  hotkeyAccelerator,
  calendar,
}: {
  isRecording: boolean;
  onToggleRecording: () => void;
  /** The global record shortcut, when it is registered and enabled. */
  hotkeyAccelerator: string | null;
  /** Present while no calendar is connected (and the nudge was not dismissed). */
  calendar: WelcomeCalendar | null;
}) {
  const importAudio = useImportAudio();

  const ways: StartWay[] = [
    {
      id: 'record',
      icon: Mic,
      category: 'everyday',
      title: t('home.start.record.title'),
      body: t('home.start.record.body'),
      action: (
        <Button size="sm" variant="outline" className={cn('h-[28px] px-2.5 text-[12.5px]', FOCUS_RING)} onClick={onToggleRecording}>
          {isRecording ? t('home.start.record.open') : t('home.start.record.action')}
        </Button>
      ),
    },
    {
      id: 'import',
      icon: FileAudio,
      category: 'interviews',
      title: t('home.start.import.title'),
      body: isRecording ? t('toolbar.importAudio.disabledHint') : t('home.start.import.body'),
      action: (
        <Button
          size="sm"
          variant="outline"
          className={cn('h-[28px] px-2.5 text-[12.5px]', FOCUS_RING)}
          disabled={isRecording || importAudio.isPending}
          onClick={() => importAudio.mutate()}
        >
          {t('home.start.import.action')}
        </Button>
      ),
    },
    calendar
      ? {
        id: 'calendar',
        icon: Calendar,
        category: 'planning',
        title: t('home.start.calendar.title'),
        body: calendar.error ?? t('home.start.calendar.body'),
        action: calendar.pendingProvider ? (
          <>
            <span className="text-[12.5px]" style={{ color: 'var(--fg-2)' }}>
              {t('home.connecting', {
                provider: calendar.pendingProvider === 'google' ? t('home.provider.google') : t('home.provider.outlook'),
              })}
            </span>
            <Button size="sm" variant="ghost" className={cn('h-[28px] px-2.5 text-[12.5px]', FOCUS_RING)} onClick={calendar.cancel}>
              {t('home.cancel')}
            </Button>
          </>
        ) : (
          <>
            <Button size="sm" variant="outline" className={cn('h-[28px] px-2.5 text-[12.5px]', FOCUS_RING)} onClick={() => calendar.connect('google')}>
              {t('home.provider.google')}
            </Button>
            <Button size="sm" variant="outline" className={cn('h-[28px] px-2.5 text-[12.5px]', FOCUS_RING)} onClick={() => calendar.connect('outlook')}>
              {t('home.provider.outlook')}
            </Button>
          </>
        ),
      }
      : {
        id: 'chat',
        icon: MessageSquare,
        category: 'planning',
        title: t('home.start.chat.title'),
        body: t('home.start.chat.body'),
        action: (
          <Button size="sm" variant="outline" className={cn('h-[28px] px-2.5 text-[12.5px]', FOCUS_RING)} onClick={() => navigate('/chat')}>
            {t('home.start.chat.action')}
            <ArrowRight aria-hidden />
          </Button>
        ),
      },
    {
      id: 'cookbooks',
      icon: BookOpen,
      category: 'briefings',
      title: t('home.start.cookbooks.title'),
      body: t('home.start.cookbooks.body'),
      action: (
        <Button size="sm" variant="outline" className={cn('h-[28px] px-2.5 text-[12.5px]', FOCUS_RING)} onClick={() => navigate('/cookbooks')}>
          {t('home.start.cookbooks.action')}
          <ArrowRight aria-hidden />
        </Button>
      ),
    },
  ];

  return (
    <div data-testid="home-welcome" className="w-full py-6 text-left">
      <section
        aria-labelledby="home-welcome-title"
        className="grid overflow-hidden rounded-[18px] md:grid-cols-[minmax(0,1fr)_240px]"
        style={{ border: '1px solid var(--border-subtle)', background: 'var(--surface-raised)', boxShadow: 'var(--shadow-sm)' }}
      >
        <div className="order-2 flex flex-col justify-center p-7 md:order-1 md:p-8">
          <p className="text-[10.5px] font-semibold uppercase tracking-[0.14em]" style={{ color: 'var(--fg-2)' }}>
            {t('home.welcome.eyebrow')}
          </p>
          <h1
            id="home-welcome-title"
            className="mt-2 text-[30px] leading-[1.1]"
            style={{ fontFamily: 'var(--font-serif)', letterSpacing: '-0.02em', color: 'var(--fg-1)' }}
          >
            {t('home.welcome.title')}
          </h1>
          <p className="mt-2.5 text-[15px] leading-relaxed" style={{ color: 'var(--fg-2)' }}>
            {t('home.welcome.tagline')}
          </p>
          <div className="mt-6 flex flex-wrap items-center gap-x-4 gap-y-3">
            <Button
              variant={isRecording ? 'destructive' : 'default'}
              onClick={onToggleRecording}
              className={cn('gap-2 rounded-full px-5', FOCUS_RING)}
            >
              {isRecording ? <Square className="size-4" /> : <Plus className="size-4" />}
              {isRecording ? t('home.stopRecording') : t('home.newNote')}
            </Button>
            {hotkeyAccelerator && (
              <p className="flex items-center gap-1.5 text-xs" style={{ color: 'var(--fg-muted)' }}>
                <span>{t('home.quickStart.label')}</span>
                <ShortcutKeys accelerator={hotkeyAccelerator} />
                <span>{t('home.quickStart.anywhere')}</span>
              </p>
            )}
          </div>
          <p className="mt-5 text-[12px]" style={{ color: 'var(--fg-muted)' }}>
            {t('home.welcome.consent')}
          </p>
        </div>
        <WelcomeArt />
      </section>

      <section aria-labelledby="home-start-heading" className="mt-9">
        <h2 id="home-start-heading" className="text-[15px] font-medium" style={{ color: 'var(--fg-1)' }}>
          {t('home.start.heading')}
        </h2>
        <div className="mt-4 grid gap-3 sm:grid-cols-2">
          {ways.map((way, index) => (
            <StartCard key={way.id} way={way} tone={COLOUR_TONES[index % COLOUR_TONES.length]} />
          ))}
        </div>
      </section>
    </div>
  );
}

interface StartWay {
  id: string;
  icon: LucideIcon;
  category: CookbookCategory;
  title: string;
  body: string;
  action: React.ReactNode;
}

function StartCard({ way, tone }: { way: StartWay; tone: CoverTone }) {
  const Icon = way.icon;
  return (
    <section
      aria-label={way.title}
      data-testid={`home-start-${way.id}`}
      className="flex min-w-0 flex-col overflow-hidden rounded-[16px] border shadow-[var(--shadow-sm)] motion-safe:transition-[transform,box-shadow] motion-safe:duration-300 hover:shadow-[var(--shadow-lg)] motion-safe:hover:-translate-y-0.5"
      style={{ borderColor: 'var(--border-subtle)', background: 'var(--surface-raised)' }}
    >
      <div className="relative h-[64px]">
        <CookbookCover seedId={`home-start-${way.id}`} category={way.category} tone={tone} shape="wide" className="absolute inset-0" />
        <span
          aria-hidden
          className="absolute left-3 top-3 inline-flex size-8 items-center justify-center rounded-[9px]"
          style={{ background: 'var(--surface-raised)', color: 'var(--fg-1)', boxShadow: '0 6px 14px -8px rgba(0,0,0,0.5)' }}
        >
          <Icon className="size-[15px]" />
        </span>
      </div>
      <div className="flex flex-1 flex-col p-4">
        <h3 className="text-[14px] font-medium" style={{ color: 'var(--fg-1)' }}>{way.title}</h3>
        <p className="mt-1 flex-1 text-[12.5px] leading-snug" style={{ color: 'var(--fg-2)' }}>
          {way.body}
        </p>
        <div className="mt-3 flex flex-wrap items-center gap-1.5">{way.action}</div>
      </div>
    </section>
  );
}

const FANNED: { id: string; category: CookbookCategory; rot: number; x: number; y: number }[] = [
  { id: 'home-welcome-a', category: 'interviews', rot: -10, x: -58, y: 12 },
  { id: 'home-welcome-b', category: 'everyday', rot: 10, x: 58, y: 12 },
];

/** The dragonfly on a paper card, fanned over two covers on an ink plate. */
function WelcomeArt() {
  return (
    <div aria-hidden="true" className="relative order-1 h-[210px] overflow-hidden md:order-2 md:h-auto md:min-h-[260px]">
      <CookbookCover seedId="home-welcome" category="planning" tone="ink" shape="wide" className="absolute inset-0" />
      <div className="absolute inset-0 flex items-center justify-center">
        {FANNED.map((s) => (
          <div
            key={s.id}
            className="absolute w-[84px]"
            style={{ transform: `translate(${s.x}px, ${s.y}px) rotate(${s.rot}deg)` }}
          >
            <div className="overflow-hidden rounded-[10px]" style={{ boxShadow: '0 18px 30px -14px rgba(0,0,0,0.55), 0 0 0 1px rgba(255,255,255,0.06)' }}>
              <CookbookCover seedId={s.id} category={s.category} tone="stone" shape="tall" className="aspect-[3/4] w-full" />
            </div>
          </div>
        ))}
        <div
          className="relative flex h-[150px] w-[124px] items-center justify-center rounded-[12px]"
          style={{ background: '#FAF9F5', boxShadow: '0 22px 36px -14px rgba(0,0,0,0.6), 0 0 0 1px rgba(255,255,255,0.08)' }}
        >
          <div className="origin-center scale-[0.78]">
            <Mascot className="mb-0" testId="home-mascot" />
          </div>
        </div>
      </div>
    </div>
  );
}
