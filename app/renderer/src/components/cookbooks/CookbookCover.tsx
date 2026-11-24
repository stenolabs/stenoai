import * as React from 'react';
import { CalendarRange, Coffee, MessagesSquare, Signpost, type LucideIcon } from 'lucide-react';
import { cn } from '@/lib/utils';
import { seedFromId, seededRandom, type CookbookCategory } from '@/lib/cookbooks';

// ---------------------------------------------------------------------------
// Generative cover art for a cookbook. No stock imagery: every cover is line-
// work drawn from a seed derived from the cookbook id, so a cookbook always
// gets the same cover, in ink/paper tones plus a few muted printed-ink colours. Each
// category has its own pair of motifs so a section reads as a family:
//
//   briefings  → steno-pad ruling with shorthand strokes | concentric arcs
//   interviews → stacked voice ridges                    | halftone field
//   planning   → topographic contours                    | survey grid
//   everyday   → halftone field                          | concentric arcs
//
// Colours come from the --cover-* tokens in globals.css, which are redefined
// for dark mode (ink covers deepen, paper covers turn warm graphite). Covers
// are decorative — the card around them carries the accessible name — so the
// SVG is aria-hidden.
// ---------------------------------------------------------------------------

export type CoverTone = 'ink' | 'paper' | 'stone' | 'sage' | 'clay' | 'sky' | 'plum' | 'ochre';
/** The colour tones, for rows that want colour (recipes, featured cookbooks). */
export const COLOUR_TONES: CoverTone[] = ['sage', 'clay', 'sky', 'plum', 'ochre'];
type Motif = 'ruled' | 'arcs' | 'ridges' | 'halftone' | 'contours' | 'survey';

const CATEGORY_MOTIFS: Record<CookbookCategory, [Motif, Motif]> = {
  briefings: ['ruled', 'arcs'],
  interviews: ['ridges', 'halftone'],
  planning: ['contours', 'survey'],
  everyday: ['halftone', 'arcs'],
};

export const CATEGORY_GLYPHS: Record<CookbookCategory, LucideIcon> = {
  briefings: Signpost,
  interviews: MessagesSquare,
  planning: CalendarRange,
  everyday: Coffee,
};

const TONES: CoverTone[] = ['ink', 'stone', 'paper', 'sage', 'clay', 'sky', 'plum', 'ochre'];

export function toneForSeed(id: string): CoverTone {
  return TONES[seedFromId(id) % TONES.length];
}

const f = (n: number) => n.toFixed(1);

function ruled(w: number, h: number, rand: () => number) {
  const lines: string[] = [];
  const gap = 13;
  for (let y = gap * 2; y < h; y += gap) lines.push(`M0 ${f(y)}H${w}`);
  // Shorthand strokes: loose cursive marks sitting on a few of the rules.
  const strokes: string[] = [];
  const rows = Math.floor(h / gap) - 3;
  const count = 5 + Math.floor(rand() * 4);
  for (let i = 0; i < count; i++) {
    const row = 2 + Math.floor(rand() * rows);
    const y = row * gap;
    const left = rand() < 0.5;
    let x = (left ? 10 : w / 2 + 10) + rand() * (w / 2 - 50);
    let d = `M${f(x)} ${f(y - 2)}`;
    const segs = 2 + Math.floor(rand() * 3);
    for (let s = 0; s < segs; s++) {
      const dx = 8 + rand() * 14;
      const up = 6 + rand() * 10;
      d += ` c${f(dx * 0.3)} ${f(-up)} ${f(dx * 0.8)} ${f(-up * 0.4)} ${f(dx)} ${f(rand() * 4 - 2)}`;
      x += dx;
    }
    strokes.push(d);
  }
  return (
    <>
      <path d={lines.join('')} strokeWidth={0.6} opacity={0.35} />
      <path d={`M${f(w / 2 - 2)} 0V${h}M${f(w / 2 + 2)} 0V${h}`} strokeWidth={0.7} opacity={0.5} />
      <path d={strokes.join('')} strokeWidth={1.6} strokeLinecap="round" opacity={0.9} fill="none" />
    </>
  );
}

