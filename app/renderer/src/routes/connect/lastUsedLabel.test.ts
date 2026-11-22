import { describe, expect, it } from 'vitest';
import { lastUsedLabel } from './ConnectionStatus';

describe('lastUsedLabel', () => {
  const now = Date.parse('2026-11-22T12:00:00.000Z');
  const ago = (ms: number) => new Date(now - ms).toISOString();

  it('reads as a short relative time', () => {
    expect(lastUsedLabel(ago(20_000), now)).toBe('Last used just now');
    expect(lastUsedLabel(ago(5 * 60_000), now)).toBe('Last used 5 min ago');
    expect(lastUsedLabel(ago(3 * 3_600_000), now)).toBe('Last used 3 hr ago');
    expect(lastUsedLabel(ago(30 * 3_600_000), now)).toBe('Last used yesterday');
    expect(lastUsedLabel(ago(4 * 86_400_000), now)).toBe('Last used 4 days ago');
  });

  it('shows nothing without a valid time, and clamps clock skew', () => {
    expect(lastUsedLabel(null, now)).toBeNull();
    expect(lastUsedLabel('garbage', now)).toBeNull();
    expect(lastUsedLabel(new Date(now + 60_000).toISOString(), now)).toBe('Last used just now');
  });
});
