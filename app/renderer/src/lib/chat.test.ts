import { describe, expect, test } from 'vitest';
import { boundedChatHistory, shortModelName } from './chat';

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
    const short = Array.from({ length: 10 }, (_, i) => ({ role: 'user' as const, content: String(i) }));
    expect(boundedChatHistory(short, 'notes', 'notes').map((m) => m.content)).toEqual(['4', '5', '6', '7', '8', '9']);
  });
});

describe('short model names', () => {
  test.each([
    ['gemma4:e2b-it-qat', 'Gemma 4 E2B'],
    ['qwen3.5:9b', 'Qwen 3.5 9B'],
    ['gpt-oss:20b', 'GPT-OSS 20B'],
    ['deepseek-r1:14b', 'DeepSeek R1 14B'],
    ['llama3.2:3b', 'Llama 3.2 3B'],
    ['gemma4:12b', 'Gemma 4 12B'],
    ['qwen3:8b', 'Qwen 3 8B'],
    ['hf.co/bartowski/google_gemma-4-E2B-it-GGUF:Q4_K_M', 'Gemma 4 E2B'],
    ['hf.co/bartowski/Llama-3.2-1B-Instruct-GGUF:Q4_K_M', 'Llama 3.2 1B'],
    ['mistral-small:latest', 'Mistral Small'],
  ])('%s -> %s', (id, label) => {
    expect(shortModelName(id)).toBe(label);
  });
});
