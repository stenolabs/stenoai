import * as React from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { cn } from '@/lib/utils';
import { t } from '@/i18n';
import { useOpenAiAsrConfig, useSetOpenAiAsrConfig, useSetOpenAiAsrKey } from '@/hooks/useModels';
import { COMPACT_BTN, COMPACT_INPUT } from '../primitives';

// Registry defaults, mirrored from src/config.py's _get_default_config. Clearing
// a field resets to these rather than persisting a blank value (the backend
// rejects a blank URL/model - see set_openai_asr_api_url / set_openai_asr_model).
const DEFAULT_OPENAI_ASR_URL = 'https://api.openai.com/v1';
const DEFAULT_OPENAI_ASR_MODEL = 'whisper-1';

/**
 * Config sub-panel shown when the OpenAI-compatible cloud ASR engine is
 * active. The API URL + model round-trip through config.json; the API key is
 * held encrypted by the main process (safeStorage) and only its set/not-set
 * state is ever surfaced (`api_key_set`) - the value is never read back.
 */
export function OpenAiAsrConfig() {
  const config = useOpenAiAsrConfig();
  const setConfig = useSetOpenAiAsrConfig();
  const setKey = useSetOpenAiAsrKey();

  const [apiUrl, setApiUrl] = React.useState('');
  const [model, setModel] = React.useState('');
  const [apiKey, setApiKey] = React.useState('');
  const [saveError, setSaveError] = React.useState<string | null>(null);
  const configSaveTail = React.useRef<Promise<unknown>>(Promise.resolve());
  const keySaveTail = React.useRef<Promise<unknown>>(Promise.resolve());
  const fieldEdits = React.useRef({ api_url: 0, model: 0 });
  const dirtyFields = React.useRef({ api_url: false, model: false });
  const committedFields = React.useRef({ api_url: DEFAULT_OPENAI_ASR_URL, model: DEFAULT_OPENAI_ASR_MODEL });
  const keyEdit = React.useRef(0);

  React.useEffect(() => {
    if (config.data) {
      committedFields.current = { api_url: config.data.api_url, model: config.data.model };
      if (!dirtyFields.current.api_url) setApiUrl(config.data.api_url);
      if (!dirtyFields.current.model) setModel(config.data.model);
    }
  }, [config.data?.api_url, config.data?.model]);

  const keySet = config.data?.api_key_set ?? false;

  const saveEndpointField = (field: 'api_url' | 'model', value: string) => {
    const edit = fieldEdits.current[field];
    // Preserve blur order even when a later edit returns to the cached value.
    const operation = configSaveTail.current
      .catch(() => undefined)
      .then(() => setConfig.mutateAsync({ [field]: value }));
    configSaveTail.current = operation;
    void operation
      .then((saved) => {
        committedFields.current[field] = saved[field] ?? (field === 'api_url' ? DEFAULT_OPENAI_ASR_URL : DEFAULT_OPENAI_ASR_MODEL);
        if (fieldEdits.current[field] !== edit) return;
        dirtyFields.current[field] = false;
        setSaveError(null);
        if (field === 'api_url') setApiUrl(saved.api_url ?? DEFAULT_OPENAI_ASR_URL);
        else setModel(saved.model ?? DEFAULT_OPENAI_ASR_MODEL);
      })
      .catch(() => {
        if (fieldEdits.current[field] !== edit) return;
        dirtyFields.current[field] = false;
        // The backend rejected or failed to save the edit. Restore the
        // displayed committed value instead of leaving a value that is not
        // actually active, especially important for an audio-upload endpoint.
        setSaveError(t('settings.ai.cloudAsr.saveSettingError'));
        if (field === 'api_url') setApiUrl(committedFields.current.api_url);
        else setModel(committedFields.current.model);
      });
  };

  const saveKey = (key: string) => {
    const edit = keyEdit.current;
    // Blur fires before a clicked Clear button. Serialize credential writes so
    // the later clear always commits after any replacement queued by blur.
    const operation = keySaveTail.current
      .catch(() => undefined)
      .then(() => setKey.mutateAsync(key));
    keySaveTail.current = operation;
    void operation
      .then(() => setSaveError(null))
      .catch(() => {
        setSaveError(t('settings.ai.cloudAsr.saveKeyError'));
      })
      .finally(() => {
        // Do not retain a plaintext credential in renderer state after either
        // outcome. The visible error is sufficient for retry.
        if (keyEdit.current === edit) setApiKey('');
      });
  };

  return (
    <div
      className="space-y-3 py-4"
      style={{ borderBottom: '1px solid var(--border-subtle)' }}
      data-testid="openai-asr-config"
    >
      <div>
        <label
          htmlFor="openai-asr-api-url"
          className="mb-1 block text-[12px] font-medium uppercase"
          style={{ letterSpacing: '0.06em', color: 'var(--fg-2)' }}
        >
          {t('settings.ai.cloudAsr.apiBaseUrlLabel')}
        </label>
        <Input
          id="openai-asr-api-url"
          value={apiUrl}
          onChange={(e) => {
            fieldEdits.current.api_url += 1;
            dirtyFields.current.api_url = true;
            setApiUrl(e.target.value);
          }}
          placeholder={t('settings.ai.cloudAsr.apiUrlPlaceholder')}
          onBlur={() => {
            // A cleared (or whitespace-only) field resets to the default URL
            // rather than trying to persist a blank the backend would reject -
            // otherwise the stale value would return on the next refresh.
            const next = apiUrl.trim() || DEFAULT_OPENAI_ASR_URL;
            if (next !== apiUrl) setApiUrl(next);
            if (dirtyFields.current.api_url || next !== config.data?.api_url) saveEndpointField('api_url', next);
            else dirtyFields.current.api_url = false;
          }}
          className={COMPACT_INPUT}
        />
      </div>
      <div>
        <label
          htmlFor="openai-asr-model"
          className="mb-1 block text-[12px] font-medium uppercase"
          style={{ letterSpacing: '0.06em', color: 'var(--fg-2)' }}
        >
          {t('settings.ai.cloudAsr.modelLabel')}
        </label>
        <Input
          id="openai-asr-model"
          value={model}
          onChange={(e) => {
            fieldEdits.current.model += 1;
            dirtyFields.current.model = true;
            setModel(e.target.value);
          }}
          placeholder={t('settings.ai.cloudAsr.modelPlaceholder')}
          onBlur={() => {
            // Same as the URL: a cleared field resets to the default model
            // rather than persisting a blank (which the backend rejects).
            const next = model.trim() || DEFAULT_OPENAI_ASR_MODEL;
            if (next !== model) setModel(next);
            if (dirtyFields.current.model || next !== config.data?.model) saveEndpointField('model', next);
            else dirtyFields.current.model = false;
          }}
          className={COMPACT_INPUT}
        />
      </div>
      <div>
        <label
          htmlFor="openai-asr-api-key"
          className="mb-1 block text-[12px] font-medium uppercase"
          style={{ letterSpacing: '0.06em', color: 'var(--fg-2)' }}
        >
          {t('settings.ai.cloudAsr.apiKeyLabel')}
        </label>
        <div className="flex items-center gap-2">
          <Input
            id="openai-asr-api-key"
            type="password"
            value={apiKey}
            onChange={(e) => {
              keyEdit.current += 1;
              setApiKey(e.target.value);
            }}
            placeholder={keySet ? '••••••••' : t('settings.ai.cloudAsr.apiKeyPlaceholder')}
            onBlur={() => {
              if (apiKey) {
                saveKey(apiKey);
              }
            }}
            className={cn(COMPACT_INPUT, 'flex-1')}
          />
          {keySet && (
            <Button
              variant="ghost"
              size="sm"
              className={COMPACT_BTN}
              onClick={() => {
                keyEdit.current += 1;
                setApiKey('');
                saveKey('');
              }}
            >
              {t('settings.ai.cloudAsr.clearAction')}
            </Button>
          )}
        </div>
        <div className="mt-1 text-[11.5px]" style={{ color: 'var(--fg-muted)' }}>
          {keySet
            ? t('settings.ai.cloudAsr.keySavedDescription')
            : t('settings.ai.cloudAsr.keyEmptyDescription')}
        </div>
        {saveError && (
          <p role="alert" className="mt-1 text-[11.5px]" style={{ color: 'var(--danger, #b42318)' }}>
            {saveError}
          </p>
        )}
      </div>
    </div>
  );
}
