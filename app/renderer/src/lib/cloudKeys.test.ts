import { describe, expect, it } from 'vitest';
import { cloudErrorKind, detectCloudProvider, KEY_PAGE_URL } from './cloudKeys';
import { ResultError } from './result';

describe('detectCloudProvider', () => {
  it('reads the provider from the key prefix', () => {
    expect(detectCloudProvider('sk-ant-api03-abc')).toBe('anthropic');
    expect(detectCloudProvider('sk-or-v1-abc')).toBe('openrouter');
    expect(detectCloudProvider('sk-proj-abc')).toBe('openai');
    expect(detectCloudProvider('sk-abc')).toBe('openai');
    expect(detectCloudProvider('  sk-or-v1-abc  ')).toBe('openrouter');
  });

  it('returns null when the format says nothing', () => {
    expect(detectCloudProvider('')).toBeNull();
    expect(detectCloudProvider('ABSK-bedrock-token')).toBeNull();
    expect(detectCloudProvider('ant-sk-x')).toBeNull();
  });
});

describe('cloudErrorKind', () => {
  it('prefers the backend error code', () => {
    expect(cloudErrorKind(new ResultError('whatever', 'no_credit'))).toBe('no_credit');
    expect(cloudErrorKind(new ResultError('Error code: 401', 'bogus'))).toBe('invalid_key');
  });

  it('classifies provider messages', () => {
    expect(cloudErrorKind(new Error("Error code: 401 - {'error': {'code': 'invalid_api_key'}}"))).toBe('invalid_key');
    expect(cloudErrorKind(new Error('OpenRouter HTTP 402: Insufficient credits'))).toBe('no_credit');
    expect(cloudErrorKind(new Error("Error code: 429 - {'code': 'insufficient_quota'}"))).toBe('no_credit');
    expect(cloudErrorKind(new Error('Connection error.'))).toBe('network');
    expect(cloudErrorKind(new Error('odd'))).toBe('unknown');
    expect(cloudErrorKind(undefined)).toBe('unknown');
  });
});

describe('KEY_PAGE_URL', () => {
  it('only points at https provider pages', () => {
    for (const url of Object.values(KEY_PAGE_URL)) expect(new URL(url).protocol).toBe('https:');
  });
});
