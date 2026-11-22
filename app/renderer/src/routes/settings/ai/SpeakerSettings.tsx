import { speakerModelsProgressLabel, speakerModelsProgressPercent } from '@/lib/parakeetProgress';
import { DownloadProgressBar } from '@/components/DownloadProgressBar';
import * as React from 'react';
import { Check, Loader2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Switch } from '@/components/ui/switch';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { t } from '@/i18n';
import type { DiarizationEngine } from '@/lib/ipc';
import {
  useDiarizationEngine,
  useDiarizationModelsState,
  useDownloadDiarizationModels,
  useSetDiarizationEngine,
} from '@/hooks/useModels';
import {
  useIdentityMatchingEnabledSetting,
  useSetIdentityMatchingEnabled,
} from '@/hooks/useSettings';
import { COMPACT_BTN, COMPACT_TRIGGER, SettingRow } from '../primitives';

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
