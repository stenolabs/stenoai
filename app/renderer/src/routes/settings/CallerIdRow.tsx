import * as React from 'react';
import { Button } from '@/components/ui/button';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import { Switch } from '@/components/ui/switch';
import { useCallerIdSetting, useSetCallerId } from '@/hooks/useSettings';
import { t } from '@/i18n';
import { ipc, type GetCallerIdResponse } from '@/lib/ipc';
import { isMac } from '@/lib/utils';
import { COMPACT_BTN, SettingRow } from './primitives';

type CallerIdSettings = Extract<GetCallerIdResponse, { success: true }>;

// iMCP's home page (it forwards to the project on GitHub): what it is and how
// to install it, before anyone downloads anything.
const IMCP_URL = 'https://imcp.app';

// The description names iMCP as a link. One sentence with an {{app}} slot,
// so a translation keeps the link where its grammar needs it.
function Description() {
  const [before, after = ''] = t('settings.general.callerId.description').split('{{app}}');
  return (
    <>
      {before}
      <button
        type="button"
        onClick={() => void ipc().shell.openExternal(IMCP_URL)}
        className="underline underline-offset-2 hover:no-underline"
        style={{ color: 'var(--fg-1)' }}
      >
        {t('settings.general.callerId.imcpLink')}
      </button>
      {after}
    </>
  );
}

// What to tell the user, in the order they would fix things. Literal keys, so
// the copy inventory can read them.
function statusText(data: CallerIdSettings): string | null {
  if (!data.caller_id_enabled) return null;
  if (!data.meeting_detection) return t('settings.general.callerId.status.needsMeetingDetection');
  switch (data.status.state) {
    case 'not-installed':
      return t('settings.general.callerId.status.notInstalled');
    case 'not-running':
      return t('settings.general.callerId.status.notRunning');
    case 'awaiting-approval':
      return t('settings.general.callerId.status.awaitingApproval');
    case 'declined':
      return t('settings.general.callerId.status.declined');
    case 'phone-off':
      return t('settings.general.callerId.status.phoneOff');
    case 'ready':
      return data.status.contacts
        ? t('settings.general.callerId.status.ready')
        : t('settings.general.callerId.status.noContacts');
    default:
      return null;
  }
}

/**
 * "Identify call participants": names the caller on notes of phone and
 * FaceTime calls through iMCP (app/caller-id.js). macOS only; renders nothing
 * elsewhere, not even while main's answer is on its way. Turned on only after
 * the user acknowledges that caller names reach the AI model, which may be a
 * cloud provider's.
 */
export function CallerIdRow() {
  return isMac ? <CallerIdSetting /> : null;
}

function CallerIdSetting() {
  const setting = useCallerIdSetting();
  const setCallerId = useSetCallerId();
  const [confirmOpen, setConfirmOpen] = React.useState(false);
  const data = setting.data;
  if (data && !data.supported) return null;

  const enabled = data?.caller_id_enabled ?? false;
  const status = data ? statusText(data) : null;
  const offerDownload = enabled && data?.status.state === 'not-installed';

  return (
    <>
      <SettingRow
        label={t('settings.general.callerId.label')}
        align="start"
        description={
          <>
            <Description />
            {status && (
              <span className="mt-1 block" data-testid="caller-id-status">
                {status}
              </span>
            )}
            {offerDownload && (
              <span className="mt-2 flex flex-wrap items-center gap-3">
                <Button
                  variant="outline"
                  size="sm"
                  className={COMPACT_BTN}
                  onClick={() => void ipc().settings.openImcpDownload()}
                >
                  {t('settings.general.callerId.getImcp')}
                </Button>
                <span>
                  {t('settings.general.callerId.homebrewHint', { command: data.homebrew })}
                </span>
              </span>
            )}
            {setting.isError && (
              <span className="mt-1 block">{t('settings.general.callerId.loadError')}</span>
            )}
            {setCallerId.isError && (
              <span className="mt-1 block" role="alert">
                {t('settings.general.callerId.saveError')}
              </span>
            )}
          </>
        }
      >
        <Switch
          checked={enabled}
          // Turning it on waits for the dialog; turning it off saves at once.
          onCheckedChange={(v) => (v ? setConfirmOpen(true) : setCallerId.mutate(false))}
          disabled={data === undefined || setCallerId.isPending}
          aria-label={t('settings.general.callerId.label')}
          data-testid="caller-id-toggle"
        />
      </SettingRow>
      <ConfirmDialog
        open={confirmOpen}
        onOpenChange={setConfirmOpen}
        title={t('settings.general.callerId.consent.title')}
        description={t('settings.general.callerId.consent.body')}
        cancelLabel={t('settings.general.callerId.consent.disable')}
        confirmLabel={t('settings.general.callerId.consent.confirm')}
        onConfirm={() => {
          setCallerId.mutate(true);
          setConfirmOpen(false);
        }}
      />
    </>
  );
}
