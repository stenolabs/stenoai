import * as React from 'react';
import { Check, Copy } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Switch } from '@/components/ui/switch';
import { cn } from '@/lib/utils';
import { useNavigate } from '@/lib/router';
import {
  useClearSystemState,
  usePickStorageFolder,
  useSetStoragePath,
  useSetTelemetry,
  useStoragePath,
  useTelemetrySetting,
} from '@/hooks/useSettings';
import { COMPACT_BTN, SettingRow } from './primitives';
import { useTranslation } from '@/i18n';
/** A read-only value with a click-to-copy button. Used for paths and IDs that
 *  users frequently need to paste into bug reports or terminal sessions. */
function CopyableValue({ value, mono = false }: { value: string; mono?: boolean }) {
  const [copied, setCopied] = React.useState(false);
  const onCopy = async () => {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1500);
    } catch {
      // Clipboard write may fail on systems without permission. Fail silently
      // — the value is still visible and the user can select-copy manually.
    }
  };
  return (
    <div
      className="inline-flex max-w-full items-center gap-1 rounded-[4px] pl-2 pr-1 py-[2px]"
      style={{ background: 'var(--surface-sunken)', color: 'var(--fg-2)' }}
    >
      <code
        className={cn(
          'flex-1 truncate select-all text-[12px]',
          mono && 'font-mono',
        )}
        title={value}
      >
        {value}
      </code>
      <button
        type="button"
        onClick={onCopy}
        aria-label={copied ? 'Copied' : 'Copy to clipboard'}
        title={copied ? 'Copied' : 'Copy to clipboard'}
        className="inline-flex size-[22px] flex-shrink-0 items-center justify-center rounded transition-colors hover:bg-[color:var(--surface-hover)]"
        style={{ color: copied ? 'var(--fg-1)' : 'var(--fg-2)' }}
      >
        {copied ? <Check size={12} /> : <Copy size={12} />}
      </button>
    </div>
  );
}

export function AdvancedTab() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const storage = useStoragePath();
  const setStorage = useSetStoragePath();
  const pickFolder = usePickStorageFolder();
  const clearState = useClearSystemState();
  const telemetry = useTelemetrySetting();
  const setTelemetry = useSetTelemetry();

  const chooseFolder = async () => {
    try {
      const folder = await pickFolder.mutateAsync();
      if (folder) setStorage.mutate(folder);
    } catch {
      // cancelled
    }
  };

  // Send '' — the backend treats an empty path as "use the default location"
  // and clears the custom override. Passing the default *path* instead would
  // be recorded as a fresh custom override, so Reset would hide itself without
  // actually resetting anything (#304).
  const resetFolder = () => setStorage.mutate('');

  const custom =
    storage.data?.custom_path &&
    storage.data.custom_path !== storage.data.default_path;
  const path = storage.data?.storage_path ?? storage.data?.default_path;

  return (
    <section data-settings-tab="advanced">
      <div
        className="flex items-start justify-between gap-6 py-4"
        style={{ borderBottom: '1px solid var(--border-subtle)' }}
      >
        <div className="min-w-0 flex-1">
          <div
            className="text-[14px] font-normal"
            style={{ color: 'var(--fg-1)', marginBottom: 2 }}
          >
            {t('settings.advanced.storageLocation')}
          </div>
          <div
            className="mb-2 text-[13px]"
            style={{ color: 'var(--fg-2)' }}
          >
            {t('settings.advanced.storageLocationDesc')}
          </div>
          {path && <CopyableValue value={path} mono />}
        </div>
        <div className="flex shrink-0 gap-2 pt-1">
          <Button
            variant="outline"
            size="sm"
            className={COMPACT_BTN}
            onClick={chooseFolder}
          >
            {t('common.choose')}
          </Button>
          {custom && (
            <Button
              variant="ghost"
              size="sm"
              className={COMPACT_BTN}
              onClick={resetFolder}
            >
              {t('common.reset')}
            </Button>
          )}
        </div>
      </div>

      <SettingRow
        label={t('settings.advanced.setupWizard')}
        description={t('settings.advanced.setupWizardDesc')}
      >
        <Button
          variant="outline"
          size="sm"
          className={COMPACT_BTN}
          onClick={() => navigate('/setup')}
        >
          {t('settings.advanced.rerunSetup')}
        </Button>
      </SettingRow>

      <SettingRow
        label={t('settings.advanced.clearRecordingState')}
        description={t('settings.advanced.clearRecordingStateDesc')}
      >
        <Button
          variant="outline"
          size="sm"
          className={COMPACT_BTN}
          onClick={() => clearState.mutate()}
          disabled={clearState.isPending}
          style={{ color: 'var(--danger)' }}
        >
          {clearState.isPending ? t('common.loading') : t('settings.advanced.clearStateButton')}
        </Button>
      </SettingRow>

      <SettingRow
        label={t('settings.advanced.analyticsTitle')}
        description={t('settings.advanced.analyticsDesc')}
        noBorder={!telemetry.data?.anonymous_id}
      >
        <Switch
          checked={telemetry.data?.telemetry_enabled ?? false}
          onCheckedChange={(v) => setTelemetry.mutate({ enabled: v, source: 'settings' })}
          disabled={telemetry.data === undefined}
        />
      </SettingRow>

      {telemetry.data?.anonymous_id && (
        <div
          className="flex items-start justify-between gap-6 py-4"
          style={{ borderBottom: 'none' }}
        >
          <div className="min-w-0 flex-1">
            <div
              className="text-[14px] font-normal"
              style={{ color: 'var(--fg-1)', marginBottom: 2 }}
            >
              Anonymous ID
            </div>
            <div
              className="mb-2 text-[13px]"
              style={{ color: 'var(--fg-2)' }}
            >
              Identifies this install in analytics. Useful when reporting bugs.
            </div>
            <CopyableValue value={telemetry.data.anonymous_id} mono />
          </div>
        </div>
      )}
    </section>
  );
}
