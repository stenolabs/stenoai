// Helpers for the guided cloud-key step in onboarding: where each provider
// issues keys, which provider a pasted key belongs to, and what a failed key
// test means in plain words.

import type { CloudProvider } from '@/lib/ipc';
import { ResultError } from '@/lib/result';

/** The providers onboarding walks people through. Bedrock and custom
 *  endpoints stay available under "Other providers" and in Settings. */
export type GuidedProvider = 'openai' | 'anthropic' | 'openrouter';

export const GUIDED_PROVIDERS: readonly GuidedProvider[] = ['openrouter', 'openai', 'anthropic'];

/** Each provider's own API-key page, opened through the main process's
 *  http(s)-only openExternal. */
export const KEY_PAGE_URL: Record<GuidedProvider, string> = {
  openai: 'https://platform.openai.com/api-keys',
  anthropic: 'https://console.anthropic.com/settings/keys',
  openrouter: 'https://openrouter.ai/settings/keys',
};

/**
 * The provider a pasted key belongs to, from its prefix:
 * sk-ant- is Anthropic, sk-or- is OpenRouter, any other sk- (including
 * sk-proj-) is OpenAI. Returns null when the format says nothing, and the
 * caller falls back to the card the person picked.
 */
export function detectCloudProvider(key: string): GuidedProvider | null {
  const k = (key ?? '').trim();
  if (k.startsWith('sk-ant-')) return 'anthropic';
  if (k.startsWith('sk-or-')) return 'openrouter';
  if (k.startsWith('sk-')) return 'openai';
  return null;
}

export type CloudErrorKind = 'invalid_key' | 'no_credit' | 'network' | 'unknown';

const KINDS: readonly CloudErrorKind[] = ['invalid_key', 'no_credit', 'network', 'unknown'];

// Mirrors classify_cloud_error in src/cloud_providers.py, for errors that did
// not come back with a code (IPC failures, older backends).
const NO_CREDIT = /\b402\b|insufficient[_ ]quota|insufficient credits|credit balance|billing|exceeded your current quota|payment required/i;
const INVALID_KEY = /\b401\b|\b403\b|invalid[_ ]api[_ ]key|incorrect api key|authentication|unauthori[sz]ed|no auth credentials|invalid x-api-key|user not found/i;
const NETWORK = /connection error|connecterror|timed out|timeout|name or service not known|nodename nor servname|getaddrinfo|network is unreachable|temporary failure in name resolution|failed to establish|connection refused|urlopen error|enotfound|econnrefused/i;

export function cloudErrorKind(error: unknown): CloudErrorKind {
  if (error instanceof ResultError && error.code && (KINDS as readonly string[]).includes(error.code)) {
    return error.code as CloudErrorKind;
  }
  const message = error instanceof Error ? error.message : typeof error === 'string' ? error : '';
  if (NO_CREDIT.test(message)) return 'no_credit';
  if (INVALID_KEY.test(message)) return 'invalid_key';
  if (NETWORK.test(message)) return 'network';
  return 'unknown';
}

export function isGuidedProvider(p: CloudProvider): p is GuidedProvider {
  return (GUIDED_PROVIDERS as readonly string[]).includes(p);
}
