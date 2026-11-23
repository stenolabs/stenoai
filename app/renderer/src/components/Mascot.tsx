import * as React from 'react';

// The Steno dragonfly as a 16-bit-style pixel sprite: a hand-drawn grid, a
// small palette and dark outlines. Two frames (wings level, wings raised) so
// it flaps while the chat is idle; it settles on frame 0 while the user types.
// One character per pixel; '.' is transparent.
const FRAMES: string[][] = [
  [
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
};

const PIXEL = 5;
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

export function Mascot({ resting = false }: { resting?: boolean }) {
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
    <div aria-hidden="true" data-testid="chat-mascot" className="mb-6 flex justify-center">
      <div className={still ? 'steno-mascot' : 'steno-mascot steno-mascot-float'}>
        <Sprite rows={FRAMES[frame]} />
      </div>
    </div>
  );
}
