import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ipc, type TelemetryToggleSource } from '@/lib/ipc';
import { unwrap } from '@/lib/result';

export const settingsKeys = {
  all: ['settings'] as const,
  notifications: () => [...settingsKeys.all, 'notifications'] as const,
  recordHotkey: () => [...settingsKeys.all, 'recordHotkey'] as const,
  telemetry: () => [...settingsKeys.all, 'telemetry'] as const,
  privacyNoticeSeen: () => [...settingsKeys.all, 'privacyNoticeSeen'] as const,
  dockIcon: () => [...settingsKeys.all, 'dockIcon'] as const,
  menuBarIcon: () => [...settingsKeys.all, 'menuBarIcon'] as const,
  systemAudio: () => [...settingsKeys.all, 'systemAudio'] as const,
  systemAudioSupport: () => [...settingsKeys.all, 'systemAudioSupport'] as const,
  autoDetectMeetings: () => [...settingsKeys.all, 'autoDetectMeetings'] as const,
  premeetingNotifications: () => [...settingsKeys.all, 'premeetingNotifications'] as const,
  launchOnLogin: () => [...settingsKeys.all, 'launchOnLogin'] as const,
  silenceAutoStop: () => [...settingsKeys.all, 'silenceAutoStop'] as const,
  language: () => [...settingsKeys.all, 'language'] as const,
  microphone: () => [...settingsKeys.all, 'microphone'] as const,
  storagePath: () => [...settingsKeys.all, 'storagePath'] as const,
  appVersion: () => [...settingsKeys.all, 'appVersion'] as const,
  userName: () => [...settingsKeys.all, 'userName'] as const,
  // Previously spelled inline at both the query and the mutation. The optimistic
  // write below only works if the two use the identical key, so they get a
  // factory like every other setting rather than two hand-written arrays.
  keepRecordings: () => [...settingsKeys.all, 'keepRecordings'] as const,
  autoSummarize: () => [...settingsKeys.all, 'autoSummarize'] as const,
  identityMatching: () => [...settingsKeys.all, 'identityMatchingEnabled'] as const,
  obsidianSync: () => [...settingsKeys.all, 'obsidianSync'] as const,
  obsidianVaultPath: () => [...settingsKeys.all, 'obsidianVaultPath'] as const,
  obsidianConflicts: () => [...settingsKeys.all, 'obsidianConflicts'] as const,
};

/**
 * Shared write path for a settings toggle whose query caches a plain boolean.
 *
 * Every `set-*` IPC spawns a backend process (settings-ipc.js -> runPythonScript,
 * ~315 ms on a packaged build). The old shape here was `onSuccess: invalidate`,
 * which spawned a SECOND process to read back the value we had just written —
 * and, because the Switch renders from the query, the toggle only moved once
 * that round trip finished. Two processes, ~630 ms of visible lag per click.
 *
 * So: flip the cache in `onMutate` (the switch responds immediately), let the
 * write run in the background, and roll back if it rejects. No read-back — a
 * resolved write means the value on disk IS the value we sent, so re-reading it
 * only costs a process. The queries still refetch from disk on their own terms;
 * this only removes the redundant one bolted to each write.
 */
function useToggleSetting(queryKey: readonly unknown[], write: (v: boolean) => Promise<unknown>) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: write,
    onMutate: async (v: boolean) => {
      // Cancel in-flight reads first: a refetch that started before the write
      // would otherwise land afterwards and reinstate the pre-toggle value.
      await qc.cancelQueries({ queryKey });
      const previous = qc.getQueryData<boolean>(queryKey);
      qc.setQueryData<boolean>(queryKey, v);
      return { previous };
    },
    // The write failed, so disk still holds the old value — put it back rather
    // than leaving the switch showing a state that was never persisted.
    onError: (_err, _v, ctx) => {
      qc.setQueryData(queryKey, ctx?.previous);
    },
  });
}

export function useNotificationsSetting() {
  return useQuery({
    queryKey: settingsKeys.notifications(),
    queryFn: async () => unwrap(await ipc().settings.getNotifications()).notifications_enabled,
  });
}

