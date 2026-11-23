import * as React from 'react';

// The Steno dragonfly as a 16-bit-style pixel sprite: a hand-drawn grid, a
// small palette and dark outlines. Two frames (wings level, wings raised) so
// it flaps while the chat is idle; it settles on frame 0 while the user types.
// One character per pixel; '.' is transparent.
const FRAMES: string[][] = [
  [
    '................KK...........',
    '...............KTTK..........',
    '..............KRKK...........',
    '.............KRRrK...........',
    '............KRRRRrK..........',
    '...........KTTTTTTTK.........',
    '............KK.KK............',
    '...........KeEKeEK...........',
    '...........KEEKEEK...........',
    '............KBBBK............',
    '.KKKKKKKKKKKKBhBKKKKKKKKKKKK.',
    'KWWVWWWWVWWWKBhBKWWWVWWWWVWWK',
    'KWVWWWWVWWWWKBhBKWWWWVWWWWVWK',
    '.KKKKKKKKKKKKBhBKKKKKKKKKKKK.',
    '..KKKKKKKKKKKBhBKKKKKKKKKKK..',
    '.KWWVWWWVWWWKBhBKWWWVWWWVWWK.',
    '.KWVWWWVWWWWKBhBKWWWWVWWWVWK.',
    '..KKKKKKKKKKKBhBKKKKKKKKKKK..',
    '.............KhK.............',
    '.............KhK.............',
    '.............KbK.............',
    '.............KhK.............',
    '.............KhK.............',
    '.............KbK.............',
    '.............KhK.............',
    '.............KhK.............',
    '.............KbK.............',
    '.............KhK.............',
    '..............K..............',
  ],
  [
    '................KK...........',
    '...............KTTK..........',
    '..............KRKK...........',
    '.............KRRrK...........',
    '............KRRRRrK..........',
    '...........KTTTTTTTK.........',
    '............KK.KK............',
    '...........KeEKeEK...........',
    '...........KEEKEEK...........',
    '............KBBBK............',
    '...KKKKKKKKKKBhBKKKKKKKKKK...',
    '..KWWVWWWVWWKBhBKWWVWWWVWWK..',
    '..KWVWWWVWWWKBhBKWWWVWWWVWK..',
    '...KKKKKKKKKKBhBKKKKKKKKKK...',
    '....KKKKKKKKKBhBKKKKKKKKK....',
    '...KWVWWWVWWKBhBKWWVWWWVWK...',
    '...KWWVWWWWWKBhBKWWWWWVWWK...',
    '....KKKKKKKKKBhBKKKKKKKKK....',
    '.............KhK.............',
    '.............KhK.............',
    '.............KbK.............',
    '.............KhK.............',
    '.............KhK.............',
    '.............KbK.............',
    '.............KhK.............',
    '.............KhK.............',
    '.............KbK.............',
    '.............KhK.............',
    '..............K..............',
  ],
];

// Palette (outline follows the theme so it reads on paper and on ink).
const PALETTE: Record<string, string> = {
  K: 'var(--mascot-outline)',
  W: '#CDEBF5', // wing
  V: '#86C5DE', // wing vein
  E: '#1F8F82', // eye
  e: '#FFFFFF', // eye glint
  B: '#2BB3A3', // body
  h: '#7FE3D4', // body highlight
  b: '#167467', // body segment
  R: '#D2423A', // Christmas hat
  r: '#A8302A', // hat shade
  T: '#FFFFFF', // hat trim and pompom
};

const PIXEL = 4;
const FLAP_MS = 180;

function prefersReducedMotion() {
  try {
    return window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  } catch {
    return false;
  }
}

function Sprite({ rows }: { rows: string[] }) {
  const width = rows[0].length;
  const cells: React.ReactNode[] = [];
  rows.forEach((row, y) => {
    for (let x = 0; x < row.length; x += 1) {
      const fill = PALETTE[row[x]];
      if (fill) cells.push(<rect key={`${x}-${y}`} x={x} y={y} width={1} height={1} fill={fill} />);
    }
  });
  return (
    <svg
      viewBox={`0 0 ${width} ${rows.length}`}
      width={width * PIXEL}
      height={rows.length * PIXEL}
      shapeRendering="crispEdges"
      focusable="false"
    >
      {cells}
    </svg>
  );
}

export function Mascot({
  resting = false,
  snow = true,
  className = 'mb-5',
  testId = 'chat-mascot',
}: {
  resting?: boolean;
  snow?: boolean;
  className?: string;
  testId?: string;
}) {
  const [frame, setFrame] = React.useState(0);
  const still = resting || prefersReducedMotion();

  React.useEffect(() => {
    if (still) {
      setFrame(0);
      return;
    }
    const timer = window.setInterval(() => setFrame((f) => (f + 1) % FRAMES.length), FLAP_MS);
    return () => window.clearInterval(timer);
  }, [still]);

  return (
    <div aria-hidden="true" data-testid={testId} className={`${className} flex justify-center`}>
      <div className="relative">
        {snow && <Snow />}
        <div className={still ? 'steno-mascot' : 'steno-mascot steno-mascot-float'}>
          <Sprite rows={FRAMES[frame]} />
        </div>
      </div>
    </div>
  );
}

// Pixel snow for the Christmas release: square flakes in the sprite's own
// pixel size, drifting down around the dragonfly. CSS only; still (and
// hidden) under reduced motion.
const FLAKES = [
  { x: -46, delay: 0, dur: 5.2, size: 1 },
  { x: -28, delay: 1.6, dur: 6.4, size: 1 },
  { x: -8, delay: 3.1, dur: 5.6, size: 1 },
  { x: 12, delay: 0.8, dur: 6.0, size: 1 },
  { x: 30, delay: 2.4, dur: 5.0, size: 1 },
  { x: 52, delay: 4.0, dur: 6.8, size: 1 },
  { x: 72, delay: 1.2, dur: 5.8, size: 1 },
  { x: 92, delay: 3.6, dur: 6.2, size: 1 },
  { x: 110, delay: 0.4, dur: 5.4, size: 1 },
  { x: 130, delay: 2.8, dur: 6.6, size: 1 },
  { x: 150, delay: 4.6, dur: 5.9, size: 1 },
  { x: 166, delay: 1.9, dur: 6.1, size: 1 },
];

function Snow() {
  return (
    <div className="steno-snow" aria-hidden="true">
      {FLAKES.map((f, i) => (
        <span
          key={i}
          className="steno-snow-flake"
          style={{
            left: f.x,
            width: PIXEL * f.size,
            height: PIXEL * f.size,
            animationDelay: `${f.delay}s`,
            animationDuration: `${f.dur}s`,
          }}
        />
      ))}
    </div>
  );
}
