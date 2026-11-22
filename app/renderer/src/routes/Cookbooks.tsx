import * as React from 'react';
import {
  ArrowUpRight,
  Check,
  ChevronLeft,
  ChevronRight,
  LayoutGrid,
  List,
  ListFilter,
  Plus,
  Search,
  X,
} from 'lucide-react';
import { MeetingsShell } from '@/components/MeetingsShell';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { CookbookCover, CATEGORY_GLYPHS, type CoverTone } from '@/components/cookbooks/CookbookCover';
import { TemplateEditor } from '@/routes/settings/TemplatesTab';
import { useTemplates } from '@/hooks/useTemplates';
import {
  COOKBOOK_CATEGORIES,
  categoryLabel,
  featuredCookbooks,
  groupByCategory,
  matchesQuery,
  toCookbook,
  type Cookbook,
  type CookbookCategory,
} from '@/lib/cookbooks';
import type { Template } from '@/lib/ipc';
import { ipc } from '@/lib/ipc';
import { cn } from '@/lib/utils';
import { t } from '@/i18n';

// ---------------------------------------------------------------------------
// Cookbooks — a gallery over the same templates Settings › Templates manages.
// Nothing here changes how notes are generated: cards open the existing
// TemplateEditor, "Create" opens it blank, and every write goes through the
// existing useTemplates mutations. The Organisation tab is deliberately
// absent: the org adapter does not share templates today, and a tab that can
// only ever be empty is worse than no tab.
// ---------------------------------------------------------------------------

const DOCS_URL = 'https://docs.stenoai.co/features/report-templates';
const INTRO_KEY = 'steno-cookbooks-intro-dismissed';
const VIEW_KEY = 'steno-cookbooks-view';

const VIEWS = ['grid', 'list'] as const;
type View = (typeof VIEWS)[number];
type Tab = 'discover' | 'mine';

const BLURBS: Record<CookbookCategory, () => string> = {
  briefings: () => t('cookbooks.categoryBlurb.briefings'),
  interviews: () => t('cookbooks.categoryBlurb.interviews'),
  planning: () => t('cookbooks.categoryBlurb.planning'),
  everyday: () => t('cookbooks.categoryBlurb.everyday'),
};

// Per-viewer conveniences only; storage can be unavailable, so never throw.
function readStored(key: string): string | null {
  try {
    return window.localStorage.getItem(key);
  } catch {
    return null;
  }
}
function writeStored(key: string, value: string) {
  try {
    window.localStorage.setItem(key, value);
  } catch {
    // Remembering is best-effort.
  }
}

function prefersReducedMotion() {
  return typeof window !== 'undefined' && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}

const FEATURED_TONES: CoverTone[] = ['ink', 'stone', 'ink', 'paper'];

const FOCUS_RING =
  'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[color:var(--focus-ring)] focus-visible:ring-offset-2 focus-visible:ring-offset-[color:var(--page)]';