export function useSetNotifications() {
  return useToggleSetting(settingsKeys.notifications(), async (v) =>
    unwrap(await ipc().settings.setNotifications(v)),
  );
}

/** The global record shortcut toggle. Returns both the persisted `enabled`
 *  preference and the live `registered` state so the Settings row can warn
 *  when the shortcut is on but another app already owns the accelerator. */
export function useRecordHotkeySetting() {
  return useQuery({
    queryKey: settingsKeys.recordHotkey(),
    queryFn: async () => {
      const res = unwrap(await ipc().settings.getRecordHotkey());
      return { enabled: res.enabled, registered: res.registered };
    },
  });
}

export function useSetRecordHotkey() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (v: boolean) => unwrap(await ipc().settings.setRecordHotkey(v)),
    onSuccess: () => qc.invalidateQueries({ queryKey: settingsKeys.recordHotkey() }),
  });
}

export function useTelemetrySetting() {
  return useQuery({
    queryKey: settingsKeys.telemetry(),
    queryFn: async () => unwrap(await ipc().settings.getTelemetry()),
  });
}

/** Same optimistic write as `useToggleSetting`, but this query caches an object
 *  ({ telemetry_enabled, anonymous_id }) — so patch the one field instead of
 *  replacing the entry, which would drop `anonymous_id`. */
export function useSetTelemetry() {
  const qc = useQueryClient();
  const key = settingsKeys.telemetry();
  type Telemetry = { telemetry_enabled: boolean; anonymous_id?: string };
  return useMutation({
    mutationFn: async ({ enabled, source }: { enabled: boolean; source: TelemetryToggleSource }) =>
      unwrap(await ipc().settings.setTelemetry(enabled, source)),
    onMutate: async ({ enabled }) => {
      await qc.cancelQueries({ queryKey: key });
      const previous = qc.getQueryData<Telemetry>(key);
      if (previous) qc.setQueryData<Telemetry>(key, { ...previous, telemetry_enabled: enabled });
      return { previous };
    },
    onError: (_err, _vars, ctx) => {
      if (ctx?.previous) qc.setQueryData<Telemetry>(key, ctx.previous);
    },
  });
}

/** One-time privacy disclosure gate. `privacy_notice_seen` is false only for
 *  existing installs whose config predates the marker (see
 *  Config._migrate_privacy_notice_seen); fresh installs are disclosed during
 *  onboarding and start true. The consent modal reads this and, on
 *  acknowledgement, marks it seen forever and invalidates this query so it
 *  won't re-open. */
export function usePrivacyNoticeSeen() {
  return useQuery({
    queryKey: settingsKeys.privacyNoticeSeen(),
    queryFn: async () => unwrap(await ipc().privacy.getNoticeSeen()).privacy_notice_seen,
  });
}

/** Persist the one-time privacy notice as seen and flip the gate query so the
 *  disclosure can't reappear. Shared by the consent modal and onboarding so the
 *  cache key + invalidation never drift as the gate evolves. The gate is set
 *  synchronously on success (don't depend on the refetch, which could fail and
 *  leave the modal stuck open); the invalidate reconciles against disk in the
 *  background. Rejects if the backend write failed — callers own their own
 *  control flow (re-arm, navigate) around it. */
export function useMarkPrivacyNoticeSeen() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async () => {
      const res = await ipc().privacy.markNoticeSeen();
      if (!res?.success) throw new Error(res?.error || 'markNoticeSeen failed');
      return res;
    },
    onSuccess: () => {
      qc.setQueryData(settingsKeys.privacyNoticeSeen(), true);
      qc.invalidateQueries({ queryKey: settingsKeys.privacyNoticeSeen() });
    },
  });
}

export function useDockIconSetting() {
  return useQuery({
    queryKey: settingsKeys.dockIcon(),
    queryFn: async () => unwrap(await ipc().settings.getDockIcon()).hide_dock_icon,
  });
}

export function useSetDockIcon() {
  return useToggleSetting(settingsKeys.dockIcon(), async (v) =>
    unwrap(await ipc().settings.setDockIcon(v)),
  );
}