function arcs(w: number, h: number, rand: () => number) {
  const corner = Math.floor(rand() * 4);
  const cx = corner % 2 === 0 ? w * (0.15 + rand() * 0.2) : w * (0.65 + rand() * 0.2);
  const cy = h * (0.18 + rand() * 0.25);
  const rings: React.ReactNode[] = [];
  const step = 7 + rand() * 5;
  const max = Math.hypot(w, h);
  for (let r = step, i = 0; r < max; r += step, i++) {
    rings.push(
      <circle
        key={i}
        cx={cx}
        cy={cy}
        r={r}
        strokeWidth={i % 4 === 0 ? 1.4 : 0.6}
        opacity={i % 4 === 0 ? 0.85 : 0.4}
        fill="none"
      />,
    );
  }
  return (
    <>
      {rings}
      <circle cx={cx} cy={cy} r={step * 1.6} fill="currentColor" stroke="none" opacity={0.9} />
    </>
  );
}

function ridges(w: number, h: number, rand: () => number) {
  const paths: string[] = [];
  const gap = 9;
  const peaks = Array.from({ length: 2 + Math.floor(rand() * 2) }, () => ({
    x: w * (0.2 + rand() * 0.6),
    s: w * (0.06 + rand() * 0.1),
    a: 0.5 + rand() * 0.8,
  }));
  for (let y = gap * 2, row = 0; y < h + 20; y += gap, row++) {
    let d = '';
    const jitter = rand() * 10;
    for (let x = 0; x <= w; x += 3) {
      let lift = 0;
      for (const p of peaks) lift += p.a * Math.exp(-((x - p.x) ** 2) / (2 * p.s ** 2));
      const noise = Math.sin(x * 0.21 + jitter + row) * 0.6 + Math.sin(x * 0.53 + row * 1.7) * 0.4;
      const yy = y - lift * (18 + noise * 6);
      d += `${x === 0 ? 'M' : 'L'}${f(x)} ${f(yy)}`;
    }
    paths.push(d);
  }
  return paths.map((d, i) => (
    <path key={i} d={d} fill="var(--cover-bg)" strokeWidth={i % 5 === 0 ? 1.3 : 0.8} opacity={0.9} />
  ));
}

function halftone(w: number, h: number, rand: () => number) {
  const fx = w * (0.25 + rand() * 0.5);
  const fy = h * (0.15 + rand() * 0.3);
  const gap = 9;
  const reach = Math.max(w, h) * (0.55 + rand() * 0.2);
  const dots: string[] = [];
  for (let y = gap / 2, row = 0; y < h; y += gap, row++) {
    for (let x = (row % 2 ? gap / 2 : 0) + gap / 2; x < w; x += gap) {
      const k = 1 - Math.min(1, Math.hypot(x - fx, y - fy) / reach);
      const r = k * k * gap * 0.55;
      if (r < 0.35) continue;
      dots.push(`M${f(x - r)} ${f(y)}a${f(r)} ${f(r)} 0 1 0 ${f(r * 2)} 0a${f(r)} ${f(r)} 0 1 0 ${f(-r * 2)} 0`);
    }
  }
  return <path d={dots.join('')} fill="currentColor" stroke="none" opacity={0.85} />;
}

function contours(w: number, h: number, rand: () => number) {
  const cx = w * (0.3 + rand() * 0.4);
  const cy = h * (0.22 + rand() * 0.2);
  const waves = Array.from({ length: 3 }, (_, i) => ({
    k: i + 2,
    phase: rand() * Math.PI * 2,
    amp: (0.16 - i * 0.04) * (0.6 + rand() * 0.6),
  }));
  const paths: React.ReactNode[] = [];
  const step = 8 + rand() * 3;
  const max = Math.hypot(w, h) * 0.9;
  for (let r = step * 0.8, i = 0; r < max; r += step, i++) {
    let d = '';
    for (let a = 0; a <= 72; a++) {
      const th = (a / 72) * Math.PI * 2;
      let m = 1;
      for (const wv of waves) m += wv.amp * Math.sin(wv.k * th + wv.phase + i * 0.08);
      const x = cx + Math.cos(th) * r * m;
      const y = cy + Math.sin(th) * r * m * 0.9;
      d += `${a === 0 ? 'M' : 'L'}${f(x)} ${f(y)}`;
    }
    paths.push(
      <path
        key={i}
        d={`${d}Z`}
        fill="none"
        strokeWidth={i % 5 === 4 ? 1.3 : 0.6}
        opacity={i % 5 === 4 ? 0.9 : 0.45}
      />,
    );
  }
  return paths;
}

