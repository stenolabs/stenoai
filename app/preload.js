/**
 * Preload — contextBridge boundary for the React renderer.
 *
 * This is the only surface the renderer gets. Every function here is a thin
 * wrapper over ipcRenderer.invoke / .send / .on. The channel contract across
 * this file, main.js, the renderer's ipc.ts and the e2e mock is enforced by
 * app/ipc-contract.test.js — a rename/removal that drifts them fails there.
 */

const { contextBridge, ipcRenderer, webUtils } = require('electron');

const VERSION = 1;
const rendererPlatformOverride =
  process.env.STENOAI_E2E === '1'
  && ['darwin', 'linux', 'win32'].includes(process.env.STENOAI_E2E_RENDERER_PLATFORM)
    ? process.env.STENOAI_E2E_RENDERER_PLATFORM
    : null;

const invoke = (channel, ...args) => ipcRenderer.invoke(channel, ...args);
const send = (channel, ...args) => ipcRenderer.send(channel, ...args);

// Every M→R event uses the same pattern: subscribe and return an unsubscribe
// fn. The wrapper strips the IpcRendererEvent so the renderer only sees the
// payload — that's an intentional part of the contract (renderer code must
// stay unaware of Electron internals).
const subscribe = (channel, cb) => {
  const handler = (_event, payload) => cb(payload);
  ipcRenderer.on(channel, handler);
  return () => ipcRenderer.removeListener(channel, handler);
};

// Streaming helper. query-chunk + query-done are both multiplexed across
// every in-flight query; the helper filters by queryId so the caller only
// gets events for the stream they asked for. Returns an unsubscribe fn
// that also sends query-cancel to the main process.
const subscribeQueryStream = (queryId, { onChunk, onDone, onError } = {}) => {
  const chunkHandler = (_event, payload) => {
    if (payload && payload.queryId === queryId && onChunk) onChunk(payload.chunk);
  };
  const doneHandler = (_event, payload) => {
    if (!payload || payload.queryId !== queryId) return;
    cleanup();
    if (payload.success) {
      if (onDone) onDone();
    } else {
      if (onError) onError(new Error(payload.error || 'query failed'));
    }
  };
  const cleanup = () => {
    ipcRenderer.removeListener('query-chunk', chunkHandler);
    ipcRenderer.removeListener('query-done', doneHandler);
  };
  ipcRenderer.on('query-chunk', chunkHandler);
  ipcRenderer.on('query-done', doneHandler);
  return () => {
    cleanup();
    ipcRenderer.send('query-cancel', queryId);
  };
};