export function Cookbooks() {
  const { templates, defaultId, isLoading } = useTemplates();
  const [editing, setEditing] = React.useState<Partial<Template> | null>(null);
  const [tab, setTab] = React.useState<Tab>('discover');
  const [query, setQuery] = React.useState('');
  const [category, setCategory] = React.useState<CookbookCategory | 'all'>('all');
  const [view, setViewState] = React.useState<View>(() =>
    readStored(VIEW_KEY) === 'list' ? 'list' : 'grid',
  );
  const [introOpen, setIntroOpen] = React.useState(() => readStored(INTRO_KEY) !== '1');
  const scrollRef = React.useRef<HTMLDivElement>(null);

  const setView = (next: View) => {
    setViewState(next);
    writeStored(VIEW_KEY, next);
  };
  const dismissIntro = () => {
    setIntroOpen(false);
    writeStored(INTRO_KEY, '1');
  };

  const cookbooks = React.useMemo(() => templates.map(toCookbook), [templates]);
  const mine = React.useMemo(() => cookbooks.filter((c) => c.mine), [cookbooks]);
  const scope = tab === 'mine' ? mine : cookbooks;
  const filtering = query.trim() !== '' || category !== 'all';
  const results = React.useMemo(
    () =>
      scope.filter(
        (c) => (category === 'all' || c.category === category) && matchesQuery(c, query),
      ),
    [scope, category, query],
  );

  const open = (template: Partial<Template>) => {
    setEditing(template);
    scrollRef.current?.scrollTo({ top: 0 });
  };

  return (
    <MeetingsShell activeSummaryFile={null} bleed>
      <div
        ref={scrollRef}
        data-testid="cookbooks-page"
        className="scrollbar-clean min-h-0 flex-1 overflow-auto"
        style={{ scrollbarGutter: 'stable', background: 'var(--page)' }}
      >
        {editing ? (
          <div
            className="mx-auto flex w-full max-w-[960px] flex-col px-10 pb-10 pt-6"
            style={{ height: '100%', minHeight: 560 }}
          >
            <TemplateEditor
              key={editing.id ?? 'new'}
              editing={editing.id ? (editing as Template) : null}
              onClose={() => setEditing(null)}
            />
          </div>
        ) : (
          <div className="mx-auto w-full max-w-[1120px] px-10 pb-28 pt-9" style={{ color: 'var(--fg-1)' }}>
            <header className="flex flex-wrap items-end justify-between gap-4">
              <div>
                <h1
                  className="m-0 text-[44px] leading-[1.05] tracking-[-0.025em]"
                  style={{ fontFamily: 'var(--font-serif)' }}
                >
                  {t('cookbooks.title')}
                </h1>
                <p className="mt-2 text-[15px]" style={{ color: 'var(--fg-2)' }}>
                  {t('cookbooks.subtitle')}
                </p>
              </div>
              <Button onClick={() => open({})} className={cn('h-9 rounded-full pl-4 pr-3.5', FOCUS_RING)}>
                {t('cookbooks.create')}
                <Plus />
              </Button>
            </header>

            {introOpen && (
              <IntroCard
                onDismiss={dismissIntro}
                onLearnMore={() => void ipc().shell.openExternal(DOCS_URL)}
              />
            )}

            <Tabs value={tab} onValueChange={(v) => setTab(v as Tab)} className="mt-9">
              <div
                className="flex flex-wrap items-end justify-between gap-x-6 gap-y-3"
                style={{ borderBottom: '1px solid var(--border-subtle)' }}
              >
                <TabsList className="h-auto gap-6 rounded-none bg-transparent p-0">
                  <UnderlineTab value="discover">{t('cookbooks.tabs.discover')}</UnderlineTab>
                  <UnderlineTab value="mine">
                    {t('cookbooks.tabs.mine')}
                    {mine.length > 0 && (
                      <span
                        className="ml-1.5 rounded-full px-1.5 text-[10.5px] tabular-nums leading-[16px]"
                        style={{ background: 'var(--surface-active)', color: 'var(--fg-2)' }}
                      >
                        {mine.length}
                      </span>
                    )}
                  </UnderlineTab>
                </TabsList>
                <Toolbar
                  query={query}
                  onQuery={setQuery}
                  category={category}
                  onCategory={setCategory}
                  view={view}
                  onView={setView}
                />
              </div>

              <TabsContent value="discover" className="mt-0">
                {filtering ? (
                  <Results items={results} view={view} defaultId={defaultId} onOpen={open} />
                ) : (
                  <>
                    <FeaturedRow
                      items={featuredCookbooks(cookbooks)}
                      defaultId={defaultId}
                      onOpen={open}
                    />
                    {groupByCategory(cookbooks).map(({ category: cat, items }) => (
                      <CategorySection
                        key={cat}
                        category={cat}
                        items={items}
                        view={view}
                        defaultId={defaultId}
                        onOpen={open}
                      />
                    ))}
                  </>
                )}
              </TabsContent>

              <TabsContent value="mine" className="mt-0">
                {filtering ? (
                  <Results items={results} view={view} defaultId={defaultId} onOpen={open} />
                ) : mine.length === 0 && !isLoading ? (
                  <EmptyMine onCreate={() => open({})} />
                ) : (
                  <section className="mt-8">
                    <CookbookCollection
                      items={mine}
                      view={view}
                      defaultId={defaultId}
                      onOpen={open}
                      onCreate={() => open({})}
                    />
                  </section>
                )}
              </TabsContent>
            </Tabs>
          </div>
        )}
      </div>
    </MeetingsShell>
  );
}