export function useShowMenuBarIconSetting() {
  return useQuery({
    queryKey: settingsKeys.menuBarIcon(),
    queryFn: async () => unwrap(await ipc().settings.getMenuBarIcon()).show_menu_bar_icon,
  });
}

export function useSetShowMenuBarIcon() {
  return useToggleSetting(settingsKeys.menuBarIcon(), async (v) =>
    unwrap(await ipc().settings.setMenuBarIcon(v)),
  );
}

export function useSystemAudioSetting() {
  return useQuery({
    queryKey: settingsKeys.systemAudio(),
    queryFn: async () => unwrap(await ipc().settings.getSystemAudio()).system_audio_enabled,
  });
}

export function useSetSystemAudio() {
  return useToggleSetting(settingsKeys.systemAudio(), async (v) =>
    unwrap(await ipc().settings.setSystemAudio(v)),
  );
}

export function useSystemAudioSupport() {
  return useQuery({
    queryKey: settingsKeys.systemAudioSupport(),
    queryFn: async () => unwrap(await ipc().recording.getSystemAudioSupport()),
    staleTime: Infinity,
  });
}

export function useAutoDetectMeetingsSetting() {
  return useQuery({
    queryKey: settingsKeys.autoDetectMeetings(),
    queryFn: async () => unwrap(await ipc().settings.getAutoDetectMeetings()).auto_detect_meetings_enabled,
  });
}

export function useSetAutoDetectMeetings() {
  return useToggleSetting(settingsKeys.autoDetectMeetings(), async (v) =>
    unwrap(await ipc().settings.setAutoDetectMeetings(v)),
  );
}

export function usePremeetingNotificationsSetting() {
  return useQuery({
    queryKey: settingsKeys.premeetingNotifications(),
    queryFn: async () =>
      unwrap(await ipc().settings.getPremeetingNotifications()).premeeting_notifications_enabled,
  });
}

export function useSetPremeetingNotifications() {
  return useToggleSetting(settingsKeys.premeetingNotifications(), async (v) =>
    unwrap(await ipc().settings.setPremeetingNotifications(v)),
  );
}

export function useLaunchOnLoginSetting() {
  return useQuery({
    queryKey: settingsKeys.launchOnLogin(),
    queryFn: async () => unwrap(await ipc().settings.getLaunchOnLogin()).launch_on_login,
  });
}

export function useSetLaunchOnLogin() {
  return useToggleSetting(settingsKeys.launchOnLogin(), async (v) =>
    unwrap(await ipc().settings.setLaunchOnLogin(v)),
  );
}

export function useLanguageSetting() {
  return useQuery({
    queryKey: settingsKeys.language(),
    queryFn: async () => unwrap(await ipc().settings.getLanguage()).language,
  });
}

export function useSetLanguage() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (code: string) => unwrap(await ipc().settings.setLanguage(code)),
    onSuccess: () => qc.invalidateQueries({ queryKey: settingsKeys.language() }),
  });
}

export function useMicrophoneSetting() {
  return useQuery({
    queryKey: settingsKeys.microphone(),
    queryFn: async () => unwrap(await ipc().settings.getMicrophone()),
  });
}

export function useSetMicrophone() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({ deviceId, label }: { deviceId: string; label: string }) =>
      unwrap(await ipc().settings.setMicrophone(deviceId, label)),
    // Write the mutation's own result straight into the cache instead of
    // invalidating: a bare invalidate leaves a window where a recording
    // started immediately after switching mics (via ensureQueryData in
    // useSystemAudioCapture.ts) could still read the pre-switch cached
    // value before the refetch lands.
    onSuccess: (result) => qc.setQueryData(settingsKeys.microphone(), result),
  });
}

export function useStoragePath() {
  return useQuery({
    queryKey: settingsKeys.storagePath(),
    queryFn: async () => unwrap(await ipc().settings.getStoragePath()),
  });
}

export function useSetStoragePath() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (path: string) => unwrap(await ipc().settings.setStoragePath(path)),
    onSuccess: () => qc.invalidateQueries({ queryKey: settingsKeys.storagePath() }),
  });
}

