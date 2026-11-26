import * as React from 'react';
import { ExternalLink, Waypoints } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { OpenAiIcon } from '@/components/ui/openai-icon';
import { AnthropicIcon } from '@/components/ui/anthropic-icon';
import { AwsIcon } from '@/components/ui/aws-icon';
import { t } from '@/i18n';
import { ipc, type CloudProvider } from '@/lib/ipc';
import { isGuidedProvider, KEY_PAGE_URL } from '@/lib/cloudKeys';
import { describeModel, modelTierLabel as tierLabel, RECOMMENDED_CLOUD_MODELS } from '@/lib/modelNames';
import {
  useAiProvider,
  useSetBedrockInferenceProfile,
  useSetBedrockRegion,
  useSetCloudApiKey,
  useSetCloudApiUrl,
  useSetCloudModel,
  useSetCloudProvider,
  useTestCloudApi,
} from '@/hooks/useAi';
import { COMPACT_BTN, COMPACT_INPUT } from '../primitives';
import { ConnectionStatus } from './ConnectionStatus';

const CLOUD_SERVICE_ICON: Record<CloudProvider, React.ReactNode> = {
  openai: <OpenAiIcon size={12} />,
  anthropic: <AnthropicIcon size={12} />,
  bedrock: <AwsIcon size={12} />,
  custom: null,
  openrouter: <Waypoints size={12} aria-hidden="true" />,
};

const PROVIDER_NAME: Record<'openai' | 'anthropic' | 'openrouter', string> = {
  openai: 'OpenAI',
  anthropic: 'Anthropic',
  openrouter: 'OpenRouter',
};

/** One picker row: the friendly name, with the tier and raw id underneath. */
function ModelOption({ id }: { id: string }) {
  const { name, tier } = describeModel(id);
  const friendly = name !== id;
  return (
    <SelectItem
      value={id}
      description={
        tier ? (friendly ? `${tierLabel(tier)} · ${id}` : tierLabel(tier)) : friendly ? id : undefined
      }
    >
      {name}
    </SelectItem>
  );
}

