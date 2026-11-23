import { describe, expect, it } from 'vitest';
import { AI_ERROR_CODES, aiErrorCode, aiErrorCopy } from './aiError';

const local = { ai_provider: 'local' as const };
const remote = { ai_provider: 'remote' as const };
const openai = { ai_provider: 'cloud' as const, cloud_provider: 'openai' };
const custom = { ai_provider: 'cloud' as const, cloud_provider: 'custom' };
const adapter = { ai_provider: 'adapter' as const };

describe('aiErrorCode', () => {
  it('accepts only the backend codes', () => {
    for (const code of AI_ERROR_CODES) expect(aiErrorCode(code)).toBe(code);
    expect(aiErrorCode('failed')).toBeNull();
    expect(aiErrorCode('Unable to answer')).toBeNull();
    expect(aiErrorCode(undefined)).toBeNull();
  });
});

describe('aiErrorCopy', () => {
  it('gives every code a title and exactly one action', () => {
    for (const code of AI_ERROR_CODES) {
      const copy = aiErrorCopy(code, openai);
      expect(copy.title).toBeTruthy();
      expect(copy.body).toBeTruthy();
      expect(copy.action.kind).toBeTruthy();
    }
  });

  it('restarts the bundled Ollama, but sends a remote server to settings', () => {
    expect(aiErrorCopy('ollama-unreachable', local)).toMatchObject({ title: 'Ollama isn’t running', action: { kind: 'restart-ollama' } });
    expect(aiErrorCopy('ollama-unreachable', remote).action).toMatchObject({ kind: 'settings', route: '/settings?tab=ai' });
  });

  it('opens the provider billing page, or AI settings without one', () => {
    expect(aiErrorCopy('quota', openai).action).toEqual({ kind: 'billing', url: expect.stringContaining('platform.openai.com') });
    expect(aiErrorCopy('quota', custom).action.kind).toBe('settings');
  });

  it('names the provider and routes org auth to Organisation', () => {
    expect(aiErrorCopy('network', openai).title).toBe('Couldn’t reach OpenAI');
    expect(aiErrorCopy('auth', openai)).toMatchObject({ title: 'Your API key was rejected', action: { kind: 'settings', label: 'Update key' } });
    expect(aiErrorCopy('auth', adapter).action).toMatchObject({ route: '/settings?tab=organisation' });
  });

  it('retries transient failures and only suggests narrowing a too-long request', () => {
    expect(aiErrorCopy('rate-limit', openai).action.kind).toBe('retry');
    expect(aiErrorCopy('timeout', local).action.kind).toBe('retry');
    expect(aiErrorCopy('context-too-long', openai).action.kind).toBe('none');
  });
});
