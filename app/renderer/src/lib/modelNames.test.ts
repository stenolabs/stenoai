import { describe, expect, it } from 'vitest';
import { DEFAULT_CLOUD_MODEL, describeModel, modelTier, RECOMMENDED_CLOUD_MODELS } from './modelNames';

describe('describeModel', () => {
  it('names and tiers the common models', () => {
    expect(describeModel('gpt-4o-mini')).toEqual({ name: 'GPT-4o mini', tier: 'fast' });
    expect(describeModel('claude-opus-4-1-20250805')).toEqual({ name: 'Claude Opus 4.1', tier: 'best' });
    expect(describeModel('google/gemini-2.5-flash')).toEqual({ name: 'Gemini 2.5 Flash', tier: 'fast' });
    expect(describeModel('gemma4:e4b-it-qat')).toEqual({ name: 'Gemma 4 E4B', tier: 'balanced' });
  });

  it('shortens unknown local tags and leaves unknown cloud ids alone, untiered', () => {
    expect(describeModel('qwen3:8b')).toEqual({ name: 'Qwen 3 8B' });
    expect(describeModel('mistral/some-model')).toEqual({ name: 'mistral/some-model' });
    expect(modelTier('mistral/some-model')).toBeUndefined();
  });

  it('every recommended and default cloud model has a friendly name and tier', () => {
    const ids = [...Object.values(RECOMMENDED_CLOUD_MODELS).flat(), ...Object.values(DEFAULT_CLOUD_MODEL)];
    for (const id of ids) expect(modelTier(id), id).toBeDefined();
  });
});
