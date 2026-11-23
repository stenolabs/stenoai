// Friendly names and a Fast / Balanced / Best hint for the models people pick
// most often, local and cloud. Anything not listed keeps its id (cloud) or the
// shortModelName rendering (local Ollama tags), with no tier: an unknown model
// gets no guess about how fast or good it is.

import type { CloudProvider } from '@/lib/ipc';
import { shortModelName } from '@/lib/chat';
import { t } from '@/i18n';

export type ModelTier = 'fast' | 'balanced' | 'best';

interface KnownModel {
  name: string;
  tier: ModelTier;
}

const KNOWN: Record<string, KnownModel> = {
  // OpenAI
  'gpt-4o-mini': { name: 'GPT-4o mini', tier: 'fast' },
  'gpt-4.1-mini': { name: 'GPT-4.1 mini', tier: 'fast' },
  'gpt-5-mini': { name: 'GPT-5 mini', tier: 'balanced' },
  'gpt-4o': { name: 'GPT-4o', tier: 'balanced' },
  'gpt-4.1': { name: 'GPT-4.1', tier: 'balanced' },
  'gpt-5': { name: 'GPT-5', tier: 'best' },
  // Anthropic
  'claude-haiku-4-5-20251001': { name: 'Claude Haiku 4.5', tier: 'fast' },
  'claude-3-5-haiku-latest': { name: 'Claude Haiku 3.5', tier: 'fast' },
  'claude-sonnet-4-5-20250929': { name: 'Claude Sonnet 4.5', tier: 'balanced' },
  'claude-3-7-sonnet-latest': { name: 'Claude Sonnet 3.7', tier: 'balanced' },
  'claude-opus-4-1-20250805': { name: 'Claude Opus 4.1', tier: 'best' },
  // AWS Bedrock (SUPPORTED_BEDROCK_MODELS in src/config.py)
  'anthropic.claude-haiku-4-5-20251001-v1:0': { name: 'Claude Haiku 4.5', tier: 'fast' },
  'anthropic.claude-3-5-haiku-20241022-v1:0': { name: 'Claude Haiku 3.5', tier: 'fast' },
  'anthropic.claude-sonnet-4-5-20250929-v2:0': { name: 'Claude Sonnet 4.5', tier: 'balanced' },
  'anthropic.claude-3-5-sonnet-20241022-v2:0': { name: 'Claude Sonnet 3.5', tier: 'balanced' },
  'anthropic.claude-opus-4-1-20250805-v1:0': { name: 'Claude Opus 4.1', tier: 'best' },
  // OpenRouter (OPENROUTER_RECOMMENDED_MODELS in src/cloud_providers.py)
  'google/gemini-2.5-flash': { name: 'Gemini 2.5 Flash', tier: 'fast' },
  'openai/gpt-4o-mini': { name: 'GPT-4o mini', tier: 'fast' },
  'anthropic/claude-haiku-4.5': { name: 'Claude Haiku 4.5', tier: 'fast' },
  'openai/gpt-5-mini': { name: 'GPT-5 mini', tier: 'balanced' },
  'anthropic/claude-sonnet-4.5': { name: 'Claude Sonnet 4.5', tier: 'balanced' },
  'google/gemini-2.5-pro': { name: 'Gemini 2.5 Pro', tier: 'best' },
  'anthropic/claude-opus-4.1': { name: 'Claude Opus 4.1', tier: 'best' },
  // Local Ollama registry (SUPPORTED_MODELS in src/config.py)
  'gemma4:e2b-it-qat': { name: 'Gemma 4 E2B', tier: 'fast' },
  'llama3.2:3b': { name: 'Llama 3.2 3B', tier: 'fast' },
  'gemma4:e4b-it-qat': { name: 'Gemma 4 E4B', tier: 'balanced' },
  'qwen3.5:9b': { name: 'Qwen 3.5 9B', tier: 'balanced' },
  'gemma4:12b-it-qat': { name: 'Gemma 4 12B', tier: 'best' },
  'gpt-oss:20b': { name: 'GPT-OSS 20B', tier: 'best' },
};

/** Recommended cloud models per provider, fastest first, shown in the
 *  Settings picker before any connection test. Custom endpoints have none. */
export const RECOMMENDED_CLOUD_MODELS: Record<CloudProvider, readonly string[]> = {
  openai: ['gpt-4o-mini', 'gpt-4.1-mini', 'gpt-5-mini', 'gpt-4.1', 'gpt-5'],
  anthropic: ['claude-haiku-4-5-20251001', 'claude-sonnet-4-5-20250929', 'claude-opus-4-1-20250805'],
  bedrock: [],
  custom: [],
  openrouter: [
    'google/gemini-2.5-flash',
    'openai/gpt-4o-mini',
    'anthropic/claude-haiku-4.5',
    'openai/gpt-5-mini',
    'anthropic/claude-sonnet-4.5',
    'google/gemini-2.5-pro',
    'anthropic/claude-opus-4.1',
  ],
};

/** The model each provider starts on (CLOUD_MODEL_DEFAULTS in src/config.py). */
export const DEFAULT_CLOUD_MODEL: Record<CloudProvider, string> = {
  openai: 'gpt-4o-mini',
  anthropic: 'claude-haiku-4-5-20251001',
  bedrock: 'anthropic.claude-haiku-4-5-20251001-v1:0',
  custom: 'gpt-4o-mini',
  openrouter: 'google/gemini-2.5-flash',
};

export interface ModelDescription {
  /** Readable name; the id itself when nothing better is known. */
  name: string;
  tier?: ModelTier;
}

export function describeModel(id: string): ModelDescription {
  const trimmed = (id ?? '').trim();
  const known = KNOWN[trimmed];
  if (known) return { ...known };
  // An Ollama tag (name:tag, no vendor path) reads better shortened.
  if (/^[a-z0-9.]+:[\w.-]+$/i.test(trimmed)) return { name: shortModelName(trimmed) };
  return { name: trimmed };
}

/** The tier for a known model id, if any. */
export function modelTier(id: string): ModelTier | undefined {
  return KNOWN[(id ?? '').trim()]?.tier;
}

/** The tier's display label ("Fast", "Balanced", "Best"). */
export function modelTierLabel(tier: ModelTier): string {
  if (tier === 'fast') return t('models.tier.fast');
  if (tier === 'balanced') return t('models.tier.balanced');
  return t('models.tier.best');
}
