import * as React from 'react';

import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Switch } from '@/components/ui/switch';
import { Button } from '@/components/ui/button';
import { SettingRow } from '@/routes/settings/primitives';
import {
  useLaunchOnLoginSetting,
  useMarkPrivacyNoticeSeen,
  useSetLaunchOnLogin,
  useSetTelemetry,
  useTelemetrySetting,
} from '@/hooks/useSettings';
import { useTranslation } from '@/i18n';
/**
 * One-time, soft privacy disclosure for existing installs upgrading into the
 * version that added telemetry + launch-on-login (both default ON). Nothing is
 * gated or held back — the modal only discloses what's on and offers immediate
 * off-toggles. Acknowledging (the "Got it" button, the X, or Escape) marks the
 * notice seen forever via `privacy.markNoticeSeen()` and invalidates the gate
 * query so it can never reappear.
 *
 * Mounted by App.tsx, which owns the `open` decision (notice not seen AND not
 * on the /setup route, so an upgrader who also lacks a model and lands on
 * onboarding isn't disclosed to twice).
 */
export function PrivacyConsentModal({ open }: { open: boolean }) {
  const { t } = useTranslation();
  const { mutateAsync: markNoticeSeen } = useMarkPrivacyNoticeSeen();

  const telemetry = useTelemetrySetting();
  const setTelemetry = useSetTelemetry();
  const telemetryEnabled = telemetry.data?.telemetry_enabled ?? true;

  const launchOnLogin = useLaunchOnLoginSetting();
  const setLaunchOnLogin = useSetLaunchOnLogin();
  const launchOnLoginEnabled = launchOnLogin.data ?? true;

  // Guard so the mark-seen write fires exactly once even if the button click
  // and the Dialog's onOpenChange(false) both resolve to acknowledge.
  const acknowledgedRef = React.useRef(false);

  const acknowledge = React.useCallback(async () => {
    if (acknowledgedRef.current) return;
    acknowledgedRef.current = true;
    try {
      // Persists the marker and flips the gate query (see the shared hook).
      await markNoticeSeen();
    } catch {
      // Persisting the marker failed (e.g. a config-write error). Unlatch so
      // the user can dismiss again instead of being trapped behind a modal
      // that no longer responds to the button, X, or Escape.
      acknowledgedRef.current = false;
    }
  }, [markNoticeSeen]);

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) void acknowledge();
      }}
    >
      <DialogContent className="max-w-md" data-privacy-consent>
        <DialogHeader>
          <DialogTitle>{t('dialogs.privacyConsentTitle')}</DialogTitle>
          <DialogDescription>
            {t('dialogs.privacyConsentBody')}
          </DialogDescription>
        </DialogHeader>

        <div className="mt-1">
          <SettingRow
            label={t('settings.advanced.analyticsTitle')}
            description={t('settings.advanced.analyticsDesc')}
          >
            <Switch
              checked={telemetryEnabled}
              onCheckedChange={(v) => setTelemetry.mutate({ enabled: v, source: 'consent' })}
              disabled={telemetry.data === undefined}
              aria-label={t('settings.advanced.analyticsTitle')}
              data-privacy-telemetry
            />
          </SettingRow>
          <SettingRow
            label={t('settings.general.launchOnLogin')}
            description={t('settings.general.launchOnLoginDesc')}
            noBorder
          >
            <Switch
              checked={launchOnLoginEnabled}
              onCheckedChange={(v) => setLaunchOnLogin.mutate(v)}
              disabled={launchOnLogin.data === undefined}
              aria-label={t('settings.general.launchOnLogin')}
              data-privacy-launch
            />
          </SettingRow>
        </div>

        <DialogFooter>
          <Button onClick={() => void acknowledge()} data-privacy-ack>
            {t('dialogs.privacyConsentAccept')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