function survey(w: number, h: number, rand: () => number) {
  const gap = 16;
  const grid: string[] = [];
  for (let x = gap; x < w; x += gap) grid.push(`M${f(x)} 0V${h}`);
  for (let y = gap; y < h; y += gap) grid.push(`M0 ${f(y)}H${w}`);
  // A plotted route: a few waypoints joined by straight legs, with markers.
  const count = 4 + Math.floor(rand() * 2);
  const points = Array.from({ length: count }, (_, i) => ({
    x: Math.round(((i + 0.5) / count) * (w / gap)) * gap,
    y: Math.round((h * (0.15 + rand() * 0.45)) / gap) * gap,
  }));
  const route = points.map((p, i) => `${i ? 'L' : 'M'}${p.x} ${p.y}`).join('');
  return (
    <>
      <path d={grid.join('')} strokeWidth={0.5} opacity={0.35} />
      <path d={route} strokeWidth={1.4} fill="none" strokeLinejoin="round" opacity={0.9} />
      {points.map((p, i) => (
        <rect
          key={i}
          x={p.x - 3}
          y={p.y - 3}
          width={6}
          height={6}
          fill={i === points.length - 1 ? 'currentColor' : 'var(--cover-bg)'}
          strokeWidth={1.2}
        />
      ))}
    </>
  );
}

const MOTIFS: Record<Motif, (w: number, h: number, rand: () => number) => React.ReactNode> = {
  ruled,
  arcs,
  ridges,
  halftone,
  contours,
  survey,
};

export interface CookbookCoverProps {
  seedId: string;
  category: CookbookCategory;
  tone?: CoverTone;
  /** 'tall' = Featured card art (fades out toward the label), 'square' = tile. */
  shape: 'tall' | 'square' | 'wide';
  /** Show the category glyph (tiles centre it; tall covers leave it to the card). */
  glyph?: boolean;
  className?: string;
}

const SIZES = { tall: [240, 320], square: [96, 96], wide: [360, 240] } as const;

export function CookbookCover({
  seedId,
  category,
  tone,
  shape,
  glyph = false,
  className,
}: CookbookCoverProps) {
  const uid = React.useId().replace(/:/g, '');
  const resolvedTone = tone ?? toneForSeed(seedId);
  const [w, h] = SIZES[shape];
  const art = React.useMemo(() => {
    const seed = seedFromId(seedId);
    const rand = seededRandom(seed);
    const motif = CATEGORY_MOTIFS[category][seed % 7 < 4 ? 0 : 1];
    return MOTIFS[motif](w, h, rand);
  }, [seedId, category, w, h]);
  const Glyph = CATEGORY_GLYPHS[category];

  return (
    <div
      aria-hidden="true"
      data-cover-tone={resolvedTone}
      className={cn('cookbook-cover relative overflow-hidden', className)}
    >
      <svg
        viewBox={`0 0 ${w} ${h}`}
        preserveAspectRatio="xMidYMid slice"
        className="cookbook-cover-art absolute inset-0 h-full w-full"
        focusable="false"
      >
        <defs>
          <filter id={`grain-${uid}`} x="0" y="0" width="100%" height="100%">
            <feTurbulence type="fractalNoise" baseFrequency="0.85" numOctaves="2" stitchTiles="stitch" />
            <feColorMatrix values="0 0 0 0 0.5  0 0 0 0 0.5  0 0 0 0 0.5  0 0 0 0.9 0" />
          </filter>
          {shape === 'tall' && (
            <linearGradient id={`fade-${uid}`} x1="0" y1="0" x2="0" y2="1">
              <stop offset="0" stopColor="#fff" stopOpacity="1" />
              <stop offset="0.5" stopColor="#fff" stopOpacity="0.85" />
              <stop offset="0.82" stopColor="#fff" stopOpacity="0.08" />
              <stop offset="1" stopColor="#fff" stopOpacity="0" />
            </linearGradient>
          )}
          {shape === 'tall' && (
            <mask id={`mask-${uid}`}>
              <rect width={w} height={h} fill={`url(#fade-${uid})`} />
            </mask>
          )}
        </defs>
        <rect width={w} height={h} fill="var(--cover-bg)" />
        <g
          className="cookbook-cover-lines"
          stroke="currentColor"
          fill="none"
          mask={shape === 'tall' ? `url(#mask-${uid})` : undefined}
        >
          {art}
        </g>
        <rect
          width={w}
          height={h}
          filter={`url(#grain-${uid})`}
          style={{ mixBlendMode: 'overlay', opacity: 'var(--cover-grain)' }}
        />
      </svg>
      {glyph && (
        <span className="cookbook-cover-glyph absolute left-1/2 top-1/2 flex -translate-x-1/2 -translate-y-1/2 items-center justify-center rounded-full">
          <Glyph strokeWidth={1.6} />
        </span>
      )}
    </div>
  );
}
