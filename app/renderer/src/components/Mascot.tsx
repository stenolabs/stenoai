import * as React from 'react';

// The Steno dragonfly, in ASCII. Two wing frames; it flaps while the chat is
// idle and settles (frame 0, no float) while the user is typing.
const FRAMES = [
  String.raw` .-~~~~~~~~-.  ___  .-~~~~~~~~-.
(____________)(o o)(____________)
 .-~~~~~~~~-.  ) (  .-~~~~~~~~-.
(____________)=( )=(____________)
               | |
               | |
               | |
               | |
               '-'`,
  String.raw`  .-~~~~~~~-.  ___  .-~~~~~~~-.
 (__________/ (o o) \__________)
  .-~~~~~~~-.  ) (  .-~~~~~~~-.
 (__________\ =( )= /__________)
               | |
               | |
               | |
               | |
               '-'`,
];

const FLAP_MS = 260;

function prefersReducedMotion() {
  try {
    return window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  } catch {
    return false;
  }
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
      <pre
        className={still ? 'steno-mascot' : 'steno-mascot steno-mascot-float'}
        style={{ fontFamily: 'var(--font-mono)' }}
      >
        {FRAMES[frame]}
      </pre>
    </div>
  );
}
