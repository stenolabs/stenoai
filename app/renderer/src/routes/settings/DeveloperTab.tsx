import * as React from 'react';
import { Button } from '@/components/ui/button';
import {
  clearDebugLogs,
  getDebugLogs,
  subscribeDebugLogs,
} from '@/lib/debugLogs';
import { ipc } from '@/lib/ipc';
import { redactDiagnostics } from '@/lib/redactDiagnostics';
import {
  useStoragePath,
  useAppVersion,
  useSystemAudioSupport,
  useSystemAudioSetting,
  useSilenceAutoStopSetting,
} from '@/hooks/useSettings';
import { useAiProvider } from '@/hooks/useAi';
import { useTranscriptionEngine } from '@/hooks/useModels';
import { useTranslation } from '@/i18n';
// Cross-process sentinel: the save-diagnostics handler (and its e2e mock) return
// this exact error string when the user dismisses the save dialog. Kept in sync
// with app/ipc-sentinels.js (EXPORT_CANCELED); the renderer can't require that
// CJS module, so it mirrors the literal (same as MeetingDetail's copy).
const DIAGNOSTICS_CANCELED = 'canceled';

export function DeveloperTab() {
  const { t } = useTranslation();
  // Read from the global store so we get the full session backlog, not just
  // lines emitted after this tab mounted.
  const logs = React.useSyncExternalStore(
    subscribeDebugLogs,
    getDebugLogs,
    getDebugLogs,
  );

  const textareaRef = React.useRef<HTMLTextAreaElement>(null);
  // Keep the textarea pinned to the most recent line whenever new logs arrive.
  React.useEffect(() => {
    const el = textareaRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [logs]);

  // Data for redaction (custom storage root) + the anonymized env header. All
  // already cached by other Settings surfaces, so these reads are free here.
  const storage = useStoragePath();
  const version = useAppVersion();
  const systemAudioSupport = useSystemAudioSupport();
  const systemAudio = useSystemAudioSetting();
  const silenceAutoStop = useSilenceAutoStopSetting();
  const engine = useTranscriptionEngine();
  const aiProvider = useAiProvider();

  // The custom storage root (only set when the user moved storage off the
  // default under-home location). It may live outside home, so redaction needs
  // the literal string; undefined means the home-dir rule already covers it.
  const storageRoot = storage.data?.custom_path ?? undefined;

  // Surfaced when a Save genuinely fails (disk error / rejection). A cancelled
  // save dialog is not an error and stays silent.
  const [saveError, setSaveError] = React.useState<string | null>(null);

  const copyLogs = () => {
    void navigator.clipboard.writeText(
      redactDiagnostics(logs, { storageRoot }).join('\n'),
    );
  };

  // Build the anonymized env header (no PII: provider TYPE not URL/key, no
  // telemetry id) + a blank line + the redacted buffer, and save it to a file
  // the user picks. Header values come from the same hooks the Settings/About
  // surfaces already use.
  const saveLogs = async () => {
    const platform = systemAudioSupport.data?.platform ?? '(unknown)';
    const osVersion = systemAudioSupport.data?.osVersion ?? '(unknown)';
    const header = [
      '# stenoai diagnostics',
      '# Paths, URLs and meeting titles are redacted. No account/telemetry id.',
      `app version: ${version.data?.version ?? '(unknown)'}`,
      `platform: ${platform}`,
      `os version: ${osVersion}`,
      `transcription engine: ${engine.data ?? '(unknown)'}`,
      `ai provider: ${aiProvider.data?.ai_provider ?? '(unknown)'}`,
      `system audio enabled: ${systemAudio.data ? 'yes' : 'no'}`,
      `silence auto-stop enabled: ${silenceAutoStop.data?.enabled ? 'yes' : 'no'}`,
      `silence auto-stop minutes: ${silenceAutoStop.data?.minutes ?? '(unknown)'}`,
    ];
    const body = redactDiagnostics(logs, { storageRoot });
    const content = [...header, '', ...body].join('\n');

    const now = new Date();
    const stamp = `${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, '0')}${String(now.getDate()).padStart(2, '0')}`;

    // Save writes a file, which can genuinely fail. A user-cancelled dialog
    // resolves with error === DIAGNOSTICS_CANCELED and stays silent; a real
    // failure (or a rejection) is surfaced inline. Mirrors MeetingDetail's
    // save-transcript consumer.
    setSaveError(null);
    try {
      const res = await ipc().settings.saveDiagnostics(
        `stenoai-diagnostics-${stamp}.txt`,
        content,
      );
      if (!res.success && res.error !== DIAGNOSTICS_CANCELED) {
        setSaveError(`Couldn't save diagnostics: ${res.error || 'unknown error'}`);
      }
    } catch (err) {
      setSaveError(
        `Couldn't save diagnostics: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  };

  const placeholder =
    'Steno debug console\nSession started — waiting for activity…\n';

  return (
    <section data-settings-tab="developer">
      <div className="flex items-baseline justify-between pb-2 pt-1">
        <div>
          <div
            className="text-[14px] font-medium"
            style={{ color: 'var(--fg-1)', marginBottom: 2 }}
          >
            {t('settings.developer.debugLogs')}
          </div>
          <div className="text-[13px]" style={{ color: 'var(--fg-2)' }}>
            {t('settings.developer.subtitle')}
          </div>
        </div>
        <div className="flex gap-2">
          <Button
            variant="ghost"
            size="sm"
            className="h-7 px-2.5 text-[13px]"
            onClick={clearDebugLogs}
          >
            {t('settings.developer.clearLogs')}
          </Button>
          <Button
            variant="ghost"
            size="sm"
            className="h-7 px-2.5 text-[13px]"
            onClick={copyLogs}
            disabled={!logs.length}
          >
            {t('settings.developer.copyLogs')}
          </Button>
          <Button
            variant="ghost"
            size="sm"
            className="h-7 px-2.5 text-[13px]"
            onClick={() => void saveLogs()}
            disabled={!logs.length}
          >
            {t('common.save')}
          </Button>
        </div>
      </div>
      {saveError && (
        <div
          className="mb-2 text-[12px]"
          style={{ color: 'var(--accent-danger, var(--fg-1))' }}
          role="alert"
        >
          {saveError}
        </div>
      )}
      <textarea
        ref={textareaRef}
        readOnly
        value={logs.length === 0 ? placeholder : logs.join('\n')}
        className="block w-full font-mono text-[12px]"
        style={{
          height: 340,
          padding: 16,
          lineHeight: 1.7,
          color: 'var(--fg-2)',
          background: 'var(--surface-sunken)',
          border: '1px solid var(--border-subtle)',
          borderRadius: 'var(--radius)',
          resize: 'none',
        }}
      />
    </section>
  );
}
