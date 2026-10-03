import { describe, expect, it } from 'vitest';
import { isUnseenRelease } from './releaseHighlights';

describe('release announcement eligibility', () => {
  it.each([
    ['0.7.1', null, true],
    ['0.7.1', 'invalid', true],
    ['0.7.1', '0.7.1', false],
    ['0.7.2', '0.7.1', true],
    ['0.10.0', '0.9.9', true],
    ['1.0.0', '0.99.99', true],
    ['0.7.0', '0.7.1', false],
    ['0.9.0', '0.10.0', false],
    ['0.7.2-beta.1', '0.7.1', false],
    ['0.0.0-e2e', null, false],
  ])('%s after %s is unseen: %s', (current, seen, expected) => {
    expect(isUnseenRelease(current, seen)).toBe(expected);
  });
});