export function usePickStorageFolder() {
  return useMutation({
    mutationFn: async () => unwrap(await ipc().settings.pickStorageFolder()).folderPath,
  });
}

export function useAppVersion() {
  return useQuery({
    queryKey: settingsKeys.appVersion(),
    queryFn: async () => unwrap(await ipc().app.getVersion()),
    staleTime: Infinity,
  });
}

export function useClearSystemState() {
  return useMutation({
    mutationFn: async () => unwrap(await ipc().system.clearState()),
  });
}

// Mirror the persisted user name into sessionStorage so the next mount in
// the same session has the value synchronously and the chat greeting
// doesn't flash 'Ask anything' before flipping to 'Hi <name>, ...'.
const USER_NAME_CACHE_KEY = 'steno-user-name';

function readCachedUserName(): string {
  try {
    return sessionStorage.getItem(USER_NAME_CACHE_KEY) ?? '';
  } catch {
    return '';
  }
}

function writeCachedUserName(name: string) {
  try {
    sessionStorage.setItem(USER_NAME_CACHE_KEY, name);
  } catch {
    // Storage may be unavailable in private mode — graceful degradation.
  }
}

export function useUserName() {
  return useQuery({
    queryKey: settingsKeys.userName(),
    queryFn: async () => {
      const name = unwrap(await ipc().settings.getUserName()).user_name;
      writeCachedUserName(name);
      return name;
    },
    // The name only changes via useSetUserName (which invalidates this
    // key), so once we have it there's no reason to refetch on remount.
    staleTime: Infinity,
    // placeholderData (NOT initialData) so the query still fetches the
    // canonical value from disk on first mount. initialData was marking
    // the query as already-fresh — combined with staleTime: Infinity that
    // suppressed the queryFn entirely, so the greeting was stuck on the
    // empty sessionStorage default forever.
    placeholderData: readCachedUserName(),
  });
}

export function useSetUserName() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (name: string) =>
      unwrap(await ipc().settings.setUserName(name)),
    onSuccess: (_data, name) => {
      writeCachedUserName(name.trim());
      qc.invalidateQueries({ queryKey: settingsKeys.userName() });
    },
  });
}

export function useKeepRecordingsSetting() {
  return useQuery({
    queryKey: settingsKeys.keepRecordings(),
    queryFn: async () => unwrap(await ipc().settings.getKeepRecordings()).keep_recordings,
  });
}

export function useSetKeepRecordings() {
  return useToggleSetting(settingsKeys.keepRecordings(), async (v) =>
    unwrap(await ipc().settings.setKeepRecordings(v)),
  );
}

export function useAutoInstallWhenIdleSetting() {
  return useQuery({
    queryKey: [...settingsKeys.all, 'autoInstallWhenIdle'] as const,
    queryFn: async () =>
      unwrap(await ipc().settings.getAutoInstallWhenIdle()).auto_install_when_idle,
  });
}

export function useSetAutoInstallWhenIdle() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (v: boolean) => unwrap(await ipc().settings.setAutoInstallWhenIdle(v)),
    onSuccess: () =>
      qc.invalidateQueries({ queryKey: [...settingsKeys.all, 'autoInstallWhenIdle'] }),
  });
}

export function useIdentityMatchingEnabledSetting() {
  return useQuery({
    queryKey: settingsKeys.identityMatching(),
    queryFn: async () =>
      unwrap(await ipc().settings.getIdentityMatchingEnabled()).identity_matching_enabled,
  });
}

export function useSetIdentityMatchingEnabled() {
  return useToggleSetting(settingsKeys.identityMatching(), async (v) =>
    unwrap(await ipc().settings.setIdentityMatchingEnabled(v)),
  );
}

export function useAutoSummarizeSetting() {
  return useQuery({
    queryKey: settingsKeys.autoSummarize(),
    queryFn: async () => unwrap(await ipc().settings.getAutoSummarize()).auto_summarize_enabled,
  });
}

export function useSetAutoSummarize() {
  return useToggleSetting(settingsKeys.autoSummarize(), async (v) =>
    unwrap(await ipc().settings.setAutoSummarize(v)),
  );
}