const stenoai = {
  version: VERSION,

  app: {
    platform: rendererPlatformOverride || process.platform,
    getVersion: () => invoke('get-app-version'),
  },

  window: {
    focus: () => send('focus-window'),
    readyToShow: () => send('renderer-ready-to-show'),
  },

  shell: {
    openExternal: (url) => invoke('open-external', url),
  },

  analytics: {
    // Fire-and-forget: the renderer has no direct access to trackEvent
    // (contextIsolation), so notification/chat events fire through here.
    // Main whitelists event names and sanitizes properties before capture.
    track: (name, props) => send('track', name, props),
  },

  system: {
    getStatus: () => invoke('get-status'),
    test: () => invoke('test-system'),
    clearState: () => invoke('clear-state'),
  },

  setup: {
    check: () => invoke('startup-setup-check'),
    ollamaAndModel: () => invoke('setup-ollama-and-model'),
    parakeet: () => invoke('setup-parakeet'),
    speakerModelsStatus: () => invoke('speaker-model-status'),
    speakerModels: () => invoke('setup-speaker-models'),
    test: () => invoke('setup-test'),
    triggerWizard: () => invoke('trigger-setup-wizard'),
  },

  privacy: {
    getNoticeSeen: () => invoke('get-privacy-notice-seen'),
    markNoticeSeen: () => invoke('set-privacy-notice-seen'),
  },

  perm: {
    checkMicrophone: () => invoke('check-microphone-permission'),
    requestMicrophone: () => invoke('request-microphone-permission'),
  },

  recording: {
    start: (name, trigger, appendTo) =>
      invoke('start-recording-ui', name, trigger, appendTo),
    stop: () => invoke('stop-recording-ui'),
    pause: () => invoke('pause-recording-ui'),
    resume: () => invoke('resume-recording-ui'),
    reportSystemAudioState: (active) => send('system-audio-recording-state', active),
    enableLoopbackAudio: () => invoke('enable-loopback-audio'),
    disableLoopbackAudio: () => invoke('disable-loopback-audio'),
    getSystemAudioSupport: () => invoke('get-system-audio-support'),
    openSystemAudioFile: (name) => invoke('open-system-audio-file', name),
    appendSystemAudioChunk: (bytes) => invoke('append-system-audio-chunk', bytes),
    closeSystemAudioFile: () => invoke('close-system-audio-file'),
    reportCaptureError: (message) => send('recording-capture-error', message),
    processSystemAudio: (filePath, name) => invoke('process-system-audio-recording', filePath, name),
    processFile: (filePath, name) => invoke('process-recording', filePath, name),
    pickAudioFile: () => invoke('select-audio-file'),
    // Electron 32+ removed File.path; webUtils.getPathForFile resolves the
    // absolute path of a dropped File so drag-and-drop import can reuse the
    // same processFile pipeline as the picker.
    getPathForFile: (file) => webUtils.getPathForFile(file),
    getQueue: () => invoke('get-queue-status'),
    getDir: () => invoke('get-recordings-dir'),
    // Hint that a recording may be imminent (e.g. user landed on Home) so
    // main can re-warm the Parakeet model into the OS page cache. Throttled
    // main-side; safe to call freely. Fire-and-forget.
    hintWarmup: () => send('warmup-parakeet-hint'),
  },

  liveTranscript: {
    // Snapshot of segments + model-load status for the in-flight recording.
    // Renderer calls this once on mount, then subscribes to
    // on.liveTranscriptChunk for the tail.
    getState: () => invoke('get-live-transcript-state'),
    // System-audio path: push a downsampled 16 kHz mono float32 chunk to
    // main's live transcribe sidecar. Bytes pass through to the Python
    // subprocess's stdin; no IPC ack to keep the hot path cheap.
    pushChunk: (bytes) => send('live-transcribe-chunk', bytes),
    // Optional explicit shutdown for the sidecar — stop-recording-ui
    // already calls it, but renderer may want to tear it down independently.
    stop: () => send('live-transcribe-stop'),
  },

  meetings: {
    list: () => invoke('list-meetings'),
    get: (summaryFile) => invoke('get-meeting', summaryFile),
    update: (summaryFile, patch) => invoke('update-meeting', summaryFile, patch),
    revealFolder: (filePath) => invoke('reveal-meeting-folder', filePath),
    delete: (meeting) => invoke('delete-meeting', meeting),
    undoDelete: (id) => invoke('undo-delete-meeting', id),
    commitDelete: (id) => invoke('commit-delete-meeting', id),
    listPendingDeletes: () => invoke('list-pending-deletes'),
    reprocess: (summaryFile, regenTitle, name) => invoke('reprocess-meeting', summaryFile, regenTitle, name),
    // Re-transcribe (#266): re-run ASR on the source recording then re-summarise
    // (regenTitle false; the retranscribe flag is the trailing arg).
    retranscribe: (summaryFile, name) => invoke('reprocess-meeting', summaryFile, false, name, true),
    recordingAvailable: (summaryFile) => invoke('recording-available', summaryFile),
    regenTitle: (summaryFile, name) => invoke('regen-meeting-title', summaryFile, name),
    saveNotes: (name, notes) => invoke('save-meeting-notes', name, notes),
    generateReport: (summaryFile, templateId) => invoke('generate-report-meeting', summaryFile, templateId),
    setActiveReport: (summaryFile, reportId) => invoke('set-active-report', summaryFile, reportId),
    deleteReport: (summaryFile, reportId) => invoke('delete-report', summaryFile, reportId),
    exportTranscript: (defaultFilename, content) =>
      invoke('export-transcript', defaultFilename, content),
    exportNotePdf: (defaultFilename, html) =>
      invoke('export-note-pdf', defaultFilename, html),
  },

  query: {
    ask: (file, q) => invoke('query-transcript', file, q),
    askStream: (id, file, q) => send('query-transcript-stream', id, file, q),
    chatGlobalStream: (id, q, folderId) => send('chat-global-stream', id, q, folderId ?? null),
    cancel: (id) => send('query-cancel', id),
  },

  chat: {
    save: (data) => invoke('save-chat-sessions', data),
    load: () => invoke('load-chat-sessions'),
  },

  folders: {
    list: () => invoke('list-folders'),
    create: (name, color) => invoke('create-folder', name, color),
    rename: (id, name) => invoke('rename-folder', id, name),
    updateIcon: (id, icon) => invoke('update-folder-icon', id, icon),
    delete: (id) => invoke('delete-folder', id),
    reorder: (ids) => invoke('reorder-folders', ids),
    addMeeting: (summaryFile, folderId) => invoke('add-meeting-to-folder', summaryFile, folderId),
    removeMeeting: (summaryFile, folderId) => invoke('remove-meeting-from-folder', summaryFile, folderId),
  },

  templates: {
    list: () => invoke('list-templates'),
    save: (template) => invoke('save-template', template),
    remove: (id) => invoke('delete-template', id),
    setDefault: (id) => invoke('set-default-template', id),
    reset: (id) => invoke('reset-template', id),
  },

  speakers: {
    listProfiles: () => invoke('list-person-profiles'),
    suggestForMeeting: (meetingStem) => invoke('suggest-speakers', meetingStem),
    confirm: (params) => invoke('confirm-speaker', params),
    createProfile: (displayName) => invoke('create-person-profile', displayName),
    renameProfile: (id, displayName) => invoke('rename-person-profile', id, displayName),
    deleteProfile: (id) => invoke('delete-person-profile', id),
    getSampleAudio: (meetingStem, channel, diarizationSpeakerId, expectedRunId, segmentIndex) =>
      invoke(
        'get-speaker-sample-audio',
        meetingStem,
        channel,
        diarizationSpeakerId,
        expectedRunId,
        segmentIndex,
      ),
    getPersonSampleAudio: (id) => invoke('get-person-sample-audio', id),
    markCluster: (params) => invoke('mark-speaker-cluster', params),
    setClusterReviewState: (params) => invoke('set-cluster-review-state', params),
    namingStatus: (meetingStem) => invoke('speaker-naming-status', meetingStem),
  },

  models: {
    checkOllama: () => invoke('check-ollama-installed'),
    list: () => invoke('list-models'),
    getCurrent: () => invoke('get-current-model'),
    set: (name) => invoke('set-model', name),
    checkInstalled: (name) => invoke('check-model-installed', name),
    pull: (name) => invoke('pull-model', name),
    cancelPull: (name) => invoke('cancel-pull', name),
    verify: (name) => invoke('verify-model', name),
    delete: (name) => invoke('delete-model', name),
    getActivePulls: () => invoke('get-active-pulls'),
    ackPullComplete: (name) => send('ack-pull-complete', name),
  },

  whisperModels: {
    list: () => invoke('list-whisper-models'),
    set: (name) => invoke('set-whisper-model', name),
    pull: (name) => invoke('pull-whisper-model', name),
  },

  parakeetModels: {
    list: () => invoke('list-parakeet-models'),
    pull: (id) => invoke('pull-parakeet-model', id ?? null),
    status: () => invoke('parakeet-status'),
  },

  appleSpeech: {
    status: (language) => invoke('apple-speech-status', language ?? 'auto'),
    prepare: (language) => invoke('prepare-apple-speech', language ?? 'auto'),
  },

  transcriptionEngine: {
    get: () => invoke('get-transcription-engine'),
    set: (engine) => invoke('set-transcription-engine', engine),
  },

  settings: {
    getNotifications: () => invoke('get-notifications'),
    setNotifications: (v) => invoke('set-notifications', v),
    getRecordHotkey: () => invoke('get-record-hotkey'),
    setRecordHotkey: (v) => invoke('set-record-hotkey', v),
    getTelemetry: () => invoke('get-telemetry'),
    setTelemetry: (v, source) => invoke('set-telemetry', v, source),
    getDockIcon: () => invoke('get-dock-icon'),
    setDockIcon: (v) => invoke('set-dock-icon', v),
    getMenuBarIcon: () => invoke('get-menu-bar-icon'),
    setMenuBarIcon: (v) => invoke('set-menu-bar-icon', v),
    getSystemAudio: () => invoke('get-system-audio'),
    setSystemAudio: (v) => invoke('set-system-audio', v),
    getAutoDetectMeetings: () => invoke('get-auto-detect-meetings'),
    setAutoDetectMeetings: (v) => invoke('set-auto-detect-meetings', v),
    getPremeetingNotifications: () => invoke('get-premeeting-notifications'),
    setPremeetingNotifications: (v) => invoke('set-premeeting-notifications', v),
    getLaunchOnLogin: () => invoke('get-launch-on-login'),
    setLaunchOnLogin: (v) => invoke('set-launch-on-login', v),
    getWhisperModel: () => invoke('get-whisper-model'),
    setWhisperModel: (model) => invoke('set-whisper-model', model),
    getKeepRecordings: () => invoke('get-keep-recordings'),
    setKeepRecordings: (v) => invoke('set-keep-recordings', v),
    getAutoSummarize: () => invoke('get-auto-summarize'),
    setAutoSummarize: (v) => invoke('set-auto-summarize', v),
    getAutoInstallWhenIdle: () => invoke('get-auto-install-when-idle'),
    setAutoInstallWhenIdle: (v) => invoke('set-auto-install-when-idle', v),
    getIdentityMatchingEnabled: () => invoke('get-identity-matching-enabled'),
    setIdentityMatchingEnabled: (v) => invoke('set-identity-matching-enabled', v),
    getSilenceAutoStop: () => invoke('get-silence-auto-stop'),
    setSilenceAutoStopEnabled: (v) => invoke('set-silence-auto-stop-enabled', v),
    setSilenceAutoStopMinutes: (v) => invoke('set-silence-auto-stop-minutes', v),
    showSilenceAutoStopNotification: (payload) => invoke('show-silence-auto-stop-notification', payload),
    showNoteReadyNotification: (payload) => invoke('show-note-ready-notification', payload),
    showTranscriptReadyNotification: (payload) => invoke('show-transcript-ready-notification', payload),
    showSystemAudioMicOnlyNotification: () => invoke('show-system-audio-mic-only-notification'),
    // Design-for-test seam: the production fire path is the main-side scheduler
    // timer; this lets e2e drive the gate + suppression deterministically.
    showPremeetingNotification: (payload) => invoke('show-premeeting-notification', payload),
    getLanguage: () => invoke('get-language'),
    setLanguage: (code) => invoke('set-language', code),
    getMicrophone: () => invoke('get-microphone'),
    setMicrophone: (deviceId, label) => invoke('set-microphone', deviceId, label),
    getUserName: () => invoke('get-user-name'),
    setUserName: (name) => invoke('set-user-name', name),
    getStoragePath: () => invoke('get-storage-path'),
    setStoragePath: (p) => invoke('set-storage-path', p),
    pickStorageFolder: () => invoke('select-storage-folder'),
    getObsidianSync: () => invoke('get-obsidian-sync'),
    setObsidianSync: (v) => invoke('set-obsidian-sync', v),
    getObsidianVaultPath: () => invoke('get-obsidian-vault-path'),
    setObsidianVaultPath: (p) => invoke('set-obsidian-vault-path', p),
    pickObsidianVaultFolder: () => invoke('select-obsidian-vault-folder'),
    getObsidianConflicts: () => invoke('get-obsidian-conflicts'),
    getAiPrompts: () => invoke('get-ai-prompts'),
    saveDiagnostics: (defaultFilename, content) =>
      invoke('save-diagnostics', defaultFilename, content),
  },

  ai: {
    getProvider: () => invoke('get-ai-provider'),
    setProvider: (p) => invoke('set-ai-provider', p),
    setRemoteOllamaUrl: (url) => invoke('set-remote-ollama-url', url),
    testRemoteOllama: (url) => invoke('test-remote-ollama', url),
    setCloudApiUrl: (url) => invoke('set-cloud-api-url', url),
    setCloudApiKey: (key) => invoke('set-cloud-api-key', key),
    setCloudProvider: (p) => invoke('set-cloud-provider', p),
    setCloudModel: (m) => invoke('set-cloud-model', m),
    setBedrockRegion: (region) => invoke('set-bedrock-region', region),
    setBedrockInferenceProfile: (profile) => invoke('set-bedrock-inference-profile', profile),
    testCloudApi: () => invoke('test-cloud-api'),
  },

  calendar: {
    google: {
      connect: () => invoke('google-auth-start'),
      cancel: () => invoke('google-auth-cancel'),
      status: () => invoke('google-auth-status'),
      disconnect: () => invoke('google-auth-disconnect'),
    },
    outlook: {
      connect: () => invoke('outlook-auth-start'),
      cancel: () => invoke('outlook-auth-cancel'),
      status: () => invoke('outlook-auth-status'),
      disconnect: () => invoke('outlook-auth-disconnect'),
    },
    getEvents: () => invoke('get-calendar-events'),
  },

  updates: {
    check: () => invoke('check-for-updates'),
    getStatus: () => invoke('get-update-status'),
    openReleasePage: (url) => invoke('open-release-page', url),
    install: () => send('install-update'),
  },

  shortcuts: {
    rendererReady: () => send('shortcut-renderer-ready'),
  },

  org: {
    status: () => invoke('org-status'),
    login: (adapterUrl, email, password) => invoke('org-login', { adapterUrl, email, password }),
    logout: () => invoke('org-logout'),
    ssoGoogleStart: (adapterUrl) => invoke('org-sso-google-start', { adapterUrl }),
    listMeetings: () => invoke('org-list-meetings'),
    getMeeting: (id) => invoke('org-get-meeting', id),
    createMeeting: (payload) => invoke('org-create-meeting', payload),
    deleteMeeting: (id) => invoke('org-delete-meeting', id),
    shareMeeting: (payload) => invoke('org-share-meeting', payload),
    getBackupState: (summaryFile) => invoke('org-get-backup-state', summaryFile),
    unshareBySummary: (summaryFile) => invoke('org-unshare-by-summary', summaryFile),
    getAutoBackup: () => invoke('org-get-auto-backup'),
    setAutoBackup: (enabled) => invoke('org-set-auto-backup', enabled),
    getPolicy: () => invoke('org-get-policy'),
    tryAutoBackup: (payload) => invoke('org-try-auto-backup', payload),
    aiChat: (payload) => invoke('org-ai-chat', payload),
    /** Fire-and-forget streaming start. Chunks arrive via query-chunk +
     *  query-done events on the existing channel — same wire as
     *  chatGlobalStream, so useStreamingQuery's subscribeQueryStream
     *  works unchanged. */
    chatStream: (streamId, payload) => send('org-chat-stream', streamId, payload),
  },

  dialog: {
    respondQuit: (confirmed) => send('quit-dialog-response', { confirmed }),
  },

  notification: {
    close: () => invoke('close-notification-window'),
    actionClicked: (actionId, notifId) => send('notification-action-clicked', { actionId, notifId }),
    bodyClicked: (notifId) => send('notification-body-clicked', { notifId }),
  },

  // All main-driven events. Every subscribe returns an unsubscribe fn.
  on: {
    debugLog: (cb) => subscribe('debug-log', cb),
    setupFlowTriggered: (cb) => subscribe('trigger-setup-flow', cb),
    toggleRecordingHotkey: (cb) => subscribe('toggle-recording-hotkey', cb),
    summaryChunk: (cb) => subscribe('summary-chunk', cb),
    summaryTitle: (cb) => subscribe('summary-title', cb),
    summaryComplete: (cb) => subscribe('summary-complete', cb),
    processingComplete: (cb) => subscribe('processing-complete', cb),
    processingProgress: (cb) => subscribe('processing-progress', cb),
    queryChunk: (cb) => subscribe('query-chunk', cb),
    queryDone: (cb) => subscribe('query-done', cb),
    modelPullProgress: (cb) => subscribe('model-pull-progress', cb),
    modelPullComplete: (cb) => subscribe('model-pull-complete', cb),
    whisperPullProgress: (cb) => subscribe('whisper-pull-progress', cb),
    whisperPullComplete: (cb) => subscribe('whisper-pull-complete', cb),
    parakeetPullProgress: (cb) => subscribe('parakeet-pull-progress', cb),
    parakeetPullComplete: (cb) => subscribe('parakeet-pull-complete', cb),
    setupOllamaProgress: (cb) => subscribe('setup-ollama-progress', cb),
    liveTranscriptReady: (cb) => subscribe('live-transcript-ready', cb),
    liveTranscriptChunk: (cb) => subscribe('live-transcript-chunk', cb),
    liveTranscriptError: (cb) => subscribe('live-transcript-error', cb),
    updateAvailable: (cb) => subscribe('update-available', cb),
    updateDownloadProgress: (cb) => subscribe('update-download-progress', cb),
    updateDownloaded: (cb) => subscribe('update-downloaded', cb),
    updateError: (cb) => subscribe('update-error', cb),
    // Main cleared a failure the About tab may still be showing (a cycle that
    // came back clean). Without this the banner would linger on a mounted tab
    // until the user navigated away and back.
    updateErrorCleared: (cb) => subscribe('update-error-cleared', cb),
    googleAuthChanged: (cb) => subscribe('google-auth-changed', cb),
    outlookAuthChanged: (cb) => subscribe('outlook-auth-changed', cb),
    shortcutStartRecording: (cb) => subscribe('shortcut-start-recording', cb),
    shortcutStopRecording: (cb) => subscribe('shortcut-stop-recording', cb),
    trayStartRecording: (cb) => subscribe('tray-start-recording', cb),
    trayStopRecording: (cb) => subscribe('tray-stop-recording', cb),
    autoRecordRequested: (cb) => subscribe('auto-record-requested', cb),
    autoPauseRequested: (cb) => subscribe('auto-pause-requested', cb),
    autoResumeRequested: (cb) => subscribe('auto-resume-requested', cb),
    autoSummariseRequested: (cb) => subscribe('auto-summarise-requested', cb),
    generateNotesRequested: (cb) => subscribe('generate-notes-requested', cb),
    navigateToMeeting: (cb) => subscribe('navigate-to-meeting', cb),
    trayOpenSettings: (cb) => subscribe('tray-open-settings', cb),
    showQuitDialog: (cb) => subscribe('show-quit-dialog', cb),
    showNotification: (cb) => subscribe('show-notification', cb),
  },

  subscribeQueryStream,
};

contextBridge.exposeInMainWorld('stenoai', stenoai);
