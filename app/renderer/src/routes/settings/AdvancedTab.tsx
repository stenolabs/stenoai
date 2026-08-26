import * as React from 'react';
import { Check, Copy } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Switch } from '@/components/ui/switch';
import { cn } from '@/lib/utils';
import { useNavigate } from '@/lib/router';
import { ipc } from '@/lib/ipc';
import {
  useClearSystemState,
  usePickStorageFolder,
  useSetStoragePath,
  useSetTelemetry,
  useStoragePath,
  useTelemetrySetting,
} from '@/hooks/useSettings';
import { COMPACT_BTN, SettingRow } from './primitives';

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
  const navigate = useNavigate();
  const storage = useStoragePath();
  const setStorage = useSetStoragePath();
  const pickFolder = usePickStorageFolder();
  const clearState = useClearSystemState();
  const telemetry = useTelemetrySetting();
  const setTelemetry = useSetTelemetry();
  const [exportFeedback, setExportFeedback] = React.useState<{
    type: 'success' | 'error';
    message: string;
  } | null>(null);
  const [isExporting, setIsExporting] = React.useState(false);
  const [exportFormat, setExportFormat] = React.useState<'md' | 'csv' | null>(null);

  const handleExportAll = async (format: 'md' | 'csv') => {
    setIsExporting(true);
    setExportFormat(format);
    setExportFeedback(null);
    try {
      const meetingsBridge = ipc().meetings;
      if ('exportAll' in meetingsBridge && typeof meetingsBridge.exportAll === 'function') {
        const res = await meetingsBridge.exportAll(format);
        if (res.success) {
          setExportFeedback({
            type: 'success',
            message: `Successfully exported ${res.count} note${res.count === 1 ? '' : 's'}.`,
          });
        } else if (res.error && res.error !== 'CANCELED' && res.error !== 'EXPORT_CANCELED') {
          setExportFeedback({
            type: 'error',
            message: `Export failed: ${res.error}`,
          });
        }
      }
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : 'Unknown error';
      setExportFeedback({
        type: 'error',
        message: `Export failed: ${msg}`,
      });
    } finally {
      setIsExporting(false);
      setExportFormat(null);
    }
  };

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
            Storage location
          </div>
          <div
            className="mb-2 text-[13px]"
            style={{ color: 'var(--fg-2)' }}
          >
            Where your notes and recordings are saved
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
            Choose…
          </Button>
          {custom && (
            <Button
              variant="ghost"
              size="sm"
              className={COMPACT_BTN}
              onClick={resetFolder}
            >
              Reset
            </Button>
          )}
        </div>
      </div>
      <div
        className="flex items-start justify-between gap-6 py-4"
        style={{ borderBottom: '1px solid var(--border-subtle)' }}
      >
        <div className="min-w-0 flex-1">
          <div
            className="text-[14px] font-normal"
            style={{ color: 'var(--fg-1)', marginBottom: 2 }}
          >
            Export all notes
          </div>
          <div
            className="mb-2 text-[13px]"
            style={{ color: 'var(--fg-2)' }}
          >
            Export every note and transcript to individual Markdown files or a single CSV spreadsheet.
          </div>
          {exportFeedback && (
            <div
              data-testid="export-all-feedback"
              className={cn(
                'text-[12px] font-medium mt-1',
                exportFeedback.type === 'success'
                  ? 'text-[color:var(--fg-1)]'
                  : 'text-[color:var(--danger)]'
              )}
            >
              {exportFeedback.message}
            </div>
          )}
        </div>
        <div className="flex shrink-0 gap-2 pt-1">
          <Button
            variant="outline"
            size="sm"
            className={COMPACT_BTN}
            disabled={isExporting}
            onClick={() => handleExportAll('md')}
            data-testid="export-all-md-btn"
          >
            {isExporting && exportFormat === 'md' ? 'Exporting…' : 'Export Markdown…'}
          </Button>
          <Button
            variant="outline"
            size="sm"
            className={COMPACT_BTN}
            disabled={isExporting}
            onClick={() => handleExportAll('csv')}
            data-testid="export-all-csv-btn"
          >
            {isExporting && exportFormat === 'csv' ? 'Exporting…' : 'Export CSV…'}
          </Button>
        </div>
      </div>


      <SettingRow
        label="Setup wizard"
        description="Reinstall dependencies or fix configuration"
      >
        <Button
          variant="outline"
          size="sm"
          className={COMPACT_BTN}
          onClick={() => navigate('/setup')}
        >
          Run
        </Button>
      </SettingRow>

      <SettingRow
        label="Clear recording state"
        description="Fix stuck recordings or processing"
      >
        <Button
          variant="outline"
          size="sm"
          className={COMPACT_BTN}
          onClick={() => clearState.mutate()}
          disabled={clearState.isPending}
          style={{ color: 'var(--danger)' }}
        >
          {clearState.isPending ? 'Clearing…' : 'Clear'}
        </Button>
      </SettingRow>

      <SettingRow
        label="Anonymous usage analytics"
        description="Help improve Steno — no meeting content is ever sent"
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
