import * as React from 'react';
import {
  Building2,
  Cloud,
  Laptop,
  Server,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Switch } from '@/components/ui/switch';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { cn } from '@/lib/utils';
import { t } from '@/i18n';
import type { AiProvider } from '@/lib/ipc';
import {
  useAiProvider,
  useSetAiProvider,
  useSetRemoteOllamaUrl,
  useTestRemoteOllama,
} from '@/hooks/useAi';
import { useAutoSummarizeSetting, useSetAutoSummarize } from '@/hooks/useSettings';
import { useOrgSession } from '@/hooks/useOrg';
import { COMPACT_BTN, COMPACT_TRIGGER, SettingRow } from '../primitives';
import { CloudProviderConfig } from './CloudProviderConfig';
import { ConnectionStatus } from './ConnectionStatus';
import { ModelList } from './SummaryModelList';

export function SummarisationSection() {
  const provider = useAiProvider();
  const setProvider = useSetAiProvider();
  const orgSession = useOrgSession();
  const autoSummarize = useAutoSummarizeSetting();
  const setAutoSummarize = useSetAutoSummarize();
  const current = provider.data?.ai_provider ?? 'local';
  const orgSignedIn = orgSession.data?.signedIn ?? false;

  return (
    <>
      <SettingRow
        label={t('settings.ai.autoSummarize.label')}
        description={t('settings.ai.autoSummarize.description')}
      >
        <Switch
          checked={autoSummarize.data ?? true}
          onCheckedChange={(v) => setAutoSummarize.mutate(v)}
          disabled={autoSummarize.data === undefined}
        />
      </SettingRow>

      <SettingRow
        label={t('settings.ai.provider.label')}
        description={
          orgSignedIn
            ? t('settings.ai.provider.managedByOrganisation')
            : t('settings.ai.provider.description')
        }
        // The Model section right below (local provider) has no divider of
        // its own — Remote/Cloud/Adapter's config blocks do (their own
        // bottom border), so they still want this row's divider to separate
        // from it.
        noBorder={current !== 'cloud' && current !== 'adapter' && !orgSignedIn}
      >
        <Select
          value={current}
          onValueChange={(v) => setProvider.mutate(v as AiProvider)}
          disabled={!provider.data || orgSignedIn}
        >
          <SelectTrigger
            className={cn(COMPACT_TRIGGER, 'min-w-[180px]')}
            data-testid="ai-provider-select"
          >
            <SelectValue />
          </SelectTrigger>
          <SelectContent className="w-72">
            <SelectItem
              value="local"
              icon={<Laptop className="size-4" />}
              description={t('settings.ai.provider.local.description')}
            >
              {t('settings.ai.provider.local.label')}
            </SelectItem>
            <SelectItem
              value="remote"
              icon={<Server className="size-4" />}
              description={t('settings.ai.provider.privateServer.description')}
            >
              {t('settings.ai.provider.privateServer.label')}
            </SelectItem>
            <SelectItem
              value="cloud"
              icon={<Cloud className="size-4" />}
              description={t('settings.ai.provider.cloud.description')}
            >
              {t('settings.ai.provider.cloud.label')}
            </SelectItem>
            <SelectItem
              value="adapter"
              disabled={!orgSignedIn}
              icon={<Building2 className="size-4" />}
              description={
                orgSignedIn
                  ? t('settings.ai.provider.organisation.description')
                  : t('settings.ai.provider.organisation.signedOut')
              }
            >
              {t('settings.ai.provider.organisation.label')}
            </SelectItem>
          </SelectContent>
        </Select>
      </SettingRow>

      {current === 'remote' && <RemoteProviderConfig />}
      {current === 'cloud' && <CloudProviderConfig />}
      {current === 'adapter' && <AdapterProviderInfo signedIn={orgSignedIn} />}

      {/* orgSignedIn check: while locked, the provider is (or is about to
          be reconciled to) 'adapter' — never show a local model list under
          the "Managed by your organisation" copy, even if the cached
          provider value is momentarily stale.
          Labelled like a SettingRow (not SectionHeading) -- this is still
          part of Summarisation & Chat, just a row whose control is a list
          of cards instead of a single trigger, so SectionHeading's
          top-level weight read as its own section on the page. */}
      {current !== 'cloud' && current !== 'adapter' && !orgSignedIn && (
        <div style={{ marginTop: '20px' }}>
          <div className="text-[14px] font-normal" style={{ color: 'var(--fg-1)', marginBottom: 2 }}>
            {t('settings.ai.model.label')}
          </div>
          <p className="text-[13px] leading-[1.5]" style={{ color: 'var(--fg-2)', marginBottom: 8 }}>
            {t('settings.ai.summaryModel.description')}
          </p>
          <ModelList />
        </div>
      )}
    </>
  );
}

/** Adapter mode has no per-user configuration — the customer's IT
 *  controls the model + API key on the adapter side. This block just
 *  reassures the user it's working (or warns them if their session has
 *  lapsed, in which case summarisation would fall back to an error). */
function AdapterProviderInfo({ signedIn }: { signedIn: boolean }) {
  return (
    <div
      className="space-y-2 py-4 text-[12px]"
      style={{ borderBottom: '1px solid var(--border-subtle)', color: 'var(--fg-2)' }}
    >
      {signedIn ? (
        <p>
          {t('settings.ai.organisation.routedNote')}
        </p>
      ) : (
        <p style={{ color: 'var(--accent-danger, var(--fg-1))' }}>
          {t('settings.ai.organisation.notSignedIn.beforeLink')}{' '}
          <strong>{t('settings.ai.organisation.notSignedIn.link')}</strong>{t('settings.ai.organisation.notSignedIn.afterLink')}
        </p>
      )}
    </div>
  );
}

function RemoteProviderConfig() {
  const provider = useAiProvider();
  const setUrl = useSetRemoteOllamaUrl();
  const testConnection = useTestRemoteOllama();
  const [url, setLocalUrl] = React.useState('');

  React.useEffect(() => {
    if (provider.data?.remote_ollama_url) {
      setLocalUrl(provider.data.remote_ollama_url);
    }
  }, [provider.data?.remote_ollama_url]);

  return (
    <div
      className="space-y-3 py-4"
      style={{ borderBottom: '1px solid var(--border-subtle)' }}
    >
      <div>
        <label
          className="mb-1 block text-[12px] font-medium uppercase"
          style={{ letterSpacing: '0.06em', color: 'var(--fg-muted)' }}
        >
          {t('settings.ai.privateServer.urlLabel')}
        </label>
        <Input
          value={url}
          onChange={(e) => setLocalUrl(e.target.value)}
          placeholder={t('settings.ai.privateServer.urlPlaceholder')}
          onBlur={() => url && setUrl.mutate(url)}
          className="h-[30px] bg-[color:var(--surface-raised)] text-[13px]"
        />
      </div>
      <div className="flex items-center gap-3">
        <Button
          variant="outline"
          size="sm"
          className={COMPACT_BTN}
          onClick={() => testConnection.mutate(url)}
          disabled={!url || testConnection.isPending}
        >
          {testConnection.isPending ? t('settings.ai.testing') : t('settings.ai.testConnection')}
        </Button>
        <ConnectionStatus
          ok={testConnection.isSuccess ? testConnection.data?.ok ?? true : testConnection.isError ? false : undefined}
          message={
            testConnection.isError
              ? testConnection.error instanceof Error
                ? testConnection.error.message
                : t('settings.ai.failed')
              : testConnection.data?.message
          }
        />
      </div>
    </div>
  );
}