/** Obsidian vault sync (#413): a toggle, a vault-folder path + picker, and a
 * read of any external-edit conflicts to surface in the Integrations tab. */
export function useObsidianSyncSetting() {
  return useQuery({
    queryKey: settingsKeys.obsidianSync(),
    queryFn: async () => unwrap(await ipc().settings.getObsidianSync()).obsidian_sync_enabled,
  });
}

export function useSetObsidianSync() {
  // Conflicts discovered by the (fire-and-forget) backfill surface via the
  // polling refetch on useObsidianConflicts, so both mutate and mutateAsync
  // stay consistent without a per-call invalidation wrapper.
  return useToggleSetting(settingsKeys.obsidianSync(), async (v) =>
    unwrap(await ipc().settings.setObsidianSync(v)),
  );
}

export function useObsidianVaultPath() {
  return useQuery({
    queryKey: settingsKeys.obsidianVaultPath(),
    queryFn: async () => unwrap(await ipc().settings.getObsidianVaultPath()).obsidian_vault_path,
  });
}

export function useSetObsidianVaultPath() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (path: string) => unwrap(await ipc().settings.setObsidianVaultPath(path)),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: settingsKeys.obsidianVaultPath() });
      qc.invalidateQueries({ queryKey: settingsKeys.obsidianConflicts() });
    },
  });
}

export function usePickObsidianVaultFolder() {
  return useMutation({
    mutationFn: async () => unwrap(await ipc().settings.pickObsidianVaultFolder()).folderPath,
  });
}

export function useObsidianConflicts() {
  return useQuery({
    queryKey: settingsKeys.obsidianConflicts(),
    queryFn: async () => unwrap(await ipc().settings.getObsidianConflicts()).conflicts,
    // The backfill/sync that records conflicts runs async in main (fire-and-
    // forget), so poll while the Integrations tab is mounted to surface a
    // freshly-recorded conflict rather than showing a stale count.
    refetchInterval: 4000,
  });
}

/** Toggle + duration for the renderer-side silence detector. Defaults
 *  to enabled / 15 minutes (matches Granola). Returns the supported
 *  minutes list too so the Settings dropdown is driven by the same
 *  source of truth as the persisted-value validation. */
export function useSilenceAutoStopSetting() {
  return useQuery({
    queryKey: settingsKeys.silenceAutoStop(),
    queryFn: async () => {
      const res = unwrap(await ipc().settings.getSilenceAutoStop());
      return {
        enabled: res.silence_auto_stop_enabled,
        minutes: res.silence_auto_stop_minutes,
        supportedMinutes: res.supported_minutes,
      };
    },
  });
}

/** The silence-auto-stop query caches { enabled, minutes, supportedMinutes };
 *  both setters patch their own field so the other two survive the write.
 *  `supportedMinutes` is backend-owned and never touched here. */
type SilenceAutoStop = { enabled: boolean; minutes: number; supportedMinutes: number[] };

function useSilenceAutoStopField<TValue>(
  field: 'enabled' | 'minutes',
  write: (v: TValue) => Promise<unknown>,
) {
  const qc = useQueryClient();
  const key = settingsKeys.silenceAutoStop();
  return useMutation({
    mutationFn: write,
    onMutate: async (v: TValue) => {
      await qc.cancelQueries({ queryKey: key });
      const previous = qc.getQueryData<SilenceAutoStop>(key);
      if (previous) qc.setQueryData<SilenceAutoStop>(key, { ...previous, [field]: v });
      return { previous };
    },
    onError: (_err, _v, ctx) => {
      if (ctx?.previous) qc.setQueryData<SilenceAutoStop>(key, ctx.previous);
    },
  });
}

export function useSetSilenceAutoStopEnabled() {
  return useSilenceAutoStopField<boolean>('enabled', async (v) =>
    unwrap(await ipc().settings.setSilenceAutoStopEnabled(v)),
  );
}

export function useSetSilenceAutoStopMinutes() {
  return useSilenceAutoStopField<number>('minutes', async (v) =>
    unwrap(await ipc().settings.setSilenceAutoStopMinutes(v)),
  );
}
