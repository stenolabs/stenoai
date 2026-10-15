import {
  parakeetProgressLabel,
  speakerModelsProgressLabel,
  speakerModelsProgressPercent,
} from '@/lib/parakeetProgress';
import { DownloadProgressBar } from '@/components/DownloadProgressBar';
import * as React from 'react';
import { Building2, Check, ChevronDown, ChevronRight, Cloud, Laptop, Loader2, Server, X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import { Input } from '@/components/ui/input';
import { Switch } from '@/components/ui/switch';
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
import { NvidiaIcon } from '@/components/ui/nvidia-icon';
import { GoogleIcon } from '@/components/ui/google-icon';
import { MetaIcon } from '@/components/ui/meta-icon';
import { QwenIcon } from '@/components/ui/qwen-icon';
import { cn, isMac } from '@/lib/utils';
import { t } from '@/i18n';
import type { AiProvider, CloudProvider, DiarizationEngine, TranscriptionEngine } from '@/lib/ipc';
import {
  useAiProvider,
  useSetAiProvider,
  useSetBedrockInferenceProfile,
  useSetBedrockRegion,
  useSetCloudApiKey,
  useSetCloudApiUrl,
  useSetCloudModel,
  useSetCloudProvider,
  useSetRemoteOllamaUrl,
  useTestCloudApi,
  useTestRemoteOllama,
} from '@/hooks/useAi';
import {
  useCurrentModel,
  useDeleteModel,
  useDiarizationEngine,
  useDiarizationModelsState,
  useDownloadDiarizationModels,
  useModels,
  useOpenAiAsrConfig,
  useParakeetModels,
  usePullModel,
  usePullParakeetModel,
  usePullWhisperModel,
  useSetActiveTranscription,
  useSetCurrentModel,
  useSetDiarizationEngine,
  useSetOpenAiAsrConfig,
  useSetOpenAiAsrKey,
  useSwitchToFasterBuild,
  useTranscriptionEngine,
  useWhisperModels,
} from '@/hooks/useModels';
import {
  useAutoSummarizeSetting,
  useIdentityMatchingEnabledSetting,
  useKeepRecordingsSetting,
  useLanguageSetting,
  useSetAutoSummarize,
  useSetIdentityMatchingEnabled,
  useSetKeepRecordings,
  useSetLanguage,
} from '@/hooks/useSettings';
import { useOrgSession } from '@/hooks/useOrg';
import { COMPACT_BTN, COMPACT_INPUT, COMPACT_TRIGGER, SectionHeading, SettingRow } from './primitives';
import { ModelCard, formatModelSize, isDefaultModel, parsePullPercent } from './model-card';
import { modelMayExceedMemory } from './model-memory';
import { LANGUAGES_PARAKEET, LANGUAGES_WHISPER } from './languages';

export function AiTab() {
  return (
    <section data-settings-tab="ai">
      <SectionHeading>{t('settings.ai.transcription.heading')}</SectionHeading>
      <TranscriptionSection />

      <SectionHeading>{t('settings.ai.summarisation.heading')}</SectionHeading>
      <p
        className="text-[13px] leading-[1.5]"
        style={{ color: 'var(--fg-2)', marginBottom: 4 }}
      >
        {t('settings.ai.summarisation.description')}
      </p>
      <SummarisationSection />
    </section>
  );
}

function TranscriptionSection() {
  const language = useLanguageSetting();
  const setLanguage = useSetLanguage();
  const keepRecordings = useKeepRecordingsSetting();
  const setKeepRecordings = useSetKeepRecordings();
  const engineQuery = useTranscriptionEngine();

  const engine = engineQuery.data ?? 'parakeet';
  // Parakeet has the narrower language set; Whisper and the OpenAI-compatible
  // cloud ASR expose Whisper language hints. Custom endpoints/models may
  // support a subset; compatibility alone does not advertise capabilities.
  const options = engine === 'parakeet' ? LANGUAGES_PARAKEET : LANGUAGES_WHISPER;
  // useSetActiveTranscription coerces language to 'auto' when switching
  // to an engine that doesn't support the current pick. So by the time
  // this renders, persisted is normally in `options`. Edge case (CLI
  // user, migrated config): fall back to 'auto' for display so the
  // trigger isn't blank — the persisted value stays on disk until they
  // pick something new.
  const persisted = language.data ?? 'auto';
  const displayValue = options.some((o) => o.value === persisted) ? persisted : 'auto';

  return (
    // Retains the pre-merge data-settings-tab="transcription" identity as a
    // nested wrapper (the page-level section is now data-settings-tab="ai").
    <div data-settings-tab="transcription">
      <p
        className="text-[13px] leading-[1.5]"
        style={{ color: 'var(--fg-2)', marginBottom: 4 }}
      >
        {engine === 'openai-asr'
          ? t('settings.ai.cloudAsr.disclosure')
          : t('settings.ai.transcription.onDeviceNote')}
      </p>
      <SettingRow
        label={t('settings.ai.language.label')}
        description={t('settings.ai.language.description')}
      >
        <Select
          value={displayValue}
          onValueChange={(v) => setLanguage.mutate(v)}
          disabled={!language.data}
        >
          {/* Explicit testid: the Model dropdown below is a second combobox in
              this section now, so parakeet-language-picker.t1 can no longer
              assume "the only combobox" to find this trigger. */}
          <SelectTrigger className={COMPACT_TRIGGER} data-testid="transcription-language-select">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {options.map((l) => (
              <SelectItem key={l.value} value={l.value}>
                {l.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </SettingRow>

      <SettingRow
        label={t('settings.ai.saveRecordings.label')}
        description={t('settings.ai.saveRecordings.description')}
      >
        <Switch
          checked={keepRecordings.data ?? false}
          onCheckedChange={(v) => setKeepRecordings.mutate(v)}
          disabled={keepRecordings.data === undefined}
        />
      </SettingRow>

      {isMac && <SpeakerSeparationSetting />}

      {isMac && (
        <SpeakerIdentificationSetting />
      )}

      <TranscriptionModelList />
    </div>
  );
}

// The name is what the trigger shows once picked; the tagline only appears
// in the open list (SelectItem renders `description` outside ItemText), so
// the compact trigger never has to fit the speaker count.
const DIARIZATION_ENGINE_OPTIONS: {
  value: DiarizationEngine;
  name: () => string;
  tagline: () => string;
}[] = [
  {
    value: 'sortformer',
    name: () => t('settings.ai.diarization.sortformerName'),
    tagline: () => t('settings.ai.diarization.sortformerTagline'),
  },
  {
    value: 'nemotron3',
    name: () => t('settings.ai.diarization.nemotron3Name'),
    tagline: () => t('settings.ai.diarization.nemotron3Tagline'),
  },
];

/**
 * Opt-in download of the speaker-separation models (macOS), and which engine
 * separates the speakers. Until the models are on disk, transcripts keep the
 * plain You / Others labels; the pipeline already falls back without them,
 * so this row only manages the download and the engine choice.
 *
 * Download fetches the saved engine's models. Picking another engine
 * downloads its models first if they are missing, and only then saves it
 * (useSetDiarizationEngine), so a failed download leaves the previous engine
 * active. While either runs, the picker is locked on the pending target.
 */
export function SpeakerSeparationSetting() {
  const engine = useDiarizationEngine();
  const setEngine = useSetDiarizationEngine();
  const { progress, clearProgress, download } = useDownloadDiarizationModels();
  const models = useDiarizationModelsState(engine.data);
  const pending = setEngine.isPending || download.isPending;
  const value = (setEngine.isPending ? setEngine.variables : engine.data) ?? 'sortformer';
  const ready = models.data === 'ready';
  // Only a missing sidecar means "not on this Mac"; a failed or timed-out
  // check still offers the download, which re-checks when it finishes.
  const unavailable = models.data === 'unavailable';

  let control: React.ReactNode;
  if (pending) {
    control = progress ? (
      <DownloadProgressBar
        className="w-[200px]"
        data-testid="speaker-models-progress"
        label={speakerModelsProgressLabel(progress)}
        percent={speakerModelsProgressPercent(progress)}
        aria-label={t('downloads.speakers.ariaLabel')}
      />
    ) : (
      <Loader2 className="h-4 w-4 animate-spin" style={{ color: 'var(--fg-2)' }} />
    );
  } else if (ready) {
    control = (
      <span className="flex items-center gap-1.5 text-[13px]" style={{ color: 'var(--fg-2)' }}>
        <Check className="h-3.5 w-3.5" />
        {t('settings.ai.speakers.installed')}
      </span>
    );
  } else if (unavailable) {
    control = (
      <span className="text-[13px]" style={{ color: 'var(--fg-2)' }}>
        {t('settings.ai.speakers.unavailable')}
      </span>
    );
  } else {
    control = (
      <Button
        size="sm"
        variant="outline"
        onClick={() => engine.data && download.mutate(engine.data)}
        disabled={models.isPending || engine.data === undefined}
      >
        {download.isError ? t('settings.ai.speakers.retry') : t('settings.ai.speakers.download')}
      </Button>
    );
  }

  let alert: string | null = null;
  if (engine.isError) alert = t('settings.ai.diarization.loadError');
  else if (setEngine.isError) alert = t('settings.ai.diarization.saveError');
  else if (download.isError) alert = t('settings.ai.speakers.failed');

  return (
    <div data-settings-speaker-models>
      <SettingRow
        label={t('settings.ai.speakers.label')}
        description={t('settings.ai.speakers.description')}
        descriptionId="speaker-models-description"
      >
        <div className="flex items-center gap-2">
          {control}
          {!unavailable && (
            <Select
              value={value}
              onValueChange={(v) => {
                clearProgress();
                setEngine.mutate(v as DiarizationEngine);
              }}
              disabled={engine.data === undefined || engine.isError || pending}
            >
              <SelectTrigger
                className={COMPACT_TRIGGER}
                aria-label={t('settings.ai.diarization.label')}
                aria-describedby="speaker-models-description"
                data-testid="diarization-engine-select"
              >
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {DIARIZATION_ENGINE_OPTIONS.map((option) => (
                  <SelectItem key={option.value} value={option.value} description={option.tagline()}>
                    {option.name()}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          )}
        </div>
      </SettingRow>
      {alert && (
        <div role="alert" className="-mt-2 flex items-center gap-2 pb-3 text-[12px]" style={{ color: 'var(--fg-2)' }}>
          <span>{alert}</span>
          {engine.isError && (
            <Button
              variant="outline"
              size="sm"
              className={COMPACT_BTN}
              data-testid="diarization-engine-retry"
              onClick={() => void engine.refetch()}
            >
              {t('settings.ai.speakers.retry')}
            </Button>
          )}
        </div>
      )}
    </div>
  );
}

export function SpeakerIdentificationSetting() {
  const enabled = useIdentityMatchingEnabledSetting();
  const setEnabled = useSetIdentityMatchingEnabled();
  return (
    <SettingRow
      label={t('settings.ai.speakerIdentification.label')}
      description={t('settings.ai.speakerIdentification.description')}
      descriptionId="speaker-identification-description"
    >
      <Switch
        aria-label={t('settings.ai.speakerIdentification.label')}
        aria-describedby="speaker-identification-description"
        checked={enabled.data ?? false}
        onCheckedChange={(value) => setEnabled.mutate(value)}
        disabled={enabled.data === undefined}
      />
    </SettingRow>
  );
}

// Tight, model-specific taglines for the dropdown items -- deliberately not
// the backend's longer `description` strings (those are written for the
// old card layout's note line). Keyed by engine since each only ever has
// one supported model today (see SUPPORTED_PARAKEET_MODELS /
// SUPPORTED_WHISPER_MODELS in the Python registries).
const ENGINE_TAGLINE: Record<Exclude<TranscriptionEngine, 'openai-asr'>, string> = {
  get parakeet() {
    return t('settings.ai.engineTagline.parakeet');
  },
  get whisper() {
    return t('settings.ai.engineTagline.whisper');
  },
};

/**
 * Parakeet vs. Whisper picker, as a single dropdown -- each engine has
 * exactly one supported model today, so this is really an engine switch,
 * not a long model list. Icons attribute the model's maker (Whisper ->
 * OpenAI, Parakeet -> NVIDIA); neither is a provider you configure
 * (transcription is always local either way).
 *
 * Picking an installed engine switches immediately. Picking one that isn't
 * installed starts a download and the trigger shows the pending target
 * (icon + name) plus an inline spinner (Parakeet only reports coarse
 * stage, no percent) or live percent (Whisper). The trigger is disabled
 * for the whole download -- neither pull hook guards against a second,
 * concurrent download of the other engine, so this is the only thing
 * stopping a switch-mid-download race where whichever download finishes
 * last silently wins.
 */
function TranscriptionModelList() {
  const parakeet = useParakeetModels();
  const whisper = useWhisperModels();
  const engine = useTranscriptionEngine();
  const setActive = useSetActiveTranscription();
  const pullParakeet = usePullParakeetModel();
  const pullWhisper = usePullWhisperModel();
  const [confirmCloudAsr, setConfirmCloudAsr] = React.useState(false);

  const isLoading = parakeet.isLoading || whisper.isLoading || engine.isLoading;
  const isError = parakeet.isError || whisper.isError || engine.isError;

  // Keep the row's own label/description in place and swap only the
  // dropdown slot for a same-sized placeholder — replacing the whole row
  // with a bare "Loading models…" line dropped the label/description and
  // caused a layout jump once the real dropdown appeared.
  if (isLoading) {
    return (
      <SettingRow
        label={t('settings.ai.model.label')}
        description={t('settings.ai.model.description')}
        noBorder
      >
        <div
          className={cn(COMPACT_TRIGGER, 'w-[190px] flex items-center gap-1.5')}
          style={{ color: 'var(--fg-muted)' }}
        >
          <Loader2 className="size-3.5 shrink-0 animate-spin" />
          <span className="truncate">{t('settings.ai.model.loading')}</span>
        </div>
      </SettingRow>
    );
  }
  if (isError) {
    return (
      <SettingRow
        label={t('settings.ai.model.label')}
        description={t('settings.ai.model.description')}
        noBorder
      >
        <div className={cn(COMPACT_TRIGGER, 'w-[190px] flex items-center')} style={{ color: 'var(--fg-2)' }}>
          <span className="truncate">{t('settings.ai.model.loadError')}</span>
        </div>
      </SettingRow>
    );
  }

  const parakeetModel = parakeet.data?.models[0];
  const whisperModel = whisper.data?.models[0];
  if (!parakeetModel || !whisperModel) return null;

  const activeEngine = engine.data ?? 'parakeet';
  // pull-*-model's IPC handle resolves only once the whole download (or a
  // failure/timeout) settles -- so the mutation's own isPending spans the
  // full download, unlike the progress dict which only lights up once the
  // first progress event arrives.
  const parakeetDownloading = pullParakeet.isPending;
  const whisperDownloading = pullWhisper.isPending;
  const downloadingEngine = parakeetDownloading ? 'parakeet' : whisperDownloading ? 'whisper' : null;
  const isDownloading = downloadingEngine !== null;
  const value: TranscriptionEngine = downloadingEngine ?? activeEngine;

  const whisperPercent =
    downloadingEngine === 'whisper' ? parsePullPercent(pullWhisper.progress[whisperModel.name]) : null;

  // Trigger label: cloud ASR has no local model object, so resolve icon+name
  // per engine rather than indexing the model-backed options array (which only
  // covers parakeet/whisper).
  const triggerFor: Record<TranscriptionEngine, { icon: React.ReactNode; name: string }> = {
    parakeet: { icon: <NvidiaIcon size={12} />, name: parakeetModel.displayName ?? parakeetModel.name },
    whisper: { icon: <OpenAiIcon size={12} />, name: whisperModel.displayName ?? whisperModel.name },
    'openai-asr': {
      icon: <Cloud className="size-3" />,
      name: t('settings.ai.cloudAsr.providerLabel'),
    },
  };
  const current = triggerFor[value];

  const onValueChange = (next: string) => {
    if (next === activeEngine) return;
    if (next === 'openai-asr') {
      // Switching to the cloud engine sends audio off-device - gate it behind
      // an explicit privacy confirmation.
      setConfirmCloudAsr(true);
      return;
    }
    if (next === 'parakeet') {
      if (parakeetModel.installed) {
        setActive.mutate({ engine: 'parakeet' });
      } else {
        pullParakeet.mutate(parakeetModel.name);
      }
    } else if (whisperModel.installed) {
      setActive.mutate({ engine: 'whisper', whisperModel: whisperModel.name });
    } else {
      pullWhisper.mutate(whisperModel.name);
    }
  };

  return (
    <>
      <SettingRow
        label={t('settings.ai.model.label')}
        description={t('settings.ai.model.description')}
        noBorder={activeEngine !== 'openai-asr'}
      >
        <Select value={value} onValueChange={onValueChange} disabled={isDownloading}>
          <SelectTrigger
            className={cn(COMPACT_TRIGGER, 'w-[190px]')}
            data-testid="transcription-model-select"
          >
            {/* A plain div, not a span: SelectTrigger applies
                `[&>span]:line-clamp-1` to any direct-child span, and
                line-clamp's `display: -webkit-box` clobbers this row's
                `inline-flex`, stacking the icon above the name instead of
                beside it. */}
            <div className="flex min-w-0 items-center gap-1.5">
              {current.icon}
              <span className="truncate">{current.name}</span>
              {isDownloading &&
                (whisperPercent !== null ? (
                  <span className="shrink-0 text-[11px] tabular-nums" style={{ color: 'var(--fg-muted)' }}>
                    {whisperPercent}%
                  </span>
                ) : (
                  <Loader2 className="size-3 shrink-0 animate-spin" style={{ color: 'var(--fg-muted)' }} />
                ))}
            </div>
          </SelectTrigger>
          <SelectContent className="w-72">
            <SelectItem value="parakeet" description={ENGINE_TAGLINE.parakeet}>
              <span className="inline-flex items-center gap-1.5">
                <NvidiaIcon size={12} />
                {parakeetModel.displayName ?? parakeetModel.name}
              </span>
            </SelectItem>
            <SelectItem value="whisper" description={ENGINE_TAGLINE.whisper}>
              <span className="inline-flex items-center gap-1.5">
                <OpenAiIcon size={12} />
                {whisperModel.displayName ?? whisperModel.name}
              </span>
            </SelectItem>
            <SelectItem
              value="openai-asr"
              description={t('settings.ai.cloudAsr.engineTagline')}
            >
              <span className="inline-flex items-center gap-1.5">
                <Cloud className="size-3" />
                {t('settings.ai.cloudAsr.providerLabel')}
              </span>
            </SelectItem>
          </SelectContent>
        </Select>
        {parakeetDownloading && (
          <p role="status" className="mt-2 max-w-[240px] text-xs text-muted-foreground">
            {parakeetProgressLabel(pullParakeet.progress[parakeetModel.name])}
          </p>
        )}
        {pullParakeet.isError && <p role="alert">{String(pullParakeet.error.message)}</p>}
      </SettingRow>

      {activeEngine === 'openai-asr' && <OpenAiAsrConfig />}

      <ConfirmDialog
        open={confirmCloudAsr}
        onOpenChange={setConfirmCloudAsr}
        title={t('settings.ai.cloudAsr.confirmTitle')}
        description={t('settings.ai.cloudAsr.confirmDescription')}
        confirmLabel={t('settings.ai.cloudAsr.confirmAction')}
        onConfirm={() => {
          setConfirmCloudAsr(false);
          setActive.mutate({ engine: 'openai-asr' });
        }}
      />
    </>
  );
}

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
function OpenAiAsrConfig() {
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
          style={{ letterSpacing: '0.06em', color: 'var(--fg-muted)' }}
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
          style={{ letterSpacing: '0.06em', color: 'var(--fg-muted)' }}
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
          style={{ letterSpacing: '0.06em', color: 'var(--fg-muted)' }}
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

function SummarisationSection() {
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

const CLOUD_SERVICE_ICON: Record<CloudProvider, React.ReactNode> = {
  openai: <OpenAiIcon size={12} />,
  anthropic: <AnthropicIcon size={12} />,
  bedrock: <AwsIcon size={12} />,
  custom: null,
};

function CloudProviderConfig() {
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
  const availableModels =
    cloudProvider === 'bedrock'
      ? bedrockModels
      : modelListFor === cloudProvider && testConnection.isSuccess
        ? testConnection.data?.models ?? []
        : [];
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
          <SelectTrigger className={COMPACT_INPUT}>
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
            className="mb-1 block text-[12px] font-medium uppercase"
            style={{ letterSpacing: '0.06em', color: 'var(--fg-muted)' }}
          >
            {t('settings.ai.cloud.baseUrl')}
          </label>
          <Input
            value={apiUrl}
            onChange={(e) => setApiUrl(e.target.value)}
            placeholder={t('settings.ai.cloud.baseUrlPlaceholder')}
            onBlur={() => apiUrl && setCloudUrl.mutate(apiUrl)}
            className={COMPACT_INPUT}
          />
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
                  : t('settings.ai.cloud.openaiKeyPlaceholder')
          }
          onBlur={() => apiKey && setCloudKey.mutate(apiKey)}
          className={COMPACT_INPUT}
        />
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
            <SelectTrigger className={COMPACT_INPUT}>
              <SelectValue placeholder={t('settings.ai.cloud.modelPlaceholder')} />
            </SelectTrigger>
            <SelectContent>
              {/* If the persisted model isn't in the fetched list (e.g. a
                  user-typed custom name from before), still show it so the
                  Trigger doesn't render blank. */}
              {!availableModels.includes(model) && model && (
                <SelectItem value={model}>{model}</SelectItem>
              )}
              {availableModels.map((m) => (
                <SelectItem key={m} value={m}>
                  {m}
                </SelectItem>
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

function ConnectionStatus({
  ok,
  message,
}: {
  ok: boolean | undefined;
  message?: string;
}) {
  if (ok === undefined) return null;
  return (
    <span
      className="flex items-center gap-1.5 text-[12px]"
      style={{ color: ok ? 'var(--fg-1)' : 'var(--danger)' }}
    >
      {ok ? <Check className="size-3.5" /> : <X className="size-3.5" />}
      {message ?? (ok ? t('settings.ai.connected') : t('settings.ai.failed'))}
    </span>
  );
}

// Attribution icon for the local Ollama model list -- matched by prefix
// against the model id (e.g. "gemma4:e2b-it-qat"), not the display name,
// since ids are the stable identifier. Remote-provider models can be
// anything a user's Ollama server has pulled, so unmatched ids just render
// without an icon rather than guessing.
function getOllamaModelIcon(modelId: string): React.ReactNode | undefined {
  if (modelId.startsWith('gemma')) return <GoogleIcon size={12} />;
  if (modelId.startsWith('llama')) return <MetaIcon size={12} />;
  if (modelId.startsWith('qwen')) return <QwenIcon size={12} />;
  if (modelId.startsWith('gpt-oss') || modelId.startsWith('gpt')) return <OpenAiIcon size={12} />;
  return undefined;
}

function ModelList() {
  const models = useModels();
  const current = useCurrentModel();
  const setCurrent = useSetCurrentModel();
  const pull = usePullModel();
  const [showDeprecated, setShowDeprecated] = React.useState(false);
  // Backs two distinct triggers that both end in "confirm, then delete one or
  // more tags": the automatic post-switch offer to remove the now-redundant
  // GGUF build, and the manual "delete this model to free up disk space"
  // action. Only one delete can be in flight/confirmed at a time in this UI,
  // so a single piece of state covers both.
  const [deleteCandidate, setDeleteCandidate] = React.useState<{ tags: string[]; description: string } | null>(
    null,
  );
  const deleteModel = useDeleteModel();
  const fasterBuild = useSwitchToFasterBuild((mlxTag) => {
    const match = models.data?.models.find((m) => m.mlxTag === mlxTag);
    if (match) {
      setDeleteCandidate({
        tags: [match.name],
        description: t('settings.ai.fasterBuildDelete.description', {
          name: match.name,
          size: formatModelSize(match.size_gb) ?? t('settings.ai.unknownSize'),
        }),
      });
    }
  });

  if (models.isLoading) {
    return (
      <div
        className="flex items-center gap-2 text-[13px]"
        style={{ color: 'var(--fg-2)' }}
      >
        <Loader2 className="size-3.5 animate-spin" />
        {t('settings.ai.model.loading')}
      </div>
    );
  }
  if (models.isError) {
    return (
      <div className="text-[13px]" style={{ color: 'var(--fg-2)' }}>
        {t('settings.ai.couldNotReach')}
      </div>
    );
  }
  if (!models.data?.models?.length) {
    return (
      <div className="text-[13px]" style={{ color: 'var(--fg-2)' }}>
        {t('settings.ai.noModelsAvailable')}
      </div>
    );
  }

  const isRemote = models.data.provider === 'remote';
  // The RAM-suitability badge only makes sense for the bundled local Ollama:
  // for remote-Ollama or any cloud provider the model runs off-machine, so
  // this Mac's memory is irrelevant. Gate strictly on 'local'.
  const isLocal = models.data.provider === 'local';
  const totalRamGb = models.data.totalRamGb;
  const sorted = [...models.data.models].sort(
    (a, b) => (a.deprecated ? 1 : 0) - (b.deprecated ? 1 : 0),
  );
  const active = sorted.filter((m) => !m.deprecated);
  const deprecated = sorted.filter((m) => m.deprecated);

  const renderCard = (m: (typeof sorted)[number]) => {
    const isCurrent = m.name === current.data;
    // On Apple Silicon, an uninstalled model is pulled straight to its NVFP4
    // sibling (matching what first-run setup's pull_target already does) --
    // config.json still ends up with the canonical GGUF id via models.set()
    // (see usePullModel's pendingSelect), but the actual download, and so
    // the IPC events this row's progress/cancel keys off of, are for the
    // NVFP4 tag. Off Apple Silicon (no mlxTag) this is just m.name, same as
    // before.
    const pullTarget = m.mlxTag ?? m.name;
    const isFasterBuildActive = fasterBuild.activeTag === m.mlxTag;
    // A "switch to faster build" pulls the SAME -nvfp4 tag a general "Select"
    // would, and usePullModel's progress listener is a global (unfiltered) IPC
    // subscription -- so it records that tag's progress too. Without this guard
    // pull.progress[pullTarget] lights up during a switch, and the card renders
    // a SECOND, duplicate progress bar (plus a duplicate Cancel) on top of the
    // faster-build one. While a switch is in flight the faster-build block owns
    // that UI, so suppress the general-download surface for this row.
    const isDownloading = Boolean(pull.progress[pullTarget]) && !isFasterBuildActive;
    const downloadProgress = isDownloading ? pull.progress[pullTarget] : undefined;
    const isDefault = !isRemote && isDefaultModel(m.description);

    let note: string | undefined;
    if (isRemote && m.description) {
      note = m.description;
    } else if (!isRemote) {
      const parts: string[] = [];
      if (m.speed) parts.push(t('settings.ai.speed', { speed: m.speed }));
      if (m.quality) parts.push(t('settings.ai.quality', { quality: m.quality }));
      note = parts.length ? parts.join(' · ') : undefined;
    }

    // The NVFP4 blob is a different (often larger) download than the GGUF
    // entry's own size -- show it instead whenever NVFP4 is what's actually
    // installed, or (nothing installed yet) what "Select" will actually
    // pull on Apple Silicon. Otherwise (GGUF installed, no NVFP4) the GGUF
    // size is what's really on disk.
    const showMlxSize = m.mlxTag && m.mlxSizeGb !== undefined && (m.mlxInstalled || !m.ggufInstalled);
    const sizeLabel = formatModelSize(showMlxSize ? m.mlxSizeGb : m.size_gb);
    const memoryWarning = isLocal && modelMayExceedMemory(m.size_gb, totalRamGb);
    const fasterBuildBlocked =
      Boolean(fasterBuild.activeTag) &&
      !isFasterBuildActive &&
      (fasterBuild.state === 'pulling' || fasterBuild.state === 'verifying' || fasterBuild.state === 'done');

    const onSelect = () => {
      if (m.installed) {
        setCurrent.mutate(m.name);
      } else {
        pull.mutate({ name: m.name, pullTarget });
      }
    };

    const onDeleteModel = () => {
      // Only tags actually present in Ollama -- a model pulled straight to
      // its NVFP4 tag (general "Select" on Apple Silicon) never has the
      // GGUF blob itself installed, and ollama.delete() on a tag that was
      // never pulled throws. Blindly including m.name here caused exactly
      // that: a stuck confirm dialog on a model with no GGUF blob.
      const tags: string[] = [];
      if (m.ggufInstalled) tags.push(m.name);
      if (m.mlxInstalled && m.mlxTag) tags.push(m.mlxTag);
      if (tags.length === 0) return;
      const label =
        tags.length > 1 ? t('settings.ai.deleteModel.multiLabel', { name: m.name }) : tags[0];
      setDeleteCandidate({
        tags,
        description:
          tags.length > 1
            ? t('settings.ai.deleteModel.description.other', {
                label,
                size: sizeLabel ?? t('settings.ai.unknownSize'),
              })
            : t('settings.ai.deleteModel.description.one', {
                label,
                size: sizeLabel ?? t('settings.ai.unknownSize'),
              }),
      });
    };

    return (
      <ModelCard
        key={m.name}
        icon={getOllamaModelIcon(m.name)}
        name={m.name}
        sizeLabel={sizeLabel}
        note={note}
        isCurrent={isCurrent}
        isDefault={isDefault}
        deprecated={Boolean(m.deprecated)}
        memoryWarning={memoryWarning}
        isDownloading={isDownloading}
        downloadProgress={downloadProgress}
        downloadBytesPerSecond={pull.bytesPerSecond[pullTarget]}
        onSelect={onSelect}
        onCancelDownload={() => pull.cancel(pullTarget)}
        isInstalled={Boolean(m.installed)}
        onDeleteModel={onDeleteModel}
        ggufInstalled={Boolean(m.ggufInstalled)}
        fasterBuildTag={m.installed ? m.mlxTag : undefined}
        fasterBuildInstalled={Boolean(m.mlxInstalled)}
        fasterBuildState={isFasterBuildActive ? fasterBuild.state : 'idle'}
        fasterBuildProgress={isFasterBuildActive ? fasterBuild.progress : undefined}
        fasterBuildBytesPerSecond={isFasterBuildActive ? fasterBuild.bytesPerSecond : undefined}
        fasterBuildBlocked={fasterBuildBlocked}
        onSwitchToFasterBuild={() => {
          if (!m.mlxTag || fasterBuildBlocked) return;
          fasterBuild.switchTo(m.mlxTag);
        }}
        onCancelFasterBuild={isFasterBuildActive ? fasterBuild.cancel : undefined}
      />
    );
  };

  return (
    <div>
      {active.map(renderCard)}

      {deprecated.length > 0 && (
        <>
          <button
            type="button"
            onClick={() => setShowDeprecated((d) => !d)}
            className="mt-4 flex cursor-pointer items-center gap-1.5 border-0 bg-transparent p-0 text-[13px]"
            style={{ color: 'var(--fg-muted)' }}
          >
            {showDeprecated ? (
              <ChevronDown size={12} />
            ) : (
              <ChevronRight size={12} />
            )}
            {showDeprecated ? t('settings.ai.deprecated.hide') : t('settings.ai.deprecated.show')}{' '}
            {t('settings.ai.deprecated.models')}
          </button>

          {showDeprecated && (
            <div className="mt-2">{deprecated.map(renderCard)}</div>
          )}
        </>
      )}

      {deleteCandidate && (
        <ConfirmDialog
          open={Boolean(deleteCandidate)}
          onOpenChange={(open) => {
            if (!open) {
              setDeleteCandidate(null);
              fasterBuild.reset();
            }
          }}
          title={t('settings.ai.deleteModel.title')}
          description={deleteCandidate.description}
          confirmLabel={t('settings.ai.deleteModel.action')}
          destructive
          onConfirm={async () => {
            // finally, not just a trailing statement: a delete call
            // rejecting (unexpected -- e.g. Ollama briefly unreachable)
            // must not leave this dialog stuck open with no way to close
            // it except Cancel (which, since some deletes may have already
            // succeeded, looked like "cancel deletes it anyway").
            // allSettled (not all): waits for every tag's attempt to finish
            // rather than returning as soon as the first one rejects, so the
            // dialog doesn't close while a sibling delete is still pending.
            try {
              const results = await Promise.allSettled(
                deleteCandidate.tags.map((tag) => deleteModel.mutateAsync(tag)),
              );
              const failed = results.filter((r): r is PromiseRejectedResult => r.status === 'rejected');
              if (failed.length > 0) {
                // eslint-disable-next-line no-console -- no toast/error-surface system exists yet; at least don't fail silently.
                console.error('Failed to delete some model tags:', failed.map((f) => f.reason));
              }
            } finally {
              setDeleteCandidate(null);
              fasterBuild.reset();
            }
          }}
        />
      )}
    </div>
  );
}
