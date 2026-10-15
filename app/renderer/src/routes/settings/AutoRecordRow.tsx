import * as React from 'react';
import { Switch } from '@/components/ui/switch';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import { t } from '@/i18n';
import { useAutoRecordMeetingsSetting, useSetAutoRecordMeetings } from '@/hooks/useSettings';
import { SettingRow } from './primitives';

const DESCRIPTION_ID = 'auto-record-description';

/**
 * "Auto-record detected meetings" (#463): record a detected meeting without the
 * Take Notes tap. Off by default, because it records without asking, and turned
 * on only after the user acknowledges that recording a call may need everyone's
 * consent. It acts on what meeting detection detects, so it is unavailable, and
 * shown off, while Auto-detected meetings is off or unsupported on this Mac.
 */
export function AutoRecordRow({
  detectionSupported,
  detectionOn,
}: {
  detectionSupported: boolean;
  detectionOn: boolean;
}) {
  const autoRecord = useAutoRecordMeetingsSetting();
  const setAutoRecord = useSetAutoRecordMeetings();
  const [confirmOpen, setConfirmOpen] = React.useState(false);

  const description = t('settings.general.autoRecord.description');
  const reason = !detectionSupported
    ? t('settings.general.autoRecord.requiresMacos14')
    : !detectionOn
      ? t('settings.general.autoRecord.needsDetection')
      : null;

  return (
    <>
      <SettingRow
        label={t('settings.general.autoRecord.label')}
        description={reason ? `${description} ${reason}` : description}
        descriptionId={DESCRIPTION_ID}
        muted={!detectionOn}
      >
        <Switch
          aria-label={t('settings.general.autoRecord.label')}
          aria-describedby={DESCRIPTION_ID}
          checked={detectionOn && (autoRecord.data ?? false)}
          // Turning it on waits for the consent dialog; turning it off saves
          // at once. Disabled while a save runs: two overlapping saves can
          // leave config.json holding the value the switch no longer shows.
          onCheckedChange={(v) => (v ? setConfirmOpen(true) : setAutoRecord.mutate(false))}
          disabled={!detectionOn || autoRecord.data === undefined || setAutoRecord.isPending}
        />
      </SettingRow>
      <ConfirmDialog
        open={confirmOpen}
        onOpenChange={setConfirmOpen}
        title={t('settings.general.autoRecord.consent.title')}
        description={t('settings.general.autoRecord.consent.body')}
        cancelLabel={t('settings.general.autoRecord.consent.keepOff')}
        confirmLabel={t('settings.general.autoRecord.consent.confirm')}
        onConfirm={() => {
          setAutoRecord.mutate(true);
          setConfirmOpen(false);
        }}
      />
    </>
  );
}
