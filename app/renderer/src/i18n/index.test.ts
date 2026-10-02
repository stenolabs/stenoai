import { describe, expect, it } from 'vitest';
import { createTranslator } from './index';

describe('createTranslator', () => {
  const translate = createTranslator({
    greeting: 'Hello, {{name}}.',
    malformed: '{{count items}} and {{1}} stay visible',
    repeated: '{{count}} of {{count}}',
  });

  it('resolves typed catalogue keys and interpolates parameters', () => {
    expect(translate('greeting', { name: 'Ada' })).toBe('Hello, Ada.');
    expect(translate('repeated', { count: 2 })).toBe('2 of 2');
  });

  it('leaves an omitted parameter visible instead of deleting copy', () => {
    expect(translate('greeting')).toBe('Hello, {{name}}.');
  });

  it('leaves malformed interpolation tokens visible', () => {
    expect(translate('malformed', { 'count items': 2, 1: 'one' })).toBe(
      '{{count items}} and {{1}} stay visible',
    );
  });
});