function UnderlineTab({ value, children }: { value: Tab; children: React.ReactNode }) {
  return (
    <TabsTrigger
      value={value}
      className={cn(
        '-mb-px rounded-none border-b-2 border-transparent bg-transparent px-0 pb-3 pt-1 text-[13.5px] font-medium',
        'text-[color:var(--fg-2)] hover:text-[color:var(--fg-1)]',
        'data-[state=active]:border-[color:var(--fg-1)] data-[state=active]:bg-transparent data-[state=active]:text-[color:var(--fg-1)] data-[state=active]:shadow-none',
      )}
    >
      {children}
    </TabsTrigger>
  );
}

function Toolbar({
  query,
  onQuery,
  category,
  onCategory,
  view,
  onView,
}: {
  query: string;
  onQuery: (q: string) => void;
  category: CookbookCategory | 'all';
  onCategory: (c: CookbookCategory | 'all') => void;
  view: View;
  onView: (v: View) => void;
}) {
  return (
    <div className="flex flex-wrap items-center gap-2 pb-2.5">
      <div className="relative">
        <Search
          aria-hidden="true"
          className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2"
          style={{ color: 'var(--fg-2)' }}
        />
        <Input
          type="search"
          value={query}
          onChange={(e) => onQuery(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Escape' && query) {
              e.preventDefault();
              onQuery('');
            }
          }}
          placeholder={t('cookbooks.search')}
          aria-label={t('cookbooks.search')}
          className="h-8 w-[210px] rounded-full pl-8 pr-7 text-[13px] [&::-webkit-search-cancel-button]:hidden"
        />
        {query && (
          <button
            type="button"
            onClick={() => onQuery('')}
            aria-label={t('cookbooks.clearSearch')}
            className={cn(
              'absolute right-1.5 top-1/2 inline-flex size-5 -translate-y-1/2 items-center justify-center rounded-full hover:bg-[color:var(--surface-active)]',
              FOCUS_RING,
            )}
            style={{ color: 'var(--fg-2)' }}
          >
            <X className="size-3" />
          </button>
        )}
      </div>
      <Select value={category} onValueChange={(v) => onCategory(v as CookbookCategory | 'all')}>
        <SelectTrigger
          aria-label={t('cookbooks.filter')}
          className="h-8 w-auto min-w-[150px] gap-2 rounded-full px-3 text-[13px]"
        >
          <ListFilter aria-hidden="true" className="size-3.5" style={{ color: 'var(--fg-2)' }} />
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="all">{t('cookbooks.filter.all')}</SelectItem>
          {COOKBOOK_CATEGORIES.map((c) => (
            <SelectItem key={c} value={c}>
              {categoryLabel(c)}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      <div
        className="inline-flex h-8 items-center rounded-full p-0.5"
        style={{ border: '1px solid hsl(var(--border))' }}
      >
        {VIEWS.map((v) => {
          const Icon = v === 'grid' ? LayoutGrid : List;
          const active = view === v;
          return (
            <button
              key={v}
              type="button"
              onClick={() => onView(v)}
              aria-pressed={active}
              aria-label={v === 'grid' ? t('cookbooks.view.grid') : t('cookbooks.view.list')}
              className={cn(
                'inline-flex h-full w-8 items-center justify-center rounded-full transition-colors',
                FOCUS_RING,
                active
                  ? 'bg-[color:var(--surface-active)] text-[color:var(--fg-1)]'
                  : 'text-[color:var(--fg-2)] hover:text-[color:var(--fg-1)]',
              )}
            >
              <Icon className="size-3.5" />
            </button>
          );
        })}
      </div>
    </div>
  );
}

function IntroCard({ onDismiss, onLearnMore }: { onDismiss: () => void; onLearnMore: () => void }) {
  return (
    <section
      aria-labelledby="cookbooks-intro-title"
      className="mt-8 grid overflow-hidden rounded-[18px] lg:grid-cols-[minmax(0,1fr)_360px]"
      style={{ border: '1px solid var(--border-subtle)', background: 'var(--surface-raised)', boxShadow: 'var(--shadow-sm)' }}
    >
      <div className="order-2 flex flex-col justify-center p-7 lg:order-1 lg:p-9">
        <p
          className="text-[10.5px] font-semibold uppercase tracking-[0.14em]"
          style={{ color: 'var(--fg-2)' }}
        >
          {t('cookbooks.intro.eyebrow')}
        </p>
        <h2
          id="cookbooks-intro-title"
          className="mt-2 text-[26px] leading-tight"
          style={{ fontFamily: 'var(--font-serif)' }}
        >
          {t('cookbooks.intro.title')}
        </h2>
        <p className="mt-3 max-w-[520px] text-[14px] leading-relaxed" style={{ color: 'var(--fg-2)' }}>
          {t('cookbooks.intro.body')}
        </p>
        <div className="mt-6 flex items-center gap-2">
          <Button size="sm" onClick={onLearnMore} className={cn('rounded-full px-4', FOCUS_RING)}>
            {t('cookbooks.intro.learnMore')}
            <ArrowUpRight />
          </Button>
          <Button size="sm" variant="ghost" onClick={onDismiss} className={cn('rounded-full px-4', FOCUS_RING)}>
            {t('cookbooks.intro.dismiss')}
          </Button>
        </div>
      </div>
      <IntroArt />
    </section>
  );
}

/** The intro card's image panel: an ink plate of contours with three small
 *  covers fanned across it, one per motif family, like books on a shelf. */
function IntroArt() {
  const stack: { id: string; category: CookbookCategory; tone: CoverTone; rot: number; x: number; y: number }[] = [
    { id: 'intro-a', category: 'interviews', tone: 'stone', rot: -9, x: -86, y: 10 },
    { id: 'intro-b', category: 'briefings', tone: 'paper', rot: 0, x: 0, y: -8 },
    { id: 'intro-c', category: 'everyday', tone: 'stone', rot: 9, x: 86, y: 10 },
  ];
  return (
    <div aria-hidden="true" className="relative order-1 h-[200px] overflow-hidden lg:order-2 lg:h-auto lg:min-h-[248px]">
      <CookbookCover seedId="cookbooks-intro" category="planning" tone="ink" shape="wide" className="absolute inset-0" />
      <div className="absolute inset-0 flex items-center justify-center">
        {stack.map((s) => (
          <div
            key={s.id}
            className="absolute w-[92px] lg:w-[104px]"
            style={{ transform: `translate(${s.x}px, ${s.y}px) rotate(${s.rot}deg)` }}
          >
            <div
              className="overflow-hidden rounded-[10px]"
              style={{ boxShadow: '0 18px 30px -14px rgba(0,0,0,0.55), 0 0 0 1px rgba(255,255,255,0.06)' }}
            >
              <CookbookCover seedId={s.id} category={s.category} tone={s.tone} shape="tall" className="aspect-[3/4] w-full" />
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

function SectionHeader({
  id,
  children,
  blurb,
  actions,
}: {
  id: string;
  children: React.ReactNode;
  blurb?: string;
  actions?: React.ReactNode;
}) {
  return (
    <div className="mb-4 flex items-end justify-between gap-4">
      <div className="min-w-0">
        <h2 id={id} className="m-0 text-[22px] leading-tight" style={{ fontFamily: 'var(--font-serif)' }}>
          {children}
        </h2>
        {blurb && (
          <p className="mt-1 text-[13px]" style={{ color: 'var(--fg-2)' }}>
            {blurb}
          </p>
        )}
      </div>
      {actions}
    </div>
  );
}

function FeaturedRow({
  items,
  defaultId,
  onOpen,
}: {
  items: Cookbook[];
  defaultId: string;
  onOpen: (t: Template) => void;
}) {
  const rowRef = React.useRef<HTMLUListElement>(null);
  const [edges, setEdges] = React.useState({ start: true, end: true });

  const measure = React.useCallback(() => {
    const el = rowRef.current;
    if (!el) return;
    setEdges({
      start: el.scrollLeft <= 2,
      end: el.scrollLeft + el.clientWidth >= el.scrollWidth - 2,
    });
  }, []);
  React.useEffect(() => {
    measure();
    const el = rowRef.current;
    if (!el || typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, [measure, items.length]);

  const page = (dir: 1 | -1) => {
    const el = rowRef.current;
    if (!el) return;
    el.scrollBy({ left: dir * el.clientWidth * 0.8, behavior: prefersReducedMotion() ? 'auto' : 'smooth' });
  };

  // Arrow keys move between cards (Tab still walks them in order too); the
  // browser scrolls the focused card into view.
  const onKeyDown = (e: React.KeyboardEvent<HTMLUListElement>) => {
    const keys = ['ArrowLeft', 'ArrowRight', 'Home', 'End'];
    if (!keys.includes(e.key)) return;
    const cards = Array.from(e.currentTarget.querySelectorAll<HTMLButtonElement>('[data-featured-card]'));
    const index = cards.indexOf(document.activeElement as HTMLButtonElement);
    if (index < 0) return;
    e.preventDefault();
    const next =
      e.key === 'Home' ? 0 : e.key === 'End' ? cards.length - 1 : index + (e.key === 'ArrowRight' ? 1 : -1);
    cards[Math.max(0, Math.min(cards.length - 1, next))]?.focus();
  };

  if (items.length === 0) return null;
  const fade = !edges.end
    ? 'linear-gradient(to right, #000 calc(100% - 64px), transparent)'
    : undefined;

  return (
    <section aria-labelledby="cookbooks-featured" className="mt-8">
      <SectionHeader
        id="cookbooks-featured"
        blurb={t('cookbooks.featured.blurb')}
        actions={
          (!edges.start || !edges.end) && (
            <div className="flex gap-1.5">
              <RowArrow dir={-1} disabled={edges.start} onClick={() => page(-1)} />
              <RowArrow dir={1} disabled={edges.end} onClick={() => page(1)} />
            </div>
          )
        }
      >
        {t('cookbooks.featured')}
      </SectionHeader>
      <ul
        ref={rowRef}
        onScroll={measure}
        onKeyDown={onKeyDown}
        aria-labelledby="cookbooks-featured"
        className="cookbook-row -mx-2 -my-3 flex snap-x snap-mandatory scroll-px-2 gap-4 overflow-x-auto px-2 py-3"
        style={{ maskImage: fade, WebkitMaskImage: fade }}
      >
        {items.map((c, i) => (
          <li key={c.id} className="shrink-0 snap-start">
            <FeaturedCard
              cookbook={c}
              tone={FEATURED_TONES[i % FEATURED_TONES.length]}
              isDefault={c.id === defaultId}
              onOpen={() => onOpen(c.template)}
            />
          </li>
        ))}
      </ul>
    </section>
  );
}

function RowArrow({ dir, disabled, onClick }: { dir: 1 | -1; disabled: boolean; onClick: () => void }) {
  const Icon = dir === 1 ? ChevronRight : ChevronLeft;
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      aria-label={dir === 1 ? t('cookbooks.featured.next') : t('cookbooks.featured.prev')}
      className={cn(
        'inline-flex size-8 items-center justify-center rounded-full transition-colors hover:bg-[color:var(--surface-hover)] disabled:opacity-35 disabled:hover:bg-transparent',
        FOCUS_RING,
      )}
      style={{ border: '1px solid hsl(var(--border))', color: 'var(--fg-1)' }}
    >
      <Icon className="size-4" />
    </button>
  );
}

function metaLine(c: Cookbook) {
  const author = c.mine ? t('cookbooks.author.you') : t('cookbooks.author.steno');
  const format =
    c.template.format === 'structured' ? t('cookbooks.format.structured') : t('cookbooks.format.markdown');
  return `${author} · ${format}`;
}

function DefaultBadge({ inverse = false }: { inverse?: boolean }) {
  return (
    <span
      className="inline-flex shrink-0 items-center gap-1 rounded-full px-2 py-[1px] text-[10px] font-semibold uppercase tracking-[0.08em]"
      style={
        inverse
          ? { boxShadow: 'inset 0 0 0 1px currentColor', background: 'var(--cover-bg)' }
          : { color: 'var(--fg-1)', background: 'var(--surface-active)' }
      }
    >
      <Check aria-hidden="true" className="size-2.5" strokeWidth={3} />
      {t('cookbooks.default')}
    </span>
  );
}

function FeaturedCard({
  cookbook: c,
  tone,
  isDefault,
  onOpen,
}: {
  cookbook: Cookbook;
  tone: CoverTone;
  isDefault: boolean;
  onOpen: () => void;
}) {
  const Glyph = CATEGORY_GLYPHS[c.category];
  const nameId = `featured-${c.id}-name`;
  const descId = `featured-${c.id}-desc`;
  return (
    <button
      type="button"
      data-featured-card
      onClick={onOpen}
      aria-labelledby={nameId}
      aria-describedby={descId}
      data-cover-tone={tone}
      className={cn(
        'cookbook-cover group relative flex h-[324px] w-[236px] flex-col justify-between overflow-hidden rounded-[16px] text-left',
        'shadow-[var(--shadow-sm)] hover:shadow-[var(--shadow-lg)] motion-safe:transition-[transform,box-shadow] motion-safe:duration-300 motion-safe:hover:-translate-y-1',
        FOCUS_RING,
      )}
    >
      <CookbookCover seedId={c.id} category={c.category} tone={tone} shape="tall" className="absolute inset-0" />
      {/* Printed-plate frame: a hairline inset like a book cover's border. */}
      <span
        aria-hidden="true"
        className="pointer-events-none absolute inset-[9px] rounded-[10px]"
        style={{ boxShadow: 'inset 0 0 0 1px currentColor', opacity: 0.16 }}
      />
      <span className="relative flex p-4">
        <span
          className="inline-flex max-w-full items-center gap-1.5 whitespace-nowrap rounded-full py-1 pl-1.5 pr-2.5 text-[9.5px] font-semibold uppercase tracking-[0.12em]"
          style={{
            background: 'var(--cover-bg)',
            boxShadow: 'inset 0 0 0 1px color-mix(in srgb, currentColor 28%, transparent)',
          }}
        >
          <Glyph aria-hidden="true" className="size-3 shrink-0" strokeWidth={1.8} />
          <span className="truncate">{categoryLabel(c.category)}</span>
        </span>
      </span>
      <span className="relative block p-5 pt-0">
        {isDefault && (
          <span className="mb-2 flex">
            <DefaultBadge inverse />
          </span>
        )}
        <span
          id={nameId}
          className="line-clamp-2 block text-[26px] leading-[1.08] tracking-[-0.02em]"
          style={{ fontFamily: 'var(--font-serif)' }}
        >
          {c.name}
        </span>
        <span id={descId} className="mt-2 line-clamp-2 block text-[12px] leading-snug opacity-75">
          {c.description}
        </span>
        <span className="mt-3 block truncate text-[10.5px] font-medium uppercase tracking-[0.1em] opacity-60">
          {metaLine(c)}
        </span>
      </span>
    </button>
  );
}

function CategorySection({
  category,
  items,
  view,
  defaultId,
  onOpen,
}: {
  category: CookbookCategory;
  items: Cookbook[];
  view: View;
  defaultId: string;
  onOpen: (t: Template) => void;
}) {
  const id = `cookbooks-section-${category}`;
  return (
    <section aria-labelledby={id} className="mt-12">
      <SectionHeader id={id} blurb={BLURBS[category]()}>
        {categoryLabel(category)}
      </SectionHeader>
      <CookbookCollection items={items} view={view} defaultId={defaultId} onOpen={onOpen} />
    </section>
  );
}

function Results({
  items,
  view,
  defaultId,
  onOpen,
}: {
  items: Cookbook[];
  view: View;
  defaultId: string;
  onOpen: (t: Template) => void;
}) {
  return (
    <section className="mt-6" aria-live="polite">
      <p className="mb-4 text-[12.5px]" style={{ color: 'var(--fg-2)' }}>
        {items.length === 1
          ? t('cookbooks.results.one')
          : t('cookbooks.results.many', { count: items.length })}
      </p>
      {items.length === 0 ? (
        <div
          className="rounded-[14px] px-6 py-12 text-center"
          style={{ border: '1px dashed var(--border-strong)' }}
        >
          <p className="text-[14px] font-medium">{t('cookbooks.empty.search')}</p>
          <p className="mt-1 text-[13px]" style={{ color: 'var(--fg-2)' }}>
            {t('cookbooks.empty.searchHint')}
          </p>
        </div>
      ) : (
        <CookbookCollection items={items} view={view} defaultId={defaultId} onOpen={onOpen} />
      )}
    </section>
  );
}

function CookbookCollection({
  items,
  view,
  defaultId,
  onOpen,
  onCreate,
}: {
  items: Cookbook[];
  view: View;
  defaultId: string;
  onOpen: (t: Template) => void;
  onCreate?: () => void;
}) {
  if (view === 'list') {
    return (
      <ul
        className="overflow-hidden rounded-[14px]"
        style={{ border: '1px solid var(--border-subtle)', background: 'var(--surface-raised)' }}
      >
        {items.map((c, i) => (
          <li key={c.id} style={i ? { borderTop: '1px solid var(--border-subtle)' } : undefined}>
            <CookbookRow cookbook={c} isDefault={c.id === defaultId} onOpen={() => onOpen(c.template)} />
          </li>
        ))}
        {onCreate && (
          <li style={items.length ? { borderTop: '1px solid var(--border-subtle)' } : undefined}>
            <button
              type="button"
              onClick={onCreate}
              className={cn('flex w-full items-center gap-3 px-4 py-3 text-left text-[13px] hover:bg-[color:var(--surface-hover)]', FOCUS_RING)}
              style={{ color: 'var(--fg-2)' }}
            >
              <Plus className="size-4" />
              {t('cookbooks.newTile')}
            </button>
          </li>
        )}
      </ul>
    );
  }
  return (
    <ul className="grid gap-3 [grid-template-columns:repeat(auto-fill,minmax(272px,1fr))]">
      {items.map((c) => (
        <li key={c.id} className="flex">
          <CookbookTile cookbook={c} isDefault={c.id === defaultId} onOpen={() => onOpen(c.template)} />
        </li>
      ))}
      {onCreate && (
        <li className="flex">
          <button
            type="button"
            onClick={onCreate}
            className={cn(
              'flex w-full items-center gap-4 rounded-[14px] p-3.5 text-left transition-colors hover:bg-[color:var(--surface-hover)]',
              FOCUS_RING,
            )}
            style={{ border: '1px dashed var(--border-strong)' }}
          >
            <span
              className="inline-flex size-[60px] shrink-0 items-center justify-center rounded-[11px]"
              style={{ background: 'var(--surface-sunken)', color: 'var(--fg-2)' }}
            >
              <Plus className="size-5" />
            </span>
            <span className="min-w-0">
              <span className="block text-[14px] font-medium">{t('cookbooks.newTile')}</span>
              <span className="mt-0.5 block text-[12.5px]" style={{ color: 'var(--fg-2)' }}>
                {t('cookbooks.newTileHint')}
              </span>
            </span>
          </button>
        </li>
      )}
    </ul>
  );
}

function CookbookTile({
  cookbook: c,
  isDefault,
  onOpen,
}: {
  cookbook: Cookbook;
  isDefault: boolean;
  onOpen: () => void;
}) {
  const nameId = `tile-${c.id}-name`;
  const descId = `tile-${c.id}-desc`;
  return (
    <button
      type="button"
      onClick={onOpen}
      aria-labelledby={nameId}
      aria-describedby={descId}
      className={cn(
        'group flex w-full items-start gap-4 rounded-[14px] p-3.5 text-left transition-[background-color,box-shadow,border-color] duration-200',
        'border border-[color:var(--border-subtle)] bg-[color:var(--surface-raised)] hover:border-[color:var(--border-strong)] hover:shadow-[var(--shadow-md)]',
        FOCUS_RING,
      )}
    >
      <CookbookCover
        seedId={c.id}
        category={c.category}
        shape="square"
        glyph
        className="size-[60px] shrink-0 rounded-[11px]"
      />
      <span className="min-w-0 flex-1 pt-0.5">
        <span className="flex items-center gap-2">
          <span id={nameId} className="truncate text-[14px] font-medium" style={{ color: 'var(--fg-1)' }}>
            {c.name}
          </span>
          {isDefault && <DefaultBadge />}
        </span>
        <span
          id={descId}
          className="mt-0.5 line-clamp-2 block text-[12.5px] leading-snug"
          style={{ color: 'var(--fg-2)' }}
        >
          {c.description}
        </span>
        <span className="mt-2 block text-[11px]" style={{ color: 'var(--fg-muted)' }}>
          {metaLine(c)}
        </span>
      </span>
    </button>
  );
}

function CookbookRow({
  cookbook: c,
  isDefault,
  onOpen,
}: {
  cookbook: Cookbook;
  isDefault: boolean;
  onOpen: () => void;
}) {
  const nameId = `row-${c.id}-name`;
  const descId = `row-${c.id}-desc`;
  return (
    <button
      type="button"
      onClick={onOpen}
      aria-labelledby={nameId}
      aria-describedby={descId}
      className={cn('group flex w-full items-center gap-3.5 px-4 py-2.5 text-left hover:bg-[color:var(--surface-hover)]', FOCUS_RING)}
    >
      <CookbookCover seedId={c.id} category={c.category} shape="square" glyph className="size-9 shrink-0 rounded-[8px]" />
      <span className="min-w-0 flex-1">
        <span className="flex items-center gap-2">
          <span id={nameId} className="truncate text-[13.5px] font-medium" style={{ color: 'var(--fg-1)' }}>
            {c.name}
          </span>
          {isDefault && <DefaultBadge />}
        </span>
        <span id={descId} className="block truncate text-[12.5px]" style={{ color: 'var(--fg-2)' }}>
          {c.description}
        </span>
      </span>
      <span className="hidden shrink-0 text-[12px] md:block" style={{ color: 'var(--fg-2)' }}>
        {categoryLabel(c.category)}
      </span>
      <span className="hidden w-[140px] shrink-0 text-right text-[11.5px] lg:block" style={{ color: 'var(--fg-muted)' }}>
        {metaLine(c)}
      </span>
    </button>
  );
}

function EmptyMine({ onCreate }: { onCreate: () => void }) {
  return (
    <div
      className="mt-8 flex flex-col items-center rounded-[18px] px-6 py-14 text-center"
      style={{ border: '1px dashed var(--border-strong)' }}
    >
      <div className="w-[88px] overflow-hidden rounded-[10px]" style={{ boxShadow: 'var(--shadow-md)' }}>
        <CookbookCover seedId="empty-mine" category="briefings" tone="ink" shape="tall" className="aspect-[3/4] w-full" />
      </div>
      <p className="mt-6 text-[17px]" style={{ fontFamily: 'var(--font-serif)' }}>
        {t('cookbooks.empty.mine')}
      </p>
      <p className="mt-1 max-w-[380px] text-[13px]" style={{ color: 'var(--fg-2)' }}>
        {t('cookbooks.empty.mineHint')}
      </p>
      <Button size="sm" onClick={onCreate} className={cn('mt-5 rounded-full px-4', FOCUS_RING)}>
        {t('cookbooks.create')}
        <Plus />
      </Button>
    </div>
  );
}