export function CloudProviderConfig() {
  const baseUrlId = React.useId();
  const provider = useAiProvider();
  const setCloudProvider = useSetCloudProvider();
  const setCloudUrl = useSetCloudApiUrl();
  const setCloudKey = useSetCloudApiKey();
  const setCloudModel = useSetCloudModel();
  const setBedrockRegion = useSetBedrockRegion();
  const setBedrockProfile = useSetBedrockInferenceProfile();
  const testConnection = useTestCloudApi();

  const cloudProvider = provider.data?.cloud_provider ?? 'openai';
  const [apiUrl, setApiUrl] = React.useState('');
  const [apiKey, setApiKey] = React.useState('');
  const [model, setModel] = React.useState('gpt-4o-mini');
  const [bedrockRegion, setBedrockRegionState] = React.useState('us-east-1');
  const [bedrockProfile, setBedrockProfileState] = React.useState('');
  // Bedrock has a curated dropdown of Claude model ids (from the backend) so
  // the user doesn't have to know the exact `anthropic.claude-…:0` strings.
  const bedrockModels = provider.data?.bedrock_supported_models ?? [];
  // When provider changes, the available-models cache is provider-specific
  // and the persisted model name swaps. Track which provider the model list
  // belongs to so we don't show OpenAI models against an Anthropic key.
  const [modelListFor, setModelListFor] = React.useState<CloudProvider | null>(null);
  const [customModelMode, setCustomModelMode] = React.useState(false);

  // Sync apiUrl/model from server-side state (separate effect: runs on any
  // provider.data change so the model name stays in sync after a successful
  // setCloudModel mutation).
  React.useEffect(() => {
    if (provider.data) {
      setApiUrl(provider.data.cloud_api_url);
      setModel(provider.data.cloud_model);
    }
  }, [provider.data?.cloud_api_url, provider.data?.cloud_model]);

  // Sync Bedrock fields from server-side state. Kept separate from the
  // cloud_api_url/model sync because the deps array would conflate setter
  // notifications across providers, causing the bedrock state to bounce
  // when an unrelated openai-mode change lands.
  React.useEffect(() => {
    if (provider.data) {
      setBedrockRegionState(provider.data.bedrock_region || 'us-east-1');
      setBedrockProfileState(provider.data.bedrock_inference_profile || '');
    }
  }, [provider.data?.bedrock_region, provider.data?.bedrock_inference_profile]);

  // Reset the cached model list ONLY when the provider changes — otherwise
  // selecting a model triggers a model-name change which would dump the
  // dropdown the user just picked from.
  React.useEffect(() => {
    if (provider.data) {
      setModelListFor((prev) =>
        prev === provider.data!.cloud_provider ? prev : null,
      );
      setCustomModelMode(false);
      testConnection.reset();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [provider.data?.cloud_provider]);

  const onTest = () => {
    setModelListFor(cloudProvider);
    testConnection.mutate();
  };

  // Bedrock surfaces a curated list of Claude model ids from the backend, so
  // the dropdown is populated immediately — no need to Test connection first.
  // Other providers still gate the dropdown on a successful list-models call.
  // Recommended picks (friendly names + a Fast / Balanced / Best hint) are
  // available straight away for the common providers; a successful test adds
  // whatever else the key can reach. Custom endpoints still need a test.
  const fetchedModels =
    modelListFor === cloudProvider && testConnection.isSuccess
      ? testConnection.data?.models ?? []
      : [];
  const availableModels =
    cloudProvider === 'bedrock'
      ? bedrockModels
      : Array.from(new Set([...RECOMMENDED_CLOUD_MODELS[cloudProvider], ...fetchedModels]));
  const showModelDropdown = availableModels.length > 0 && !customModelMode;
  // Persist the selected model immediately on change (Select doesn't fire
  // onBlur, so the previous "save on blur" pattern would lose the choice).
  const onModelSelect = (next: string) => {
    if (next === '__custom__') {
      setCustomModelMode(true);
      return;
    }
    setModel(next);
    setCloudModel.mutate(next);
  };

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
          {t('settings.ai.cloud.service')}
        </label>
        <Select
          value={cloudProvider}
          onValueChange={(v) => setCloudProvider.mutate(v as CloudProvider)}
        >
          <SelectTrigger className={COMPACT_INPUT} data-testid="cloud-service-select">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="openai">
              <span className="inline-flex items-center gap-1.5">
                {CLOUD_SERVICE_ICON.openai}
                OpenAI
              </span>
            </SelectItem>
            <SelectItem value="anthropic">
              <span className="inline-flex items-center gap-1.5">
                {CLOUD_SERVICE_ICON.anthropic}
                {t('settings.ai.cloud.serviceAnthropic')}
              </span>
            </SelectItem>
            <SelectItem value="openrouter">
              <span className="inline-flex items-center gap-1.5">
                {CLOUD_SERVICE_ICON.openrouter}
                {t('settings.ai.cloud.serviceOpenRouter')}
              </span>
            </SelectItem>
            <SelectItem value="bedrock">
              <span className="inline-flex items-center gap-1.5">
                {CLOUD_SERVICE_ICON.bedrock}
                {t('settings.ai.cloud.serviceBedrock')}
              </span>
            </SelectItem>
            <SelectItem value="custom">{t('settings.ai.cloud.customService')}</SelectItem>
          </SelectContent>
        </Select>
      </div>
      {cloudProvider === 'bedrock' && (
        <>
          <div>
            <label
              className="mb-1 block text-[12px] font-medium uppercase"
              style={{ letterSpacing: '0.06em', color: 'var(--fg-muted)' }}
            >
              {t('settings.ai.cloud.awsRegion')}
            </label>
            <Input
              value={bedrockRegion}
              onChange={(e) => setBedrockRegionState(e.target.value)}
              placeholder={t('settings.ai.cloud.awsRegionPlaceholder')}
              onBlur={() =>
                bedrockRegion && setBedrockRegion.mutate(bedrockRegion)
              }
              className={COMPACT_INPUT}
            />
          </div>
          <div>
            <label
              className="mb-1 block text-[12px] font-medium uppercase"
              style={{ letterSpacing: '0.06em', color: 'var(--fg-muted)' }}
            >
              {t('settings.ai.cloud.inferenceProfile')}
            </label>
            <Input
              value={bedrockProfile}
              onChange={(e) => setBedrockProfileState(e.target.value)}
              placeholder={t('settings.ai.cloud.inferenceProfilePlaceholder')}
              onBlur={() => setBedrockProfile.mutate(bedrockProfile.trim())}
              className={COMPACT_INPUT}
            />
          </div>
        </>
      )}
      {cloudProvider === 'custom' && (
        <div>
          <label
            htmlFor={baseUrlId}
            className="mb-1 block text-[12px] font-medium uppercase"
            style={{ letterSpacing: '0.06em', color: 'var(--fg-muted)' }}
          >
            {t('settings.ai.cloud.baseUrl')}
          </label>
          <Input
            id={baseUrlId}
            aria-describedby={`${baseUrlId}-hint`}
            value={apiUrl}
            onChange={(e) => setApiUrl(e.target.value)}
            placeholder={t('settings.ai.cloud.baseUrlPlaceholder')}
            onBlur={() => apiUrl && setCloudUrl.mutate(apiUrl)}
            className={COMPACT_INPUT}
          />
          <p id={`${baseUrlId}-hint`} className="mt-1 text-[11.5px]" style={{ color: 'var(--fg-muted)' }}>
            {t('settings.ai.cloud.baseUrlHint')}
          </p>
        </div>
      )}
      <div>
        <label
          className="mb-1 block text-[12px] font-medium uppercase"
          style={{ letterSpacing: '0.06em', color: 'var(--fg-muted)' }}
        >
          {t('settings.ai.cloud.apiKey')}
        </label>
        <Input
          type="password"
          value={apiKey}
          onChange={(e) => setApiKey(e.target.value)}
          placeholder={
            provider.data?.cloud_api_key_set
              ? '••••••••'
              : cloudProvider === 'bedrock'
                ? t('settings.ai.cloud.bedrockKeyPlaceholder')
                : cloudProvider === 'anthropic'
                  ? t('settings.ai.cloud.anthropicKeyPlaceholder')
                  : cloudProvider === 'openrouter'
                    ? t('settings.ai.cloud.openrouterKeyPlaceholder')
                    : t('settings.ai.cloud.openaiKeyPlaceholder')
          }
          onBlur={() => apiKey && setCloudKey.mutate(apiKey)}
          className={COMPACT_INPUT}
        />
        {isGuidedProvider(cloudProvider) && (
          <button
            type="button"
            onClick={() => void ipc().shell.openExternal(KEY_PAGE_URL[cloudProvider])}
            className="mt-1 inline-flex items-center gap-1 text-[11.5px] underline-offset-2 hover:underline"
            style={{ color: 'var(--fg-2)' }}
          >
            {t('settings.ai.cloud.getKey', { provider: PROVIDER_NAME[cloudProvider] })}
            <ExternalLink className="size-3" aria-hidden="true" />
          </button>
        )}
      </div>
      <div>
        <label
          className="mb-1 block text-[12px] font-medium uppercase"
          style={{ letterSpacing: '0.06em', color: 'var(--fg-muted)' }}
        >
          {t('settings.ai.model.label')}
        </label>
        {showModelDropdown ? (
          <Select value={model} onValueChange={onModelSelect}>
            <SelectTrigger className={COMPACT_INPUT} data-testid="cloud-model-select">
              <SelectValue placeholder={t('settings.ai.cloud.modelPlaceholder')} />
            </SelectTrigger>
            <SelectContent>
              {/* If the persisted model isn't in the fetched list (e.g. a
                  user-typed custom name from before), still show it so the
                  Trigger doesn't render blank. */}
              {!availableModels.includes(model) && model && <ModelOption id={model} />}
              {availableModels.map((m) => (
                <ModelOption key={m} id={m} />
              ))}
              <SelectItem value="__custom__">{t('settings.ai.cloud.customModel')}</SelectItem>
            </SelectContent>
          </Select>
        ) : (
          <div className="flex items-center gap-2">
            <Input
              value={model}
              onChange={(e) => setModel(e.target.value)}
              placeholder={
                cloudProvider === 'bedrock'
                  ? t('settings.ai.cloud.bedrockModelPlaceholder')
                  : cloudProvider === 'anthropic'
                    ? t('settings.ai.cloud.anthropicModelPlaceholder')
                    : cloudProvider === 'openrouter'
                      ? t('settings.ai.cloud.openrouterModelPlaceholder')
                      : t('settings.ai.cloud.openaiModelPlaceholder')
              }
              onBlur={() => model && setCloudModel.mutate(model)}
              className={COMPACT_INPUT}
            />
            {availableModels.length > 0 && customModelMode && (
              <Button
                variant="ghost"
                size="sm"
                className={COMPACT_BTN}
                onClick={() => setCustomModelMode(false)}
              >
                {t('settings.ai.cloud.pickFromList')}
              </Button>
            )}
          </div>
        )}
        {availableModels.length === 0 && cloudProvider !== 'bedrock' && (
          <div className="mt-1 text-[11.5px]" style={{ color: 'var(--fg-muted)' }}>
            {t('settings.ai.cloud.testToLoadModels')}
          </div>
        )}
      </div>
      <div className="flex items-center gap-3">
        <Button
          variant="outline"
          size="sm"
          className={COMPACT_BTN}
          onClick={onTest}
          disabled={testConnection.isPending}
        >
          {testConnection.isPending ? t('settings.ai.testing') : t('settings.ai.testConnection')}
        </Button>
        <ConnectionStatus
          ok={testConnection.isSuccess ? true : testConnection.isError ? false : undefined}
          message={
            testConnection.isError
              ? testConnection.error instanceof Error
                ? testConnection.error.message
                : t('settings.ai.failed')
              : testConnection.isSuccess && testConnection.data?.models
                ? t('settings.ai.cloud.modelsAvailable', { count: testConnection.data.models.length })
                : undefined
          }
        />
      </div>
      <div className="text-[12px]" style={{ color: 'var(--fg-2)' }}>
        {t('settings.ai.cloud.thirdPartyNote')}
      </div>
    </div>
  );
}
