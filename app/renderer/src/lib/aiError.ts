import { t } from '@/i18n';
import type { AiProvider, CloudProvider } from '@/lib/ipc';

/**
 * Why a chat answer failed, as a stable code from the backend (src/ai_errors.py
 * -> CHAT_STREAM_ERROR:<code> / CHAT_AGENT_ERROR:<code> -> query-done.errorCode).
 * Codes are classified from exception types and HTTP statuses only, so they
 * never carry provider text. The renderer only ever shows the fixed copy below
 * for them, never an error message.
 */
export const AI_ERROR_CODES = [
  'ollama-unreachable',
  'model-missing',
  'auth',
  'quota',
  'rate-limit',
  'network',
  'timeout',
  'context-too-long',
  'unknown',
] as const;

export type AiErrorCode = (typeof AI_ERROR_CODES)[number];

export function aiErrorCode(value: unknown): AiErrorCode | null {
  return typeof value === 'string' && (AI_ERROR_CODES as readonly string[]).includes(value)
    ? (value as AiErrorCode)
    : null;
}

/** The one thing the notice offers to do about a failure. */
export type AiErrorAction =
  | { kind: 'restart-ollama' }
  | { kind: 'settings'; route: string; label: string }
  | { kind: 'billing'; url: string }
  | { kind: 'retry' }
  | { kind: 'none' };

export interface AiErrorProviderFields {
  ai_provider: AiProvider;
  cloud_provider?: CloudProvider | string;
}

export interface AiErrorCopy {
  title: string;
  body: string;
  action: AiErrorAction;
}

const AI_SETTINGS = '/settings?tab=ai';

// Billing pages for providers whose accounts run on prepaid credit or a plan.
// A custom endpoint has no known billing page, so it gets AI settings instead.
const BILLING_URLS: Record<string, string> = {
  openai: 'https://platform.openai.com/settings/organization/billing/overview',
  anthropic: 'https://console.anthropic.com/settings/billing',
  bedrock: 'https://console.aws.amazon.com/billing/home',
  openrouter: 'https://openrouter.ai/settings/credits',
};

const CLOUD_NAMES: Record<string, () => string> = {
  openai: () => t('aiError.provider.openai'),
  anthropic: () => t('aiError.provider.anthropic'),
  bedrock: () => t('aiError.provider.bedrock'),
  openrouter: () => t('aiError.provider.openrouter'),
};

/** A short, human name for whichever provider answers chat right now. */
export function aiProviderName(provider: AiErrorProviderFields | undefined): string {
  switch (provider?.ai_provider) {
    case 'local':
      return t('aiError.provider.ollama');
    case 'remote':
      return t('aiError.provider.remote');
    case 'adapter':
      return t('aiError.provider.adapter');
    case 'cloud': {
      const name = CLOUD_NAMES[String(provider.cloud_provider ?? '')];
      return name ? name() : t('aiError.provider.generic');
    }
    default:
      return t('aiError.provider.generic');
  }
}

export function aiErrorCopy(code: AiErrorCode, provider: AiErrorProviderFields | undefined): AiErrorCopy {
  const name = aiProviderName(provider);
  const kind = provider?.ai_provider;
  const settings = (label = t('aiError.action.openAiSettings'), route = AI_SETTINGS): AiErrorAction =>
    ({ kind: 'settings', route, label });
  switch (code) {
    case 'ollama-unreachable':
      // Steno starts the bundled Ollama itself; a remote server is the user's.
      return kind === 'remote'
        ? { title: t('aiError.remoteUnreachable.title'), body: t('aiError.remoteUnreachable.body'), action: settings() }
        : { title: t('aiError.ollamaUnreachable.title'), body: t('aiError.ollamaUnreachable.body'), action: { kind: 'restart-ollama' } };
    case 'model-missing':
      return { title: t('aiError.modelMissing.title'), body: t('aiError.modelMissing.body'), action: settings() };
    case 'auth':
      return kind === 'adapter'
        ? { title: t('aiError.orgAuth.title'), body: t('aiError.orgAuth.body'), action: settings(t('aiError.action.openOrganisation'), '/settings?tab=organisation') }
        : { title: t('aiError.auth.title'), body: t('aiError.auth.body', { provider: name }), action: settings(t('aiError.action.updateKey')) };
    case 'quota': {
      const url = kind === 'cloud' ? BILLING_URLS[String(provider?.cloud_provider ?? '')] : undefined;
      return {
        title: t('aiError.quota.title'),
        body: t('aiError.quota.body', { provider: name }),
        action: url ? { kind: 'billing', url } : settings(),
      };
    }
    case 'rate-limit':
      return { title: t('aiError.rateLimit.title'), body: t('aiError.rateLimit.body', { provider: name }), action: { kind: 'retry' } };
    case 'network':
      return { title: t('aiError.network.title', { provider: name }), body: t('aiError.network.body'), action: { kind: 'retry' } };
    case 'timeout':
      return { title: t('aiError.timeout.title', { provider: name }), body: t('aiError.timeout.body'), action: { kind: 'retry' } };
    case 'context-too-long':
      return { title: t('aiError.contextTooLong.title'), body: t('aiError.contextTooLong.body'), action: { kind: 'none' } };
    case 'unknown':
    default:
      return { title: t('aiError.unknown.title'), body: t('aiError.unknown.body', { provider: name }), action: { kind: 'retry' } };
  }
}

/** What a failed turn saves as its text, so history stays readable anywhere.
 *  Saved without a provider (generic wording): the provider can change later. */
export function aiErrorSavedText(code: AiErrorCode, provider?: AiErrorProviderFields): string {
  return aiErrorCopy(code, provider).title;
}
