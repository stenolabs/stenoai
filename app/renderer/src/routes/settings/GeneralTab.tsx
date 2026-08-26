import * as React from 'react';
import { ExternalLink, Loader2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Switch } from '@/components/ui/switch';
import { GoogleCalendarIcon } from '@/components/ui/google-calendar-icon';
import { OutlookIcon } from '@/components/ui/outlook-icon';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { isMac, shortcut } from '@/lib/utils';
import { useTheme } from '@/hooks/useTheme';
import {
  useAutoDetectMeetingsSetting,
  useAutoInstallWhenIdleSetting,
  useDockIconSetting,
  useLaunchOnLoginSetting,
  useMicrophoneSetting,
  useNotificationsSetting,
  usePremeetingNotificationsSetting,
  useRecordHotkeySetting,
  useSetAutoDetectMeetings,
  useSetAutoInstallWhenIdle,
  useSetDockIcon,
  useSetLaunchOnLogin,
  useSetMicrophone,
  useSetNotifications,
  useSetRecordHotkey,
  useSetPremeetingNotifications,
  useSetShowMenuBarIcon,
  useSetSilenceAutoStopEnabled,
  useSetSilenceAutoStopMinutes,
  useSetSystemAudio,
  useSetUserName,
  useShowMenuBarIconSetting,
  useSilenceAutoStopSetting,
  useSystemAudioSetting,
  useSystemAudioSupport,
  useUserName,
} from '@/hooks/useSettings';
import { useAudioInputDevices } from '@/hooks/useAudioInputDevices';
import {
  useGoogleCalendarAuth,
  useOutlookCalendarAuth,
} from '@/hooks/useCalendarEvents';
import { COMPACT_BTN, COMPACT_TRIGGER, SectionHeading, SettingRow } from './primitives';
import { useI18n, SUPPORTED_LOCALES, type Locale, t } from '@/i18n';

const DEFAULT_MIC_VALUE = 'default';

