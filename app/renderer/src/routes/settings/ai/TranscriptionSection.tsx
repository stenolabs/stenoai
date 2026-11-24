import { parakeetProgressLabel } from '@/lib/parakeetProgress';
import { DownloadProgressBar } from '@/components/DownloadProgressBar';
import * as React from 'react';
import { Cloud, Loader2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import { Switch } from '@/components/ui/switch';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { OpenAiIcon } from '@/components/ui/openai-icon';
import { NvidiaIcon } from '@/components/ui/nvidia-icon';
import { cn, isMac } from '@/lib/utils';
import { t } from '@/i18n';
import type { TranscriptionEngine } from '@/lib/ipc';
import {
  useParakeetModels,
  usePullLanguageModel,
  usePullParakeetModel,
  usePullWhisperModel,
  useSetActiveTranscription,
  useSetLanguageModelsEnabled,
  useTranscriptionEngine,
  useWhisperModels,
} from '@/hooks/useModels';
import {
  useKeepRecordingsSetting,
  useLanguageSetting,
  useSetKeepRecordings,
  useSetLanguage,
} from '@/hooks/useSettings';
import { COMPACT_TRIGGER, SettingRow, SubSettings } from '../primitives';
import { formatModelSize, parsePullPercent } from '../model-card';
import { LANGUAGES_PARAKEET, LANGUAGES_WHISPER } from '../languages';
import { OpenAiAsrConfig } from './OpenAiAsrConfig';
import { SpeakerIdentificationSetting, SpeakerSeparationSetting } from './SpeakerSettings';

export function TranscriptionSection() {
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

      {engine === 'whisper' && <HebrewModelSetting language={displayValue} />}

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

/**
 * Opt-in download of ivrit.ai's Hebrew Whisper (Whisper engine only). Once
 * installed, the backend uses it in place of the main model for any recording
 * pinned to or detected as Hebrew; the switch turns that off without deleting
 * the download. Other languages always stay on the main model.
 *
 * Shown nested under Language, and only where it can apply: while the
 * language is Auto or Hebrew. Once installed it stays visible whatever the
 * language (or while it downloads), so the switch is never out of reach.
 */
function HebrewModelSetting({ language }: { language: string }) {
  const whisper = useWhisperModels();
  const pull = usePullLanguageModel();
  const setEnabled = useSetLanguageModelsEnabled();

  const model = whisper.data?.languageModels.find((m) => m.language === 'he');
  if (!model) return null;
  if (!model.installed && !pull.isPending && language !== 'auto' && language !== 'he') return null;

  let control: React.ReactNode;
  if (pull.isPending) {
    control = (
      <DownloadProgressBar
        className="w-[200px]"
        data-testid="hebrew-model-progress"
        label={t('settings.ai.hebrewModel.downloading')}
        percent={parsePullPercent(pull.progress[model.name])}
        aria-label={t('settings.ai.hebrewModel.ariaLabel')}
      />
    );
  } else if (model.installed) {
    control = (
      <Switch
        aria-label={t('settings.ai.hebrewModel.label')}
        aria-describedby="hebrew-model-description"
        checked={whisper.data?.languageModelsEnabled ?? true}
        onCheckedChange={(value) => setEnabled.mutate(value)}
        disabled={setEnabled.isPending}
      />
    );
  } else {
    control = (
      <Button size="sm" variant="outline" onClick={() => pull.mutate(model.name)}>
        {pull.isError ? t('settings.ai.hebrewModel.retry') : t('settings.ai.hebrewModel.download')}
      </Button>
    );
  }

  return (
    <SubSettings divider>
      <SettingRow
        label={t('settings.ai.hebrewModel.label')}
        description={t('settings.ai.hebrewModel.description', {
          size: formatModelSize(model.size_gb) ?? t('settings.ai.unknownSize'),
        })}
        descriptionId="hebrew-model-description"
      >
        {control}
        {pull.isError && (
          <p role="alert" className="mt-2 max-w-[240px] text-xs" style={{ color: 'var(--danger)' }}>
            {t('settings.ai.hebrewModel.failed')}
          </p>
        )}
      </SettingRow>
    </SubSettings>
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
        // Only the download just started should report an error.
        pullWhisper.reset();
        pullParakeet.mutate(parakeetModel.name);
      }
    } else if (whisperModel.installed) {
      setActive.mutate({ engine: 'whisper', whisperModel: whisperModel.name });
    } else {
      pullParakeet.reset();
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
        {(pullParakeet.isError || pullWhisper.isError) && (
          <p role="alert" className="mt-2 max-w-[240px] text-xs" style={{ color: 'var(--danger)' }}>
            {String((pullParakeet.isError ? pullParakeet.error : pullWhisper.error)?.message ?? '')}
          </p>
        )}
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
