import { t } from '@/i18n';
import { ResultError } from './result';

/** User-facing copy for an actions error code (mcp-actions.js ActionError codes). */
export function actionErrorMessage(error: unknown): string {
  const code = error instanceof ResultError ? error.code : undefined;
  switch (code) {
    case 'disabled-by-org':
      return t('actions.error.disabledByOrg');
    case 'endpoint-not-allowed':
      return t('actions.error.endpointNotAllowed');
    case 'invalid-url':
      return t('actions.error.invalidUrl');
    case 'invalid-token':
      return t('actions.error.invalidToken');
    case 'invalid-header':
      return t('actions.error.invalidHeader');
    case 'secure-storage':
      return t('actions.error.secureStorage');
    case 'needs-auth':
    case 'reauth-required':
      return t('actions.error.needsAuth');
    case 'needs-registration':
      return t('actions.error.needsRegistration');
    case 'cancelled':
      return t('actions.error.cancelled');
    case 'timeout':
      return t('actions.error.timeout');
    case 'denied':
      return t('actions.error.denied');
    case 'atlassian-no-site':
      return t('actions.error.atlassianNoSite');
    case 'no-connections':
      return t('actions.error.noConnections');
    case 'connection-unavailable':
    case 'tool-unavailable':
      return t('actions.error.connectionUnavailable');
    case 'invalid-arguments':
      return t('actions.error.invalidArguments');
    case 'invalid-state':
      return t('actions.error.invalidState');
    case 'suggest-failed':
    case 'provider-failed':
    case 'read-failed':
      return t('actions.error.suggestFailed');
    case 'pkce-unsupported':
    case 'issuer-mismatch':
    case 'resource-mismatch':
    case 'insecure-endpoint':
    case 'invalid-metadata':
    case 'discovery-failed':
    case 'registration-failed':
    case 'token-failed':
    case 'auth-failed':
      return t('actions.error.authFailed');
    default:
      return t('actions.error.generic');
  }
}
