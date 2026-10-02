import { clsx, type ClassValue } from 'clsx';
import { twMerge } from 'tailwind-merge';

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

const bridgePlatform =
  typeof window !== 'undefined' ? window.stenoai?.app?.platform : undefined;

export const isMac = bridgePlatform
  ? bridgePlatform === 'darwin'
  : typeof navigator !== 'undefined'
    && /mac|iphone|ipad|ipod/i.test(navigator.platform || navigator.userAgent);

export const isLinux = bridgePlatform
  ? bridgePlatform === 'linux'
  : typeof navigator !== 'undefined' && /linux/i.test(navigator.platform || navigator.userAgent);

/**
 * Render a keyboard shortcut for the current platform. Pass mac glyphs and a
 * non-mac fallback; we pick the right one at call time. The Electron main
 * accelerator already auto-maps CommandOrControl, so this is purely cosmetic.
 */
export function shortcut(mac: string, other: string): string {
  return isMac ? mac : other;
}

/**
 * Format an elapsed-seconds count as ``MM:SS`` (or ``H:MM:SS`` past an hour).
 * Used by every dock + transcript surface that shows recording duration.
 * Negative or fractional inputs clamp to 0 and integer-truncate, so callers
 * can pass live elapsed counters without pre-rounding.
 */
export function formatElapsed(seconds: number): string {
  const s = Math.max(0, seconds | 0);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const rem = s % 60;
  const pad = (n: number) => n.toString().padStart(2, '0');
  if (h > 0) return `${h}:${pad(m)}:${pad(rem)}`;
  return `${pad(m)}:${pad(rem)}`;
}