export function GeneralTab() {
  const { locale, setLocale } = useI18n();
  const { theme, setTheme } = useTheme();
  const notifications = useNotificationsSetting();
  const setNotifications = useSetNotifications();
  const premeetingNotifications = usePremeetingNotificationsSetting();
  const setPremeetingNotifications = useSetPremeetingNotifications();
  const systemAudio = useSystemAudioSetting();
  const setSystemAudio = useSetSystemAudio();
  const systemAudioSupport = useSystemAudioSupport();
  const systemAudioDescription = (() => {
    if (systemAudioSupport.data && !systemAudioSupport.data.supported) {
      return `Capture both sides of a call (requires macOS 14.4+, you're on ${systemAudioSupport.data.osVersion || 'an older version'}). Mic-only recording still works.`;
    }
    return 'Capture both sides of a call. Turn off to record your mic only.';
  })();
  const autoDetect = useAutoDetectMeetingsSetting();
  const setAutoDetect = useSetAutoDetectMeetings();
  // Auto-detect is a macOS-14+ feature (the mic-monitor binary is macOS-only and
  // only has a reliable per-app signal on 14+ — see #116). Mirror main's
  // isAutoDetectSupported() exactly so the toggle isn't a no-op-but-enabled
  // control: non-darwin is unsupported (main never spawns the watcher there), and
  // darwin < 14 is unsupported. While the probe is loading (data undefined) we
  // don't disable (matching the other rows); a darwin osVersion that won't parse
  // stays permissive (a real 14+ user must never lose the feature over a hiccup).
  const autoDetectSupported = (() => {
    const data = systemAudioSupport.data;
    if (!data) return true; // probe still loading — don't disable prematurely
    if (data.platform !== 'darwin') return false; // macOS-only feature
    const major = parseInt(String(data.osVersion).split('.')[0], 10);
    if (!Number.isFinite(major)) return true; // permissive on parse failure
    return major >= 14;
  })();
  const launchOnLogin = useLaunchOnLoginSetting();
  const setLaunchOnLogin = useSetLaunchOnLogin();
  const autoInstallWhenIdle = useAutoInstallWhenIdleSetting();
  const setAutoInstallWhenIdle = useSetAutoInstallWhenIdle();
  const recordHotkey = useRecordHotkeySetting();
  const setRecordHotkey = useSetRecordHotkey();
  const recordAccel = shortcut('⌘⇧R', 'Ctrl+Shift+R');
  const silenceAutoStop = useSilenceAutoStopSetting();
  const setSilenceAutoStopEnabled = useSetSilenceAutoStopEnabled();
  const setSilenceAutoStopMinutes = useSetSilenceAutoStopMinutes();
  const dockIcon = useDockIconSetting();
  const setDockIcon = useSetDockIcon();
  const menuBarIcon = useShowMenuBarIconSetting();
  const setMenuBarIcon = useSetShowMenuBarIcon();
  const microphone = useMicrophoneSetting();
  const setMicrophone = useSetMicrophone();
  const audioInputDevices = useAudioInputDevices();
  const google = useGoogleCalendarAuth();
  const outlook = useOutlookCalendarAuth();
  const userName = useUserName();
  const setUserName = useSetUserName();
  const [nameDraft, setNameDraft] = React.useState('');
  const nameSeededRef = React.useRef(false);
  // Tracks in-flight typing so a late initial fetch can't clobber the user's
  // draft. Set on the first edit, and released again by persistName on blur —
  // the danger window is only mount → first commit, so once the edit is
  // committed the seeding effect is free to re-sync from userName.data.
  const nameDirtyRef = React.useRef(false);
  // Wait for the real query (not the sessionStorage placeholder) before
  // seeding — otherwise we lock onto a stale empty string and ignore the
  // canonical value when it arrives from disk.
  React.useEffect(() => {
    if (nameSeededRef.current) return;
    if (nameDirtyRef.current) return;
    if (userName.isPending || userName.isPlaceholderData) return;
    if (userName.data !== undefined) {
      setNameDraft(userName.data);
      nameSeededRef.current = true;
    }
  }, [userName.data, userName.isPending, userName.isPlaceholderData]);
  const persistName = () => {
    const trimmed = nameDraft.trim();
    if (trimmed !== (userName.data ?? '')) {
      setUserName.mutate(trimmed);
    }
    // The editing session is over (committed on blur/Enter), so there's no more
    // in-flight typing to protect. Release the dirty guard so the seeding effect
    // can re-sync from any later userName.data change — the backend's canonical
    // value, or a refetch after the mutation invalidates. Otherwise a no-op
    // commit (draft equal to the not-yet-resolved placeholder) would leave the
    // guard stuck and the field stranded on a stale/blank draft.
    nameDirtyRef.current = false;
  };

  const calendarConnected =
    google.status.data?.connected || outlook.status.data?.connected;
  const calendarProvider = google.status.data?.connected
    ? 'Google'
    : outlook.status.data?.connected
      ? 'Outlook'
      : null;
  // Only populated for connections made after the email-capture change —
  // pre-existing connections fall back to the provider name below.
  const calendarEmail = google.status.data?.connected
    ? google.status.data.email
    : outlook.status.data?.connected
      ? outlook.status.data.email
      : null;

  const [oauth, setOauth] = React.useState<
    | {
        provider: 'google' | 'outlook';
        state: 'pending' | 'error';
        message?: string;
      }
    | null
  >(null);

  React.useEffect(() => {
    if (!oauth) return;
    if (oauth.provider === 'google' && google.status.data?.connected) {
      setOauth(null);
    }
    if (oauth.provider === 'outlook' && outlook.status.data?.connected) {
      setOauth(null);
    }
  }, [oauth, google.status.data?.connected, outlook.status.data?.connected]);

  // Synchronous in-flight lock. react-query's isPending only flips true on the
  // NEXT render, so two clicks handled in the same tick both read a stale
  // false and slip past an isPending-based guard; a ref set before the first
  // mutate closes that exact window. The token distinguishes attempts so a
  // superseded attempt's settle (a cancel or a newer startConnect took over)
  // can't release a still-active attempt's lock.
  const connectingRef = React.useRef(false);
  const connectTokenRef = React.useRef(0);

  const startConnect = async (provider: 'google' | 'outlook') => {
    if (connectingRef.current) return;
    connectingRef.current = true;
    const token = ++connectTokenRef.current;
    setOauth({ provider, state: 'pending' });
    try {
      if (provider === 'google') await google.connect.mutateAsync();
      else await outlook.connect.mutateAsync();
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      // A user-initiated Cancel rejects the connect mutation with "Cancelled"
      // (see useGoogleCalendarAuth/useOutlookCalendarAuth) — not an error to
      // surface back to the user.
      if (message === 'Cancelled') return;
      // Only surface the error if THIS attempt is still the active one. The
      // token check catches a cancel-then-immediate-retry of the same provider,
      // where a newer attempt is also `pending`/same-provider — provider+state
      // alone can't tell the stale rejection apart from the fresh dialog. It
      // also covers a dismissed dialog or a switch to a different provider.
      setOauth((current) =>
        connectTokenRef.current === token &&
        current?.provider === provider &&
        current.state === 'pending'
          ? { provider, state: 'error', message }
          : current,
      );
    } finally {
      // Release only if this is still the active attempt — a cancel or a newer
      // startConnect may have superseded it and now owns the lock.
      if (connectTokenRef.current === token) connectingRef.current = false;
    }
  };

  const cancelConnect = () => {
    // Abort the in-flight handshake so we don't leak a loopback OAuth server
    // that could silently complete the connection (and save tokens) after the
    // user has already backed out of the dialog.
    if (oauth?.state === 'pending') {
      if (oauth.provider === 'google') google.cancel.mutate();
      else outlook.cancel.mutate();
    }
    // Release the lock immediately so the user can retry or switch providers
    // without waiting for the abandoned mutation to reject.
    connectingRef.current = false;
    setOauth(null);
  };

  // Both the menu bar icon and the dock icon are ways back into a hidden
  // window (see Sidebar's requestSingleInstanceLock recovery via
  // Applications/Spotlight relaunch) — hiding both isn't blocked, just
  // called out, since it's easy to miss that the recovery path still works.
  const bothIconsHidden = (dockIcon.data ?? false) && !(menuBarIcon.data ?? true);

  return (
    <section data-settings-tab="general">
      <SectionHeading>{t('settings.general.sectionLanguage')}</SectionHeading>
      <SettingRow
        label={t('settings.general.uiLanguage')}
        description={t('settings.general.uiLanguageDesc')}
      >
        <Select
          value={locale}
          onValueChange={(v) => setLocale(v as Locale)}
        >
          <SelectTrigger
            className={COMPACT_TRIGGER}
            data-testid="ui-language-select"
          >
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {SUPPORTED_LOCALES.map((l) => (
              <SelectItem key={l.code} value={l.code}>
                {l.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </SettingRow>

      <SectionHeading>{t('settings.general.sectionPreferences')}</SectionHeading>
      <SettingRow
        label={t('settings.general.userName')}
        description={t('settings.general.userNameDesc')}
      >
        <Input
          value={nameDraft}
          onChange={(e) => {
            nameDirtyRef.current = true;
            setNameDraft(e.target.value);
          }}
          onBlur={persistName}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault();
              // Just blur — onBlur runs persistName, so calling it directly
              // here would queue a duplicate setUserName mutation.
              (e.target as HTMLInputElement).blur();
            }
          }}
          placeholder={t('settings.general.userName')}
          autoComplete="given-name"
          className="h-[30px] w-[180px] rounded-[6px] bg-[color:var(--surface-raised)] text-[13px]"
          data-testid="user-name-input"
        />
      </SettingRow>

      <SettingRow
        label={t('settings.general.theme')}
        description={t('settings.general.themeDesc')}
        noBorder
      >
        <Select
          value={theme}
          onValueChange={(v) => setTheme(v as 'light' | 'dark' | 'system')}
        >
          <SelectTrigger
            className={COMPACT_TRIGGER}
            data-testid="theme-select"
          >
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="system">{t('settings.general.themeSystem')}</SelectItem>
            <SelectItem value="light">{t('settings.general.themeLight')}</SelectItem>
            <SelectItem value="dark">{t('settings.general.themeDark')}</SelectItem>
          </SelectContent>
        </Select>
      </SettingRow>

      <SectionHeading>Calendar</SectionHeading>

      <SettingRow
        label="Connect calendar"
        description={
          calendarConnected
            ? `Connected to ${calendarEmail || calendarProvider}`
            : 'Show upcoming meetings on the home screen'
        }
        noBorder
      >
        {calendarConnected ? (
          <Button
            variant="outline"
            size="sm"
            className={COMPACT_BTN}
            onClick={() => {
              if (google.status.data?.connected) google.disconnect.mutate();
              else outlook.disconnect.mutate();
            }}
          >
            {google.status.data?.connected ? (
              <GoogleCalendarIcon size={13} />
            ) : (
              <OutlookIcon size={13} />
            )}
            Disconnect
          </Button>
        ) : (
          <div className="flex gap-2">
            <Button
              variant="outline"
              size="sm"
              className={COMPACT_BTN}
              onClick={() => void startConnect('google')}
            >
              <GoogleCalendarIcon size={13} />
              Google
            </Button>
            <Button
              variant="outline"
              size="sm"
              className={COMPACT_BTN}
              onClick={() => void startConnect('outlook')}
            >
              <OutlookIcon size={13} />
              Outlook
            </Button>
          </div>
        )}
      </SettingRow>

      <OAuthPrompt
        state={oauth}
        onClose={cancelConnect}
        onRetry={() => oauth && void startConnect(oauth.provider)}
      />

      <SectionHeading>Meeting notifications</SectionHeading>

      <SettingRow
        label={t('settings.general.premeetingNotifications')}
        description={t('settings.general.premeetingNotificationsDesc')}
      >
        <Switch
          checked={premeetingNotifications.data ?? true}
          onCheckedChange={(v) => setPremeetingNotifications.mutate(v)}
          disabled={premeetingNotifications.data === undefined}
        />
      </SettingRow>

      <SettingRow
        label={t('settings.general.autoDetectMeetings')}
        description={
          autoDetectSupported
            ? 'Watch for other apps using your microphone and notify you when a call starts, with a one-click button to record.'
            : `Watch for other apps using your microphone and notify you when a call starts. Requires macOS 14 (Sonoma) or later${
                systemAudioSupport.data?.osVersion ? `, you're on ${systemAudioSupport.data.osVersion}` : ''
              }.`
        }
      >
        <Switch
          checked={autoDetectSupported && (autoDetect.data ?? true)}
          onCheckedChange={(v) => setAutoDetect.mutate(v)}
          disabled={autoDetect.data === undefined || !autoDetectSupported}
        />
      </SettingRow>

      <SettingRow
        label={t('settings.general.postMeetingNotifications')}
        description={t('settings.general.postMeetingNotificationsDesc')}
        noBorder
      >
        <Switch
          checked={notifications.data ?? false}
          onCheckedChange={(v) => setNotifications.mutate(v)}
          disabled={notifications.data === undefined}
        />
      </SettingRow>

      <SectionHeading>Recording</SectionHeading>

      <SettingRow
        label={t('settings.general.microphoneDevice')}
        description={t('settings.general.microphoneDeviceDesc')}
      >
        <Select
          value={microphone.data?.device_id ?? DEFAULT_MIC_VALUE}
          onValueChange={(deviceId) => {
            if (deviceId === DEFAULT_MIC_VALUE) {
              setMicrophone.mutate({ deviceId: DEFAULT_MIC_VALUE, label: '' });
              return;
            }
            const device = audioInputDevices.find((d) => d.deviceId === deviceId);
            // Re-selecting the already-pinned-but-disconnected device (the
            // synthetic SelectItem below) won't be found in audioInputDevices
            // — fall back to its already-known stored label instead of
            // overwriting it with an empty string.
            const label =
              device?.label ??
              (deviceId === microphone.data?.device_id ? microphone.data?.label ?? '' : '');
            setMicrophone.mutate({ deviceId, label });
          }}
          disabled={microphone.data === undefined}
        >
          <SelectTrigger className="h-8 w-56 text-sm" data-testid="microphone-select">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={DEFAULT_MIC_VALUE}>{t('common.systemDefault')}</SelectItem>
            {audioInputDevices.map((d, i) => (
              <SelectItem key={d.deviceId} value={d.deviceId}>
                {d.label || `Microphone ${i + 1}`}
              </SelectItem>
            ))}
            {/* The selected device was unplugged / isn't in the current device
                list — keep it selectable so the dropdown doesn't silently jump
                back to "System Default" out from under the user. */}
            {microphone.data?.device_id &&
              !audioInputDevices.some((d) => d.deviceId === microphone.data?.device_id) && (
                <SelectItem value={microphone.data.device_id}>
                  {microphone.data.label || 'Unknown device (disconnected)'}
                </SelectItem>
              )}
          </SelectContent>
        </Select>
      </SettingRow>

      {/* macOS only: chooses mic-only vs mic+system. Windows always records
          mic+system (toggle hidden), so this control isn't shown there. */}
      {isMac && (
        <SettingRow label={t('settings.general.systemAudio')} description={systemAudioDescription}>
          <Switch
            checked={(systemAudio.data ?? true) && (systemAudioSupport.data?.supported ?? true)}
            onCheckedChange={(v) => setSystemAudio.mutate(v)}
            disabled={systemAudio.data === undefined || systemAudioSupport.data?.supported === false}
          />
        </SettingRow>
      )}

      <SettingRow
        label={t('settings.general.silenceAutoStop')}
        description={t('settings.general.silenceAutoStopDesc')}
        noBorder
      >
        <div className="flex items-center gap-3">
          <Select
            value={String(silenceAutoStop.data?.minutes ?? 2)}
            onValueChange={(v) => setSilenceAutoStopMinutes.mutate(Number(v))}
            disabled={
              silenceAutoStop.data === undefined || silenceAutoStop.data.enabled === false
            }
          >
            <SelectTrigger className="h-8 w-28 text-sm">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {(silenceAutoStop.data?.supportedMinutes ?? [2, 5, 10, 15, 30]).map((m) => (
                <SelectItem key={m} value={String(m)}>
                  {m} minutes
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Switch
            checked={silenceAutoStop.data?.enabled ?? true}
            onCheckedChange={(v) => setSilenceAutoStopEnabled.mutate(v)}
            disabled={silenceAutoStop.data === undefined}
          />
        </div>
      </SettingRow>

      <SectionHeading>System</SectionHeading>

      <SettingRow
        label={t('settings.general.launchOnLogin')}
        description={t('settings.general.launchOnLoginDesc')}
      >
        <Switch
          checked={launchOnLogin.data ?? true}
          onCheckedChange={(v) => setLaunchOnLogin.mutate(v)}
          disabled={launchOnLogin.data === undefined}
        />
      </SettingRow>

      <SettingRow
        label="Install updates automatically"
        description="When the app is idle and not recording, download and install updates in the background, then restart. You'll still be notified when an update is available."
      >
        <Switch
          checked={autoInstallWhenIdle.data ?? true}
          onCheckedChange={(v) => setAutoInstallWhenIdle.mutate(v)}
          disabled={autoInstallWhenIdle.data === undefined}
        />
      </SettingRow>

      <SettingRow
        label={isMac ? t('settings.general.menuBarIcon') : t('settings.general.menuBarIconWin')}
        description={
          bothIconsHidden
            ? 'Both your dock icon and menu bar icon will be hidden. Reopen Steno from Applications or Spotlight to bring the window back.'
            : isMac
              ? 'Show a Steno icon in the menu bar for quick access.'
              : 'Show a Steno icon in the system tray for quick access.'
        }
      >
        <Switch
          checked={menuBarIcon.data ?? true}
          onCheckedChange={(v) => setMenuBarIcon.mutate(v)}
          disabled={menuBarIcon.data === undefined}
        />
      </SettingRow>

      {/* The dock is a macOS-only concept and the apply logic in main.js is
          darwin-gated, so this toggle is a no-op off-mac. Hide it entirely on
          Windows/Linux rather than show a broken control. (Unlike the tray
          row above, which is cross-platform — Electron's Tray API covers the
          macOS menu bar and the Windows system tray alike.) */}
      {isMac && (
        <SettingRow
          label={t('settings.general.dockIcon')}
          description={
            bothIconsHidden
              ? 'Both your dock icon and menu bar icon will be hidden. Reopen Steno from Applications or Spotlight to bring the window back.'
              : 'Run as menu bar app only'
          }
          noBorder
        >
          <Switch
            checked={dockIcon.data ?? false}
            onCheckedChange={(v) => setDockIcon.mutate(v)}
            disabled={dockIcon.data === undefined}
          />
        </SettingRow>
      )}

      <SectionHeading>Keyboard shortcut</SectionHeading>

      <SettingRow
        label={t('settings.general.recordHotkey')}
        description={
          <>
            Start or stop recording from anywhere with {recordAccel}. Turn off if it
            conflicts with another app.
            {recordHotkey.data?.enabled === true &&
              recordHotkey.data.registered === false && (
                <span className="mt-1 block" style={{ color: 'var(--fg-2)' }}>
                  Couldn't register — another app may be using this shortcut.
                </span>
              )}
          </>
        }
        noBorder
      >
        <Switch
          checked={recordHotkey.data?.enabled ?? true}
          onCheckedChange={(v) => setRecordHotkey.mutate(v)}
          disabled={recordHotkey.data === undefined}
        />
      </SettingRow>
    </section>
  );
}

interface OAuthPromptProps {
  state:
    | {
        provider: 'google' | 'outlook';
        state: 'pending' | 'error';
        message?: string;
      }
    | null;
  onClose: () => void;
  onRetry: () => void;
}

function OAuthPrompt({ state, onClose, onRetry }: OAuthPromptProps) {
  const open = !!state;
  const providerName = state?.provider === 'outlook' ? 'Outlook' : 'Google';
  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-md" data-oauth-prompt>
        <DialogHeader>
          <DialogTitle>
            {state?.state === 'error'
              ? `Couldn't connect to ${providerName}`
              : `Connecting to ${providerName}`}
          </DialogTitle>
          <DialogDescription>
            {state?.state === 'error'
              ? state.message || 'The authorization flow did not complete.'
              : 'Complete the authorization in your browser. This dialog will close automatically once access is granted.'}
          </DialogDescription>
        </DialogHeader>

        {state?.state === 'pending' && (
          <div className="flex items-center gap-3 rounded-md border border-border bg-paper-0 p-3 text-sm text-muted-foreground dark:bg-paper-1">
            <Loader2 className="size-4 animate-spin text-foreground" />
            <span className="flex-1">Waiting for authorization…</span>
            <ExternalLink className="size-3.5" />
          </div>
        )}

        <DialogFooter>
          {state?.state === 'error' ? (
            <>
              <Button variant="outline" onClick={onClose}>
                Close
              </Button>
              <Button onClick={onRetry}>Try again</Button>
            </>
          ) : (
            <Button variant="outline" onClick={onClose}>
              Cancel
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
