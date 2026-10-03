import { describe, expect, test } from 'vitest';
import { boundedChatHistory } from './chat';

describe('conversation history follows explicit context', () => {
  test('switching back to an org meeting excludes private general and local-note turns', () => {
    const messages = [
      { role: 'user' as const, content: 'Shared question' },
      { role: 'assistant' as const, content: 'Shared answer', context: '__meeting__' },
      { role: 'user' as const, content: 'Private question', context: '__general__' },
      { role: 'assistant' as const, content: 'Private note', context: 'notes' },
    ];
    expect(boundedChatHistory(messages, '__meeting__', '__meeting__').map((m) => m.content)).toEqual(['Shared question', 'Shared answer']);
    expect(boundedChatHistory(messages, '__general__', '__meeting__').map((m) => m.content)).toEqual(['Private question']);
  });
  test('caps turns, per-turn content and total content', () => {
    const messages = Array.from({ length: 10 }, () => ({ role: 'user' as const, content: 'x'.repeat(6000) }));
    const history = boundedChatHistory(messages, 'notes', 'notes');
    expect(history).toHaveLength(3);
    expect(history.every((m) => m.content.length === 4000)).toBe(true);
  });
});
