import type * as React from 'react';
import { AnthropicIcon } from '@/components/ui/anthropic-icon';
import { OpenAiIcon } from '@/components/ui/openai-icon';

export type GlyphKind = 'anthropic' | 'openai' | 'cursor' | 'initials';

/**
 * Monochrome tile for an integration: the brand marks already in the repo
 * (Anthropic, OpenAI) in ink, or a neutral glyph/initials otherwise. Paper and
 * ink only, so the grid reads as one palette.
 */
export function ConnectGlyph({ kind, initials }: { kind: GlyphKind; initials?: string }) {
  let mark: React.ReactNode;
  if (kind === 'anthropic') mark = <AnthropicIcon size={18} />;
  else if (kind === 'openai') mark = <OpenAiIcon size={18} />;
  else if (kind === 'cursor') mark = <CursorGlyph />;
  else {
    mark = (
      <span
        className="text-[12px] font-medium tracking-tight"
        style={{ fontFamily: 'var(--font-sans)' }}
      >
        {initials}
      </span>
    );
  }
  return (
    <span
      aria-hidden
      className="flex size-9 shrink-0 items-center justify-center rounded-lg"
      style={{ background: 'var(--surface-sunken)', color: 'var(--fg-1)' }}
    >
      {mark}
    </span>
  );
}

/** A plain hexagonal cube: neutral, not Cursor's trademark. */
function CursorGlyph() {
  return (
    <svg
      viewBox="0 0 24 24"
      width={18}
      height={18}
      fill="none"
      stroke="currentColor"
      strokeWidth={1.6}
      aria-hidden
    >
      <path d="M12 2.8 20 7.4v9.2L12 21.2 4 16.6V7.4Z" strokeLinejoin="round" />
      <path d="M4 7.4 12 12l8-4.6M12 12v9.2" strokeLinejoin="round" />
    </svg>
  );
}
