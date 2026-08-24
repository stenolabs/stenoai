const { app, BrowserWindow, ipcMain, dialog, shell, systemPreferences, globalShortcut, Tray, Menu, nativeImage, powerMonitor, net, session } = require('electron');

// safeStorage is accessed lazily via getSafeStorage(), NOT destructured from the
// require above. On macOS, merely retrieving the safeStorage binding at load
// time used to register an app-ready observer that eagerly initialized OSCrypt
// and touched the login Keychain — popping the "<app> Safe Storage" permission
// dialog on every launch even for users who had no stored secret at all
// (Electron 42.0.0 regression, made lazy again in 42.4.1). Keeping the binding
// out of the top-level destructure means loading main.js can never trigger that
// access; the first Keychain touch happens only when a credential helper below
// actually runs (saving a cloud key, org sign-in, calendar connect). require()
// is cached, so getSafeStorage() is cheap.
function getSafeStorage() {
  return require('electron').safeStorage;
}

// Prevent EPIPE crashes when stdout/stderr pipe is broken (e.g. launching terminal closed)
process.stdout?.on('error', () => {});
process.stderr?.on('error', () => {});

// --- Early crash logger ---------------------------------------------------
// Packaged Electron apps on Windows surface no stderr/console, so a main-process
// exception during startup just looks like "nothing happens" (silent exit 1).
// Persist any uncaught error to a file we can read afterwards. Registered before
// the first heavy require so it also catches module-load failures. We log then
// exit(1) to preserve the original crash behaviour.
function _logStartupCrash(kind, err) {
  try {
    const _fs = require('fs');
    const _os = require('os');
    const _path = require('path');
    const stamp = new Date().toISOString();
    const detail = (err && (err.stack || err.message)) || String(err);
    const line = `[${stamp}] ${kind}: ${detail}\n`;
    for (const dir of [_os.tmpdir(), process.env.APPDATA, _os.homedir()]) {
      if (!dir) continue;
      try { _fs.appendFileSync(_path.join(dir, 'steno-crash.log'), line); break; } catch (_) {}
    }
  } catch (_) {}
}
// Windows/Linux only: packaged Electron apps surface no stderr there, so this
// file-based crash log is the only way to see a main-process startup failure.
// macOS keeps its default behaviour (Electron's error dialog + console) — we
// don't want to change the signed/notarised mac build's error handling.
if (process.platform !== 'darwin') {
  process.on('uncaughtException', (err) => { _logStartupCrash('uncaughtException', err); process.exit(1); });
  process.on('unhandledRejection', (reason) => { _logStartupCrash('unhandledRejection', reason); });
}

const path = require('path');
// Backend CLI seam (spawn wrapper, process-tree kill, bundled-backend paths,
// runPythonScript), the debug-log sink, and the quit teardown registry are
// carved out of this file (RFC #327, Phase 0); wired once below via factories.
const { spawn, killProcessTree, createBackendCli } = require('./backend-cli');
const { createDebugLog } = require('./debug-log');
const { createTeardownRegistry } = require('./teardown');
const { registerFoldersIpc } = require('./folders-ipc');
const { registerSettingsIpc } = require('./settings-ipc');
const { registerPersonSampleIpc } = require('./person-sample-ipc');
const { registerSpeakerIpc } = require('./speaker-ipc');
const { registerObsidianSync } = require('./obsidian-sync');
const { registerObsidianIpc } = require('./obsidian-ipc');
const { isSafeToAutoInstall } = require('./update-idle-gate');
const { describeUpdateError, updateErrorPhase } = require('./update-error-copy');
const { isOSUpdateEligible, MIN_MACOS_FOR_AUTOUPDATE } = require('./update-os-gate');
const processingLog = require('./processing-log');
const { isMeetingApp, allowsDeviceLevelFallback, isMacos14Plus } = require('./meeting-detect');
const { sweepOrphanedLiveSnapshots } = require('./live-snapshot-sweep');
const { userNotesFilePath } = require('./notes-file');
const { buildNoteReadyNotificationOptions, buildTranscriptReadyBody } = require('./notification-copy');
const { makeLineReader } = require('./backend-stream');
const {
  defaultTranscriptionEngine,
  normalizeTranscriptionEngine,
  isLiveTranscriptionEngine,
} = require('./transcription-engine');
// Pure deep-link (stenoai://) parsing/sanitizing lives in ./shortcut-url
// (unit-tested). The stateful side — window creation, IPC dispatch,
// notifications — stays here and calls parseShortcutUrl().
const {
  SHORTCUT_PROTOCOL,
  extractShortcutUrlFromArgv,
  sanitizeShortcutUrlForLogs,
  parseShortcutUrl,
} = require('./shortcut-url');
const { parseSetupCheckOutput } = require('./setup-check-parse');
const { parseSpeakerModelStatusOutput } = require('./speaker-model-status');
const { isDiagnosticStdoutLine, sanitizeArgsForLog } = require('./diagnostics-filter');
// Pure analytics bucketing/classification/sanitization lives in
// ./analytics-helpers (unit-tested). trackEvent() itself and every IPC
// handler that calls it stay here, alongside the PostHog client.
const {
  textLengthBucket,
  durationBucket,
  RENDERER_TRACK_EVENTS,
  sanitizeTrackProperties,
  calendarMeetingProvider,
  classifyErrorReason,
  classifySummarizationStreamError,
  captureSanitizedException,
  sanitizeModelForAnalytics,
  summarizeCalendarSnapshot,
  withTimeout,
} = require('./analytics-helpers');

// `spawn` (windowsHide wrapper) and `killProcessTree` now live in ./backend-cli
// (imported above), with unit coverage in backend-cli.test.js.
const fs = require('fs');
const https = require('https');
const http = require('http');
const os = require('os');
const { URL, URLSearchParams } = require('url');
const crypto = require('crypto');
const { EXPORT_CANCELED } = require('./ipc-sentinels');
const { mayExposeMainWindow } = require('./e2e-window-visibility');
const { PostHog } = require('posthog-node');
const { initMain } = require('electron-audio-loopback');
const { autoUpdater } = require('electron-updater');

// E2E test-harness hooks. Set via env vars; production sees none of these.
//   STENOAI_USER_DATA_DIR — per-test temp userData dir (must be set before app.whenReady)
//   STENOAI_E2E=1         — skip tray, auto-updater, PostHog telemetry
//   STENOAI_E2E_MOCK_IPC=1 — install deterministic mock IPC handlers
//   STENOAI_E2E_HEADLESS=1 - keep the main window rendered but never visible/focused
if (process.env.STENOAI_USER_DATA_DIR) {
  app.setPath('userData', process.env.STENOAI_USER_DATA_DIR);
}
const IS_E2E = process.env.STENOAI_E2E === '1';
const IS_E2E_MOCK_IPC = process.env.STENOAI_E2E_MOCK_IPC === '1';
const IS_E2E_HEADLESS = IS_E2E && process.env.STENOAI_E2E_HEADLESS === '1';

// Global (system-wide) accelerator to toggle recording. CommandOrControl
// resolves to Cmd on macOS and Ctrl on Windows/Linux, so no manual
// process.platform split is needed. The env override lets the e2e T2 spec
// register a low-collision accelerator that can't clash with whatever the
// real host already occupies (see e2e/specs/record-hotkey.t2.spec.ts).
const RECORD_HOTKEY_ACCEL = process.env.STENOAI_E2E_RECORD_ACCEL || 'CommandOrControl+Shift+R';

// Shared toggle-recording handler for the global shortcut — reused by the
// startup registration and the live-apply set-record-hotkey IPC handler so
// both bind the exact same behaviour.
function handleRecordHotkey() {
  console.log('Global hotkey triggered: toggle recording');
  if (mainWindow) {
    mainWindow.webContents.send('toggle-recording-hotkey');
  }
}

// Direct config.json read (no Python subprocess) for the startup registration
// gate — mirrors the launch-on-login / notifications snapshot reads. The
// startup backend call is skipped under IS_E2E, so a subprocess gate would be
// untestable in T2. Absence of the key = ON (back-compat: the shortcut was
// unconditionally registered before this setting existed).
function recordHotkeyEnabledFromDisk() {
  try {
    const cfgPath = path.join(getUserDataDir(), 'config.json');
    if (fs.existsSync(cfgPath)) {
      const cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf-8'));
      return cfg.record_hotkey_enabled !== false;
    }
  } catch (e) {
    console.warn('Failed to read record_hotkey_enabled from config:', e?.message);
  }
  return true;
}

// Idempotently drive the global record hotkey to `enabled` and report the
// resulting registration. globalShortcut.register() returns false when the
// accelerator is ALREADY registered (including by us), so a bare register on a
// repeat-enable — or an enable that races the startup registration — would
// report a spurious failure while isRegistered() is actually true. Guarding on
// isRegistered() keeps both call sites idempotent and the return value honest.
function applyRecordHotkey(enabled) {
  if (enabled) {
    if (!globalShortcut.isRegistered(RECORD_HOTKEY_ACCEL)) {
      globalShortcut.register(RECORD_HOTKEY_ACCEL, handleRecordHotkey);
    }
  } else if (globalShortcut.isRegistered(RECORD_HOTKEY_ACCEL)) {
    globalShortcut.unregister(RECORD_HOTKEY_ACCEL);
  }
  return globalShortcut.isRegistered(RECORD_HOTKEY_ACCEL);
}
if (IS_E2E_MOCK_IPC) {
  require('./e2e-mock-ipc').install({ ipcMain, BrowserWindow });
}

// Distinguish dev runs from the packaged "Steno" app in the dock, About menu,
// and Cmd+Tab. Production keeps the productName from package.json untouched.
if (!app.isPackaged) {
  app.setName('Steno Dev');
}

// Initialize electron-audio-loopback before app is ready.
// forceCoreAudioTap drives Chromium to use macOS 14.4+ CoreAudio Process Taps
// (NSAudioCaptureUsageDescription) rather than ScreenCaptureKit. SCK was
// returning silent right channels in our tests on macOS 26; CoreAudio Tap
// matches Meetily's default and is the path our Info.plist + entitlements
// are prepared for. Older macOS (< 14.4) is gated out at the UI layer.
// Only force the macOS CoreAudio tap on darwin. forceCoreAudioTap appends a
// macOS-only Chromium feature flag (MacCatapSystemAudioLoopbackCapture) — on
// Windows that's irrelevant (Chromium uses WASAPI loopback) and passing it is
// at best a no-op, so we don't.
initMain({ forceCoreAudioTap: process.platform === 'darwin' });

/*
 * electron-audio-loopback's enable handler obtains a real screen source for
 * the video track, which unnecessarily couples system-audio recording to the
 * macOS Screen Recording permission. The renderer still requests video:true,
 * so the callback must include request.frame: an audio-only response throws
 * after consuming the one-shot callback. Electron also invokes the display
 * media handler without awaiting it, so callback failures must be caught here
 * to avoid an unhandled rejection crashing the main process.
 *
 * Keep this override platform-neutral: audio:'loopback' retains the package's
 * semantics on Windows while avoiding the same callback crash landmine.
 */
ipcMain.removeHandler('enable-loopback-audio');
ipcMain.handle('enable-loopback-audio', () => {
  session.defaultSession.setDisplayMediaRequestHandler((request, callback) => {
    try {
      callback({ video: request.frame, audio: 'loopback' });
    } catch (err) {
      console.error('[loopback] display media callback failed:', err);
    }
  });
});

// Windows taskbar identity. Without an explicit AppUserModelID matching the
// installer's, the taskbar shows a default/Electron icon (and groups the window
// separately) even when the window icon is correct — it keys off the AUMID, not
// the window icon. Must match the NSIS shortcut's id (build.appId).
if (process.platform === 'win32') {
  try { app.setAppUserModelId('com.stenoai.recorder'); } catch (_) {}
}

// CoreAudio Process Taps require macOS 14.4+. Returns false on non-macOS or
// older versions so the renderer can disable the system-audio toggle rather
// than silently producing dead-channel recordings.
function isCoreAudioTapSupported() {
  if (process.platform !== 'darwin') return false;
  try {
    const v = process.getSystemVersion();
    const [maj, min = 0] = v.split('.').map((n) => parseInt(n, 10) || 0);
    return maj > 14 || (maj === 14 && min >= 4);
  } catch (_) {
    return false;
  }
}

// Whether the auto-detect-meetings watcher may run on this OS. Gated to
// macOS 14+ because the mic-monitor only has a reliable per-app signal there;
// on macOS 12/13 it falls back to a coarse device-level signal that misfires
// (see #116). Pure version logic lives in ./meeting-detect (unit-tested).
function isAutoDetectSupported() {
  try {
    return isMacos14Plus(process.platform, process.getSystemVersion());
  } catch (_) {
    // A getSystemVersion() throw is treated like an unparseable version, but
    // only PERMISSIVELY on darwin (a real 14+ Mac must never lose the feature
    // over a probe hiccup). On non-darwin the feature is unsupported regardless,
    // so a throw there stays false — consistent with isMacos14Plus.
    return process.platform === 'darwin';
  }
}

// Whether system-audio (loopback) capture is available on this OS at all.
// macOS: CoreAudio Process Tap (14.4+). Windows: electron-audio-loopback uses
// Chromium's WASAPI loopback on Windows 10+ (both Win10 and Win11 report major
// version 10). Linux: not wired. Drives the Settings/MainToolbar toggle.
function isSystemAudioSupported() {
  if (process.platform === 'darwin') return isCoreAudioTapSupported();
  if (process.platform === 'win32') {
    try {
      const maj = parseInt(process.getSystemVersion().split('.')[0], 10) || 0;
      return maj >= 10;
    } catch (_) {
      return true; // assume a modern Windows if the version probe fails
    }
  }
  return false;
}

// Per-OS user data dir, mirroring src/config.get_user_data_dir(). Used by the
// few synchronous config reads on the Electron side so they resolve the right
// path on Windows/Linux instead of the macOS literal.
function getUserDataDir() {
  // E2E isolation: a per-test temp dir set via STENOAI_USER_DATA_DIR must win
  // for every path this resolves (.org-session, markers, config reads) — the
  // same dir Electron's app.setPath('userData', …) already honors above. Inert
  // in production (the var is never set). Mirrors src/config.get_user_data_dir.
  if (process.env.STENOAI_USER_DATA_DIR) {
    return process.env.STENOAI_USER_DATA_DIR;
  }
  if (process.platform === 'darwin') {
    return path.join(os.homedir(), 'Library', 'Application Support', 'stenoai');
  }
  if (process.platform === 'win32') {
    const base = process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming');
    return path.join(base, 'stenoai');
  }
  const base = process.env.XDG_DATA_HOME || path.join(os.homedir(), '.local', 'share');
  return path.join(base, 'stenoai');
}

// Output dir the Python pipeline reads/writes (custom storage, else user-data).
function getOutputDir() {
  return path.join(_cachedCustomStoragePath || getUserDataDir(), 'output');
}

let mainWindow;
let notificationWindow;

// ── Custom notification toast ────────────────────────────────────────────────
// Drop-in replacement for Electron's `Notification` that renders our OWN
// frameless BrowserWindow toast (renderer route `/notification` →
// NotificationToast.tsx) instead of an OS banner, so every notification is
// visually consistent and theme-aware on macOS AND Windows. It mirrors the
// slice of Electron's Notification API the app relies on:
//   new Notification({ title, body, actions, iconType })
//   .show() / .close() / .on('click'|'action'|'close') / static isSupported()
// Being API-compatible means every existing call site — and
// trackNotificationLifecycle — keeps working unchanged; they just render a
// custom UI. See app/renderer/src/components/NotificationToast.tsx for the view.
//
// Events (kept identical to Electron's Notification so trackNotificationLifecycle
// still tells an interaction from a passive dismiss):
//   'click'  — the toast body was tapped        (renderer → notification-body-clicked)
//   'action' — an action button was tapped      (renderer → notification-action-clicked, index arg)
//   'close'  — the toast went away by ANY means (body/action click-through, the
//              X button, the 15s auto-close, or being superseded)
//
// Single-toast semantics: only one toast window exists at a time; showing a new
// one supersedes (closes) the current one — matching the pre-existing
// pre-meeting toast.
//
// Cross-platform: the window options (transparent, alwaysOnTop, skipTaskbar,
// focusable:false, hasShadow:false, positioned top-right via workArea) and the
// setVisibleOnAllWorkspaces/setAlwaysOnTop calls are all valid on macOS AND
// Windows — the `visibleOnFullScreen` option and the `'screen-saver'` level are
// macOS-only but are harmlessly ignored on Windows. This is the exact window
// config the pre-meeting toast already shipped with on both platforms, so
// there's no new platform-specific surface to gate.
const { EventEmitter } = require('events');

class Notification extends EventEmitter {
  constructor(options = {}) {
    super();
    this.options = options;
    this.payload = {
      id: `n_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`,
      title: options.title || '',
      body: options.body || options.subtitle || '',
      actions: (options.actions || []).map((a) => ({
        // Electron actions have no id; key by text (the app's actions are all
        // single-button with a unique label, so this is stable).
        id: a.text,
        text: a.text,
        type: a.type,
      })),
    };
    if (options.iconType) this.payload.iconType = options.iconType;
  }

  show() {
    // Supersede any current toast (single-toast semantics).
    if (notificationWindow && !notificationWindow.isDestroyed()) {
      notificationWindow.close();
    }

    const { screen } = require('electron');
    const primaryDisplay = screen.getPrimaryDisplay();
    const { width } = primaryDisplay.workAreaSize;
    const { x, y } = primaryDisplay.workArea;

    // Capture the window in a local `win` so the ready-to-show / closed
    // closures below always reference THIS toast's window — never a later one
    // that superseded it via the module-level `notificationWindow`. Reading the
    // module-level var inside those closures was the original closure bug: a
    // fast-following toast reassigned it, and the earlier toast's timers/handlers
    // then acted on the wrong window (closing the new toast, leaking the old).
    const win = new BrowserWindow({
      width: 400,
      height: 70,
      x: x + width - 425,
      y: y + 1,
      // Create HIDDEN and only ever show via showInactive() in ready-to-show
      // below. Without this, `show` defaults to true, so the constructor shows
      // the window with the *activating* show() — which brings the whole app to
      // the foreground (firing app.on('activate') → mainWindow.show()/focus()),
      // so a passive toast appearing wrongly refocuses Steno. focusable:false
      // stops the toast taking key focus but does NOT stop app activation; only
      // show:false + showInactive() keeps the app in the background.
      show: false,
      // Because the toast now stays in a backgrounded app, a click on its
      // buttons would otherwise be swallowed as the app-activating click (so the
      // user has to click twice — once to activate, once to act). acceptFirstMouse
      // makes that first click register as a real click on the button.
      acceptFirstMouse: true,
      frame: false,
      transparent: true,
      alwaysOnTop: true,
      resizable: false,
      skipTaskbar: true,
      focusable: false,
      hasShadow: false,
      backgroundColor: '#00000000',
      webPreferences: {
        nodeIntegration: false,
        contextIsolation: true,
        sandbox: true,
        preload: path.join(__dirname, 'preload.js'),
      },
    });
    notificationWindow = win;
    // Deny window.open + block foreign navigation on the toast window too, so the
    // security guards cover EVERY BrowserWindow (#377). allowExternalLinks lets a
    // Join/meeting link route out via shell.openExternal.
    hardenWindow(win, { allowExternalLinks: true });
    win._activeCustomNotification = this;
    // Also pin the window to the notification instance so a handler bound to
    // THIS notif (e.g. the pre-meeting 'close' dismissal-telemetry handler) can
    // read its OWN window's flags rather than the module-level `notificationWindow`,
    // which a superseding toast reassigns out from under a not-yet-fired 'close'.
    this._window = win;
    // Set true by close-notification-window / the action+body IPC handlers.
    // Scoped to this window instance (not a module-level flag) so a superseding
    // toast can't leak interaction state across windows. Only the pre-meeting
    // path reads it (to avoid double-counting a renderer-tracked dismiss against
    // the main-side auto-close dismiss); the other notifications rely on
    // trackNotificationLifecycle's own click/dismiss bookkeeping.
    win._analyticsInteracted = false;

    const rendererDist = path.join(__dirname, 'renderer', 'dist', 'index.html');
    win.loadFile(rendererDist, { hash: '/notification' });

    let autoCloseTimer;
    // Registered immediately (not inside ready-to-show) so a toast superseded
    // BEFORE it finishes loading still emits 'close' and clears the module-level
    // ref — the auto-close timer simply hasn't been armed yet in that case.
    win.on('closed', () => {
      if (autoCloseTimer) clearTimeout(autoCloseTimer);
      this.emit('close');
      if (notificationWindow === win) notificationWindow = null;
    });

    win.once('ready-to-show', () => {
      win.showInactive();
      win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
      win.setAlwaysOnTop(true, 'screen-saver', 1);

      // Keep the 15s auto-close (matches the pre-existing pre-meeting toast).
      autoCloseTimer = setTimeout(() => {
        if (!win.isDestroyed()) win.close();
      }, 15000);

      win.webContents.send('show-notification', this.payload);
    });
  }

  close() {
    // Only act if we're still the active toast — a superseded toast's window is
    // already gone, so this is a harmless no-op in that case.
    if (
      notificationWindow &&
      notificationWindow._activeCustomNotification === this &&
      !notificationWindow.isDestroyed()
    ) {
      notificationWindow.close();
    }
  }

  static isSupported() {
    return true;
  }
}

let pythonProcess;
let tray = null;
let isQuitting = false;
// true once the window has been shown for the first time (React mounted).
// Prevents activate/focus handlers from showing the window before it's ready.
let windowReadyToShow = false;
let shortcutQueue = [];
let pendingShortcutUrls = [];
let rendererShortcutReady = false;
let launchedByShortcut = false;
// true when this launch was triggered by the OS login item (auto-launch).
// Set once at startup (before the app_opened event). On a login launch we
// suppress the first window show so Steno starts hidden in the tray/menu bar,
// and we tag telemetry so background opens don't inflate DAU/funnels.
let launchedHidden = false;

/**
 * The only route through which the main window may be exposed.
 * Playwright can fully drive a hidden BrowserWindow, so E2E runs use the same
 * renderer without repeatedly stealing focus from the host desktop.
 */
function exposeMainWindow({ focus = true } = {}) {
  if (!mayExposeMainWindow({ isE2EHeadless: IS_E2E_HEADLESS })) return false;
  if (!mainWindow || mainWindow.isDestroyed()) return false;
  if (mainWindow.isMinimized()) mainWindow.restore();
  if (!mainWindow.isVisible()) mainWindow.show();
  if (focus) mainWindow.focus();
  return true;
}

// SHORTCUT_PROTOCOL and the pure deep-link parsing/sanitizing helpers
// (extractShortcutUrlFromArgv, sanitizeShortcutUrlForLogs, parseShortcutUrl,
// and the parse-internal sanitizeShortcutSessionName) live in ./shortcut-url,
// imported at the top of this file.
// --- Phase 0 infra seams (RFC #327), wired once here ---
// Placed after the module state declarations above and before every call site
// (sendDebugLog, getBackendPath, runPythonScript are all used far below). The
// debug-log sink reads the live `mainWindow` through an accessor; backend-cli's
// runPythonScript gets the logging + diagnostics seams injected. These are
// `const`s (not hoisted like the old function declarations), so they must be
// defined before first use — hence their position here.
const sendDebugLog = createDebugLog({ getMainWindow: () => mainWindow });
const { getBackendPath, getBackendCwd, runPythonScript } = createBackendCli({
  app,
  sendDebugLog,
  sanitizeArgsForLog,
  attachProcessingStderr,
  forwardDiagnosticStdout,
});
// Quit teardown registry (RFC #327 ground rule 4). No consumers yet — domains
// that own a child process/timer (Ollama, mic monitor, recording runtime, …)
// register an idempotent dispose() as they move out of main.js. Drained in
// will-quit below.
const teardown = createTeardownRegistry();

const gotSingleInstanceLock = app.requestSingleInstanceLock();

function registerShortcutProtocolClient() {
  if (process.platform !== 'darwin') {
    return false;
  }

  // In development (electron .), macOS protocol registration needs executable + app args.
  if (!app.isPackaged) {
    return app.setAsDefaultProtocolClient(
      SHORTCUT_PROTOCOL,
      process.execPath,
      [path.resolve(process.argv[1])]
    );
  }

  return app.setAsDefaultProtocolClient(SHORTCUT_PROTOCOL);
}

// getBackendPath / getBackendCwd / runPythonScript now come from ./backend-cli
// via createBackendCli(...) wired near the top of this file.

// Path to the mic-in-use helper. Keeps the .exe suffix branch ready for a
// future Windows port — the JSON-line stdout contract is platform-agnostic,
// so swapping in a Windows binary at this path is the only required change.
function getMicMonitorPath() {
  const binName = process.platform === 'win32' ? 'mic-monitor.exe' : 'mic-monitor';
  if (app.isPackaged) {
    return path.join(process.resourcesPath, binName);
  } else {
    return path.join(__dirname, '..', 'bin', binName);
  }
}

// macOS SpeechTranscriber helper. The PyInstaller COLLECT stage places it
// beside the backend's other native binaries under _internal; source runs use
// repo-root bin/. The override keeps T2 tests model-free.
function getAppleTranscribePath() {
  if (process.env.STENOAI_TRANSCRIBE_SIDECAR_PATH) {
    return process.env.STENOAI_TRANSCRIBE_SIDECAR_PATH;
  }
  if (app.isPackaged) {
    return path.join(process.resourcesPath, 'stenoai', '_internal', 'steno-transcribe');
  }
  return path.join(__dirname, '..', 'bin', 'steno-transcribe');
}

function ensureMainWindow() {
  if (!app.isReady()) {
    sendDebugLog('Shortcut action received before app ready; deferring window creation');
    return false;
  }

  if (!mainWindow || mainWindow.isDestroyed()) {
    createWindow();
  }

  return true;
}

function dispatchShortcutAction(action) {
  if (!mainWindow || mainWindow.isDestroyed()) {
    return false;
  }

  if (action.type === 'start') {
    mainWindow.webContents.send('shortcut-start-recording', {
      sessionName: action.sessionName || null
    });
    launchedByShortcut = false;
    return true;
  }

  if (action.type === 'stop') {
    mainWindow.webContents.send('shortcut-stop-recording');
    launchedByShortcut = false;
    return true;
  }

  return false;
}

function flushShortcutQueue() {
  if (!rendererShortcutReady || !mainWindow || mainWindow.isDestroyed()) {
    return;
  }

  while (shortcutQueue.length > 0) {
    const nextAction = shortcutQueue.shift();
    const dispatched = dispatchShortcutAction(nextAction);
    if (!dispatched) {
      shortcutQueue.unshift(nextAction);
      break;
    }
  }
}

function enqueueShortcutAction(action) {
  if (shortcutQueue.length >= 5) {
    sendDebugLog('Shortcut queue overflow, dropping oldest action');
    shortcutQueue.shift();
  }
  shortcutQueue.push(action);
  flushShortcutQueue();
}

async function shouldShowShortcutNotifications() {
  return notificationsEnabled();
}

// Single source of truth for "is the user's Desktop notifications toggle
// on?". Reads the persisted Python config via handleGetNotifications.
// Falls back to `true` on any read error so a transient config issue
// never silently swallows notifications the user expects. Used by every
// notification handler (shortcut, silence auto-stop, note ready) — keeps
// the gate consistent rather than re-implementing it per call site.
async function notificationsEnabled() {
  try {
    const settings = await handleGetNotifications();
    if (!settings.success) return true;
    return settings.notifications_enabled !== false;
  } catch (_) {
    return true;
  }
}

// Same shape as notificationsEnabled(), but for the calendar-based
// pre-meeting heads-up specifically — independent of the "post meeting"
// notifications_enabled toggle (note-ready / silence-auto-stop). Used by
// firePreMeetingNotification and schedulePreMeetingNotifications instead of
// notificationsEnabled(), so the two gates never share state.
async function premeetingNotificationsEnabled() {
  try {
    const settings = await handleGetPremeetingNotifications();
    if (!settings.success) return true;
    return settings.premeeting_notifications_enabled !== false;
  } catch (_) {
    return true;
  }
}

async function showShortcutNotification(body) {
  if (process.platform !== 'darwin') {
    return;
  }

  try {
    const enabled = await shouldShowShortcutNotifications();
    if (!enabled || !Notification.isSupported()) {
      return;
    }

    const notif = new Notification({
      title: 'Steno Shortcuts',
      body
    });
    trackNotificationLifecycle(notif, 'shortcut');
    notif.show();
  } catch (error) {
    console.error('Failed to show shortcut notification:', error.message);
  }
}

const BACKEND_STATUS_RETRY_ATTEMPTS = 3;
const BACKEND_STATUS_RETRY_DELAY_MS = 250;

// Default local AI (summarisation) model the first-run setup pulls. The setup
// pull here is NOT backend-driven, so this must be kept in sync with
// src.config.Config.DEFAULT_MODEL (the Python single source of truth).
const DEFAULT_AI_MODEL = 'gemma4:e2b-it-qat';

function wait(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function isBackendRecording() {
  for (let attempt = 1; attempt <= BACKEND_STATUS_RETRY_ATTEMPTS; attempt += 1) {
    try {
      const status = await handleGetStatus();
      if (status.success) {
        return status.status.includes('STATUS: RECORDING');
      }
    } catch (error) {
      if (attempt === BACKEND_STATUS_RETRY_ATTEMPTS) {
        console.error('Error checking recording status for shortcut action:', error.message);
      }
    }

    if (attempt < BACKEND_STATUS_RETRY_ATTEMPTS) {
      await wait(BACKEND_STATUS_RETRY_DELAY_MS);
    }
  }

  console.warn('Backend status unavailable after retries; assuming not recording for shortcut action');
  return false;
}

async function handleShortcutUrl(incomingUrl) {
  const parsedAction = parseShortcutUrl(incomingUrl);
  const safeShortcutUrl = sanitizeShortcutUrlForLogs(incomingUrl);

  if (parsedAction.type === 'invalid') {
    sendDebugLog(`Ignored invalid shortcut URL (${parsedAction.reason}): ${safeShortcutUrl}`);
    await showShortcutNotification('Invalid shortcut URL');
    launchedByShortcut = false;
    return;
  }

  const backendRecording = await isBackendRecording();
  const recording = backendRecording || systemAudioRecordingActive;

  if (parsedAction.type === 'start') {
    if (recording) {
      await showShortcutNotification('Recording already in progress');
      launchedByShortcut = false;
      return;
    }

    if (!ensureMainWindow()) {
      launchedByShortcut = true;
      pendingShortcutUrls.push(incomingUrl);
      return;
    }
    enqueueShortcutAction(parsedAction);
    await showShortcutNotification('Start recording requested');
    return;
  }

  if (!recording) {
    await showShortcutNotification('Recording already stopped');
    launchedByShortcut = false;
    return;
  }

  if (!ensureMainWindow()) {
    launchedByShortcut = true;
    pendingShortcutUrls.push(incomingUrl);
    return;
  }
  enqueueShortcutAction(parsedAction);
  await showShortcutNotification('Stop recording requested');
}

// Telemetry state
let posthogClient = null;
let telemetryEnabled = false;
let anonymousId = null;

const POSTHOG_API_KEY = 'phc_U2cnTyIyKGNSVaK18FyBMltd8nmN7uHxhhm21fAHwqb';
const POSTHOG_HOST = 'https://us.i.posthog.com';

// Google Calendar OAuth2 configuration
const GOOGLE_CLIENT_ID = '281073275073-20da4u5t9luk2366vd5ai0a2r55d5pf5.apps.googleusercontent.com';
const GOOGLE_CLIENT_SECRET = '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';
// `openid` + the email scope get an `id_token` back in the token exchange
// response, which we decode locally to read the connected account's email —
// no extra userinfo API call needed.
const GOOGLE_SCOPES = 'openid https://www.googleapis.com/auth/calendar.readonly https://www.googleapis.com/auth/userinfo.email';
const GOOGLE_AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
const GOOGLE_TOKEN_URL = 'https://oauth2.googleapis.com/token';

// Outlook Calendar OAuth2 configuration (PKCE public client — no client secret)
const OUTLOOK_CLIENT_ID = '53a8ba1f-3a2e-4fc9-afb1-b9b8ff13de19';
// See GOOGLE_SCOPES comment — openid/email here for the same id_token decode.
// `profile` is required for the `preferred_username` claim to be populated
// (Microsoft's id_token claims reference) — the fallback we use when a
// work/school account has no `email` claim.
const OUTLOOK_SCOPES = 'Calendars.Read offline_access openid email profile';
const OUTLOOK_AUTH_URL = 'https://login.microsoftonline.com/common/oauth2/v2.0/authorize';
const OUTLOOK_TOKEN_URL = 'https://login.microsoftonline.com/common/oauth2/v2.0/token';

/**
 * Register or remove the OS "launch on login" item.
 *
 * Cross-platform: Electron's setLoginItemSettings covers macOS and Windows
 * (Windows writes HKCU\...\Run under the hood). Hidden launch differs per OS:
 * on Windows we register with `--hidden` and detect it via argv at startup; on
 * macOS the deprecated openAsHidden no longer works (macOS 13+), so the window
 * suppression is driven by getLoginItemSettings().wasOpenedAtLogin instead —
 * openAsHidden is passed only as a legacy best-effort, never relied on.
 *
 * No-op under E2E and in dev (unpackaged), so tests and `npm start` never
 * register a login item on the developer's machine. Silent-fail — a login-item
 * error must never break app startup.
 */
function applyLoginItemSetting(enabled) {
  if (IS_E2E || !app.isPackaged) return;
  try {
    app.setLoginItemSettings({
      openAtLogin: enabled,
      openAsHidden: enabled, // macOS legacy best-effort; not relied on for correctness
      args: process.platform === 'win32' && enabled ? ['--hidden'] : [],
    });
  } catch (e) {
    console.warn('setLoginItemSettings failed (non-fatal):', e?.message);
  }
}

/**
 * Initialize PostHog telemetry by reading config from Python backend.
 */
// One config.json read (no extra subprocess) + a token-file existence check
// for the identify() super-properties below. `launch_on_login` defaults ON
// (feature ships enabled-for-everyone; users opt out in Settings), so a legacy
// config missing the key reports true.
function loadIdentitySuperProperties() {
  let cfg = {};
  try {
    const cfgPath = path.join(getUserDataDir(), 'config.json');
    if (fs.existsSync(cfgPath)) cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf-8'));
  } catch (_) {}
  let calendarConnected = false;
  try {
    calendarConnected = Boolean(loadGoogleTokens()) || Boolean(loadOutlookTokens());
  } catch (_) {}
  return {
    ai_provider: cfg.ai_provider || 'local',
    notifications_enabled: cfg.notifications_enabled !== false,
    calendar_connected: calendarConnected,
    launch_on_login: cfg.launch_on_login !== false,
  };
}

// Re-identify so segmentation reflects the LATEST calendar/provider/
// notifications state, not just what was true at app launch. Called from the
// handlers that change any of these (calendar connect/disconnect, AI
// provider, notifications toggle) in addition to the initial identify() in
// initTelemetry.
function refreshIdentitySuperProperties() {
  if (!telemetryEnabled || !posthogClient || !anonymousId) return;
  try {
    posthogClient.identify({
      distinctId: anonymousId,
      properties: loadIdentitySuperProperties(),
    });
  } catch (_) {
    // Silent fail -- telemetry must never break the app
  }
}

async function initTelemetry() {
  if (IS_E2E) {
    telemetryEnabled = false;
    return;
  }
  try {
    const result = await new Promise((resolve, reject) => {
      const proc = spawn(getBackendPath(), ['get-telemetry'], {
        cwd: getBackendCwd()
      });
      let stdout = '';
      proc.stdout.on('data', (data) => { stdout += data.toString(); });
      proc.on('close', (code) => {
        if (code === 0) resolve(stdout);
        else reject(new Error(`get-telemetry exited with code ${code}`));
      });
      proc.on('error', reject);
    });

    const config = JSON.parse(result.trim());
    telemetryEnabled = config.telemetry_enabled;
    anonymousId = config.anonymous_id;

    if (telemetryEnabled) {
      posthogClient = new PostHog(POSTHOG_API_KEY, { host: POSTHOG_HOST, disableGeoip: true });
      // Identify user for DAU tracking
      posthogClient.identify({
        distinctId: anonymousId,
        properties: {
          platform: process.platform,
          arch: process.arch,
          ...loadIdentitySuperProperties(),
        }
      });
      console.log('Telemetry initialized (anonymous analytics enabled)');
    } else {
      console.log('Telemetry disabled by user preference');
    }
  } catch (error) {
    console.error('Failed to initialize telemetry:', error.message);
    telemetryEnabled = false;
  }
}

// Cache the app version at module load. trackEvent fires from ~35 call sites
// across the recording lifecycle; re-reading + JSON.parsing package.json each
// time burns 0.5 ms of main-thread time per call for a value that's immutable
// for the lifetime of the process. `require` already caches transitively, so
// we get the parsed object once.
const APP_VERSION = (() => {
  try {
    return require('./package.json').version || '';
  } catch (_) {
    return '';
  }
})();

/**
 * Track an analytics event. Silent fail -- never throws.
 */
function trackEvent(eventName, properties = {}) {
  try {
    if (!telemetryEnabled || !posthogClient || !anonymousId) return;

    posthogClient.capture({
      distinctId: anonymousId,
      event: eventName,
      properties: {
        app_version: APP_VERSION,
        platform: process.platform,
        arch: process.arch,
        ...properties
      }
    });
  } catch (error) {
    // Silent fail -- telemetry must never break the app
  }
}

// Renderer-originated analytics. contextIsolation means the renderer can't
// call trackEvent directly, so it fire-and-forgets through this bridge.
// RENDERER_TRACK_EVENTS/sanitizeTrackProperties (./analytics-helpers) are the
// name whitelist + PER-EVENT property-key allowlist so a buggy/compromised
// renderer can't smuggle an arbitrary event name, or PII (a meeting title,
// attendee name, transcript snippet) under an unexpected key, into PostHog.
ipcMain.on('track', (_event, eventName, properties) => {
  if (typeof eventName !== 'string' || !RENDERER_TRACK_EVENTS.has(eventName)) return;
  trackEvent(eventName, sanitizeTrackProperties(eventName, properties));
});

// Fires notification_shown/_clicked/_dismissed for a native Notification
// instance, added as EXTRA listeners alongside each notification's own
// click/action handler (Electron's EventEmitter supports multiple listeners
// per event) so this never changes existing behavior. `close` fires whenever
// the notification goes away by any means; `clicked` distinguishes an actual
// click/action from an unclicked auto-dismiss/timeout.
function trackNotificationLifecycle(notif, type, extraProps = {}) {
  let clicked = false;
  const props = { type, ...extraProps };
  trackEvent('notification_shown', props);
  notif.on('click', () => { clicked = true; trackEvent('notification_clicked', props); });
  notif.on('action', () => { clicked = true; trackEvent('notification_clicked', props); });
  notif.on('close', () => {
    if (!clicked) trackEvent('notification_dismissed', props);
  });
}

/**
 * Flush and shut down the PostHog client.
 */
async function shutdownTelemetry() {
  try {
    if (posthogClient) {
      await posthogClient.shutdown();
      posthogClient = null;
      console.log('Telemetry shut down');
    }
  } catch (error) {
    // Silent fail
  }
}

// Minimal crash capture -- gated on the same telemetryEnabled/posthogClient
// state as trackEvent. Captured via sanitizeErrorForCrashReport, never the
// raw error: an uncaught fs/child_process error's .message can embed a local
// path or a calendar-titled session name, so it must never ride along
// verbatim -- only classifyErrorReason's fixed enum + the (PII-free) stack
// frames survive.
//
// A registered 'uncaughtException'/'unhandledRejection' listener suppresses
// Node's default fatal-exception behavior (print + exit) ENTIRELY. Before
// this handler existed, macOS registered no listener for either (see
// _logStartupCrash above, non-darwin only), so Node's default applied:
// print and terminate. Without an explicit exit here, a fatal main-process
// exception would instead leave Electron running in an undefined state --
// continuing after an uncaught exception is unsafe regardless of whether
// telemetry succeeded, so the process MUST still exit either way. The
// bounded flush is a best-effort attempt to let the capture above actually
// reach PostHog before that exit, not a guarantee.
//
// Caveat: on Windows/Linux, `_logStartupCrash` (top of file) is a SEPARATE,
// pre-existing uncaughtException listener that calls process.exit(1) first
// (registered before this module even requires `path`), so a fatal crash
// there can still exit before this handler's flush completes. That's an
// accepted best-effort gap on the alpha platform -- the file-based crash log
// remains authoritative there. macOS has no competing exit(1) handler, so
// capture is reliable on the primary, signed build.
//
// posthog-node's instance captureException() is fire-and-forget: internally
// it does `await propertiesFromUnknownInput(...)` (async stack parsing) and
// only calls its own client.capture() -- the thing that actually enqueues
// the event -- AFTER that resolves, but the public method doesn't expose or
// await that promise. So flushing immediately after calling captureException
// can run against a still-empty queue, sending nothing. This short delay
// gives that internal parsing a chance to finish and enqueue the event
// before we attempt to flush -- best-effort (there's no public API to know
// for certain it's done), not a guarantee, but without it the flush below is
// close to a no-op.
const CAPTURE_EXCEPTION_ENQUEUE_DELAY_MS = 50;

async function captureExceptionAndFlush(err) {
  if (!telemetryEnabled || !posthogClient || !anonymousId) return;
  captureSanitizedException(posthogClient, err, anonymousId);
  await new Promise((resolve) => setTimeout(resolve, CAPTURE_EXCEPTION_ENQUEUE_DELAY_MS));
  await withTimeout(posthogClient.flush(), 1000);
}

process.on('uncaughtException', async (err) => {
  try {
    await captureExceptionAndFlush(err);
  } catch (_) {
    // Silent fail -- telemetry must never mask the original crash
  } finally {
    process.exit(1);
  }
});

process.on('unhandledRejection', async (reason) => {
  try {
    const err = reason instanceof Error ? reason : new Error(String(reason));
    await captureExceptionAndFlush(err);
  } catch (_) {
    // Silent fail
  } finally {
    process.exit(1);
  }
});

/**
 * Get the list of allowed base directories, including any custom storage path.
 */
let _cachedCustomStoragePath = null;
function getAllowedBaseDirs() {
  const projectRoot = path.join(__dirname, '..');
  const dirs = [
    projectRoot,
    // getUserDataDir() rather than a macOS literal: cross-platform (the old
    // hardcoded ~/Library path is wrong on Windows/Linux) and it honors
    // STENOAI_USER_DATA_DIR. In production this resolves to the same per-OS
    // data dir as before; under e2e it's the isolated temp dir, so a test can
    // hand the app a WAV from its temp recordings folder.
    getUserDataDir()
  ];
  if (_cachedCustomStoragePath) {
    dirs.push(_cachedCustomStoragePath);
  }
  return dirs;
}

// Obsidian vault sync engine (#413). Closures capture the (hoisted) path
// helpers; the mirror stays inert until initObsidianSync() loads the cached
// config at startup. folders.json sits beside the output dir.
const obsidianSync = registerObsidianSync({
  getUserDataDir,
  getAllowedBaseDirs,
  validateSafeFilePath,
  resolveFoldersJsonPath: () => path.join(path.dirname(getOutputDir()), 'folders.json'),
  sendDebugLog,
});

// Sync resolver for the audio recordings folder. Mirrors the path order used
// by the async `get-recordings-dir` handler (custom storage > packaged data
// dir > dev scratch). Use this anywhere we need the path inside an IPC
// handler that can't `await runPythonScript`.
function resolveRecordingsDir() {
  let dir;
  if (_cachedCustomStoragePath && !process.env.STENOAI_USER_DATA_DIR) {
    dir = path.join(_cachedCustomStoragePath, 'recordings');
  } else {
    // getUserDataDir() resolves the per-OS data dir when packaged (Windows
    // %APPDATA%/stenoai; identical on macOS) AND honors STENOAI_USER_DATA_DIR
    // (the e2e temp dir) — so JS agrees with the backend's get_data_dirs() in
    // every mode. The old hardcoded REPO/recordings dev branch ignored both,
    // so the dev app (and e2e) disagreed with the frozen backend, which writes
    // notes under ~/Library even in dev — that mismatch broke import-collision
    // dedup in `npm start` (#233). The STENOAI_USER_DATA_DIR guard above mirrors
    // get_data_dirs()'s precedence (config.py): the e2e isolation override beats
    // a configured custom storage path, so a test can never escape the temp dir.
    dir = path.join(getUserDataDir(), 'recordings');
  }
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

// Copy an externally-imported audio file into Steno's own recordings/ dir
// before it enters the processing pipeline. process-streaming deletes the
// source after a successful transcribe whenever keep_recordings is off (the
// default), so transcribing an import in place would silently delete the
// user's original (e.g. ~/Desktop/interview.m4a). Copying first means the
// unlink only ever touches our own copy. The collision-safe filename also
// stops two imports that share a basename from overwriting each other's
// {stem}_summary.md. The displayed title comes from the caller's sessionName,
// not this (possibly de-duplicated) filename, so the user still sees "interview".
async function copyImportIntoRecordings(srcPath) {
  const dir = resolveRecordingsDir();
  // The durable note lives in output/<stem>_summary.{md,json}, named from the
  // audio stem — and it OUTLIVES the audio: process-streaming unlinks the
  // recording after a successful transcribe (keep_recordings off, the default).
  // So a stem that's free in recordings/ can still collide with a note from an
  // earlier same-basename import whose audio was already removed. Skip any stem
  // whose note already exists so re-importing e.g. interview.m4a becomes
  // interview-1 rather than silently overwriting the first interview's summary.
  // output/ is the sibling of recordings/ under the same data root (matching
  // the Python pipeline's get_data_dirs layout).
  const outputDir = path.join(path.dirname(dir), 'output');
  const ext = path.extname(srcPath);
  const stem = path.basename(srcPath, ext);
  const noteExists = (name) =>
    fs.existsSync(path.join(outputDir, `${name}_summary.md`)) ||
    fs.existsSync(path.join(outputDir, `${name}_summary.json`));
  // Is the STEM already taken in recordings/, regardless of extension? The note
  // is keyed on the stem alone (output/<stem>_summary.md), so meeting.wav and
  // meeting.m4a collide on it even though their filenames differ. A bare
  // COPYFILE_EXCL on <stem><ext> wouldn't catch that — the two dest names don't
  // clash — so we must also reject a stem any sibling file already uses. Dotfiles
  // (our .stem.import reservation markers below) are skipped.
  const audioStemTaken = (name) => {
    let entries;
    try {
      entries = fs.readdirSync(dir);
    } catch {
      return false;
    }
    return entries.some(
      (f) => !f.startsWith('.') && path.basename(f, path.extname(f)) === name,
    );
  };
  // Reserve the OUTPUT STEM atomically and independently of the extension. The
  // noteExists / audioStemTaken checks are non-atomic on their own: two
  // concurrent imports of the same stem but different extensions (meeting.wav +
  // meeting.m4a) could both pass them, both copy successfully (different dest
  // filenames → no EEXIST), and both later write meeting_summary.md, one
  // clobbering the other. A per-stem marker created with 'wx' (O_EXCL) is the
  // atomic claim that closes that window: only one import wins .<name>.import,
  // the other gets EEXIST and bumps to <stem>-1. Once a copy lands, the audio
  // file itself holds the stem (audioStemTaken sees it), so the marker is
  // transient and removed in finally; the durable post-deletion record stays the
  // note. COPYFILE_EXCL is kept as belt-and-suspenders. On APFS the copy is a
  // near-instant copy-on-write clone.
  for (let n = 0; ; n += 1) {
    const name = n === 0 ? stem : `${stem}-${n}`;
    // A pre-existing note or sibling audio with this stem means it's already
    // owned; skip ahead so the pipeline writes <stem>-N_summary.* beside it.
    if (noteExists(name) || audioStemTaken(name)) continue;
    const reservation = path.join(dir, `.${name}.import`);
    let handle;
    try {
      handle = await fs.promises.open(reservation, 'wx');
    } catch (err) {
      if (err.code === 'EEXIST') continue;
      throw err;
    }
    try {
      const dest = path.join(dir, `${name}${ext}`);
      await fs.promises.copyFile(srcPath, dest, fs.constants.COPYFILE_EXCL);
      return dest;
    } catch (err) {
      if (err.code === 'EEXIST') continue;
      throw err;
    } finally {
      await handle.close();
      await fs.promises.rm(reservation, { force: true });
    }
  }
}

// Sweep orphaned .<stem>.import reservation markers. copyImportIntoRecordings
// removes its marker in a finally, but a crash (or hard kill) between the 'wx'
// open and that finally leaves the marker on disk. Because audioStemTaken skips
// dotfiles, the orphan never trips the early skip — it silently forces every
// later import of that stem to bump to <stem>-1 via EEXIST, even with no real
// collision. No import is ever in flight at app startup, so any marker present
// then is unambiguously stale and safe to delete. Best-effort: a failure here
// must never block launch.
async function sweepStaleImportMarkers() {
  try {
    const dir = resolveRecordingsDir();
    const entries = await fs.promises.readdir(dir);
    await Promise.all(
      entries
        .filter((f) => f.startsWith('.') && f.endsWith('.import'))
        .map((f) => fs.promises.rm(path.join(dir, f), { force: true })),
    );
  } catch (err) {
    console.warn('Failed to sweep stale import markers:', err?.message ?? err);
  }
}

/**
 * Validate that a file path is within allowed directories (security)
 * Prevents path traversal attacks by ensuring files are only accessed
 * within the app's designated data directories
 */
function validateSafeFilePath(filepath, allowedBaseDirs) {
  if (!filepath) return false;

  try {
    // Resolve to absolute path and normalize
    const resolvedPath = path.resolve(filepath);

    // The renderer is untrusted, so a lexical prefix check alone is
    // symlink-vulnerable: a symlink placed inside an allowed dir but pointing
    // outside it would slip through. Canonicalize BOTH the target and each base
    // dir with realpath before the containment check, so an escaping symlink
    // resolves to its real (out-of-bounds) target and is rejected. realpath also
    // normalizes platform quirks that must match on both sides — on macOS
    // /tmp -> /private/tmp, which the e2e temp data dir relies on — which is
    // exactly why we canonicalize both sides.
    //
    // realpath throws if the path doesn't exist yet (e.g. a file being created),
    // so fall back to canonicalizing the parent directory and re-appending the
    // basename; if even the parent can't be resolved, use the lexical path so we
    // don't break create-new-file flows.
    let canonicalPath;
    try {
      canonicalPath = fs.realpathSync(resolvedPath);
    } catch (_) {
      try {
        canonicalPath = path.join(fs.realpathSync(path.dirname(resolvedPath)), path.basename(resolvedPath));
      } catch (_) {
        canonicalPath = resolvedPath;
      }
    }

    // Ensure it's within one of the allowed base directories
    for (const baseDir of allowedBaseDirs) {
      let resolvedBase;
      try {
        resolvedBase = fs.realpathSync(path.resolve(baseDir));
      } catch (_) {
        resolvedBase = path.resolve(baseDir);
      }
      if (canonicalPath.startsWith(resolvedBase + path.sep) || canonicalPath === resolvedBase) {
        return true;
      }
    }

    return false;
  } catch (error) {
    console.error('Error validating file path:', error);
    return false;
  }
}

// --- Soft-delete: single-summary tombstone deferred delete (#234) ----------
// Deleting a note HIDES only its summary file, by renaming it into a hidden
// sibling dir (`output/.pending-delete/<id>/`). Every backend scan identifies a
// note SOLELY by its summary glob (`list_meetings` / global chat glob
// `output/*_summary.{json,md}`, non-recursive), so hiding the summary makes the
// note invisible to all of them via a SINGLE atomic same-filesystem rename — no
// multi-file moves, no cross-volume copy, no manifest, no restore/purge/sweep.
//
// The transcript, recording and sidecars are NOT moved: they stay in place and
// are unlinked only when the delete COMMITS (window elapsed / explicit dismiss /
// clean quit). Undo renames the summary back. A crash mid-window leaves the
// hidden summary on disk; startup recovery renames it back so the note REAPPEARS
// (fail-safe: a lost undo window must never vanish a note, only ever un-delete).
//
// State is owned by MAIN (the renderer only shows a display-only countdown).
// pendingDeletes maps an id -> its record; pendingDeleteBySummary indexes the
// canonical original summary path -> id for dedup.
const PENDING_DELETE_DIRNAME = '.pending-delete';
const DELETE_WINDOW_MS = 8000;
// id -> { id, meeting, summaryFileKey, hiddenDir, originalSummaryPath,
//         hiddenSummaryPath, canonicalSummary, ancillaryPaths, deadline,
//         state, timer }
// A note names EXACTLY ONE summary_file; we hide that single file (one atomic
// rename). No multi-variant/twin bookkeeping — see the delete handler's note on
// the anomalous, fail-safe .json+.md twin edge.
const pendingDeletes = new Map();
// canonical(the note's original summary path) -> id, so a second delete of the
// same summary is rejected.
const pendingDeleteBySummary = new Map();

// Canonicalize a path via realpath, falling back to a parent-realpath + basename
// (for a path whose leaf no longer exists, e.g. an already-hidden summary) and
// finally the lexical resolve. Used for identity comparisons only.
function canonicalPathForCompare(p) {
  const resolved = path.resolve(p);
  try {
    return fs.realpathSync(resolved);
  } catch (_) {
    try {
      return path.join(fs.realpathSync(path.dirname(resolved)), path.basename(resolved));
    } catch (_) {
      return resolved;
    }
  }
}

// An id is generated by us (`<ts>-<hex>`) but comes back from the untrusted
// renderer on undo/commit. We only ever use it as a Map key (undo/commit read
// the hidden path from OUR record, never build a path from the renderer id), but
// reject any separator/parent token as defense-in-depth.
function isSafePendingId(id) {
  return (
    typeof id === 'string' &&
    id.length > 0 &&
    !id.includes('/') &&
    !id.includes('\\') &&
    !id.includes('..') &&
    id !== '.' &&
    id !== '..'
  );
}

// Canonical STEM identity for a summary path: strip the `_summary.{md,json}`
// suffix and keep the containing dir, so the two format variants of one note
// (<stem>_summary.json / <stem>_summary.md) collapse to the SAME key. Used by
// isSummaryBusy so deleting the .json while a job rewrites the .md (or vice
// versa) is still seen as busy. Falls back to the full canonical path when the
// basename isn't a summary variant (never matches an unrelated file).
function summaryStemKey(summaryAbs) {
  const canon = canonicalPathForCompare(summaryAbs);
  const dir = path.dirname(canon);
  const base = path.basename(canon);
  for (const suf of ['_summary.md', '_summary.json']) {
    if (base.endsWith(suf)) {
      return path.join(dir, base.slice(0, -suf.length));
    }
  }
  return canon;
}

// Is a note (by its summary path) currently in an active pipeline — recording
// into, queued/processing, or reprocessing? A delete must be refused for such a
// note, or a finishing job would rewrite (resurrect) or re-upload the summary we
// just hid = the note reappears / leaks after the user deleted it. Compares by
// canonical STEM (not exact path) so deleting one format variant while a job is
// rewriting the other variant of the SAME note is still caught — otherwise the
// job could resurrect the summary while commit unlinks the audio.
function isSummaryBusy(summaryAbs) {
  const target = summaryStemKey(summaryAbs);
  const candidates = [];
  for (const key of activeReprocessJobs.keys()) candidates.push(key);
  if (currentRecordingAppendTarget) candidates.push(currentRecordingAppendTarget);
  if (currentProcessingJob) {
    if (currentProcessingJob.appendTo) candidates.push(currentProcessingJob.appendTo);
    if (currentProcessingJob.summaryFile) candidates.push(currentProcessingJob.summaryFile);
  }
  for (const job of processingQueue) {
    if (job && job.appendTo) candidates.push(job.appendTo);
    if (job && job.summaryFile) candidates.push(job.summaryFile);
  }
  return candidates.some((c) => summaryStemKey(c) === target);
}

// A trashable meeting file must live directly in an allowed base's output/,
// recordings/, or transcripts/ folder — NOT just anywhere under the broad
// allowed roots. This rejects a crafted meeting whose audio_file points at,
// say, <userData>/config.json (Codex C2): config.json is under an allowed base,
// but its parent dir is not one of the meeting-file folders. realpath-resolving
// both the candidate's parent and each leaf dir closes the symlink gap.
function isAllowedMeetingSource(src, allowedBaseDirs) {
  const leafDirs = [];
  for (const base of allowedBaseDirs) {
    for (const sub of ['output', 'recordings', 'transcripts']) {
      const p = path.join(base, sub);
      let real;
      try {
        real = fs.realpathSync(p);
      } catch (_) {
        real = path.resolve(p);
      }
      leafDirs.push(real);
    }
  }
  const parent = path.dirname(src);
  let realParent;
  try {
    realParent = fs.realpathSync(parent);
  } catch (_) {
    realParent = path.resolve(parent);
  }
  return leafDirs.includes(realParent);
}

// No-clobber occupancy test. Uses lstat (NOT existsSync) so a DANGLING symlink
// at the path counts as occupied: existsSync follows the link and returns false
// for a broken target, which would let a renameSync silently REPLACE the symlink
// (and, if it weren't dangling, write THROUGH it out of the sandbox). Any lstat
// success — regular file, dir, symlink, broken symlink — means "occupied".
function pathIsOccupied(p) {
  try {
    fs.lstatSync(p);
    return true;
  } catch (err) {
    // Only a genuine "not found" proves the path is free. A transient lstat
    // error (EIO / EACCES / ...) must fail SAFE — treat the path as occupied so
    // we never renameSync over something we couldn't inspect.
    if (err && err.code === 'ENOENT') return false;
    return true;
  }
}

// Remove a hidden summary's `.pending-delete/<id>/` scaffold, then best-effort
// remove the now-empty `.pending-delete/` parent (rmdir fails, harmlessly, if
// another pending delete still occupies it). Keeps output/ tidy between windows.
function removeHiddenScaffold(idDir) {
  try {
    fs.rmSync(idDir, { recursive: true, force: true });
  } catch (_) {}
  try {
    fs.rmdirSync(path.dirname(idDir));
  } catch (_) {}
}

// Commit a pending delete: PERMANENTLY unlink the hidden summary + every
// ancillary file (transcript / recording(s) / reports sidecar), then the
// `.pending-delete/<id>` scaffold. This is the FINAL delete — no rollback.
// Called when the undo window elapses, on an explicit dismiss
// (commit-delete-meeting), and synchronously for every entry at clean quit.
// Best-effort + idempotent: a missing file / unknown id is fine.
function commitPendingDelete(id) {
  const entry = pendingDeletes.get(id);
  if (!entry) return;
  // Mark committing FIRST so a racing undo-delete-meeting loses (it checks state).
  entry.state = 'committing';
  if (entry.timer) {
    clearTimeout(entry.timer);
    entry.timer = null;
  }
  // Returns true if the file is gone after this call (unlinked or already
  // absent), false if it survived every retry (e.g. a permanently locked file).
  const unlinkBestEffort = (p) => {
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        fs.unlinkSync(p);
        return true;
      } catch (err) {
        if (err && err.code === 'ENOENT') return true; // already gone — done.
        // Transient (EBUSY/EPERM on Windows): retry a couple of times, else give
        // up (best-effort — a residual file is recovered/cleaned on next launch).
      }
    }
    return false;
  };
  // The hidden summary IS the note. If it can't be permanently removed (e.g. a
  // locked file), do NOT drop the pending record, remove the scaffold, or delete
  // the ancillaries: leaving the hidden summary under .pending-delete/<id>/ lets
  // startup recovery rename it back so the note REAPPEARS intact (fail-safe — the
  // note un-deletes rather than half-committing with its transcript/recording
  // already gone). Bailing before the ancillary unlinks keeps a full restore
  // possible. A later quit-time sweep / next launch retries the commit.
  if (!unlinkBestEffort(entry.hiddenSummaryPath)) {
    console.warn(
      `Commit: hidden summary unremovable, leaving for startup recovery: ${entry.hiddenSummaryPath}`,
    );
    return;
  }
  // The note is now permanently gone — mirror the deletion into the Obsidian
  // vault (#413) if sync is on. Runs at the single commit choke point so the
  // timer, explicit-dismiss and quit paths all mirror; preserves an
  // externally-edited vault copy (skip + flag) rather than clobbering it.
  try { obsidianSync.removeNoteBySummaryPath(entry.originalSummaryPath); } catch (_) {}
  // Ancillary files (transcript / recording(s) / reports sidecar) are hygiene,
  // not the note itself: a rare permanently-locked orphan is accepted (fail-safe
  // direction — never risk the note over a stray file). Log any that survived.
  for (const p of entry.ancillaryPaths) {
    if (!unlinkBestEffort(p)) {
      console.warn(`Commit: orphaned ancillary file (could not remove): ${p}`);
    }
  }
  removeHiddenScaffold(entry.hiddenDir);
  pendingDeletes.delete(id);
  if (pendingDeleteBySummary.get(entry.canonicalSummary) === id) {
    pendingDeleteBySummary.delete(entry.canonicalSummary);
  }
}

// Synchronously commit EVERY pending delete. Called at clean quit — the undo
// window ends at quit, so a still-pending delete becomes permanent. Electron
// does NOT await quit handlers, so this does only synchronous fs work and never
// blocks quit. A force-kill / crash that skips this leaves hidden summaries on
// disk, which startup recovery turns back into visible notes (fail-safe).
function commitAllPendingDeletesSync() {
  for (const id of [...pendingDeletes.keys()]) {
    try {
      commitPendingDelete(id);
    } catch (_) {}
  }
}

// Startup RECOVERY (NON-destructive — replaces the old purge-on-launch). A hidden
// summary still under `output/.pending-delete/<id>/` at launch is from a prior
// session whose undo window was cut short by a crash / force-kill. RENAME it back
// to output/ so the note REAPPEARS — a crash mid-window must never vanish a note,
// only ever un-delete it. Then remove the empty scaffold. Best-effort; never
// blocks launch. If the original path is occupied, LEAVE the hidden copy + log
// (never clobber). Scans every allowed base's output/ (custom storage included).
function recoverPendingDeletesOnLaunch() {
  const outputDirs = new Set();
  for (const base of getAllowedBaseDirs()) {
    outputDirs.add(path.join(base, 'output'));
  }
  for (const outputDir of outputDirs) {
    const pendingRoot = path.join(outputDir, PENDING_DELETE_DIRNAME);
    let rootStat;
    try {
      rootStat = fs.lstatSync(pendingRoot);
    } catch (_) {
      continue; // No `.pending-delete` dir here — nothing to recover.
    }
    if (!rootStat.isDirectory()) {
      console.warn('.pending-delete is not a real directory — skipping recovery:', pendingRoot);
      continue;
    }
    let idDirs;
    try {
      idDirs = fs.readdirSync(pendingRoot);
    } catch (_) {
      continue;
    }
    for (const idDir of idDirs) {
      const idPath = path.join(pendingRoot, idDir);
      try {
        if (!fs.lstatSync(idPath).isDirectory()) continue;
        for (const name of fs.readdirSync(idPath)) {
          const hidden = path.join(idPath, name);
          // Only recover regular files (the only thing we ever hide is a summary).
          if (!fs.lstatSync(hidden).isFile()) continue;
          const original = path.join(outputDir, name);
          // No-clobber (lstat, not existsSync, so a dangling symlink at the
          // destination counts as occupied and is never replaced). The residual
          // TOCTOU between this check and the renameSync is accepted: single-user
          // desktop, synchronous handler, sub-ms window; Node has no atomic
          // rename-no-replace.
          if (pathIsOccupied(original)) {
            console.warn(`Recovery: original occupied, leaving hidden copy: ${hidden}`);
            continue;
          }
          fs.renameSync(hidden, original);
          console.log(`Recovery: restored hidden summary -> ${original}`);
        }
      } catch (e) {
        console.warn(`Recovery: failed for ${idPath} (non-fatal):`, e?.message);
      }
      // Remove the (now hopefully empty) `.pending-delete/<id>` scaffold. rmdir
      // fails loudly-but-caught if a hidden copy was intentionally left behind.
      try {
        fs.rmdirSync(idPath);
      } catch (_) {}
    }
    // Remove the empty `.pending-delete` root.
    try {
      fs.rmdirSync(pendingRoot);
    } catch (_) {}
  }
}

// #377 — harden every BrowserWindow against untrusted navigation. The renderer
// routes all real external links through the `open-external` IPC (shell.openExternal),
// so nothing legitimately relies on window.open or on navigating the window away
// from the bundled renderer. Deny window.open outright, and cancel any full-page
// navigation — the SPA uses in-app routing, so a will-navigate here is a
// foreign/injected navigation, never a real route change. Interactive windows still
// let a genuine http(s) link (a target=_blank "Report an issue", or a link
// inside a note) open in the user's browser instead of silently dying.
function hardenWindow(win, { allowExternalLinks = false } = {}) {
  const wc = win.webContents;
  wc.setWindowOpenHandler(({ url }) => {
    // HTTP(S) only — matches the will-navigate branch below and the established
    // `open-external` IPC policy (no mailto/other schemes; nothing legitimate in
    // the renderer opens a non-http(s) popup). #377 review.
    if (allowExternalLinks && /^https?:/i.test(url)) {
      shell.openExternal(url);
    }
    return { action: 'deny' };
  });
  wc.on('will-navigate', (event) => {
    // Electron 42: read the target off the event (the positional `url` arg is
    // deprecated). will-navigate only fires on a real document navigation — the
    // SPA's hash routing never reaches here, so anything that does is foreign.
    const url = event.url;
    if (url === wc.getURL()) return; // reload of the exact trusted document is fine
    event.preventDefault();
    if (allowExternalLinks && /^https?:/i.test(url)) {
      shell.openExternal(url);
    }
  });
}

function createWindow(options = {}) {
  rendererShortcutReady = false;

  const windowOpts = {
    width: 1188,
    height: 844,
    minWidth: 1000,
    minHeight: 600,
    // Explicit window/taskbar icon on Windows. Relying on the exe-embedded icon
    // is unreliable (Windows icon cache shows a stale/default icon), so we point
    // at the bundled .ico directly. macOS uses its .icns via the app bundle.
    ...(process.platform === 'win32'
      ? {
          icon: app.isPackaged
            ? path.join(process.resourcesPath, 'icon.ico')
            : path.join(__dirname, 'build', 'icon.ico'),
        }
      : {}),
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
      preload: path.join(__dirname, 'preload.js'),
      scrollBounce: true,
      // backgroundThrottling is left at its default (true) and toggled at
      // runtime instead — see applyRecordingBackgroundThrottling(). We only
      // disable throttling WHILE recording (renderer-owned capture timers must
      // run full-rate even when the window is hidden), and let a
      // backgrounded-idle app throttle normally so it doesn't burn CPU.
    },
    // Windows/Linux render the Electron application menu as an in-window menu
    // bar (File/Edit/View/…); macOS puts it in the global bar. Hide it off-mac
    // so the app keeps its clean custom-toolbar look (Alt still reveals it).
    autoHideMenuBar: true,
    show: false,
    backgroundColor: '#FAF9F5',
    ...(process.platform === 'darwin'
      ? {
          titleBarStyle: 'hiddenInset',
          // React UI renders the macOS traffic lights inside the sidebar's
          // top band rather than floating above a fixed titlebar.
          trafficLightPosition: { x: 18, y: 18 },
        }
      : {}),
  };
  if (options.bounds && typeof options.bounds.x === 'number') {
    Object.assign(windowOpts, options.bounds);
  }

  mainWindow = new BrowserWindow(windowOpts);
  hardenWindow(mainWindow, { allowExternalLinks: true });

  const rendererDist = path.join(__dirname, 'renderer', 'dist', 'index.html');
  const hash = process.env.STENOAI_RENDERER_HASH;
  if (hash) {
    mainWindow.loadFile(rendererDist, { hash });
  } else {
    mainWindow.loadFile(rendererDist);
  }

  windowReadyToShow = false;

  const showWhenReady = () => {
    // Always mark readiness so activate/focus handlers (which gate on
    // windowReadyToShow) can reveal the window later — even on a login launch
    // where we skip the initial show. Only the show() itself is suppressed when
    // launched hidden, so Steno starts in the tray/menu bar; a tray/Dock click
    // then brings it up normally.
    windowReadyToShow = true;
    if (launchedHidden) {
      return;
    }
    exposeMainWindow({ focus: false });
  };

  mainWindow.once('ready-to-show', () => {
    if (launchedByShortcut) {
      return;
    }
    // Wait until React signals it has mounted. Fall back to showing after
    // 4s in case the signal never arrives.
    const fallback = setTimeout(showWhenReady, 4000);
    ipcMain.once('renderer-ready-to-show', () => {
      clearTimeout(fallback);
      showWhenReady();
    });
  });



  // On macOS, hide to tray instead of destroying (like Slack, Spotify)
  mainWindow.on('close', (event) => {
    if (process.platform === 'darwin' && !isQuitting) {
      event.preventDefault();
      mainWindow.hide();
    }
  });

  // Returning to the window is the strongest "about to record" signal — keep
  // the Parakeet model hot. Throttled + recording-guarded inside rewarmParakeet.
  mainWindow.on('focus', () => rewarmParakeet('window-focus'));

  mainWindow.on('closed', () => {
    mainWindow = null;
    rendererShortcutReady = false;
    // Abort any in-flight org SSE streams so they don't keep consuming
    // network/CPU after the renderer is gone.
    if (typeof orgStreamAborters !== 'undefined') {
      for (const ctrl of orgStreamAborters.values()) {
        try { ctrl.abort(); } catch (_) {}
      }
      orgStreamAborters.clear();
    }
    if (pythonProcess) {
      pythonProcess.kill();
    }
  });
}

function getTrayIconPath(recording) {
  const iconName = recording ? 'trayIconRecordingTemplate' : 'trayIconTemplate';
  if (app.isPackaged) {
    return path.join(process.resourcesPath, 'assets', `${iconName}.png`);
  }
  return path.join(__dirname, 'assets', `${iconName}.png`);
}

function createTray() {
  const icon = nativeImage.createFromPath(getTrayIconPath(false));
  icon.setTemplateImage(true);
  tray = new Tray(icon);
  tray.setToolTip('Steno');

  updateTrayMenu();
}

function updateTrayIcon(recording) {
  if (!tray) return;
  const icon = nativeImage.createFromPath(getTrayIconPath(recording));
  icon.setTemplateImage(true);
  tray.setImage(icon);
  tray.setToolTip(recording ? 'Steno - Recording' : 'Steno');
  updateTrayMenu();
}

function showAndFocusWindow() {
  exposeMainWindow();
}

function updateTrayMenu() {
  if (!tray) return;
  const isRecording = currentRecordingProcess !== null || systemAudioRecordingActive;

  const appVersion = require('./package.json').version;

  const contextMenu = Menu.buildFromTemplate([
    {
      label: 'Open Steno',
      click: showAndFocusWindow
    },
    {
      label: isRecording ? 'Stop Recording' : 'Start Recording',
      click: () => {
        if (mainWindow) {
          mainWindow.webContents.send(isRecording ? 'tray-stop-recording' : 'tray-start-recording');
        }
      }
    },
    {
      label: 'Settings',
      click: () => {
        showAndFocusWindow();
        if (mainWindow) {
          mainWindow.webContents.send('tray-open-settings');
        }
      }
    },
    {
      label: 'Hide Steno',
      click: () => {
        if (mainWindow) mainWindow.hide();
      }
    },
    { type: 'separator' },
    {
      label: `Steno v${appVersion}`,
      enabled: false
    },
    {
      label: 'Report a Bug',
      click: () => {
        shell.openExternal('https://discord.gg/DZ6vcQnxxu');
      }
    },
    { type: 'separator' },
    {
      label: 'Quit Steno',
      click: () => {
        app.quit();
      }
    }
  ]);

  tray.setContextMenu(contextMenu);
}

// ── Parakeet warm-up ────────────────────────────────────────────────────
// The backend is stateless, so the model is reloaded once per recording
// subprocess. We pre-load it into the OS page cache at launch and again at
// recording-intent moments — the page cache can be evicted hours after
// launch, which is a big part of "first record is sometimes slow." Re-warming
// on window focus / activate / a renderer hint keeps it hot right before the
// user records. Module-scoped so createWindow's focus handler can reach it.
let lastParakeetWarmupAt = 0;
const PARAKEET_REWARM_THROTTLE_MS = 5 * 60 * 1000;
// Stamped when a live transcription subprocess spawns; logged against
// LIVE_READY to measure real model-load latency in the field.
let parakeetLoadStartedAt = 0;

function spawnParakeetWarmup() {
  try {
    const warmupProc = spawn(getBackendPath(), ['warmup-parakeet'], {
      cwd: getBackendCwd(),
      stdio: 'ignore',
      windowsHide: true,
    });
    warmupProc.unref();
    warmupProc.on('error', (err) => {
      sendDebugLog(`[parakeet-warmup] spawn failed (non-fatal): ${err.message}`);
    });
  } catch (e) {
    sendDebugLog(`[parakeet-warmup] startup error (non-fatal): ${e.message}`);
  }
}

function rewarmParakeet(reason) {
  // No backend subprocesses under E2E — focus/activate/renderer-hint must not
  // spawn a warmup against the temp data dir (keeps the test tiers hermetic).
  if (IS_E2E) return;
  // Cheap in-memory guards first, so a throttled or mid-recording focus event
  // doesn't pay the loadTranscriptionEngine() file read. Don't compete with an
  // active recording — the model is already resident in the recording
  // subprocess, so a re-warm would only duplicate the mmap.
  if (currentRecordingProcess !== null || systemAudioRecordingActive || liveTranscribeProcess) return;
  const now = Date.now();
  if (now - lastParakeetWarmupAt < PARAKEET_REWARM_THROTTLE_MS) return;
  if (loadTranscriptionEngine() !== 'parakeet') return;
  lastParakeetWarmupAt = now;
  sendDebugLog(`[parakeet-warmup] re-warm (${reason})`);
  spawnParakeetWarmup();
}

if (!gotSingleInstanceLock) {
  app.quit();
} else {
  ipcMain.on('warmup-parakeet-hint', () => rewarmParakeet('renderer-hint'));
  app.on('second-instance', (event, argv) => {
    const shortcutUrl = extractShortcutUrlFromArgv(argv);
    if (shortcutUrl) {
      if (app.isReady()) {
        handleShortcutUrl(shortcutUrl).catch(err => {
          sendDebugLog(`Error handling shortcut URL: ${err.message}`);
        });
      } else {
        launchedByShortcut = true;
        pendingShortcutUrls.push(shortcutUrl);
      }
    }

    exposeMainWindow();
  });

  // Sends the custom in-app quit dialog to the renderer and waits for a response.
  // Falls back to true (allow quit) if the window is unavailable. A 5s timeout
  // guards against a wedged React tree — on timeout we resolve false to
  // preserve any active recording rather than killing it silently.
  async function showCustomQuitDialog(type, jobCount) {
    if (!mainWindow || mainWindow.isDestroyed()) return true;
    exposeMainWindow();
    mainWindow.webContents.send('show-quit-dialog', { type, jobCount });
    return new Promise((resolve) => {
      const handler = (_event, data) => {
        clearTimeout(timer);
        resolve(data && data.confirmed === true);
      };
      const timer = setTimeout(() => {
        ipcMain.removeListener('quit-dialog-response', handler);
        resolve(false);
      }, 5000);
      ipcMain.once('quit-dialog-response', handler);
    });
  }

  app.on('before-quit', async (event) => {
    if (isQuitting) return;

    // Synchronous flag — systemAudioRecordingActive is updated via IPC on each
    // state change. Capture is renderer-driven on every platform now.
    if (systemAudioRecordingActive) {
      event.preventDefault();
      const confirmed = await showCustomQuitDialog('recording');
      if (confirmed) {
        // Ask the renderer to finalise its WebM (incremental file is already on
        // disk) and queue processing before we exit — best-effort.
        if (mainWindow && !mainWindow.isDestroyed()) {
          try {
            await mainWindow.webContents.executeJavaScript('stopSystemAudioRecording("quit")');
          } catch (e) {
            // Best effort -- file is saved even if processing doesn't start
          }
        }
        systemAudioRecordingActive = false;
        updateTrayIcon(false);
        isQuitting = true;
        app.quit();
      }
    } else if (isProcessing || processingQueue.length > 0) {
      event.preventDefault();
      const jobCount = processingQueue.length + (isProcessing ? 1 : 0);
      const confirmed = await showCustomQuitDialog('processing', jobCount);
      if (confirmed) {
        isQuitting = true;
        app.quit();
      }
    } else {
      isQuitting = true;
    }
  });

  app.on('open-url', (event, incomingUrl) => {
    if (process.platform !== 'darwin') {
      return;
    }

    event.preventDefault();
    sendDebugLog(`Received shortcut URL via open-url: ${sanitizeShortcutUrlForLogs(incomingUrl)}`);

    if (!app.isReady()) {
      launchedByShortcut = true;
      pendingShortcutUrls.push(incomingUrl);
      return;
    }

    handleShortcutUrl(incomingUrl).catch(err => {
      sendDebugLog(`Error handling shortcut URL: ${err.message}`);
    });
  });

  app.whenReady().then(async () => {
    // Resolve whether this launch was an OS login-item auto-launch BEFORE the
    // app_opened event and the first window show below. macOS reports it via
    // wasOpenedAtLogin (the deprecated openAsHidden no longer works on 13+);
    // Windows carries the `--hidden` arg we registered the login item with.
    // Only treat it as hidden if the setting isn't explicitly off, so a stale
    // OS login item (setting since disabled) doesn't wrongly hide the window.
    try {
      let launchOnLoginEnabled = true;
      try {
        const cfgPath = path.join(getUserDataDir(), 'config.json');
        if (fs.existsSync(cfgPath)) {
          const cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf-8'));
          launchOnLoginEnabled = cfg.launch_on_login !== false;
        }
      } catch (_) {}
      const openedAtLogin =
        process.platform === 'darwin'
          ? Boolean(app.getLoginItemSettings().wasOpenedAtLogin)
          : process.argv.includes('--hidden');
      launchedHidden = openedAtLogin && launchOnLoginEnabled;
    } catch (e) {
      console.warn('Failed to resolve login-launch state (non-fatal):', e?.message);
    }

    // Follow the OS system proxy for all main-process HTTP (net.fetch uses the
    // default session). net.fetch alone honours the *session* proxy, but the
    // default session does NOT auto-adopt the Windows system proxy — without
    // this, the org adapter + S3 calls still went direct and failed behind a
    // corporate proxy (verified on a Windows VM: net::ERR_NETWORK_ACCESS_DENIED
    // until the session was pointed at the system proxy). mode:'system' is a
    // no-op on a machine with no proxy configured, so the no-proxy happy path
    // (and the signed macOS build) is unchanged. Best-effort.
    try {
      session.defaultSession.setProxy({ mode: 'system' }).catch((e) => {
        console.warn('setProxy(system) failed (non-fatal):', e?.message);
      });
    } catch (e) {
      console.warn('setProxy(system) threw (non-fatal):', e?.message);
    }

    // Persistent diagnostic log under <userData>/logs (honors
    // STENOAI_USER_DATA_DIR via getUserDataDir, so e2e/tests stay isolated).
    // The startup marker is a stable anchor that separates sessions.
    try {
      processingLog.init({ dir: path.join(getUserDataDir(), 'logs') });
      processingLog.logLine('app', `startup v${app.getVersion()} platform=${process.platform}`);
    } catch (e) {
      console.warn('processing-log init failed (non-fatal):', e?.message);
    }

    // Application menu. macOS uses the global menu bar with mac-only roles
    // (services/hide/unhide). Windows/Linux get a slimmer, platform-correct
    // menu — kept (editing accelerators, Settings, Help) but hidden by default
    // via autoHideMenuBar so it doesn't clash with the app's custom toolbar;
    // Alt reveals it (standard Windows behaviour).
    const settingsItem = {
      label: 'Settings…',
      accelerator: 'CmdOrCtrl+,',
      click: () => {
        showAndFocusWindow();
        if (mainWindow) {
          mainWindow.webContents.send('tray-open-settings');
        }
      }
    };
    const helpSubmenu = {
      role: 'help',
      submenu: [
        { label: 'Learn More', click: () => shell.openExternal('https://github.com/stenolabs/stenoai') },
        { label: 'Report a Bug', click: () => shell.openExternal('https://discord.gg/DZ6vcQnxxu') }
      ]
    };
    const appMenu = Menu.buildFromTemplate(
      process.platform === 'darwin'
        ? [
            {
              // Custom appMenu to add Settings… with the conventional ⌘,
              // shortcut (the default `{ role: 'appMenu' }` omits Settings).
              label: app.name,
              submenu: [
                { role: 'about' },
                { type: 'separator' },
                settingsItem,
                { type: 'separator' },
                { role: 'services' },
                { type: 'separator' },
                { role: 'hide' },
                { role: 'hideOthers' },
                { role: 'unhide' },
                { type: 'separator' },
                { role: 'quit' }
              ]
            },
            { role: 'fileMenu' },
            { role: 'editMenu' },
            { role: 'viewMenu' },
            { role: 'windowMenu' },
            helpSubmenu
          ]
        : [
            { label: '&File', submenu: [settingsItem, { type: 'separator' }, { role: 'quit' }] },
            { role: 'editMenu' },
            { role: 'viewMenu' },
            { role: 'windowMenu' },
            helpSubmenu
          ]
    );
    Menu.setApplicationMenu(appMenu);

    if (process.platform === 'darwin') {
      try {
        const osVer = process.getSystemVersion();
        const tapOk = isCoreAudioTapSupported();
        sendDebugLog(`[sysaudio] macOS ${osVer} — CoreAudio Tap supported=${tapOk}`);
      } catch (e) {
        sendDebugLog(`[sysaudio] startup probe failed: ${e.message}`);
      }
    }


    // Dev runs otherwise show the default Electron dock icon. Packaged builds
    // already get this icon via electron-builder's `mac.icon` setting.
    if (!app.isPackaged && process.platform === 'darwin' && app.dock) {
      try {
        app.dock.setIcon(path.join(__dirname, 'build', 'icon-dragonfly.icns'));
      } catch (e) {
        console.error('Failed to set dev dock icon:', e.message);
      }
    }

    // Pre-load Parakeet weights in a background subprocess so the first
    // recording's `record --live` / `transcribe-stream` spawn sees the
    // model file already in the OS page cache. Saves ~1 s off the
    // visible "first record after launch" latency. Fire-and-forget —
    // never block window creation on it. Skipped for Whisper users
    // (Parakeet model would be downloading or absent) and gated on
    // model presence by the CLI command itself (no-ops when missing).
    // Skipped under E2E so the mock-IPC (T1) and real-backend (T2) tiers stay
    // hermetic — no stray backend subprocess touching the temp data dir.
    if (!IS_E2E && loadTranscriptionEngine() === 'parakeet') {
      lastParakeetWarmupAt = Date.now();
      spawnParakeetWarmup();
    }

    // Register the global hotkey for toggle recording, unless the user turned
    // it off in Settings. CommandOrControl resolves per-platform (Cmd on
    // macOS, Ctrl on Windows/Linux). Gate on the persisted preference read
    // directly from config.json — absence of the key = ON (back-compat).
    // MUST run before createWindow(): the renderer queries get-record-hotkey
    // on mount and caches { registered }, so registering only after the
    // slow awaits below would report a transient registered:false as a
    // registration failure ("couldn't register" hint, hidden shortcut copy).
    if (recordHotkeyEnabledFromDisk()) {
      if (applyRecordHotkey(true)) {
        console.log(`Global hotkey registered: ${RECORD_HOTKEY_ACCEL}`);
      } else {
        console.error(`Failed to register global hotkey: ${RECORD_HOTKEY_ACCEL}`);
      }
    } else {
      console.log('Global record hotkey disabled by preference — not registering');
    }

    createWindow();
    if (!IS_E2E && loadShowMenuBarIconEnabled()) createTray();
    setupAutoUpdater();
    setupAutoMeetingDetector();
    setupDevNotificationTriggers();
    // Pre-meeting heads-up scheduler (calendar-time based). Skipped under E2E —
    // tests drive the show-premeeting-notification IPC seam directly; this would
    // otherwise start a background calendar poll.
    if (!IS_E2E) startPreMeetingScheduler();

    // Hard lock: reconcile ai_provider with the org session once at startup
    // (belt-and-braces for tray-only starts; the sidebar's org-status call
    // triggers the same coalesced reconcile). Fire-and-forget. Skipped under
    // E2E — it spawns the backend, and the test tiers drive provider state via
    // mock IPC (T1) or on-demand IPC handlers (T2), keeping startup hermetic.
    if (!IS_E2E) reconcileAiProviderWithOrgSession().catch(() => {});

    // Auto-pause active recordings when the machine sleeps (lid close etc.)
    // and offer a Resume prompt on wake — see autoPauseForSleep. Processing
    // watchdogs are frozen across the sleep so their deadline can't elapse
    // while the subprocess is suspended — see makeInactivityWatchdog.
    powerMonitor.on('suspend', autoPauseForSleep);
    powerMonitor.on('suspend', freezeInactivityWatchdogsForSleep);
    powerMonitor.on('resume', promptResumeAfterWake);
    powerMonitor.on('resume', thawInactivityWatchdogsAfterWake);
    // Re-evaluate the idle auto-install gate when the machine wakes or the
    // screen unlocks — a downloaded update can then install the moment the
    // user has stepped away, without waiting for the next 60s tick. Cheap and
    // self-guarding (no-ops unless an update is staged). E2E-gated so the test
    // suite never even wires it (belt-and-braces with the gate's own guards).
    if (!IS_E2E) {
      powerMonitor.on('lock-screen', () => { maybeAutoInstallWhenIdle().catch(() => {}); });
      powerMonitor.on('resume', () => { maybeAutoInstallWhenIdle().catch(() => {}); });
    }
    const protocolRegistered = registerShortcutProtocolClient();
    sendDebugLog(`Protocol handler registration (${SHORTCUT_PROTOCOL}): ${protocolRegistered}`);

    // Load hide-dock-icon preference and apply. Skipped under E2E (spawns the
    // backend; the test tiers don't exercise the dock-icon preference).
    if (!IS_E2E && process.platform === 'darwin' && app.dock) {
      try {
        const dockResult = await new Promise((resolve, reject) => {
          const proc = spawn(getBackendPath(), ['get-dock-icon'], {
            cwd: getBackendCwd()
          });
          let stdout = '';
          proc.stdout.on('data', (data) => { stdout += data.toString(); });
          proc.on('close', (code) => {
            if (code === 0) resolve(stdout);
            else reject(new Error(`get-dock-icon exited with code ${code}`));
          });
          proc.on('error', reject);
        });

        const dockConfig = JSON.parse(dockResult.trim());
        if (dockConfig.hide_dock_icon) {
          app.dock.hide();
          console.log('Dock icon hidden (menu bar only mode)');
        }
      } catch (e) {
        console.error('Failed to load dock icon preference:', e.message);
      }
    }

    // Re-apply the OS "launch on login" item on every startup from the
    // persisted preference (config.json read directly — no subprocess). This is
    // what makes the feature default-ON for everyone: new installs default true
    // and existing configs missing the key fall back to true (registering the
    // login item on this launch), while a user who turned it off persists false
    // and stays unregistered. Idempotent; no-op under E2E / dev (see helper).
    try {
      let launchOnLoginEnabled = true;
      const cfgPath = path.join(getUserDataDir(), 'config.json');
      if (fs.existsSync(cfgPath)) {
        const cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf-8'));
        launchOnLoginEnabled = cfg.launch_on_login !== false;
      }
      applyLoginItemSetting(launchOnLoginEnabled);
    } catch (e) {
      console.warn('Failed to apply launch-on-login setting at startup:', e?.message);
    }

    // Initialize telemetry and track app open. Tag the launch context so
    // hidden background auto-launches (which fire on every login/reboot) are
    // filterable and don't inflate DAU/funnels — filter hidden=false (or
    // launch_source='user') for a true "engaged open" metric.
    await initTelemetry();
    trackEvent('app_opened', {
      launch_source: launchedHidden ? 'login-item' : 'user',
      hidden: launchedHidden,
    });
    checkForOrphanedRecording();

    // Sweep orphaned live-transcript snapshot temp files (#259). The primary
    // cleanup is the finally-unlink in processNextInQueue, but a quit/crash
    // while a job is still QUEUED never runs it, leaking stenoai-live-*.txt in
    // the temp dir. The processing queue is purely in-memory (`processingQueue`
    // / `currentProcessingJob` are `let` state, and the on-disk
    // `.recording-active` marker holds only a timestamp), so at startup NO job
    // can reference a snapshot — the keep-set is built defensively from live
    // queue state (empty here) to stay correct if requeue-on-restart is ever
    // added. The age guard is what prevents racing a snapshot a concurrent
    // startup path is still enqueuing. Best-effort: never blocks launch.
    try {
      const keepPaths = new Set(
        processingQueue
          .map((job) => job && job.liveTranscriptFile)
          .concat(currentProcessingJob && currentProcessingJob.liveTranscriptFile)
          .filter(Boolean),
      );
      const { deleted } = sweepOrphanedLiveSnapshots({
        tmpDir: os.tmpdir(),
        keepPaths,
      });
      if (deleted.length > 0) {
        sendDebugLog(`Swept ${deleted.length} orphaned live-transcript snapshot(s)`);
      }
    } catch (e) {
      console.warn('Live-snapshot sweep failed (non-fatal):', e?.message);
    }

    // Load custom storage path for file validation. Skipped under E2E (spawns
    // the backend; the test tiers keep startup backend-free).
    if (!IS_E2E) {
      try {
        const spResult = await runPythonScript('simple_recorder.py', ['get-storage-path'], true);
        const spData = JSON.parse(spResult.trim());
        if (spData.storage_path) {
          _cachedCustomStoragePath = spData.storage_path;
          console.log('Custom storage path loaded:', _cachedCustomStoragePath);
        }
      } catch (e) {
        // Non-fatal - custom path just won't be cached
      }
    }

    // Recover any soft-deleted notes whose undo window was cut short by a crash
    // (#234): a hidden summary still under output/.pending-delete/ is renamed back
    // so the note REAPPEARS (fail-safe — a lost window never vanishes a note).
    // Best-effort — a failure here must never block launch. Cross-platform;
    // getUserDataDir() honors STENOAI_USER_DATA_DIR so tests/e2e stay isolated.
    // MUST run AFTER the custom storage path load above: recovery scans every
    // getAllowedBaseDirs() output/ dir, and that list only includes the custom
    // storage path once _cachedCustomStoragePath is set — sweeping earlier would
    // miss a custom-storage user's hidden summaries, leaving a crash-orphaned
    // note invisible (effectively lost) instead of restoring it.
    try {
      recoverPendingDeletesOnLaunch();
    } catch (e) {
      console.warn('pending-delete recovery on launch failed (non-fatal):', e?.message);
    }

    // Load the Obsidian sync config into the engine's cache (so per-note hooks
    // never shell Python) and reconcile any index drift from changes made while
    // the app was closed (#413). After the storage-path + pending-delete steps
    // so getAllowedBaseDirs() is complete. Best-effort — never blocks launch.
    try {
      const [osEnabled, osVault] = await Promise.all([
        runPythonScript('simple_recorder.py', ['get-obsidian-sync'], true),
        runPythonScript('simple_recorder.py', ['get-obsidian-vault-path'], true),
      ]);
      obsidianSync.setCachedConfig({
        enabled: !!JSON.parse(osEnabled.trim()).obsidian_sync_enabled,
        vaultPath: JSON.parse(osVault.trim()).obsidian_vault_path || '',
      });
      // Fire-and-forget: reconcile yields internally, so it must not block the
      // awaited launch sequence.
      obsidianSync.reconcileOnLaunch().catch(() => {});
    } catch (e) {
      console.warn('Obsidian sync init failed (non-fatal):', e?.message);
    }

    // Clear any .import reservation markers orphaned by a crash mid-import. No
    // import is in flight at startup, so a leftover marker is always stale and
    // would otherwise force every future import of that stem to bump to -N.
    // MUST run after the custom storage path is loaded above: resolveRecordingsDir()
    // keys off _cachedCustomStoragePath, so sweeping earlier would scan the
    // default dir and miss a custom-storage user's recordings/ entirely.
    await sweepStaleImportMarkers();

    // Instant-stop recovery: clear any `processing: true` left on a note by an
    // app quit mid-pipeline (the child died with it). No queue is active at
    // startup, so any such flag is stale — leaving it would strand the note
    // "finishing up" forever. MUST run after the custom storage path load above
    // for the same reason as the import sweep: getOutputDir() keys off
    // _cachedCustomStoragePath, so sweeping earlier scans the default output
    // dir and misses a custom-storage user's notes entirely. Deferred off the
    // critical path so the per-note frontmatter scan never delays first paint.
    setImmediate(sweepStuckProcessingFlags);

    if (pendingShortcutUrls.length > 0) {
      const urlsToProcess = [...pendingShortcutUrls];
      pendingShortcutUrls = [];

      for (const shortcutUrl of urlsToProcess) {
        await handleShortcutUrl(shortcutUrl);
      }
    }
  });

  // Fallback for launch contexts where deep-link may arrive via argv instead of open-url.
  if (process.platform === 'darwin') {
    const argvShortcutUrl = extractShortcutUrlFromArgv(process.argv);
    if (argvShortcutUrl) {
      pendingShortcutUrls.push(argvShortcutUrl);
      launchedByShortcut = true;
    }
  }

  app.on('will-quit', async () => {
    globalShortcut.unregisterAll();
    if (tray) {
      tray.destroy();
      tray = null;
    }
    // Kill Ollama on quit. The process may have been started by Electron or
    // the Python backend — both write the PID to ollama.pid in _internal/.
    // killProcessTree tears down ollama's child runner subprocesses too, so
    // they don't orphan on Windows.
    const pidFile = path.join(getBackendCwd(), '_internal', 'ollama.pid');
    try {
      const pid = parseInt(require('fs').readFileSync(pidFile, 'utf8').trim(), 10);
      if (pid) killProcessTree(pid);
      require('fs').unlinkSync(pidFile);
    } catch (_) {}
    // Also kill if Electron spawned it directly
    if (ollamaPid) {
      killProcessTree(ollamaPid);
      ollamaPid = null;
    }
    // Commit every pending soft-delete synchronously (#234): the undo window ends
    // at quit, so a still-pending delete becomes permanent. Sync-only (Electron
    // does not await quit handlers). A crash that skips this leaves hidden
    // summaries that startup recovery turns back into notes (fail-safe).
    try {
      commitAllPendingDeletesSync();
    } catch (_) {}
    // Drain the teardown registry (RFC #327 ground rule 4) BEFORE the async
    // telemetry shutdown — Electron does not await quit handlers, so work after
    // the first await is not a reliable barrier. Synchronous + idempotent;
    // no-op until domains register disposers.
    teardown.drain();
    await shutdownTelemetry();
  });

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') {
      app.quit();
    }
  });

  app.on('activate', () => {
    // macOS can deliver 'activate' before Electron's own 'ready' event fires
    // (e.g. cold launch via Dock). The whenReady().then() path below already
    // creates the initial window once ready, so just no-op here until then -
    // mirrors the same guard already used in the second-instance/open-url
    // handlers above.
    if (!app.isReady()) return;
    rewarmParakeet('activate');
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      // Only show if the window has finished its initial load.
      // On first launch, windowReadyToShow is false until React mounts.
      if (windowReadyToShow) {
        exposeMainWindow();
      }
      launchedByShortcut = false;
    } else {
      launchedByShortcut = false;
      createWindow();
    }
  });

  // Renderer/child-process crashes aren't caught by the main-process
  // uncaughtException handler above -- Electron surfaces them here instead.
  // Same telemetry gate, same "code not content" reasoning; see the
  // uncaughtException handler's comment for the capture-reliability caveat.
  app.on('render-process-gone', (_event, _webContents, details) => {
    try {
      if (telemetryEnabled && posthogClient && anonymousId) {
        captureSanitizedException(
          posthogClient,
          new Error(`render-process-gone: ${details?.reason || 'unknown'}`),
          anonymousId
        );
      }
    } catch (_) {}
  });

  app.on('child-process-gone', (_event, details) => {
    try {
      if (telemetryEnabled && posthogClient && anonymousId) {
        captureSanitizedException(
          posthogClient,
          new Error(`child-process-gone: ${details?.type || 'unknown'} (${details?.reason || 'unknown'})`),
          anonymousId
        );
      }
    } catch (_) {}
  });
}

// Focus window handler (used by notification click to bring app to foreground)
ipcMain.on('focus-window', () => {
    exposeMainWindow();
});

ipcMain.on('shortcut-renderer-ready', () => {
  rendererShortcutReady = true;
  flushShortcutQueue();
});

// Microphone permission handlers.
// systemPreferences.getMediaAccessStatus / askForMediaAccess are macOS-only.
// On Windows and Linux the OS handles mic permission at the WASAPI/ALSA layer
// and there is no programmatic prompt — report 'granted' so the renderer
// stops gating recording on a permission that doesn't exist.
ipcMain.handle('check-microphone-permission', async () => {
  try {
    if (process.platform !== 'darwin') {
      return { success: true, status: 'granted' };
    }
    const status = systemPreferences.getMediaAccessStatus('microphone');
    console.log('Microphone permission status:', status);
    return { success: true, status };
  } catch (error) {
    console.error('Error checking microphone permission:', error);
    return { success: false, error: error.message };
  }
});

ipcMain.handle('request-microphone-permission', async () => {
  try {
    if (process.platform !== 'darwin') {
      return { success: true, granted: true };
    }
    console.log('Requesting microphone permission...');
    const granted = await systemPreferences.askForMediaAccess('microphone');
    console.log('Microphone permission granted:', granted);
    return { success: true, granted };
  } catch (error) {
    console.error('Error requesting microphone permission:', error);
    return { success: false, error: error.message };
  }
});

// Reports whether system-audio capture is available on this OS. Used by
// Settings to disable the toggle on unsupported macOS / non-mac platforms.
ipcMain.handle('get-system-audio-support', async () => {
  try {
    const supported = isSystemAudioSupported();
    // Windows loopback works but is pending hardware verification, so the UI
    // labels it experimental and ships it opt-in (default off).
    const experimental = process.platform === 'win32';
    let osVersion = '';
    if (process.platform === 'darwin') {
      try { osVersion = process.getSystemVersion(); } catch (_) {}
    } else {
      try { osVersion = process.getSystemVersion(); } catch (_) {}
    }
    return {
      success: true,
      supported,
      experimental,
      platform: process.platform,
      osVersion,
    };
  } catch (error) {
    return { success: false, error: error.message };
  }
});

// Debug functionality handled by side panel now

// Backend communication - always uses bundled stenoai executable
// runPythonScript is provided by createBackendCli(...) wired near the top of
// this file (verbatim body moved to ./backend-cli).

// Recovers a graceful {"success": false, "error": ...} a CLI command printed
// to stdout right before exiting non-zero (see runPythonScript's err.stdout
// above) -- without this, a real "already exists"/"not found" message gets
// discarded in favor of a generic "Python script failed with code 1: <stderr>"
// wrapper that's useless to a human. Falls back to that generic message when
// stdout wasn't valid JSON (an actual crash, not a graceful failure).
function parsePythonFailureJson(error) {
  try {
    const parsed = JSON.parse(error.stdout || '');
    if (parsed && typeof parsed === 'object' && parsed.success === false) return parsed;
  } catch (_) {
    // stdout wasn't JSON -- fall through to the generic error below.
  }
  return { success: false, error: error.message };
}

async function getBackendStatusInternal(silent = true) {
  const result = await runPythonScript('simple_recorder.py', ['status'], silent);
  return { success: true, status: result };
}

async function handleGetStatus() {
  try {
    return await getBackendStatusInternal(true); // Silent mode
  } catch (error) {
    return { success: false, error: error.message };
  }
}

async function handleGetNotifications() {
  try {
    const result = await runPythonScript('simple_recorder.py', ['get-notifications']);
    const jsonData = JSON.parse(result);

    return {
      success: true,
      ...jsonData
    };
  } catch (error) {
    sendDebugLog(`Error getting notification settings: ${error.message}`);
    return { success: false, error: error.message };
  }
}

async function handleGetPremeetingNotifications() {
  try {
    const result = await runPythonScript('simple_recorder.py', ['get-premeeting-notifications']);
    const jsonData = JSON.parse(result);

    return {
      success: true,
      ...jsonData
    };
  } catch (error) {
    sendDebugLog(`Error getting pre-meeting notification settings: ${error.message}`);
    return { success: false, error: error.message };
  }
}

ipcMain.handle('get-status', handleGetStatus);

ipcMain.handle('process-recording', async (event, audioFile, sessionName) => {
  try {
    // Route imported files through the same processing queue a stopped
    // recording uses, instead of a blocking synchronous run. The import then
    // surfaces as a processing row (badge + auto-refresh on completion) in
    // the meeting list and survives the trigger popover closing, rather than
    // showing no progress until it finishes. addToProcessingQueue spawns
    // process-streaming (already captured by the #224 processing-log via its
    // 'process-streaming' label), serialises behind any in-flight job, and
    // emits 'processing-complete' when done.
    //
    // Security: this handler imports a USER-PICKED file (native dialog OR
    // drag-drop → webUtils.getPathForFile), so — unlike the meeting-file
    // handlers — we deliberately can't require containment in
    // getAllowedBaseDirs: importing an external ~/Desktop/interview.m4a is the
    // whole point. The path is still renderer-supplied, though, so harden the
    // trust boundary: resolve symlinks, then require a REGULAR FILE with a
    // supported audio extension. This rejects directories, device/FIFO/socket
    // special files (copyFile on which could hang or exhaust disk) and non-audio
    // arbitrary-read targets like /etc/passwd — the same constraints the picker
    // dialog filter and drag-drop isAudioFile() already apply upstream, now also
    // enforced where the renderer's trust actually crosses into main.
    if (!audioFile || typeof audioFile !== 'string') {
      return { success: false, error: 'Invalid file path' };
    }
    let realAudioFile;
    try {
      // realpath (not just resolve) follows symlinks to the true target, so the
      // isFile()/extension checks and the copy all act on the same real file.
      realAudioFile = await fs.promises.realpath(path.resolve(audioFile));
      const stat = await fs.promises.stat(realAudioFile);
      if (!stat.isFile()) {
        return { success: false, error: 'Invalid file path' };
      }
    } catch {
      return { success: false, error: 'Audio file not found' };
    }
    const ext = path.extname(realAudioFile).slice(1).toLowerCase();
    if (!IMPORT_AUDIO_EXTENSIONS.includes(ext)) {
      return { success: false, error: 'Unsupported file type' };
    }

    // Copy the import into our recordings/ dir first: process-streaming
    // unlinks the source after a successful transcribe (keep_recordings
    // defaults off), so queueing the user's original path would delete it.
    const queuedFile = await copyImportIntoRecordings(realAudioFile);
    addToProcessingQueue(queuedFile, sessionName, null);
    return { success: true };
  } catch (error) {
    trackEvent('error_occurred', { error_type: 'process_recording', reason: classifyErrorReason(error) });
    return { success: false, error: error.message };
  }
});

ipcMain.handle('test-system', async () => {
  try {
    const result = await runPythonScript('simple_recorder.py', ['test']);
    return { success: true, result: result };
  } catch (error) {
    return { success: false, error: error.message };
  }
});

// Audio/video container formats the backend (librosa/ffmpeg) can decode.
// MUST stay in sync with AUDIO_EXTENSIONS in
// app/renderer/src/hooks/useImportAudio.ts — the picker (here) and drag-drop
// (there) live in different processes, so the list is mirrored rather than
// shared. Keep both edits together.
const IMPORT_AUDIO_EXTENSIONS = [
  'wav', 'mp3', 'm4a', 'aac', 'webm', 'aiff', 'aif', 'flac', 'ogg', 'caf',
  'mp4', 'mov',
];

ipcMain.handle('select-audio-file', async () => {
  const result = await dialog.showOpenDialog(mainWindow, {
    properties: ['openFile'],
    filters: [
      { name: 'Audio Files', extensions: IMPORT_AUDIO_EXTENSIONS }
    ]
  });

  if (!result.canceled && result.filePaths.length > 0) {
    return { success: true, filePath: result.filePaths[0] };
  }

  return { success: false, error: 'No file selected' };
});

ipcMain.handle('list-meetings', async () => {
  try {
    const result = await runPythonScript('simple_recorder.py', ['list-meetings'], true); // Silent mode
    return { success: true, meetings: JSON.parse(result) };
  } catch (error) {
    return { success: false, error: error.message };
  }
});

// Parse a legacy .md meeting file into the standard meeting dict. Mirrors
// simple_recorder._parse_meeting_markdown so the detail page can render .md
// meetings without a Python round-trip. Returns the FULL data (transcript
// included) — the size-stripping that list-meetings does is intentionally
// not applied here because the detail page needs the transcript.
async function readReportsSidecar(meetingPath, allowedOutputDirs) {
  // Derive sidecar path: <stem>_summary.(md|json) → <stem>_reports.json
  const ext = path.extname(meetingPath); // '.md' or '.json'
  const base = path.basename(meetingPath, ext); // e.g. '20240101_120000_summary'
  const dir = path.dirname(meetingPath);
  // Strip trailing '_summary' if present (handles both naming conventions)
  const stem = base.endsWith('_summary') ? base.slice(0, -'_summary'.length) : base;
  const sidecarPath = path.join(dir, `${stem}_reports.json`);
  try {
    // Path containment (mirrors get-meeting): the derived '_reports.json' is
    // read directly, so a symlinked sidecar could otherwise escape the allowed
    // output tree. Resolve its REAL path and require it to live under one of the
    // same allowed output dirs the meeting passed. realpath needs the file to
    // exist; a missing sidecar -> caught below -> empty result.
    const realSidecar = await fs.promises.realpath(path.resolve(sidecarPath));
    const allowed = Array.isArray(allowedOutputDirs)
      && allowedOutputDirs.some(b => b && realSidecar.startsWith(b));
    if (!allowed) {
      return { reports: [], active_report: null };
    }
    const raw = await fs.promises.readFile(realSidecar, 'utf-8');
    const data = JSON.parse(raw);
    return {
      reports: Array.isArray(data.reports) ? data.reports : [],
      active_report: data.active_report ?? null,
    };
  } catch {
    return { reports: [], active_report: null };
  }
}

// Port of simple_recorder._REASONING_TAG_HEADER_PATTERN / _normalize_markdown_for_parsing.
// A reasoning-model summary can emit its closing think tag inline with the first
// header (e.g. `</thought>## Summary`); without a break the section-splitter never
// sees the `## ` at line start and drops the whole summary. This pushes the header
// onto its own line before splitting. Scoped to think/thought/thinking/reasoning so
// unrelated inline markup can't trigger a spurious break.
//   Kept equivalent to the Python side for the ASCII tags + whitespace that
//   actually occur in model output (same tag set: `i` = Python re.IGNORECASE,
//   `g` = re.sub replaces all occurrences, `\s` spans the space/newline between
//   tag and header). JS and Python `\s`/IGNORECASE differ only on exotic Unicode
//   whitespace and non-ASCII case folds, which don't appear here. Any edit MUST
//   be mirrored in simple_recorder._normalize_markdown_for_parsing (see #346).
const REASONING_TAG_HEADER_PATTERN = /(<\/(?:think|thought|thinking|reasoning)>)\s*(#{1,6}\s)/gi;

function normalizeMarkdownForParsing(mdText) {
  // Ensure headers immediately following a reasoning tag start on a new line.
  return mdText.replace(REASONING_TAG_HEADER_PATTERN, '$1\n$2');
}

// Mirrors simple_recorder._parse_meeting_markdown so the detail page (get-meeting)
// can render .md meetings without a Python round-trip. The two parsers MUST stay
// byte-for-byte equivalent on everything they surface into session_info / the
// meeting dict — they drift silently otherwise (see #346, and #313 for a prior
// drift). Any change here has to land in _parse_meeting_markdown too.
function parseMeetingMarkdown(content, mdPath) {
  // Split frontmatter
  const meta = {};
  let body = content;
  if (content.startsWith('---')) {
    const parts = content.split('---');
    // content.split('---', 2) in Python keeps the remainder; replicate by
    // re-joining everything after the second delimiter.
    if (parts.length >= 3) {
      const fmText = parts[1].trim();
      body = parts.slice(2).join('---').trim();
      for (const line of fmText.split('\n')) {
        const colon = line.indexOf(':');
        if (colon === -1) continue;
        const key = line.slice(0, colon).trim();
        let value = line.slice(colon + 1).trim();
        if (value.startsWith('"') && value.endsWith('"')) {
          value = value.slice(1, -1).replace(/\\(.)/g, '$1');
        } else if (value.startsWith('[')) {
          try {
            value = JSON.parse(value);
          } catch (_) {
            value = [];
          }
        } else if (value === 'null') {
          value = null;
        } else if (value === 'true') {
          value = true;
        } else if (value === 'false') {
          value = false;
        } else if (/^-?\d+$/.test(value)) {
          value = parseInt(value, 10);
        }
        meta[key] = value;
      }
    }
  }

  body = normalizeMarkdownForParsing(body);

  // Parse markdown body into sections keyed by lowercased `## ` heading.
  const sections = {};
  let currentSection = null;
  let currentLines = [];
  for (const line of body.split('\n')) {
    if (line.startsWith('## ')) {
      if (currentSection) sections[currentSection] = currentLines.join('\n').trim();
      currentSection = line.slice(3).trim().toLowerCase();
      currentLines = [];
    } else {
      currentLines.push(line);
    }
  }
  if (currentSection) sections[currentSection] = currentLines.join('\n').trim();

  const participants = sections.participants
    ? sections.participants.split(',').map((p) => p.trim()).filter(Boolean)
    : [];

  const keyPoints = [];
  if (sections['key points']) {
    for (let line of sections['key points'].split('\n')) {
      line = line.trim();
      if (line.startsWith('- ')) keyPoints.push(line.slice(2));
    }
  }

  const actionItems = [];
  if (sections['action items']) {
    for (let line of sections['action items'].split('\n')) {
      line = line.trim();
      if (line.startsWith('- ')) actionItems.push(line.slice(2).replace('[ ] ', '').replace('[x] ', ''));
    }
  }

  const discussionAreas = [];
  if (sections['key topics']) {
    let currentTopic = null;
    let topicLines = [];
    for (const line of sections['key topics'].split('\n')) {
      if (line.startsWith('### ')) {
        if (currentTopic) {
          discussionAreas.push({ title: currentTopic, analysis: topicLines.join('\n').trim() });
        }
        currentTopic = line.slice(4).trim();
        topicLines = [];
      } else {
        topicLines.push(line);
      }
    }
    if (currentTopic) {
      discussionAreas.push({ title: currentTopic, analysis: topicLines.join('\n').trim() });
    }
  }

  const stem = path.basename(mdPath).replace(/\.md$/, '');
  const sessionInfo = {
    name: meta.title || stem,
    processed_at: meta.date || '',
    duration_seconds: meta.duration_seconds ?? null,
    summary_file: mdPath,
    output_language: meta.language ?? null,
  };
  if (meta.transcription_failed) {
    sessionInfo.transcription_failed = true;
    sessionInfo.reprocessable = Boolean(meta.reprocessable);
    if (meta.audio_file) sessionInfo.audio_file = meta.audio_file;
    if (meta.error) sessionInfo.error = meta.error;
  }
  if (meta.notes_generated === false) {
    sessionInfo.notes_generated = false;
  }
  // Mirror the Python list parser (_parse_meeting_markdown): the detail page
  // needs these markers too, or its Generate-notes CTA / processing affordance
  // never fires. notes_stale drives the floating "Generate notes" CTA after a
  // continue-recording append; is_live_transcript flags a live-sourced note;
  // processing is the instant-stop "finishing up" placeholder state.
  if (meta.notes_stale) {
    sessionInfo.notes_stale = true;
  }
  if (meta.is_live_transcript) {
    sessionInfo.is_live_transcript = true;
  }
  if (meta.processing) {
    sessionInfo.processing = true;
  }

  return {
    session_info: sessionInfo,
    summary: sections.summary || '',
    participants,
    discussion_areas: discussionAreas,
    key_points: keyPoints,
    action_items: actionItems,
    transcript: sections.transcript || '',
    is_diarised: meta.is_diarised || false,
    diarised_text: meta.is_diarised ? sections.transcript || '' : null,
    user_notes: sections['user notes'] ?? null,
    folders: meta.folders || [],
  };
}

/**
 * Validate a renderer-supplied meeting summary path (symlink-safe containment).
 *
 * Returns { realPath, allowedOutputDirs } when `summaryFile` is a .md/.json that
 * resolves — with symlinks followed — into one of the app's known output/
 * directories, or { error } describing why it was rejected. Extracted from
 * get-meeting so every handler taking a summaryFile applies the SAME check:
 * realpath BOTH the target and each <baseDir>/output before the prefix test, so
 * a symlink planted inside an allowed dir can't escape the allowlist into an
 * arbitrary-file read/write (path.resolve only collapses '..', it does not
 * follow symlinks), while a legitimately symlinked base dir (macOS
 * /tmp -> /private/tmp, which the e2e temp data dir uses) still matches. The
 * output/ scoping + extension gate also stop a renderer-controlled path to some
 * other JSON inside an allowed root from being treated as a meeting file.
 * Callers MUST use the returned realPath downstream (backend CLI args, file
 * reads) rather than the original string, so the thing validated is the thing
 * used. realpath needs the path to exist; a missing target -> denied.
 */
async function validateMeetingFilePath(summaryFile) {
  // Reject non-strings up front: the renderer is untrusted and could pass an
  // object/number, on which `.endsWith` would THROW a TypeError — turning this
  // async function into a rejected promise that an un-try-wrapped `await` (e.g.
  // the query-transcript-stream listener) would surface as an unhandled
  // rejection. Fail closed with the same error shape as any other bad path.
  if (typeof summaryFile !== 'string' || (!summaryFile.endsWith('.json') && !summaryFile.endsWith('.md'))) {
    return { error: 'Invalid file path' };
  }
  let realPath;
  try {
    realPath = await fs.promises.realpath(path.resolve(summaryFile));
  } catch {
    return { error: 'Access denied' };
  }
  const allowedOutputDirs = await Promise.all(
    getAllowedBaseDirs().map(async d => {
      try {
        return (await fs.promises.realpath(path.resolve(d, 'output'))) + path.sep;
      } catch {
        return null; // output dir may not exist yet
      }
    }),
  );
  const allowed = allowedOutputDirs.some(base => base && realPath.startsWith(base));
  if (!allowed) {
    return { error: 'Access denied' };
  }
  return { realPath, allowedOutputDirs };
}

ipcMain.handle('get-meeting', async (_event, summaryFile) => {
  try {
    const validated = await validateMeetingFilePath(summaryFile);
    if (validated.error) {
      return { success: false, error: validated.error };
    }
    const { realPath: realResolved, allowedOutputDirs } = validated;
    const content = await fs.promises.readFile(realResolved, 'utf-8');
    const summaryBase = path.basename(realResolved);
    const summarySuffix = summaryBase.endsWith('_summary.md')
      ? '_summary.md'
      : summaryBase.endsWith('_summary.json')
        ? '_summary.json'
        : null;
    let hasSpeakerSidecar = false;
    if (summarySuffix) {
      const meetingStem = summaryBase.slice(0, -summarySuffix.length);
      const speakerSidecarPath = path.join(path.dirname(realResolved), `${meetingStem}_speakers.json`);
      try {
        hasSpeakerSidecar = (await fs.promises.lstat(speakerSidecarPath)).isFile();
      } catch {
        hasSpeakerSidecar = false;
      }
    }
    if (summaryFile.endsWith('.md')) {
      // Legacy .md meetings are still listed by list-meetings, so their detail
      // pages route through here. Unlike the list payload, the detail page
      // needs the full data INCLUDING the transcript (for the AskBar /
      // TranscriptPanel), so we return everything parseMeetingMarkdown yields.
      const mdMeeting = parseMeetingMarkdown(content, realResolved);
      const mdSidecar = await readReportsSidecar(realResolved, allowedOutputDirs);
      return { success: true, meeting: { ...mdMeeting, has_speaker_sidecar: hasSpeakerSidecar, reports: mdSidecar.reports, active_report: mdSidecar.active_report } };
    }
    const jsonMeeting = JSON.parse(content);
    const jsonSidecar = await readReportsSidecar(realResolved, allowedOutputDirs);
    return { success: true, meeting: { ...jsonMeeting, has_speaker_sidecar: hasSpeakerSidecar, reports: jsonSidecar.reports, active_report: jsonSidecar.active_report } };
  } catch (error) {
    return { success: false, error: error.message };
  }
});

ipcMain.handle('clear-state', async () => {
  try {
    const result = await runPythonScript('simple_recorder.py', ['clear-state']);
    return { success: true, message: result };
  } catch (error) {
    return { success: false, error: error.message };
  }
});

ipcMain.handle('reprocess-meeting', async (event, summaryFile, regenerateTitle, sessionName, retranscribe) => {
  try {
    // Security: symlink-safe containment-check the renderer-supplied summary path
    // before it reaches the backend CLI, and pass the canonical realPath (not the
    // original string) downstream. Event/map keys stay keyed on the original
    // summaryFile — that's UI correlation the renderer matches on, not file access.
    const validated = await validateMeetingFilePath(summaryFile);
    if (validated.error) {
      return { success: false, error: validated.error };
    }
    const { realPath } = validated;

    const args = ['reprocess', realPath];
    if (regenerateTitle) args.push('--regenerate-title');
    // Re-transcribe (#266): re-run ASR on the source recording with the current
    // settings before re-summarising. The backend emits HEARTBEAT:transcribe:*
    // during ASR, which the same inactivity watchdog below already resets on.
    if (retranscribe) args.push('--retranscribe');

    sendDebugLog(`🔄 Reprocessing meeting: ${summaryFile}`);
    sendDebugLog(`$ stenoai ${args.join(' ')}`);

    // Surface this reprocess as in-flight on the queue payload so the
    // renderer can show the existing meeting row with a processing badge
    // even when the user navigates away from MeetingDetail mid-reprocess.
    // Keyed by summaryFile in the activeReprocessJobs map so overlapping
    // reprocess calls (e.g. user reprocesses A then navigates and
    // reprocesses B before A finishes) coexist. Removed in the finally
    // block below so a Python crash or spawn error doesn't leave it
    // stuck.
    activeReprocessJobs.set(summaryFile, { summaryFile, sessionName: sessionName || null });

    const aiEnv = getAiEnv();
    const reprocessEnv = Object.keys(aiEnv).length > 0 ? { ...require('process').env, ...aiEnv } : undefined;

    await new Promise((resolve, reject) => {
      const proc = spawn(getBackendPath(), args, {
        cwd: getBackendCwd(),
        env: reprocessEnv
      });

      let stderrBuf = '';
      // Mirrors the main pipeline: true only if summarization actually ran
      // (STREAM_COMPLETE). "Generate notes" reprocess always summarises; a
      // retranscribe with auto_summarize off wouldn't, so track it rather than
      // assume. Threaded into processing-complete so the renderer fires
      // "Note ready" only when notes exist (#bug2).
      let summarizationCompleted = false;

      // Liveness watchdog — see makeInactivityWatchdog. Summary CHUNK:
      // lines (and HEARTBEAT: lines if a retranscribe is ever added here)
      // keep resetting it, so only a genuinely hung process gets killed.
      const watchdog = makeInactivityWatchdog(proc, TRANSCRIBE_INACTIVITY_MS, 'reprocess');

      proc.on('error', (err) => {
        watchdog.clear();
        reject(new Error(`reprocess spawn error: ${err.message}`));
      });

      const stdoutReader = makeLineReader();
      proc.stdout.on('data', (data) => {
        watchdog.reset();
        for (const line of stdoutReader.feed(data)) {
          if (line.startsWith('CHUNK:')) {
            try {
              const encoded = line.slice(6);
              const chunk = Buffer.from(encoded, 'base64').toString('utf-8');
              if (mainWindow && !mainWindow.isDestroyed()) {
                mainWindow.webContents.send('summary-chunk', { chunk, sessionName, summaryFile });
              }
            } catch (e) { console.log('CHUNK decode error:', e.message); }
          } else if (line.startsWith('TITLE:')) {
            const title = line.slice(6);
            if (mainWindow && !mainWindow.isDestroyed()) {
              mainWindow.webContents.send('summary-title', { title, sessionName });
            }
          } else if (line === 'STREAM_COMPLETE') {
            summarizationCompleted = true;
            if (mainWindow && !mainWindow.isDestroyed()) {
              mainWindow.webContents.send('summary-complete', { success: true, sessionName, summaryFile });
            }
          } else if (line.startsWith('PROGRESS:')) {
            if (mainWindow && !mainWindow.isDestroyed()) {
              mainWindow.webContents.send('processing-progress', { line, summaryFile });
            }
          } else if (line.startsWith('STREAM_ERROR:')) {
            const errMsg = line.slice('STREAM_ERROR:'.length);
            sendDebugLog(`❌ Reprocess stream error: ${errMsg}`);
            if (mainWindow && !mainWindow.isDestroyed()) {
              mainWindow.webContents.send('summary-complete', { success: false, sessionName, summaryFile });
            }
          } else {
            // Unclassified stdout: forward only diagnostic markers, drop content.
            forwardDiagnosticStdout(line, 'reprocess');
          }
        }
      });

      proc.stderr.on('data', (data) => {
        watchdog.reset();
        const msg = data.toString().trim();
        if (msg) {
          stderrBuf += msg + '\n';
          sendDebugLog(`STDERR: ${msg}`);
        }
      });

      proc.on('close', (code) => {
        watchdog.clear();
        if (code === 0) {
          console.log(`✅ Completed reprocessing: ${sessionName}`);
          // Reprocess / generate-notes / re-transcribe rewrote the note — mirror
          // it into the vault (#413) if sync is on. Use the canonical realPath
          // (not the renderer alias) so it indexes under the true summary stem.
          try { if (realPath) obsidianSync.syncNoteBySummaryPath(realPath); } catch (_) {}
          // Look up the saved meeting so the completion event carries meetingData
          // with the note's CURRENT title — reprocess may have generated an LLM
          // title, so `sessionName` here can still be the 'Note' placeholder. The
          // renderer's note-ready notification reads meetingData.session_info.name
          // for its body; without this it falls back to the generic string and
          // the note title never shows. Mirrors the recording-complete path.
          runPythonScript('simple_recorder.py', ['list-meetings'], true)
            .then((meetingsResult) => {
              const allMeetings = JSON.parse(meetingsResult);
              const processedMeeting =
                allMeetings.find((m) => m.session_info?.summary_file === summaryFile) || null;
              if (mainWindow && !mainWindow.isDestroyed()) {
                mainWindow.webContents.send('processing-complete', {
                  success: true,
                  sessionName,
                  summaryFile,
                  meetingData: processedMeeting,
                  notesGenerated: summarizationCompleted,
                  message: 'Reprocessing completed successfully'
                });
              }
            })
            .catch((error) => {
              console.error('Error fetching reprocessed meeting:', error);
              // Fall back to firing without meetingData — the note-ready title
              // may be generic, but the note is still in the list + sidebar.
              if (mainWindow && !mainWindow.isDestroyed()) {
                mainWindow.webContents.send('processing-complete', {
                  success: true,
                  sessionName,
                  summaryFile,
                  notesGenerated: summarizationCompleted,
                  message: 'Reprocessing completed successfully'
                });
              }
            })
            .finally(() => resolve());
        } else {
          if (mainWindow && !mainWindow.isDestroyed()) {
            mainWindow.webContents.send('processing-complete', {
              success: false,
              sessionName,
              summaryFile,
              message: `Reprocessing failed (exit ${code})`,
            });
          }
          reject(new Error(`reprocess exited with code ${code}: ${stderrBuf.slice(-500)}`));
        }
      });
    });

    sendDebugLog('✅ Meeting reprocessed successfully');
    return { success: true };
  } catch (error) {
    sendDebugLog(`❌ Reprocessing failed: ${error.message}`);
    return { success: false, error: error.message };
  } finally {
    activeReprocessJobs.delete(summaryFile);
  }
});

// Re-transcribe availability (#266): report whether the source recording for a
// note still exists on disk, so the renderer can offer "Re-transcribe" only when
// re-running ASR is actually possible (keep-recordings was on). Read-only.
ipcMain.handle('recording-available', async (event, summaryFile) => {
  try {
    // Same containment check the reprocess path uses — the renderer is untrusted.
    const validated = await validateMeetingFilePath(summaryFile);
    if (validated.error) {
      return { success: false, error: validated.error };
    }
    // Derive the recording stem from the note filename: <stem>_summary.{md,json}.
    const base = path.basename(validated.realPath).replace(/\.(md|json)$/, '');
    const stem = base.endsWith('_summary') ? base.slice(0, -'_summary'.length) : base;
    // The recording keeps the note's stem with an arbitrary extension (native
    // .wav, system-audio .webm, imported .m4a/.mp3), so match on stem, not glob.
    const recordingsDir = resolveRecordingsDir();
    let available = false;
    try {
      for (const dirent of fs.readdirSync(recordingsDir, { withFileTypes: true })) {
        // Require a regular file — matches the Python _find_recording_for_stem
        // is_file() check, so a directory named e.g. `<stem>.wav` doesn't offer
        // a re-transcribe that then fails with RETRANSCRIBE_NO_AUDIO (#266).
        if (!dirent.isFile()) continue;
        const name = dirent.name;
        const dot = name.lastIndexOf('.');
        const nameStem = dot > 0 ? name.slice(0, dot) : name;
        if (nameStem === stem) {
          available = true;
          break;
        }
      }
    } catch {
      available = false; // recordings dir may not exist yet
    }
    return { success: true, available };
  } catch (error) {
    return { success: false, error: error.message };
  }
});

ipcMain.handle('generate-report-meeting', async (event, summaryFile, templateId) => {
  // Security: symlink-safe containment-check the renderer-supplied summary path
  // before ANY use of it — including the sessionName read below, which opens the
  // file directly — and use the canonical realPath downstream. Event/map keys
  // stay keyed on the original summaryFile (UI correlation the renderer matches).
  const validated = await validateMeetingFilePath(summaryFile);
  if (validated.error) {
    return { success: false, error: validated.error };
  }
  const { realPath } = validated;

  // Resolve the sessionName from the meeting JSON so streaming events carry the
  // same key as the reprocess flow (keyed by sessionName, disambiguated by summaryFile).
  let sessionName = null;
  try {
    const fs = require('fs');
    const data = JSON.parse(fs.readFileSync(realPath, 'utf-8'));
    sessionName = data?.session_info?.name || null;
  } catch (_) { /* non-fatal — sessionName stays null */ }

  try {
    const args = ['generate-report', realPath, templateId];

    sendDebugLog(`📄 Generating report for: ${summaryFile} (template: ${templateId})`);
    sendDebugLog(`$ stenoai ${args.join(' ')}`);

    activeReprocessJobs.set(summaryFile, { summaryFile, sessionName });

    const aiEnv = getAiEnv();
    const reportEnv = Object.keys(aiEnv).length > 0 ? { ...require('process').env, ...aiEnv } : undefined;

    await new Promise((resolve, reject) => {
      const proc = spawn(getBackendPath(), args, {
        cwd: getBackendCwd(),
        env: reportEnv
      });

      let stderrBuf = '';

      const watchdog = makeInactivityWatchdog(proc, TRANSCRIBE_INACTIVITY_MS, 'generate-report');

      proc.on('error', (err) => {
        watchdog.clear();
        reject(new Error(`generate-report spawn error: ${err.message}`));
      });

      // Buffer across chunk boundaries (matching reprocess/process-streaming),
      // so a CHUNK:<base64 summary> line straddling two data events can't lose
      // its prefix and fall into the diagnostic fallback below.
      const stdoutReader = makeLineReader();
      proc.stdout.on('data', (data) => {
        watchdog.reset();
        for (const line of stdoutReader.feed(data)) {
          if (line.startsWith('CHUNK:')) {
            try {
              const encoded = line.slice(6);
              const chunk = Buffer.from(encoded, 'base64').toString('utf-8');
              if (mainWindow && !mainWindow.isDestroyed()) {
                mainWindow.webContents.send('summary-chunk', { chunk, sessionName, summaryFile });
              }
            } catch (e) { console.log('CHUNK decode error:', e.message); }
          } else if (line.startsWith('TITLE:')) {
            const title = line.slice(6);
            if (mainWindow && !mainWindow.isDestroyed()) {
              mainWindow.webContents.send('summary-title', { title, sessionName });
            }
          } else if (line === 'STREAM_COMPLETE') {
            if (mainWindow && !mainWindow.isDestroyed()) {
              mainWindow.webContents.send('summary-complete', { success: true, sessionName, summaryFile, report: true });
            }
          } else if (line.startsWith('PROGRESS:')) {
            if (mainWindow && !mainWindow.isDestroyed()) {
              mainWindow.webContents.send('processing-progress', { line, summaryFile });
            }
          } else if (line.startsWith('STREAM_ERROR:')) {
            const errMsg = line.slice('STREAM_ERROR:'.length);
            sendDebugLog(`❌ Report generation stream error: ${errMsg}`);
            if (mainWindow && !mainWindow.isDestroyed()) {
              mainWindow.webContents.send('summary-complete', { success: false, sessionName, summaryFile, report: true });
            }
          } else if (line.startsWith('SAVED:')) {
            sendDebugLog(`Report saved: ${line.slice(6).trim()}`);
          } else {
            // Unclassified stdout: forward only diagnostic markers, drop content.
            forwardDiagnosticStdout(line, 'generate-report');
          }
        }
      });

      proc.stderr.on('data', (data) => {
        watchdog.reset();
        const msg = data.toString().trim();
        if (msg) {
          stderrBuf += msg + '\n';
          sendDebugLog(`STDERR: ${msg}`);
        }
      });

      proc.on('close', (code) => {
        watchdog.clear();
        if (code === 0) {
          console.log(`✅ Completed report generation: ${sessionName}`);
          if (mainWindow && !mainWindow.isDestroyed()) {
            mainWindow.webContents.send('processing-complete', {
              success: true,
              sessionName,
              summaryFile,
              report: true,
              // A report is only ever generated for a note that already has
              // notes, so "notes exist" is true — preserves the pre-existing
              // note-ready behavior and keeps this off the transcript-only
              // "generate notes?" branch (#bug2).
              notesGenerated: true,
              message: 'Report generation completed successfully'
            });
          }
          resolve();
        } else {
          if (mainWindow && !mainWindow.isDestroyed()) {
            mainWindow.webContents.send('processing-complete', {
              success: false,
              sessionName,
              summaryFile,
              report: true,
              message: `Report generation failed (exit ${code})`,
            });
          }
          reject(new Error(`generate-report exited with code ${code}: ${stderrBuf.slice(-500)}`));
        }
      });
    });

    sendDebugLog('✅ Report generated successfully');
    return { success: true };
  } catch (error) {
    sendDebugLog(`❌ Report generation failed: ${error.message}`);
    return { success: false, error: error.message };
  } finally {
    activeReprocessJobs.delete(summaryFile);
  }
});

ipcMain.handle('set-active-report', async (_e, summaryFile, reportId) => {
  try {
    // Security: symlink-safe containment-check + canonical realPath. The backend's
    // report_store derives a <stem>_reports.json sidecar NEXT TO this path, so the
    // realpath'd, output-scoped path is what must be passed — not the raw string.
    const validated = await validateMeetingFilePath(summaryFile);
    if (validated.error) {
      return { success: false, error: validated.error };
    }
    const out = await runPythonScript('simple_recorder.py', ['set-active-report', validated.realPath, reportId]);
    return JSON.parse(out);
  } catch (error) { return { success: false, error: error.message }; }
});

ipcMain.handle('delete-report', async (_e, summaryFile, reportId) => {
  try {
    // Security: symlink-safe containment-check + canonical realPath. The backend's
    // report_store derives a <stem>_reports.json sidecar NEXT TO this path, so the
    // realpath'd, output-scoped path is what must be passed — not the raw string.
    const validated = await validateMeetingFilePath(summaryFile);
    if (validated.error) {
      return { success: false, error: validated.error };
    }
    const out = await runPythonScript('simple_recorder.py', ['delete-report', validated.realPath, reportId]);
    return JSON.parse(out);
  } catch (error) { return { success: false, error: error.message }; }
});

ipcMain.handle('regen-meeting-title', async (event, summaryFile, sessionName) => {
  try {
    // Security: symlink-safe containment-check the renderer-supplied summary path
    // and pass the canonical realPath to the backend CLI, not the raw string.
    const validated = await validateMeetingFilePath(summaryFile);
    if (validated.error) {
      return { success: false, error: validated.error };
    }
    const { realPath } = validated;

    // Register this job so isSummaryBusy() sees it: regen-title rewrites the
    // ORIGINAL summary path after a model wait, so a delete during that wait would
    // let the regen resurrect the summary while commit unlinks the hidden copy +
    // ancillaries = a resurrected note with lost audio. Keyed on the original
    // summaryFile (isSummaryBusy canonicalizes keys); cleared in the finally.
    activeReprocessJobs.set(summaryFile, { summaryFile, sessionName: sessionName || null });

    const aiEnv = getAiEnv();
    const regenEnv = Object.keys(aiEnv).length > 0 ? { ...require('process').env, ...aiEnv } : undefined;

    await new Promise((resolve, reject) => {
      const proc = spawn(getBackendPath(), ['regen-title', realPath], {
        cwd: getBackendCwd(),
        env: regenEnv,
      });

      let stderrBuf = '';
      const procTimeout = setTimeout(() => { proc.kill(); }, 2 * 60 * 1000);

      proc.on('error', (err) => { clearTimeout(procTimeout); reject(new Error(err.message)); });

      proc.stdout.on('data', (data) => {
        data.toString().split('\n').forEach((line) => {
          if (line.startsWith('TITLE:')) {
            const title = line.slice(6);
            if (mainWindow && !mainWindow.isDestroyed()) {
              mainWindow.webContents.send('summary-title', { title, sessionName });
            }
          }
        });
      });

      proc.stderr.on('data', (data) => { stderrBuf += data.toString(); });

      proc.on('close', (code) => {
        clearTimeout(procTimeout);
        if (code === 0) resolve();
        else reject(new Error(`regen-title exited with code ${code}: ${stderrBuf.slice(-300)}`));
      });
    });

    return { success: true };
  } catch (error) {
    return { success: false, error: error.message };
  } finally {
    activeReprocessJobs.delete(summaryFile);
  }
});

ipcMain.handle('query-transcript', async (event, summaryFile, question) => {
  try {
    sendDebugLog(`🤖 Querying transcript (${String(question || '').length} chars)`);

    // Security: the renderer is untrusted, so containment-check the summary path
    // (symlink-safe, output/ only) before it reaches the backend, and pass the
    // canonical realPath — not the original string — as the file arg.
    const validated = await validateMeetingFilePath(summaryFile);
    if (validated.error) {
      return { success: false, error: validated.error };
    }

    // Run the query command — getAiEnv supplies the right env for whichever
    // provider is active (cloud key for cloud, adapter url+token for org).
    const env = getAiEnv();
    const result = await runPythonScript('simple_recorder.py', ['query', validated.realPath, '-q', question], false, env);

    // Parse the JSON response
    try {
      const jsonResponse = JSON.parse(result.trim());
      if (jsonResponse.success) {
        sendDebugLog('✅ Query answered successfully');
        trackEvent('ai_query_used', {
          success: true,
          query_length: textLengthBucket(question),
          has_response: Boolean(jsonResponse.answer),
        });
        return { success: true, answer: jsonResponse.answer };
      } else {
        sendDebugLog(`❌ Query failed: ${jsonResponse.error}`);
        trackEvent('ai_query_used', { success: false, query_length: textLengthBucket(question), has_response: false });
        return { success: false, error: jsonResponse.error };
      }
    } catch (parseError) {
      // If parsing fails, check if the result contains any JSON
      const jsonMatch = result.match(/\{[\s\S]*\}/);
      if (jsonMatch) {
        const jsonResponse = JSON.parse(jsonMatch[0]);
        if (jsonResponse.success) {
          trackEvent('ai_query_used', {
            success: true,
            query_length: textLengthBucket(question),
            has_response: Boolean(jsonResponse.answer),
          });
          return { success: true, answer: jsonResponse.answer };
        } else {
          trackEvent('ai_query_used', { success: false, query_length: textLengthBucket(question), has_response: false });
          return { success: false, error: jsonResponse.error };
        }
      }
      sendDebugLog(`❌ Failed to parse query response: ${parseError.message}`);
      trackEvent('ai_query_used', { success: false, query_length: textLengthBucket(question), has_response: false });
      return { success: false, error: 'Failed to parse AI response' };
    }
  } catch (error) {
    sendDebugLog(`❌ Query failed: ${error.message}`);
    trackEvent('error_occurred', { error_type: 'query_transcript', reason: classifyErrorReason(error) });
    return { success: false, error: error.message };
  }
});

const activeQueryProcs = new Map();

// Cancellation intent for streaming queries that are still in their pre-spawn
// async window. query-transcript-stream now `await`s validateMeetingFilePath
// BEFORE it registers a killable proc in activeQueryProcs, so a query-cancel
// (or sender-destroy) arriving during that await would otherwise be LOST — the
// cancel finds nothing to kill, then the backend spawns uncancellable. Each
// in-flight validation registers a setter here keyed by queryId; query-cancel
// invokes it to flip the handler's `cancelled` flag, and the handler checks
// that flag on every exit path so it never spawns-then-orphans a proc.
const pendingQueryCancels = new Map();

ipcMain.on('query-cancel', (_event, queryId) => {
  const proc = activeQueryProcs.get(queryId);
  if (proc) {
    console.log(`[QUERY] Cancelling queryId=${queryId}`);
    proc.kill();
    activeQueryProcs.delete(queryId);
  }
  // Cancel a stream that's still validating (pre-spawn): flip its flag so the
  // handler bails out instead of spawning after the await resolves.
  const pending = pendingQueryCancels.get(queryId);
  if (pending) {
    console.log(`[QUERY] Cancelling pre-spawn queryId=${queryId}`);
    pending();
    pendingQueryCancels.delete(queryId);
  }
  // Org-chat streams use AbortController instead of a child process; share
  // the same query-cancel channel so the renderer doesn't have to know which
  // backend a given streamId belongs to.
  const ctrl = orgStreamAborters.get(queryId);
  if (ctrl) {
    console.log(`[ORG] Cancelling streamId=${queryId}`);
    try { ctrl.abort(); } catch (_) {}
    orgStreamAborters.delete(queryId);
  }
});

ipcMain.on('query-transcript-stream', async (event, queryId, summaryFile, question) => {
  console.log(`[QUERY] IPC received: question="${question.substring(0, 50)}" file="${summaryFile}"`);
  sendDebugLog(`🤖 Streaming query (${String(question || '').length} chars)`);
  const env = { ...process.env, ...getAiEnv() };

  // chat_message_sent restores visibility into single-meeting chat (dormant
  // since the old bare-ping ai_query_used stopped being reachable once chat
  // moved to this streaming IPC). Guarded by `tracked` because this handler
  // has multiple exit paths (line-based STREAM_COMPLETE/ERROR, the close
  // handler's buf-remainder fallback, and non-zero exit code) that can each
  // fire for the same logical query -- fire the analytics event exactly once.
  let tracked = false;
  let chunkCount = 0;
  const trackChatOnce = (success) => {
    if (tracked) return;
    tracked = true;
    trackEvent('chat_message_sent', {
      success,
      scope: 'single_meeting',
      query_length: textLengthBucket(question),
      has_response: chunkCount > 0,
    });
  };

  // Security: the renderer is untrusted, so containment-check the summary path
  // (symlink-safe, output/ only) BEFORE spawning the backend, and spawn with the
  // canonical realPath. The handler is async only to await this check — the spawn
  // still happens synchronously afterwards. The console.log/debug lines above may
  // keep logging the original string (a label); the spawn arg must be the realPath.
  //
  // Cancel-race guard: because we now `await` BEFORE registering a killable proc
  // in activeQueryProcs, a query-cancel during the await would be lost. Register
  // cancellation intent via pendingQueryCancels (see the query-cancel handler)
  // and honour the flag on every exit path so a cancel that lands mid-validation
  // aborts the query instead of spawning an uncancellable backend.
  let cancelled = false;
  pendingQueryCancels.set(queryId, () => { cancelled = true; });

  // Send query-done only if the renderer is still alive — event.sender.send
  // throws "Object has been destroyed" once the sender is gone. The try/catch is
  // belt-and-suspenders: isDestroyed() + send() run in the same synchronous tick
  // (no yield between them), but send can still throw for other reasons (e.g. the
  // frame went away), and a failure to notify must never crash the main process.
  const sendDone = (payload) => {
    try {
      if (!event.sender.isDestroyed()) event.sender.send('query-done', { queryId, ...payload });
    } catch (_) { /* renderer gone — nothing to notify */ }
  };
  // The renderer can also be destroyed DURING the pre-spawn await (window closed
  // or navigated away). The `destroyed` listener below is only wired up AFTER
  // spawn, and `.once('destroyed')` never fires for an event that already
  // happened — so a destroy mid-validation would spawn an orphaned, unobserved
  // backend. Treat "sender gone while validating" the same as a cancel: bail on
  // every pre-spawn exit path, and re-check immediately after spawn.
  const aborted = () => cancelled || event.sender.isDestroyed();

  let validated;
  try {
    validated = await validateMeetingFilePath(summaryFile);
  } catch (err) {
    // Defense-in-depth: validateMeetingFilePath is fail-closed and shouldn't
    // throw, but if it ever does (e.g. a future refactor), don't let it become
    // an unhandled rejection that can take down the main process.
    pendingQueryCancels.delete(queryId);
    sendDone({ success: false, error: 'Invalid file path' });
    trackChatOnce(false);
    return;
  }
  pendingQueryCancels.delete(queryId);

  if (validated.error) {
    sendDone({ success: false, error: validated.error });
    trackChatOnce(false);
    return;
  }
  if (aborted()) {
    // A cancel landed, or the renderer went away, while we were validating —
    // bail out before spawning an uncancellable / orphaned backend. A cancelled
    // query is not a completed "message sent", so (like the killed-proc close
    // path, code === null) it is deliberately left untracked.
    sendDone({ success: false, error: 'Cancelled' });
    return;
  }

  let proc;
  try {
    const backendPath = getBackendPath();
    proc = require('child_process').spawn(backendPath, ['query-streaming', validated.realPath, '-q', question], {
      env,
      cwd: getBackendCwd(),
      windowsHide: true,
    });
  } catch (err) {
    sendDone({ success: false, error: err.message });
    trackChatOnce(false);
    return;
  }

  activeQueryProcs.set(queryId, proc);
  // Belt-and-suspenders: a cancel or a sender-destroy could have flipped the
  // abort condition between the pre-spawn check and here. If the query is no
  // longer wanted, kill the freshly-spawned proc immediately so it can't be
  // orphaned (the pendingQueryCancels entry is already gone, and a destroy that
  // already fired won't reach the `destroyed` listener wired up below).
  if (aborted()) {
    proc.kill();
    activeQueryProcs.delete(queryId);
    sendDone({ success: false, error: 'Cancelled' });
    return;
  }
  // Kill the spawned proc if the renderer sender goes away before the query
  // finishes. Keep a reference so we can remove the listener on normal close
  // (otherwise repeated queries on a long-lived sender leak one-time listeners).
  const onSenderDestroyed = () => {
    if (activeQueryProcs.has(queryId)) {
      proc.kill();
      activeQueryProcs.delete(queryId);
    }
  };
  event.sender.once('destroyed', onSenderDestroyed);
  let buf = '';
  proc.stdout.on('data', (data) => {
    buf += data.toString();
    // Split on CRLF or LF: the backend's stdout is \r\n on Windows, and an exact
    // match below (=== 'STREAM_COMPLETE') would otherwise miss the trailing \r.
    const lines = buf.split(/\r?\n/);
    buf = lines.pop();
    for (const line of lines) {
      if (line.startsWith('CHAT_CHUNK:') || line.startsWith('CHUNK:')) {
        const prefixLen = line.startsWith('CHAT_CHUNK:') ? 11 : 6;
        try {
          const chunk = Buffer.from(line.slice(prefixLen), 'base64').toString('utf-8');
          chunkCount++;
          if (chunkCount === 1) console.log(`[QUERY] First chunk received (queryId=${queryId})`);
          if (!event.sender.isDestroyed()) event.sender.send('query-chunk', { queryId, chunk });
          else {
            console.log(`[QUERY] Sender destroyed, killing process queryId=${queryId}`);
            proc.kill();
            activeQueryProcs.delete(queryId);
          }
        } catch (e) { console.log(`[QUERY] Chunk decode error: ${e.message}`); }
      } else if (line === 'CHAT_STREAM_COMPLETE' || line === 'STREAM_COMPLETE') {
        console.log(`[QUERY] STREAM_COMPLETE received, ${chunkCount} chunks sent`);
        if (!event.sender.isDestroyed()) event.sender.send('query-done', { queryId, success: true });
        else console.log(`[QUERY] Sender destroyed at STREAM_COMPLETE`);
        trackChatOnce(true);
      } else if (line.startsWith('CHAT_STREAM_ERROR:') || line.startsWith('STREAM_ERROR:')) {
        const errMsg = line.startsWith('CHAT_STREAM_ERROR:') ? line.slice(18) : line.slice(13);
        console.log(`[QUERY] STREAM_ERROR: ${errMsg}`);
        if (!event.sender.isDestroyed()) event.sender.send('query-done', { queryId, success: false, error: errMsg });
        trackChatOnce(false);
      }
    }
  });

  proc.stderr.on('data', (data) => {
    const msg = data.toString().trim();
    if (msg) console.log(`[QUERY stderr] ${msg.substring(0, 200)}`);
  });

  proc.on('close', (code) => {
    activeQueryProcs.delete(queryId);
    if (!event.sender.isDestroyed()) {
      event.sender.removeListener('destroyed', onSenderDestroyed);
    }
    console.log(`[QUERY] Process closed, code=${code}, chunks=${chunkCount}, bufRemainder=${buf.length > 0 ? JSON.stringify(buf.substring(0, 100)) : 'empty'}`);
    if (buf.trim() === 'CHAT_STREAM_COMPLETE' || buf.trim() === 'STREAM_COMPLETE') {
      console.log(`[QUERY] STREAM_COMPLETE was in buf remainder — sending done now`);
      if (!event.sender.isDestroyed()) event.sender.send('query-done', { queryId, success: true });
      trackChatOnce(true);
    } else if (code !== 0 && code !== null && !event.sender.isDestroyed()) {
      // code === null means killed (cancelled) — renderer already handles that case
      event.sender.send('query-done', { queryId, success: false, error: `Process exited with code ${code}` });
      trackChatOnce(false);
    }
  });

  proc.on('error', (err) => {
    activeQueryProcs.delete(queryId);
    if (!event.sender.isDestroyed()) event.sender.send('query-done', { queryId, success: false, error: err.message });
    trackChatOnce(false);
  });
});

// Cross-note chat (Chat tab). Same wire protocol as query-transcript-stream
// (CHAT_CHUNK / CHAT_STREAM_COMPLETE / CHAT_STREAM_ERROR -> query-chunk /
// query-done) so the renderer can reuse useStreamingQuery. Works with every
// provider — the Python CLI sizes the assembled corpus to the active model's
// context window (smaller for local/remote), so a local model answers over
// fewer recent notes instead of overflowing. No retrieval (RAG) yet.
ipcMain.on('chat-global-stream', (event, queryId, question, folderId) => {
  sendDebugLog(`💬 Global chat query (${String(question || '').length} chars, folder: ${folderId || 'all'})`);
  const env = { ...process.env, ...getAiEnv() };

  const args = ['chat-global-streaming', '-q', question];
  if (folderId && typeof folderId === 'string' && folderId !== 'all') {
    args.push('-f', folderId);
  }

  // See query-transcript-stream's trackChatOnce comment -- same multi-exit-
  // path guard, scope: 'global' distinguishes cross-note chat from a
  // single-meeting query.
  let tracked = false;
  let chunkCount = 0;
  const trackChatOnce = (success) => {
    if (tracked) return;
    tracked = true;
    trackEvent('chat_message_sent', {
      success,
      scope: 'global',
      query_length: textLengthBucket(question),
      has_response: chunkCount > 0,
    });
  };

  let proc;
  try {
    proc = require('child_process').spawn(
      getBackendPath(),
      args,
      { env, cwd: getBackendCwd(), windowsHide: true },
    );
  } catch (err) {
    event.sender.send('query-done', { queryId, success: false, error: err.message });
    trackChatOnce(false);
    return;
  }

  activeQueryProcs.set(queryId, proc);
  const onSenderDestroyed = () => {
    if (activeQueryProcs.has(queryId)) {
      proc.kill();
      activeQueryProcs.delete(queryId);
    }
  };
  event.sender.once('destroyed', onSenderDestroyed);

  let buf = '';
  proc.stdout.on('data', (data) => {
    buf += data.toString();
    const rawLines = buf.split('\n');
    buf = rawLines.pop();
    // Strip a trailing CR: on Windows the backend's stdout is \r\n, so splitting
    // on \n leaves "CHAT_STREAM_COMPLETE\r" which the exact-match below would
    // miss — the stream would then never signal done. (The CHUNK/ERROR prefixes
    // tolerate it, but the completion sentinel must be matched exactly.)
    for (const line of rawLines.map((l) => (l.endsWith('\r') ? l.slice(0, -1) : l))) {
      if (line.startsWith('CHAT_CHUNK:')) {
        try {
          const chunk = Buffer.from(line.slice(11), 'base64').toString('utf-8');
          chunkCount++;
          if (!event.sender.isDestroyed()) {
            event.sender.send('query-chunk', { queryId, chunk });
          } else {
            proc.kill();
            activeQueryProcs.delete(queryId);
          }
        } catch (e) { /* ignore decode errors */ }
      } else if (line === 'CHAT_STREAM_COMPLETE') {
        if (!event.sender.isDestroyed()) {
          event.sender.send('query-done', { queryId, success: true });
        }
        trackChatOnce(true);
      } else if (line.startsWith('CHAT_STREAM_ERROR:')) {
        const errMsg = line.slice(18);
        if (!event.sender.isDestroyed()) {
          event.sender.send('query-done', { queryId, success: false, error: errMsg });
        }
        trackChatOnce(false);
      }
    }
  });

  proc.stderr.on('data', (data) => {
    const msg = data.toString().trim();
    if (msg) sendDebugLog(`[chat-global stderr] ${msg.slice(0, 200)}`);
  });

  proc.on('close', (code) => {
    activeQueryProcs.delete(queryId);
    if (!event.sender.isDestroyed()) {
      event.sender.removeListener('destroyed', onSenderDestroyed);
    }
    if (buf.trim() === 'CHAT_STREAM_COMPLETE') {
      if (!event.sender.isDestroyed()) event.sender.send('query-done', { queryId, success: true });
      trackChatOnce(true);
    } else if (code !== 0 && code !== null && !event.sender.isDestroyed()) {
      event.sender.send('query-done', { queryId, success: false, error: `Process exited with code ${code}` });
      trackChatOnce(false);
    }
  });

  proc.on('error', (err) => {
    activeQueryProcs.delete(queryId);
    if (!event.sender.isDestroyed()) {
      event.sender.send('query-done', { queryId, success: false, error: err.message });
    }
    trackChatOnce(false);
  });
});

// Chat sessions persistence.
//
// The legacy renderer reads/writes `chat_sessions.json` as a flat array.
// The new renderer uses an enriched `{ sessions: [...] }` shape. To avoid
// silently breaking the legacy UI when a user toggles between renderers, we
// store the new shape in a separate file (`chat_sessions_v2.json`) and never
// modify the legacy file. On first load, if v2 is absent we read the legacy
// file once for migration; subsequent saves only touch v2.
//
// Writes use tmp+rename to keep the file atomic across crashes / power loss
// (a truncated chat_sessions file is hard to recover and would lose all
// chat history on next launch).
const CHAT_SESSIONS_V2_FILENAME = 'chat_sessions_v2.json';
const CHAT_SESSIONS_LEGACY_FILENAME = 'chat_sessions.json';

function chatSessionsV2Path() {
  return path.join(app.getPath('userData'), CHAT_SESSIONS_V2_FILENAME);
}

function chatSessionsLegacyPath() {
  return path.join(app.getPath('userData'), CHAT_SESSIONS_LEGACY_FILENAME);
}

ipcMain.handle('save-chat-sessions', async (event, data) => {
  const filePath = chatSessionsV2Path();
  const tmpPath = `${filePath}.tmp`;
  try {
    fs.writeFileSync(tmpPath, JSON.stringify(data), 'utf-8');
    fs.renameSync(tmpPath, filePath);
    return { success: true };
  } catch (err) {
    try { if (fs.existsSync(tmpPath)) fs.unlinkSync(tmpPath); } catch (_) {}
    return { success: false, error: err.message };
  }
});

ipcMain.handle('load-chat-sessions', async () => {
  const v2Path = chatSessionsV2Path();
  // Prefer v2 file when present
  if (fs.existsSync(v2Path)) {
    try {
      const raw = fs.readFileSync(v2Path, 'utf-8');
      return { success: true, data: JSON.parse(raw) };
    } catch (err) {
      // Corrupt v2 file — quarantine it so we don't keep failing on every load,
      // then fall through to legacy migration / empty state.
      const corruptPath = `${v2Path}.corrupt-${Date.now()}`;
      try { fs.renameSync(v2Path, corruptPath); } catch (_) {}
      console.error(`[chat-sessions] v2 file unreadable, quarantined to ${corruptPath}:`, err.message);
    }
  }
  // First run on the new renderer: try to migrate from the legacy file.
  // Legacy file is read but never modified, so legacy renderer remains intact.
  const legacyPath = chatSessionsLegacyPath();
  if (fs.existsSync(legacyPath)) {
    try {
      const raw = fs.readFileSync(legacyPath, 'utf-8');
      return { success: true, data: JSON.parse(raw), migratedFromLegacy: true };
    } catch (err) {
      console.error('[chat-sessions] legacy file unreadable:', err.message);
    }
  }
  return { success: true, data: null };
});

ipcMain.handle('save-meeting-notes', async (event, sessionName, notes) => {
  try {
    // Write into the user-data output dir — the SAME dir Python's get_data_dirs()
    // uses (custom storage if set, else getUserDataDir(), which honors
    // STENOAI_USER_DATA_DIR). The old getBackendCwd()/_internal/output target was
    // INSIDE the app bundle: read-only in a packaged/signed app (so saving notes
    // failed for real users on macOS + Windows), and a dir the Python pipeline
    // never reads notes from, so reprocess's _load_user_notes couldn't find them.
    const outputDir = getOutputDir();
    if (!fs.existsSync(outputDir)) fs.mkdirSync(outputDir, { recursive: true });
    const notesFile = userNotesFilePath(outputDir, sessionName);
    fs.writeFileSync(notesFile, notes, 'utf-8');
    return { success: true, path: notesFile };
  } catch (error) {
    console.error('Failed to save meeting notes:', error);
    return { success: false, error: error.message };
  }
});

// Transcript export bridge. The renderer builds the Markdown bundle and hands us
// the finished string; we own only the file write. STENOAI_E2E_EXPORT_PATH bypasses
// the native dialog so the Playwright T2 spec can drive this hermetically (same
// isolation philosophy as STENOAI_USER_DATA_DIR).
ipcMain.handle('export-transcript', async (event, defaultFilename, content) => {
  try {
    if (typeof content !== 'string' || content.length === 0) {
      return { success: false, error: 'No transcript content to export.' };
    }

    // Test-only seam: only honor it under e2e, so a stray env var in a real
    // launch can't silently redirect a user's export to an arbitrary path.
    const seamPath = IS_E2E ? process.env.STENOAI_E2E_EXPORT_PATH : undefined;
    let targetPath = seamPath;

    if (!targetPath) {
      // The renderer supplies a suggested name only; reduce it to a bare
      // filename so a malformed value can't steer defaultPath with an absolute
      // path or traversal components. The user still confirms via the dialog.
      const suggested =
        typeof defaultFilename === 'string' && defaultFilename.trim()
          ? path.basename(defaultFilename).slice(0, 200)
          : 'transcript.md';
      const result = await dialog.showSaveDialog(mainWindow, {
        defaultPath: suggested,
        filters: [
          { name: 'Markdown', extensions: ['md'] },
          { name: 'Text', extensions: ['txt'] },
        ],
      });
      if (result.canceled || !result.filePath) {
        return { success: false, error: EXPORT_CANCELED };
      }
      targetPath = result.filePath;
    }

    // Atomic write: write to a temp file in the SAME directory, then rename it
    // into place. A direct writeFile() that fails mid-way (disk full, I/O error)
    // truncates and corrupts a pre-existing file at targetPath; tmp+rename leaves
    // the original untouched on failure. Mirrors the chat-sessions persistence
    // pattern (~line 2056). Async so a large transcript can't block the UI thread.
    const dir = path.dirname(targetPath);
    const base = path.basename(targetPath);
    const tmpPath = path.join(dir, `.${base}.${require('crypto').randomBytes(6).toString('hex')}.tmp`);
    try {
      await fs.promises.writeFile(tmpPath, content, 'utf-8');
      // Node's fs.rename maps to MoveFileExW(MOVEFILE_REPLACE_EXISTING) on
      // Windows and rename(2) on Unix — both atomically replace an existing
      // destination on the same volume, so no separate unlink is needed.
      await fs.promises.rename(tmpPath, targetPath);
    } catch (writeErr) {
      // Best-effort cleanup so a failed export doesn't leave a stray temp file.
      try { await fs.promises.unlink(tmpPath); } catch (_) {}
      throw writeErr;
    }
    return { success: true, path: targetPath };
  } catch (err) {
    return { success: false, error: String(err && err.message ? err.message : err) };
  }
});

// Render a self-contained HTML string to a PDF Buffer in an offscreen window.
// The renderer builds the branded HTML (app/renderer/src/lib/notesPdf.ts); here
// we only rasterise it. The window is hardened (no node integration, no
// preload) and torn down in a finally so a render failure can't leak a hidden
// window. printBackground keeps the paper fill/ink; preferCSSPageSize honors the
// document's own `@page { size: A4; margin: … }` so page geometry lives with the
// template, not here. Cross-platform: printToPDF is Chromium, identical on both.
const PDF_RENDER_TIMEOUT_MS = 15000;

async function renderHtmlToPdf(html) {
  const win = new BrowserWindow({
    show: false,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
      // No preload / IPC surface: this window only ever renders a static,
      // renderer-supplied document to PDF.
    },
  });
  // Background render of renderer-supplied HTML: deny any popup and block any
  // navigation the document might attempt (no openExternal — this is not an
  // interactive window and must never spawn a browser tab on its own).
  hardenWindow(win);
  try {
    const render = (async () => {
      // Load the HTML directly as a data URL (self-contained: CSS, font, and
      // logo are inlined), so there is no temp .html file to manage or clean up.
      await win.loadURL('data:text/html;charset=UTF-8,' + encodeURIComponent(html));
      // loadURL resolves on did-finish-load, but @font-face decoding (the
      // embedded Ovo woff2) is async and may not be done yet — printing now can
      // rasterise with the Georgia fallback, defeating the branded look. Wait
      // for the fonts to settle first. executeJavaScript runs in the render
      // window out-of-band (not subject to the document CSP), so this is safe
      // even with scripts disabled by the page's own CSP.
      await win.webContents.executeJavaScript('document.fonts.ready.then(() => true)');
      return win.webContents.printToPDF({
        printBackground: true,
        preferCSSPageSize: true,
      });
    })();

    // Bound the whole render. If Chromium stalls (a known intermittent
    // printToPDF failure mode under GPU/compositor trouble), the awaited promise
    // would never settle — hanging the IPC call and stranding the hidden window.
    // On timeout we reject; the caller converts that to a clean {success:false}
    // and the outer finally still tears the window down (which also unblocks the
    // orphaned render promise).
    let timer;
    const timeout = new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error('PDF render timed out')), PDF_RENDER_TIMEOUT_MS);
    });
    try {
      return await Promise.race([render, timeout]);
    } finally {
      clearTimeout(timer);
    }
  } finally {
    if (!win.isDestroyed()) win.destroy();
  }
}

// Notes export as a branded PDF. Mirrors export-transcript's file-write contract
// (basename-only defaultPath, atomic tmp+rename, IS_E2E-gated env seam,
// EXPORT_CANCELED on dialog dismiss) but rasterises the renderer-built HTML to a
// PDF first. The renderer owns the document (styling, section selection, HTML
// escaping); this handler owns the render + the write.
ipcMain.handle('export-note-pdf', async (event, defaultFilename, html) => {
  try {
    if (typeof html !== 'string' || html.length === 0) {
      return { success: false, error: 'No notes content to export.' };
    }

    // Test-only seam: only honor it under e2e, so a stray env var in a real
    // launch can't silently redirect a user's export to an arbitrary path.
    const seamPath = IS_E2E ? process.env.STENOAI_E2E_EXPORT_PATH : undefined;
    let targetPath = seamPath;

    if (!targetPath) {
      // Suggested name only; reduce to a bare filename so a malformed value
      // can't steer defaultPath with an absolute path or traversal components.
      const suggested =
        typeof defaultFilename === 'string' && defaultFilename.trim()
          ? path.basename(defaultFilename).slice(0, 200)
          : 'notes.pdf';
      const result = await dialog.showSaveDialog(mainWindow, {
        defaultPath: suggested,
        filters: [{ name: 'PDF', extensions: ['pdf'] }],
      });
      if (result.canceled || !result.filePath) {
        return { success: false, error: EXPORT_CANCELED };
      }
      targetPath = result.filePath;
    }

    // Rasterise BEFORE touching the destination, so a render failure surfaces
    // without having created or truncated any file.
    const pdf = await renderHtmlToPdf(html);

    // Atomic write: tmp file in the SAME directory, then rename into place, so a
    // failed write can't truncate a pre-existing file. Mirrors export-transcript.
    const dir = path.dirname(targetPath);
    const base = path.basename(targetPath);
    const tmpPath = path.join(dir, `.${base}.${require('crypto').randomBytes(6).toString('hex')}.tmp`);
    try {
      await fs.promises.writeFile(tmpPath, pdf);
      await fs.promises.rename(tmpPath, targetPath);
    } catch (writeErr) {
      try { await fs.promises.unlink(tmpPath); } catch (_) {}
      throw writeErr;
    }
    return { success: true, path: targetPath };
  } catch (err) {
    return { success: false, error: String(err && err.message ? err.message : err) };
  }
});

// Save the (already redacted, renderer-built) diagnostics bundle to a file the
// user picks. Mirrors export-transcript: basename-only defaultPath, atomic
// tmp+rename, and the e2e save-path seam. The renderer owns redaction + the env
// header (redactDiagnostics + header build); this handler only writes bytes.
ipcMain.handle('save-diagnostics', async (event, defaultFilename, content) => {
  try {
    if (typeof content !== 'string' || content.length === 0) {
      return { success: false, error: 'No diagnostics content to save.' };
    }

    // Test-only seam: only honor it under e2e, so a stray env var in a real
    // launch can't silently redirect a user's save to an arbitrary path.
    const seamPath = IS_E2E ? process.env.STENOAI_E2E_DIAGNOSTICS_PATH : undefined;
    let targetPath = seamPath;

    if (!targetPath) {
      // The renderer supplies a suggested name only; reduce it to a bare
      // filename so a malformed value can't steer defaultPath with an absolute
      // path or traversal components. The user still confirms via the dialog.
      const suggested =
        typeof defaultFilename === 'string' && defaultFilename.trim()
          ? path.basename(defaultFilename).slice(0, 200)
          : 'stenoai-diagnostics.txt';
      const result = await dialog.showSaveDialog(mainWindow, {
        defaultPath: suggested,
        filters: [{ name: 'Text', extensions: ['txt'] }],
      });
      if (result.canceled || !result.filePath) {
        return { success: false, error: EXPORT_CANCELED };
      }
      targetPath = result.filePath;
    }

    // Atomic write: tmp file in the SAME directory, then rename into place, so a
    // failed write can't truncate a pre-existing file. Mirrors export-transcript.
    const dir = path.dirname(targetPath);
    const base = path.basename(targetPath);
    const tmpPath = path.join(dir, `.${base}.${require('crypto').randomBytes(6).toString('hex')}.tmp`);
    try {
      await fs.promises.writeFile(tmpPath, content, 'utf-8');
      await fs.promises.rename(tmpPath, targetPath);
    } catch (writeErr) {
      try { await fs.promises.unlink(tmpPath); } catch (_) {}
      throw writeErr;
    }
    return { success: true, path: targetPath };
  } catch (err) {
    return { success: false, error: String(err && err.message ? err.message : err) };
  }
});

// Replace (or remove, when empty) the "## User Notes" section at the tail of a
// meeting markdown body. Kept a pure string transform so it's unit-testable and
// never touches the summary/transcript sections above it. `body` is everything
// after the closing frontmatter `---`.
function upsertUserNotesSection(body, notes) {
  const idx = body.indexOf('\n## User Notes');
  // Trim trailing whitespace from the kept head so re-appends don't accrete
  // blank lines across repeated autosaves.
  const head = (idx === -1 ? body : body.slice(0, idx)).replace(/\s+$/, '');
  const trimmed = String(notes ?? '').replace(/\s+$/, '');
  if (!trimmed) {
    // Notes cleared → drop the section entirely.
    return head + '\n';
  }
  return `${head}\n\n## User Notes\n\n${trimmed}\n`;
}

ipcMain.handle('update-meeting', async (event, summaryFilePath, updates) => {
  try {
    // Security: the renderer is untrusted, so containment-check the summary path
    // (symlink-safe, output/ only) and operate exclusively on the canonical
    // realPath for every read/write below — never the original renderer string.
    const validated = await validateMeetingFilePath(summaryFilePath);
    if (validated.error) {
      return { success: false, error: validated.error };
    }
    const { realPath } = validated;

    // Read existing data
    if (!fs.existsSync(realPath)) {
      return {
        success: false,
        error: 'Meeting file not found'
      };
    }

    const isMarkdown = realPath.endsWith('.md');
    let data;

    if (isMarkdown) {
      const raw = fs.readFileSync(realPath, 'utf8');
      // Escape a string for a YAML double-quoted scalar. Backslash MUST be
      // escaped before the quote, and embedded newlines must become literal
      // \n so they don't end the scalar mid-line.
      const yamlQuote = (s) =>
        '"' + String(s)
          .replace(/\\/g, '\\\\')
          .replace(/"/g, '\\"')
          .replace(/\n/g, '\\n')
          .replace(/\r/g, '')
        + '"';

      // Strip the outer quotes only — the simple frontmatter we read here is
      // for the response shape (data.session_info.name) and doesn't need to
      // reverse YAML escapes for its sole consumer (the renderer).
      const readTitle = (rawValue) => rawValue.trim().replace(/^"|"$/g, '');

      // Line-based rewrite: only mutate the keys we're updating, leave every
      // other line (including non-string values like arrays/booleans) byte-
      // identical so we don't corrupt structured fields like `folders: [...]`.
      let title = '';
      let updatedAt = new Date().toISOString();
      let body = raw;
      let updatedRaw = raw;

      if (raw.startsWith('---')) {
        // Split with NO limit and rejoin the tail: split('---', 3) DISCARDS any
        // '---' in the body (markdown thematic breaks in summaries, and the
        // '--- Resumed HH:MM ---' separators continue-recording writes into
        // every continued note), silently TRUNCATING the transcript from the
        // first in-body '---' to EOF on the next My-notes autosave. Mirrors
        // clearNoteProcessingFlag / parseMeetingMarkdown's split/slice(2).join.
        const parts = raw.split('---');
        if (parts.length >= 3) {
          const fmText = parts[1];
          body = parts.slice(2).join('---');
          const lines = fmText.split('\n');
          let titleSeen = false;
          let updatedAtSeen = false;
          const newLines = lines.map((line) => {
            const colon = line.indexOf(':');
            if (colon === -1) return line;
            const key = line.slice(0, colon).trim();
            if (key === 'title') {
              titleSeen = true;
              const original = line.slice(colon + 1);
              if (updates.name !== undefined) {
                return `title: ${yamlQuote(updates.name)}`;
              }
              title = readTitle(original);
              return line;
            }
            if (key === 'updated_at') {
              updatedAtSeen = true;
              return `updated_at: ${yamlQuote(updatedAt)}`;
            }
            return line;
          });
          if (!titleSeen && updates.name !== undefined) {
            // Insert before the trailing blank line (if any) for readability.
            const insertIdx = newLines[newLines.length - 1] === '' ? newLines.length - 1 : newLines.length;
            newLines.splice(insertIdx, 0, `title: ${yamlQuote(updates.name)}`);
            title = updates.name;
          } else if (updates.name !== undefined) {
            title = updates.name;
          }
          if (!updatedAtSeen) {
            const insertIdx = newLines[newLines.length - 1] === '' ? newLines.length - 1 : newLines.length;
            newLines.splice(insertIdx, 0, `updated_at: ${yamlQuote(updatedAt)}`);
          }
          // Upsert the "## User Notes" body section (My notes tab). It is
          // always the LAST section (summary → ## Transcript → ## User Notes,
          // matching simple_recorder.py's write order), so replacing from the
          // header to EOF preserves the summary + transcript verbatim.
          if (updates.user_notes !== undefined) {
            body = upsertUserNotesSection(body, updates.user_notes);
          }
          updatedRaw = `---${newLines.join('\n')}---${body}`;
        }
      }

      fs.writeFileSync(realPath, updatedRaw, 'utf8');

      // Title/notes edits fire no processing-complete, so mirror explicitly
      // (#413). A title change here drives the vault-file rename via the index.
      try { obsidianSync.syncNoteBySummaryPath(realPath); } catch (_) {}

      data = {
        session_info: {
          name: updates.name !== undefined ? updates.name : title,
          summary_file: realPath,
          updated_at: updatedAt,
        },
      };
    } else {
      data = JSON.parse(fs.readFileSync(realPath, 'utf8'));

      if (updates.name !== undefined) {
        data.session_info.name = updates.name;
      }
      if (updates.summary !== undefined) {
        data.summary = updates.summary;
      }
      if (updates.participants !== undefined) {
        data.participants = updates.participants;
      }
      if (updates.key_points !== undefined) {
        data.key_points = updates.key_points;
      }
      if (updates.action_items !== undefined) {
        data.action_items = updates.action_items;
      }
      if (updates.user_notes !== undefined) {
        data.user_notes = updates.user_notes;
      }

      data.session_info.updated_at = new Date().toISOString();
      fs.writeFileSync(realPath, JSON.stringify(data, null, 2), 'utf8');
    }

    console.log(`Updated meeting: ${realPath}`);

    return {
      success: true,
      message: 'Meeting updated successfully'
    };
  } catch (error) {
    console.error('Update meeting error:', error);
    return { success: false, error: error.message };
  }
});

ipcMain.handle('reveal-meeting-folder', async (event, filePath) => {
  try {
    const projectRoot = path.join(__dirname, '..');
    const allowedBaseDirs = getAllowedBaseDirs();
    const absolutePath = path.isAbsolute(filePath) ? filePath : path.join(projectRoot, filePath);
    if (!validateSafeFilePath(absolutePath, allowedBaseDirs)) {
      return { success: false, error: 'Invalid file path: outside allowed directories' };
    }
    shell.showItemInFolder(absolutePath);
    return { success: true };
  } catch (error) {
    return { success: false, error: error.message };
  }
});

// Soft-delete a note (#234): atomically HIDE only its summary file (rename into
// `output/.pending-delete/<id>/`) so every backend scan stops seeing it, while
// its transcript / recording / sidecars stay in place. Returns an id so the
// renderer can offer Undo; MAIN owns an 8 s timer that COMMITS (permanently
// unlinks everything) when it fires. Nothing is destroyed here.
ipcMain.handle('delete-meeting', async (event, meetingData) => {
  try {
    const meeting = meetingData;
    const projectRoot = path.join(__dirname, '..');
    const allowedBaseDirs = getAllowedBaseDirs();

    const summaryFile = meeting?.session_info?.summary_file;
    // (#234) We deliberately IGNORE meeting.session_info.transcript_file /
    // audio_file: those are renderer-supplied and arbitrary, so trusting them
    // would let a crafted delete of note A name note B's files as ancillaries and
    // permanently unlink them at commit. ALL ancillaries are derived from the
    // validated summary's own STEM below — the real transcript/recording of a note
    // ARE the stem-derived paths, so nothing legitimate is lost and the
    // cross-note-destruction surface is closed.
    //
    // SCOPE (#234): gating/unsharing an org upload on delete is a separate
    // follow-up, out of scope here — org upload sends renderer-supplied content
    // strings (not live file reads), and the busy-guard already refuses a delete
    // while the note is locally recording/processing/reprocessing.

    if (!summaryFile) {
      // Without a summary there's nothing for a backend scan to key off — no note
      // to hide. Treat as a no-op success (mirrors "nothing to delete").
      return { success: true, message: 'No summary file to delete' };
    }

    const toAbs = (p) => (path.isAbsolute(p) ? p : path.join(projectRoot, p));
    const summaryPath = toAbs(summaryFile);
    const outputDir = path.dirname(summaryPath);

    // Derive the note's stem from its summary basename (<stem>_summary.{json,md}).
    // Every ancillary is bound to this stem (never taken raw from the meeting obj).
    const summaryBase = path.basename(summaryPath);
    let stem = null;
    for (const suf of ['_summary.md', '_summary.json']) {
      if (summaryBase.endsWith(suf)) {
        stem = summaryBase.slice(0, -suf.length);
        break;
      }
    }

    // Refuse a delete for a note that's currently active (recording into /
    // queued / processing / reprocessing): a finishing job would rewrite
    // (resurrect) or re-upload the summary we're about to hide.
    if (isSummaryBusy(summaryPath)) {
      return { success: false, error: 'note is busy (recording/processing)' };
    }

    // Dedup: one pending delete per summary. Reject rather than replace (a stale
    // caller view must not silently supersede an in-flight window).
    const canonicalSummary = canonicalPathForCompare(summaryPath);
    if (pendingDeleteBySummary.has(canonicalSummary)) {
      return { success: false, error: 'delete already pending' };
    }

    // --- Enumerate the ANCILLARY file set (unlinked only at commit), bound to
    // this note's STEM ONLY (never the renderer-supplied transcript_file /
    // audio_file): the <stem>_reports.json sidecar and the stem-derived
    // transcript + recording(s). Only the SUMMARY file itself is hidden.
    //
    // Deliberately EXCLUDED: `<safeName>_notes.txt`. That draft-notes file is
    // named from the renderer-controlled session title, NOT the stem, so two
    // notes sharing a title share the file — committing this delete could
    // permanently unlink another note's draft. It isn't safely bindable to this
    // note's identity, so we leave it orphaned (the fail-safe direction).
    const ancillaryCandidates = [];
    // Reports sidecar: <stem>_summary.{md,json} -> <stem>_reports.json.
    {
      let sidecarBase = null;
      for (const suf of ['_summary.md', '_summary.json']) {
        if (summaryBase.endsWith(suf)) {
          sidecarBase = summaryBase.slice(0, -suf.length) + '_reports.json';
          break;
        }
      }
      if (!sidecarBase) {
        const ext = path.extname(summaryBase);
        sidecarBase = summaryBase.slice(0, summaryBase.length - ext.length) + '_reports.json';
      }
      ancillaryCandidates.push(path.join(outputDir, sidecarBase));
    }
    // Speakers sidecar: <stem>_speakers.json. Same class of miss as the
    // reports sidecar was -- a per-meeting file added later that the delete
    // enumeration never learned about. Reproduced end to end: the note,
    // transcript and audio went, and an 84 KB file of VOICE EMBEDDINGS
    // stayed behind, which is the worst thing in the set to leave on disk
    // after someone deletes a meeting. It is stem-bound like the others, so
    // it inherits the same containment checks and the same undo window.
    //
    // Note this removes only the meeting's per-cluster embeddings. A person
    // CONFIRMED from this meeting keeps their voice profile in config.json,
    // deliberately: those are bound to the person, not the meeting, and are
    // what makes recognition work across recordings (verified against a real
    // library, where working prototypes came from meetings deleted long ago).
    // Deleting a person is its own explicit action in the Speakers panel.
    if (stem) {
      ancillaryCandidates.push(path.join(outputDir, `${stem}_speakers.json`));
    }
    // Derive the transcript + recording from the summary stem (FACT A). A normal
    // .md note carries ONLY summary_file, so without this the transcript and the
    // RECORDING would be orphaned, defeating the whole point of #234 (protect the
    // audio). Naming mirrors the backend: <base>/transcripts/<stem>_transcript.txt
    // and <base>/recordings/<stem>.<ext> (any extension — imports stay .m4a/.mp3,
    // system-audio is .webm, native captures are .wav; Codex C5).
    if (stem) {
      const dataRoot = path.dirname(outputDir); // summary is in <base>/output/
      ancillaryCandidates.push(path.join(dataRoot, 'transcripts', `${stem}_transcript.txt`));
      const recordingsDir = path.join(dataRoot, 'recordings');
      try {
        for (const name of fs.readdirSync(recordingsDir)) {
          if (path.parse(name).name === stem) {
            ancillaryCandidates.push(path.join(recordingsDir, name));
          }
        }
      } catch (_) {
        // recordings/ may not exist (summary-only note) — nothing to add.
      }
    }

    // --- Security pre-pass on the SUMMARY (the only file we move). Must pass the
    // broad containment check, live in an allowed meeting folder, and be a real
    // regular file (reject a dir/symlink so a crafted meeting can't redirect the
    // rename). Any failure blocks the whole delete before anything is touched.
    if (!validateSafeFilePath(summaryPath, allowedBaseDirs)) {
      console.error(`Security: Blocked delete of summary outside allowed dirs: ${summaryPath}`);
      return { success: false, error: 'Blocked delete due to security validation' };
    }
    if (!isAllowedMeetingSource(summaryPath, allowedBaseDirs)) {
      console.error(`Security: summary is not in an allowed meeting folder: ${summaryPath}`);
      return { success: false, error: 'Blocked delete due to security validation' };
    }
    let summaryStat;
    try {
      summaryStat = fs.lstatSync(summaryPath);
    } catch (_) {
      // Already gone from disk — nothing for a scan to see. No-op success.
      return { success: true, message: 'No files to delete' };
    }
    if (!summaryStat.isFile()) {
      return { success: false, error: 'Summary is not a regular file' };
    }

    // --- Twin edge (ANOMALOUS, FAIL-SAFE): a note names EXACTLY ONE
    // summary_file, and we hide only that one. If a stem somehow has BOTH
    // <stem>_summary.json AND <stem>_summary.md, hiding the named one leaves the
    // other, and the `output/*_summary.{json,md}` scan keeps the note VISIBLE —
    // so the delete under-hides (note REAPPEARS), never over-deletes: nothing is
    // lost. This is accepted deliberately: the app's own writers only ever
    // produce <stem>_summary.md (JSON summaries are legacy, read-only; reprocess
    // rewrites in place without changing suffix), so a real twin can only arise
    // from external/legacy state. Hiding all variants would be nicer, but NOT at
    // the cost of the multi-file rename + rollback path (a failed rollback there
    // can strand/destroy a summary) — for user AUDIO the single-file tombstone is
    // the safer trade. A follow-up could hide every variant if it stays
    // rollback-free.

    // Filter ancillaries to the ones that EXIST, are regular files, and live in
    // an allowed meeting folder — the only paths we'll unlink at commit. A bad
    // one (missing, symlink, dir, out-of-folder) is skipped, never fatal. Exclude
    // the summary itself (it's hidden, not unlinked as an ancillary).
    const uniqueAncillary = [...new Set(ancillaryCandidates)].filter((p) => p !== summaryPath);
    const ancillaryPaths = [];
    for (const p of uniqueAncillary) {
      if (!validateSafeFilePath(p, allowedBaseDirs)) {
        console.warn(`Skipping ancillary outside allowed dirs (not tracked): ${p}`);
        continue;
      }
      let st;
      try {
        st = fs.lstatSync(p);
      } catch (_) {
        continue; // Missing — nothing to unlink at commit.
      }
      if (!st.isFile()) {
        console.warn(`Skipping non-regular-file ancillary (not tracked): ${p}`);
        continue;
      }
      if (!isAllowedMeetingSource(p, allowedBaseDirs)) {
        console.warn(`Skipping ancillary outside allowed meeting folders (not tracked): ${p}`);
        continue;
      }
      ancillaryPaths.push(p);
    }

    // --- Atomically HIDE the single summary. `.pending-delete/<id>/` is a
    // sibling of the summary under output/, so renameSync is atomic on the same
    // filesystem (no EXDEV).
    const id = `${Date.now()}-${crypto.randomBytes(4).toString('hex')}`;
    const pendingRoot = path.join(outputDir, PENDING_DELETE_DIRNAME);

    // Fail-closed if the `.pending-delete` root exists but is NOT a real directory
    // (a symlink/file). mkdirSync would follow a symlinked root and move the
    // summary OUT of the sandbox, and startup recovery skips a non-dir root — the
    // note would be stranded/lost. This matches the guard in
    // recoverPendingDeletesOnLaunch().
    try {
      const rootStat = fs.lstatSync(pendingRoot);
      if (!rootStat.isDirectory()) {
        return { success: false, error: 'invalid pending-delete root' };
      }
    } catch (err) {
      // ONLY a genuinely-missing root is fine (mkdir creates it below). Any other
      // lstat error (EACCES, EIO, ...) must fail-closed: we can't prove the root
      // is a safe directory, so refuse rather than mkdir into an unknown state.
      if (!err || err.code !== 'ENOENT') {
        return { success: false, error: 'cannot access pending-delete root' };
      }
    }

    const hiddenDir = path.join(pendingRoot, id);
    try {
      fs.mkdirSync(hiddenDir, { recursive: true });
    } catch (err) {
      // e.g. output/ is read-only (fail-closed): nothing moved, originals intact.
      return { success: false, error: `Failed to prepare pending-delete: ${err.message}` };
    }

    // Hide the summary with ONE same-filesystem rename. On failure remove the
    // scaffold; the original is untouched (rename either fully succeeds or leaves
    // the source in place) so there is no partial state to roll back.
    const hiddenSummaryPath = path.join(hiddenDir, path.basename(summaryPath));
    if (!validateSafeFilePath(hiddenSummaryPath, allowedBaseDirs)) {
      try {
        fs.rmSync(hiddenDir, { recursive: true, force: true });
      } catch (_) {}
      return { success: false, error: 'Blocked delete due to security validation' };
    }
    try {
      fs.renameSync(summaryPath, hiddenSummaryPath);
    } catch (err) {
      try {
        fs.rmSync(hiddenDir, { recursive: true, force: true });
      } catch (_) {}
      return { success: false, error: `Failed to hide summary: ${err.message}` };
    }

    // Record the pending delete + start MAIN's deadline timer.
    const deadline = Date.now() + DELETE_WINDOW_MS;
    const entry = {
      id,
      meeting,
      // The exact `summary_file` string the renderer's list is keyed on, so a
      // rehydrating renderer can match this note.
      summaryFileKey: summaryFile,
      hiddenDir,
      originalSummaryPath: summaryPath,
      hiddenSummaryPath,
      canonicalSummary,
      ancillaryPaths,
      deadline,
      state: 'pending',
      timer: null,
    };
    entry.timer = setTimeout(() => {
      try {
        commitPendingDelete(id);
      } catch (_) {}
    }, DELETE_WINDOW_MS);
    pendingDeletes.set(id, entry);
    pendingDeleteBySummary.set(canonicalSummary, id);

    return { success: true, id, deadline };
  } catch (error) {
    console.error('Delete meeting error:', error);
    return { success: false, error: error.message };
  }
});

// Undo a soft-delete (#234): rename the hidden summary back to its original path
// so the note reappears in every backend scan. Near-infallible (one same-
// filesystem rename). Loses only once the window has started committing.
ipcMain.handle('undo-delete-meeting', async (event, id) => {
  try {
    if (!isSafePendingId(id)) {
      return { success: false, error: 'Invalid delete id' };
    }
    const entry = pendingDeletes.get(id);
    if (!entry || entry.state !== 'pending') {
      // Missing or already committing — Undo loses once the commit starts.
      return { success: false, error: 'nothing to undo' };
    }
    // No-clobber: if the original path is now occupied (e.g. the user re-recorded
    // the same-stem note during the window), refuse — keep the tombstone intact.
    // lstat (not existsSync) so a DANGLING symlink there also counts as occupied.
    // The residual TOCTOU between this check and the renameSync below is accepted:
    // single-user desktop, synchronous handler, sub-ms window; Node has no atomic
    // rename-no-replace.
    if (pathIsOccupied(entry.originalSummaryPath)) {
      console.error(`Undo: original path occupied, refusing to clobber: ${entry.originalSummaryPath}`);
      return { success: false, error: 'restore target already exists' };
    }
    // Restore the single summary with one same-filesystem rename.
    try {
      fs.renameSync(entry.hiddenSummaryPath, entry.originalSummaryPath);
    } catch (err) {
      return { success: false, error: `Undo failed: ${err.message}` };
    }
    // Success — clear the timer, drop the entry + its scaffold dir.
    if (entry.timer) {
      clearTimeout(entry.timer);
      entry.timer = null;
    }
    removeHiddenScaffold(entry.hiddenDir);
    pendingDeletes.delete(id);
    if (pendingDeleteBySummary.get(entry.canonicalSummary) === id) {
      pendingDeleteBySummary.delete(entry.canonicalSummary);
    }
    return { success: true, meeting: entry.meeting };
  } catch (error) {
    console.error('Undo delete meeting error:', error);
    return { success: false, error: error.message };
  }
});

// Explicit COMMIT (#234): the user dismissed the toast (or its window elapsed and
// the renderer wants to finalize now). Permanently removes the note's files.
// Idempotent: an unknown / already-committed id is a success (nothing to do).
ipcMain.handle('commit-delete-meeting', async (event, id) => {
  try {
    if (!isSafePendingId(id)) {
      return { success: false, error: 'Invalid delete id' };
    }
    commitPendingDelete(id);
    return { success: true };
  } catch (error) {
    console.error('Commit delete meeting error:', error);
    return { success: false, error: error.message };
  }
});

// List the notes with an in-flight soft-delete, so a freshly-loaded renderer can
// rehydrate its Undo toasts (MAIN owns the deadline — the renderer must not
// invent its own). Returns the exact `summary_file` string each note is listed
// under, plus the id + deadline + meeting for the toast.
ipcMain.handle('list-pending-deletes', async () => {
  const pending = [];
  for (const entry of pendingDeletes.values()) {
    if (entry.state !== 'pending') continue;
    pending.push({
      id: entry.id,
      summaryFile: entry.summaryFileKey,
      deadline: entry.deadline,
      meeting: entry.meeting,
    });
  }
  return { success: true, pending };
});

// Queue status handler
ipcMain.handle('get-queue-status', async () => {
  return {
    success: true,
    isProcessing,
    queueSize: processingQueue.length,
    currentJob: currentProcessingJob?.sessionName || null,
    currentReprocesses: Array.from(activeReprocessJobs.values()),
    hasRecording: currentRecordingProcess !== null || systemAudioRecordingActive,
    isPaused: recordingRuntimeState.isPaused,
    elapsedSeconds: (currentRecordingProcess !== null || systemAudioRecordingActive)
      ? getRecordingElapsedSeconds()
      : (isProcessing && currentProcessingStartedAtMs
          ? Math.floor((Date.now() - currentProcessingStartedAtMs) / 1000)
          : 0),
    sessionName: currentRecordingSessionName,
    // The note (summary-file realpath) an active continue/resume is recording
    // INTO, so the renderer can tell "recording this note" from "recording a
    // different one" by identity rather than by the (collidable) display name.
    // Null for a fresh new-note recording (no existing target) or when idle.
    recordingSummaryFile:
      (currentRecordingProcess !== null || systemAudioRecordingActive)
        ? (currentRecordingAppendTarget || null)
        : null,
    // The real note file the CURRENT recording/processing session produces (the
    // instant-stop placeholder written at stop, then rewritten in place by the
    // pipeline). Lets useMeetings dedupe the synthetic "__live__/…" row against
    // the real note once it exists, so one recording is never shown twice
    // (#bug4). Deterministic from the audio stem, so it's the same key across
    // this session's recording → processing phases.
    //
    // Precedence matters: prefer the ACTIVE recording's key over a PROCESSING
    // job's. In the supported back-to-back flow (stop meeting A → immediately
    // start meeting B while A is still processing), `sessionName` reports B (the
    // recording), so liveSummaryFile must also be B's — otherwise it'd be A's,
    // A's note is already in the list, and B's live row would be wrongly dropped
    // (B shows no row at all). At B's own stop, teardown nulls
    // activeSysAudioSummaryFile before currentProcessingJob is set to B, so the
    // fallback still yields B and the intended dedup against B's placeholder
    // fires. Only the Parakeet instant-stop path writes a placeholder, so this
    // only actually bites there; Whisper/import have no placeholder (dedup is a
    // no-op) and it's null when idle.
    liveSummaryFile: activeSysAudioSummaryFile || currentProcessingJob?.summaryFile || null,
  };
});

// Push a chunk of raw 16 kHz INTERLEAVED STEREO float32 audio (mic=L,
// system=R) to the live transcribe sidecar's stdin. Renderer decimates its
// two pre-merge Web Audio taps and calls this every ~256 ms. We expect
// either a Node Buffer or a TypedArray; both stringify safely to bytes via
// the same write() call. No-op if the sidecar isn't running (e.g. spawn
// failed, or recording ended).
// Back-pressure-aware write to the live-transcribe sidecar's stdin (#357).
// stdin.write() returns false when the OS pipe buffer is full; ignoring that
// signal lets a stalled sidecar force main to buffer live audio unboundedly on
// the JS heap. We honor it: once back-pressured, queue chunks and flush them on
// the stream's 'drain' event (listener installed in spawnLiveTranscribe). The
// queue is bounded — under a genuine stall (which Fix #1's Python keep-pace
// guard makes very unlikely) we drop the OLDEST (stalest) audio rather than grow
// the heap without limit. Reaching the cap needs ~64 s of *continuous*
// back-pressure, i.e. a sidecar that has effectively hung: at that point the
// live transcript is already compromised and dropping (which can splice a gap
// into the live FINAL) is the least-bad option — the post-stop batch
// transcription reads the on-disk recording and is unaffected. All state is
// per-process (bound on `proc` in spawnLiveTranscribe) so a quick stop→start
// can't bleed a stale queue into the new sidecar.
const LIVE_STDIN_MAX_QUEUE_BYTES = 8 * 1024 * 1024; // ≈ 64 s of 16 kHz stereo float32

function writeLiveChunk(proc, buf) {
  if (proc._stdinBackpressured) {
    proc._stdinQueue.push(buf);
    proc._stdinQueueBytes += buf.length;
    // Bound the queue: drop the oldest chunk(s) once we exceed the cap. Keep at
    // least the chunk we just pushed so a single oversized buffer still flows.
    while (proc._stdinQueueBytes > LIVE_STDIN_MAX_QUEUE_BYTES
           && proc._stdinQueue.length > 1) {
      const dropped = proc._stdinQueue.shift();
      proc._stdinQueueBytes -= dropped.length;
      proc._stdinDroppedBytes += dropped.length;
    }
    return;
  }
  if (!proc.stdin.write(buf)) proc._stdinBackpressured = true;
}

ipcMain.on('live-transcribe-chunk', (event, payload) => {
  const proc = liveTranscribeProcess;
  if (!proc || proc.killed) return;
  if (!payload) return;
  // Teardown race: on stop we end/kill the sidecar, but the renderer may push
  // one more in-flight chunk → an async "write after end" error. Skip the write
  // once stdin is no longer writable so we don't log a spurious error on every
  // recording stop.
  const stdin = proc.stdin;
  if (!stdin || stdin.destroyed || stdin.writableEnded || !stdin.writable) return;
  // Renderer side sends an ArrayBuffer; Electron's IPC layer hands us a
  // Buffer here. If a TypedArray slipped through, normalise.
  const buf = Buffer.isBuffer(payload) ? payload : Buffer.from(payload);
  try {
    writeLiveChunk(proc, buf);
  } catch (e) {
    // EPIPE means Python exited (e.g. crashed). Drop silently; the exit
    // handler will null out the process ref.
    sendDebugLog(`live-transcribe-chunk write failed: ${e.message}`);
  }
});

// Optional explicit stop signal (mirrors live-transcribe-chunk on the
// send channel). stop-recording-ui already calls stopLiveTranscribe, so
// this is mostly defensive — e.g. if the renderer wants to tear down the
// sidecar without ending the recording (it doesn't today, but a future
// "pause live transcription" toggle could).
ipcMain.on('live-transcribe-stop', () => {
  stopLiveTranscribe();
});

// Returns the current live transcript buffer for the in-flight recording.
// Used by LiveTranscriptPanel after a late mount (e.g. user navigated away
// and back during recording) to backfill segments before subscribing to
// `live-transcript-chunk` for the tail. Returns an empty array when no
// recording is active.
ipcMain.handle('get-live-transcript-state', async () => {
  return {
    success: true,
    sessionName: liveTranscriptState.sessionName,
    segments: liveTranscriptState.segments.slice(),
    priorSegments: (liveTranscriptState.priorSegments || []).slice(),
    ready: liveTranscriptState.ready,
    error: liveTranscriptState.error,
  };
});

// Spawn the active live ASR sidecar. Parakeet uses the Python backend;
// Apple uses the native SpeechTranscriber helper. Both emit the same
// LIVE_READY / LIVE_SEG / LIVE_ERROR line protocol.
function spawnLiveTranscribe(sessionName, options = {}) {
  if (liveTranscribeProcess) {
    // Race-safe restart: a quick stop→start can land here while the
    // previous subprocess is still draining its stdin. Skipping the
    // spawn would silently leave the new session with no live
    // transcription. Force-stop the old one and reset state so we
    // always end up with a fresh sidecar.
    sendDebugLog('Live transcribe sidecar still present at new start; forcing restart');
    stopLiveTranscribe();
    liveTranscribeProcess = null;
    liveTranscribeSessionName = null;
    liveTranscribeStdoutBuf = '';
  }
  const aiEnv = getAiEnv();
  const env = Object.keys(aiEnv).length > 0
    ? { ...require('process').env, ...aiEnv }
    : undefined;
  const transcription = loadTranscriptionContext();
  const usesAppleSpeech = transcription.engine === 'apple';
  const executable = usesAppleSpeech ? getAppleTranscribePath() : getBackendPath();
  const args = usesAppleSpeech
    ? ['stream', transcription.language || 'auto']
    : ['transcribe-stream'];
  parakeetLoadStartedAt = usesAppleSpeech ? 0 : Date.now();
  liveTranscribeProcess = spawn(executable, args, {
    cwd: getBackendCwd(),
    env,
    // Default {pipe, pipe, pipe} — audio enters stdin and the shared live
    // protocol is read from stdout.
  });
  liveTranscribeSessionName = sessionName;
  liveTranscribeStdoutBuf = '';

  // Per-instance drain promise: resolves when THIS process has fully closed
  // its stdio (all stdout `data` events processed), not merely exited. We bind
  // the resolver to `proc` so a quick stop→start can't have the old process's
  // teardown resolve/null the NEW process's state (#207 review-2, Finding 2).
  const proc = liveTranscribeProcess;
  proc._usesAppleSpeech = usesAppleSpeech;
  proc._liveLanguage = usesAppleSpeech ? (transcription.language || 'auto') : null;
  proc._timelineOffset = typeof options.timelineOffset === 'number' && Number.isFinite(options.timelineOffset) && options.timelineOffset > 0
    ? options.timelineOffset
    : 0;
  proc._drainResolve = null;
  proc._drainPromise = new Promise((resolve) => {
    proc._drainResolve = resolve;
  });

  // stdin back-pressure state (#357): honored by writeLiveChunk(). Flushed on
  // 'drain' below. Per-process so a quick stop→start starts with an empty queue.
  proc._stdinBackpressured = false;
  proc._stdinQueue = [];
  proc._stdinQueueBytes = 0;
  proc._stdinDroppedBytes = 0;
  proc.stdin.on('drain', () => {
    proc._stdinBackpressured = false;
    while (proc._stdinQueue.length > 0
           && proc.stdin.writable && !proc.stdin.writableEnded) {
      const chunk = proc._stdinQueue.shift();
      proc._stdinQueueBytes -= chunk.length;
      if (!proc.stdin.write(chunk)) { proc._stdinBackpressured = true; break; }
    }
    if (proc._stdinDroppedBytes > 0) {
      sendDebugLog(
        `live-transcribe stdin back-pressure: dropped ${proc._stdinDroppedBytes} `
        + 'bytes of stale audio while the sidecar was behind',
      );
      proc._stdinDroppedBytes = 0;
    }
  });

  proc.stdout.on('data', (data) => {
    // Drop output from a superseded process. On a quick stop→start the OLD
    // sidecar may still be draining; without this guard its stdout would write
    // into the global buffer / liveTranscriptState and contaminate the NEW
    // recording with stale segments (#207 review, Blocker 1).
    if (liveTranscribeProcess !== proc) return;
    // Stdout arrives in arbitrary-sized chunks; concatenate then split on
    // newlines so a multi-line frame straddling reads is handled.
    liveTranscribeStdoutBuf += data.toString();
    let nl;
    while ((nl = liveTranscribeStdoutBuf.indexOf('\n')) !== -1) {
      const line = liveTranscribeStdoutBuf.slice(0, nl);
      liveTranscribeStdoutBuf = liveTranscribeStdoutBuf.slice(nl + 1);
      handleLiveTranscribeLine(line, proc);
    }
  });

  proc.stderr.on('data', (data) => {
    // Python logger output goes to stderr — bubble through debug log
    // without spamming the renderer.
    sendDebugLog(`[live-transcribe] ${data.toString().trim()}`);
  });

  attachProcessingStderr(proc, 'live-transcribe');

  // Wait on `close`, not `exit`: `exit` fires when the child terminates but
  // does NOT guarantee stdout is fully drained and every `data` event has been
  // processed — so the FINAL segment may not yet be in liveTranscriptState.
  // `close` fires only after all stdio streams have closed, which is the
  // correct barrier for the #207 fallback snapshot (review-2, Finding 1).
  proc.on('close', (code, signal) => {
    sendDebugLog(`Live transcribe sidecar closed code=${code} signal=${signal}`);
    // Only clear globals if THIS process is still the active one. A quick
    // stop→start may have already installed a fresh sidecar; nulling here
    // would destroy the new process's state (review-2, Finding 2).
    if (liveTranscribeProcess === proc) {
      liveTranscribeProcess = null;
      liveTranscribeSessionName = null;
      liveTranscribeStdoutBuf = '';
      // Clear the load clock if the sidecar died before LIVE_READY, so a later
      // path can't log a duration against this stale stamp.
      parakeetLoadStartedAt = 0;
    }
    // Unblock this instance's drain waiter (#207, Fix 2) now that all stdout
    // has been flushed and parsed by the stdout handler above. Resolver is
    // bound to `proc`, so it only ever resolves for the right process.
    if (proc._drainResolve) {
      const resolve = proc._drainResolve;
      proc._drainResolve = null;
      resolve();
    }
  });

  proc.on('error', (err) => {
    sendDebugLog(`Live transcribe sidecar error: ${err.message}`);
    // A spawn-time error means `close` may never fire — unblock the drain
    // waiter so the fallback snapshot doesn't hang on a process that died.
    if (proc._drainResolve) {
      const resolve = proc._drainResolve;
      proc._drainResolve = null;
      resolve();
    }
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('live-transcript-error', {
        sessionName,
        stage: 'spawn',
        message: err.message,
      });
    }
  });

  // stdin emits 'error' asynchronously when a write completes against a
  // closed pipe (the sync try/catch around stdin.write only catches
  // immediate errors). Without a listener, EPIPE bubbles to uncaught and
  // crashes the main process. Race window: chunks queued in the IPC
  // pipeline land here after the sidecar exited (stop, crash, kill).
  proc.stdin.on('error', (err) => {
    if (err && err.code === 'EPIPE') {
      // Expected when Python exited mid-write. The exit handler will
      // null the ref so subsequent chunks short-circuit at the guard.
      return;
    }
    sendDebugLog(`Live transcribe stdin error: ${err.message}`);
  });
}

// Shared LIVE_* line handler used by the transcribe-stream stdout parser.
// Keeps the per-line semantics (buffer mutation + IPC emit) in one place
// so the legacy `record --live` path and this sidecar path stay in lock
// step if we ever extend the protocol.
function handleLiveTranscribeLine(line, proc = liveTranscribeProcess) {
  const sessionName = liveTranscribeSessionName;
  if (line.startsWith('LIVE_READY:')) {
    if (parakeetLoadStartedAt) {
      sendDebugLog(`[parakeet-load] model ready in ${Date.now() - parakeetLoadStartedAt}ms (transcribe-stream)`);
      parakeetLoadStartedAt = 0;
    }
    liveTranscriptState.ready = true;
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('live-transcript-ready', { sessionName });
    }
    return;
  }
  if (line.startsWith('LIVE_SEG:')) {
    try {
      const seg = JSON.parse(line.slice('LIVE_SEG:'.length));
      const offset = (proc && typeof proc._timelineOffset === 'number' && Number.isFinite(proc._timelineOffset))
        ? proc._timelineOffset
        : 0;
      const rawStart = typeof seg.start === 'number' ? seg.start : 0;
      const rawEnd = typeof seg.end === 'number' ? seg.end : rawStart;
      const segment = {
        text: seg.text,
        start: rawStart + offset,
        end: rawEnd + offset,
        isFinal: !!seg.is_final,
        // 'You' | 'Others', set directly by the Python sidecar from which
        // channel (mic vs system) produced this segment — a structural
        // fact, not a client-side RMS guess.
        speaker: seg.speaker,
      };
      // Invariant maintained on liveTranscriptState.segments: chronologically
      // sorted finals first, followed by at most one in-progress partial per
      // speaker trailing at the end. With two independent channels now
      // emitting interleaved streams, "replace whatever the last array entry
      // is" (the old single-stream logic) would clobber one channel's
      // in-progress partial with the other's, and a final released late by
      // the bleed-dedup hold could land out of chronological order relative
      // to a still-ongoing utterance on the other channel. Splitting finals
      // from trailing partials and inserting each in its own lane fixes both.
      const speakerKey = segment.speaker === 'Others' ? 'Others' : 'You';
      let splitIdx = liveTranscriptState.segments.length;
      while (splitIdx > 0 && !liveTranscriptState.segments[splitIdx - 1].isFinal) splitIdx--;
      const finals = liveTranscriptState.segments.slice(0, splitIdx);
      const partials = liveTranscriptState.segments.slice(splitIdx);
      if (segment.isFinal) {
        let insertAt = finals.length;
        while (insertAt > 0 && finals[insertAt - 1].start > segment.start) insertAt--;
        finals.splice(insertAt, 0, segment);
        // Only drop a same-speaker partial if it could plausibly BE the
        // utterance this final supersedes (started before this final's
        // utterance ended). A bleed-delayed final can arrive well after
        // the SAME speaker has already started a newer, unrelated
        // utterance — dropping every same-speaker partial indiscriminately
        // would clobber that unrelated one until its next partial tick.
        const remainingPartials = partials.filter(
          (s) => (s.speaker === 'Others' ? 'Others' : 'You') !== speakerKey
            || s.start > segment.end,
        );
        liveTranscriptState.segments = [...finals, ...remainingPartials];
      } else {
        const otherPartials = partials.filter(
          (s) => (s.speaker === 'Others' ? 'Others' : 'You') !== speakerKey,
        );
        liveTranscriptState.segments = [...finals, ...otherPartials, segment];
      }
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('live-transcript-chunk', { sessionName, segment });
      }
    } catch (e) {
      sendDebugLog(`LIVE_SEG parse error (sidecar): ${e.message}`);
    }
    return;
  }
  if (line.startsWith('LIVE_ERROR:')) {
    try {
      const payload = JSON.parse(line.slice('LIVE_ERROR:'.length));
      liveTranscriptState.error = payload;
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('live-transcript-error', {
          sessionName, ...payload,
        });
      }
    } catch (e) {
      sendDebugLog(`LIVE_ERROR parse error (sidecar): ${e.message}`);
    }
  }
}

// Tear down the live transcribe sidecar. Closing stdin is the clean
// shutdown signal — Python's read loop hits EOF, drains the VAD, exits.
// Falls back to SIGTERM after a short wait if it doesn't exit on its own.
//
// Returns a promise that resolves once the sidecar has fully exited (or
// immediately if there was none). The #207 fallback snapshot awaits this so
// it captures the FINAL segment of the last utterance, which Python only emits
// after stdin EOF (Fix 2). Callers that don't care can ignore the return value.
function stopLiveTranscribe() {
  const proc = liveTranscribeProcess;
  if (!proc) return Promise.resolve();
  // The per-instance drain promise (installed in spawnLiveTranscribe) resolves
  // on this process's `close` — bound to `proc`, so a double-stop or a
  // quick restart can't cross resolvers between processes (review-2, Finding 2).
  const exited = proc._drainPromise || Promise.resolve();
  try {
    // Flush any back-pressure queue (#357) into stdin before ending it.
    // Chunks held in proc._stdinQueue haven't reached Node's write buffer yet,
    // so a stop while back-pressured would otherwise discard the tail of the
    // last utterance and truncate Python's live FINAL. Handing them to write()
    // now lets end() flush them to the sidecar; Node buffers past the OS pipe
    // limit here, which is fine for a one-shot drain at teardown.
    if (proc._stdinQueue && proc._stdinQueue.length > 0
        && proc.stdin.writable && !proc.stdin.writableEnded) {
      for (const chunk of proc._stdinQueue) proc.stdin.write(chunk);
    }
    if (proc._stdinQueue) { proc._stdinQueue = []; proc._stdinQueueBytes = 0; }
    proc.stdin.end();
  } catch (_) { /* already closed */ }
  // Watchdog: if THIS Python process hasn't exited in SIDECAR_KILL_WATCHDOG_MS,
  // force kill. Bind to `proc`, not the global liveTranscribeProcess: after a
  // quick stop→start the global already points at the NEW sidecar, so the old
  // hung process would never be recognized and killed (#207 review, Blocker 1).
  setTimeout(() => {
    if (!proc.killed) {
      try { proc.kill('SIGTERM'); } catch (_) {}
    }
  }, SIDECAR_KILL_WATCHDOG_MS);
  return exited;
}

async function restartActiveAppleLiveTranscribeAfterLanguageChange() {
  const proc = liveTranscribeProcess;
  const sessionName = liveTranscribeSessionName;
  if (!proc || !proc._usesAppleSpeech || !systemAudioRecordingActive || !sessionName) {
    return;
  }

  sendDebugLog('Language changed; restarting active Apple live transcribe sidecar');
  liveTranscriptState.ready = false;
  liveTranscriptState.error = null;

  await stopLiveTranscribe();

  // Filter to retained final segments and compute timeline offset from maximum end time
  const retainedFinals = (liveTranscriptState.segments || [])
    .filter((segment) => segment && segment.isFinal);
  liveTranscriptState.segments = retainedFinals;

  let timelineOffset = 0;
  for (const seg of retainedFinals) {
    if (typeof seg.end === 'number' && Number.isFinite(seg.end) && seg.end > timelineOffset) {
      timelineOffset = seg.end;
    }
  }

  if (
    systemAudioRecordingActive
    && currentRecordingSessionName === sessionName
    && liveTranscribeProcess === null
  ) {
    spawnLiveTranscribe(sessionName, { timelineOffset });
  }
}



// Sync read avoids spawning a backend process on every recording start.
function loadTranscriptionEngine() {
  try {
    const cfgPath = path.join(getUserDataDir(), 'config.json');
    if (!fs.existsSync(cfgPath)) return defaultTranscriptionEngine();
    const cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf-8'));
    return normalizeTranscriptionEngine(cfg.transcription_engine);
  } catch (_) {
    return defaultTranscriptionEngine();
  }
}

// Sync read of engine/model/language for live setup and analytics.
function loadTranscriptionContext() {
  try {
    const cfgPath = path.join(getUserDataDir(), 'config.json');
    if (!fs.existsSync(cfgPath)) {
      const engine = defaultTranscriptionEngine();
      return { engine, model: engine, language: 'auto' };
    }
    const cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf-8'));
    const engine = normalizeTranscriptionEngine(cfg.transcription_engine);
    return {
      engine,
      model: engine === 'whisper'
        ? sanitizeModelForAnalytics(cfg.whisper_model)
        : engine,
      language: cfg.language || 'auto',
    };
  } catch (_) {
    const engine = defaultTranscriptionEngine();
    return { engine, model: engine, language: 'auto' };
  }
}

// Sync read of the summarization provider + model for
// summarization_completed's analytics properties.
function loadSummarizationContext() {
  try {
    const cfgPath = path.join(getUserDataDir(), 'config.json');
    if (!fs.existsSync(cfgPath)) {
      return { provider: 'local', model: 'unknown' };
    }
    const cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf-8'));
    const provider = cfg.ai_provider || 'local';
    return {
      provider,
      model: provider === 'cloud'
        ? sanitizeModelForAnalytics(cfg.cloud_model)
        : sanitizeModelForAnalytics(cfg.model),
    };
  } catch (_) {
    return { provider: 'local', model: 'unknown' };
  }
}

// Sync read of the auto-detect-meetings setting; default ON. Reads the JSON
// directly to avoid spawning Python during startup just to read a boolean. Wire any new defaults through the Python config so
// the truth lives in one place.
function loadAutoDetectMeetingsEnabled() {
  try {
    const cfgPath = path.join(getUserDataDir(), 'config.json');
    if (!fs.existsSync(cfgPath)) return true;
    const cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf-8'));
    return cfg.auto_detect_meetings_enabled !== false;
  } catch (_) {
    return true;
  }
}

// Same sync-read-at-startup pattern as loadAutoDetectMeetingsEnabled(), used
// to decide whether createTray() should run at all without spawning Python.
function loadShowMenuBarIconEnabled() {
  try {
    const cfgPath = path.join(getUserDataDir(), 'config.json');
    if (!fs.existsSync(cfgPath)) return true;
    const cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf-8'));
    return cfg.show_menu_bar_icon !== false;
  } catch (_) {
    return true;
  }
}

// Sync read of the idle auto-install setting; default ON (matches the Python
// config default). Read fresh on every gate tick so flipping the toggle in
// Settings takes effect without a relaunch. Same no-subprocess JSON read as the
// helpers above — the source of truth is the Python config.
function loadAutoInstallWhenIdleEnabled() {
  try {
    const cfgPath = path.join(getUserDataDir(), 'config.json');
    if (!fs.existsSync(cfgPath)) return true;
    const cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf-8'));
    return cfg.auto_install_when_idle !== false;
  } catch (_) {
    return true;
  }
}

// Global recording state management
let systemAudioRecordingActive = false;  // Track system audio recording for tray/quit
// Toggle renderer background-throttling to match recording state (#442 review).
// While recording we must NOT throttle — capture is renderer-owned (MediaRecorder
// timeslice + silence-auto-stop interval + the live-tap) and can run with the
// window hidden (auto-detect starts without showing it), where Chromium would
// otherwise clamp timers. When not recording we allow throttling so a
// backgrounded-idle app doesn't waste CPU. Reads the flag, so it's correct
// regardless of which start/stop path called it. Idempotent + fail-safe.
function applyRecordingBackgroundThrottling() {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  try {
    // setBackgroundThrottling(allowed): true = throttle when hidden (default),
    // false = never throttle. We disallow throttling while recording.
    mainWindow.webContents.setBackgroundThrottling(!systemAudioRecordingActive);
  } catch (_) { /* older Electron / no webContents — harmless */ }
}
let currentRecordingProcess = null;
let currentRecordingSessionName = null;  // Surfaced in get-queue-status so renderer knows which meeting is live
let processingQueue = [];

// ── End orphan-recording cleanup ────────────────────────────────────────
// Live-transcript ring buffer for the in-flight recording. Populated by the
// Python `record --live` subprocess's LIVE_SEG: stdout lines. The renderer
// subscribes to `live-transcript-chunk` for new entries and calls
// `liveTranscript.getState()` after a late mount to backfill. Reset on every
// fresh recording start so a previous session's segments don't leak into
// the next note. ``ready`` flips true once the Python side has loaded the
// Parakeet model; ``error`` carries the last failure reason (model failed
// to load, MLX missing, etc.) for the UI to surface.
let liveTranscriptState = {
  sessionName: null,
  // The note (summary-file realpath) this buffer belongs to, used to decide
  // whether a resume/continue is continuing THIS note (carry its prior
  // segments) or a different one (start fresh). Set at start for appends and
  // stamped at stop for a fresh recording once its landing note is known — so
  // matching on it is unambiguous even when two notes share the default "Note"
  // name (session name alone would collide).
  summaryFile: null,
  segments: [],
  // Display-only carry-over: the finalised segments from the PREVIOUS
  // recording into this same note, preserved across a resume/continue so the
  // live bar shows earlier speech instead of starting blank. Kept SEPARATE
  // from `segments` on purpose — the resumed sidecar restarts its clock at 0,
  // so folding these into the chronologically-sorted `segments` would misorder
  // them, and including them in the stop-time snapshot/append would duplicate
  // text the note already holds on disk. Rendered before the live tail; never
  // fed to the snapshot/placeholder/append pipeline.
  priorSegments: [],
  ready: false,
  error: null,
};

// Sidecar Python `transcribe-stream` subprocess used by the system-audio
// path. The renderer captures mic + system audio on separate Web Audio
// taps, downsamples each to 16 kHz, interleaves them into stereo (mic=L,
// system=R — NOT mixed to mono), and pushes chunks here via
// `live-transcribe-chunk`; we pipe them into this process's stdin. The
// sidecar de-interleaves and transcribes each channel independently so
// LIVE_SEG's `speaker` field is a structural fact, not a guess. Its
// stdout is parsed the same way
// the in-process `record --live` stdout is — same LIVE_READY / LIVE_SEG /
// LIVE_ERROR protocol, same liveTranscriptState mutations, same IPC
// events emitted to the renderer.
// How long stopLiveTranscribe() lets Python drain + emit its FINAL segment
// before force-killing the sidecar. The fallback snapshot's drain wait is
// aligned to the same value so the snapshot never times out ahead of the kill.
const SIDECAR_KILL_WATCHDOG_MS = 5000;
let liveTranscribeProcess = null;
let liveTranscribeSessionName = null;
let liveTranscribeStdoutBuf = '';
// The drain barrier (#207, Fix 2) now lives per process instance on
// `proc._drainPromise` / `proc._drainResolve` (installed in
// spawnLiveTranscribe). stopLiveTranscribe() only closes stdin and returns
// immediately, but Python still needs a moment to drain its VAD and emit the
// FINAL segment of the last utterance; the fallback snapshot awaits that
// instance's promise so it captures the final segment instead of racing ahead
// of it — and a quick restart can't cross resolvers between processes.
let isProcessing = false;
let currentProcessingJob = null;
// Wall-clock start of the in-flight queue job, so the processing timer advances
// for jobs with no recording elapsed (e.g. an imported file). Recordings keep
// using their draft start time on the renderer side.
let currentProcessingStartedAtMs = null;
// Reprocess runs as a side-channel from the main processing queue (different
// Python command, started directly from the reprocess-meeting IPC). Tracked
// here so the renderer can show "this note is being regenerated" on Home
// without confusing it with a queued recording. Map keyed by summaryFile so
// overlapping reprocess calls coexist — earlier a single global raced: B's
// IPC overwrote A's entry, and A's finally would null the state out while
// B was still running, hiding B's badge. Entries are removed in each IPC's
// finally so a Python crash or spawn error doesn't leave them stuck.
//
// NOTE (pre-existing, out of #234 scope): keyed by summaryFile, so TWO jobs on
// the SAME summary path still overwrite each other's marker (and the first
// finally clears it while the second runs). The reprocess UI's re-entrancy
// guards prevent concurrent same-note jobs, so this isn't triggerable today; not
// changed here to avoid altering the shared map's semantics.
const activeReprocessJobs = new Map();
let recordingRuntimeState = {
  startedAtMs: null,
  pausedAtMs: null,
  pausedTotalMs: 0,
  isPaused: false
};
let ollamaProcess = null;  // Track spawned Ollama process for cleanup on quit
let ollamaPid = null;      // Store PID separately since unref() disconnects the process
let ollamaStartedByUs = false;

// Content-free crash/force-quit detection (report Appendix: ~8% of macOS
// recordings never fire recording_stopped at all -- a silent gap in the
// activation funnel). Written when a recording starts, deleted on a clean
// stop; if it's still there at the NEXT launch, the previous run never
// reached stop-recording-ui's cleanup.
function getRecordingActiveMarkerPath() {
  return path.join(getUserDataDir(), '.recording-active');
}

function markRecordingActiveOnDisk() {
  try {
    fs.writeFileSync(getRecordingActiveMarkerPath(), String(Date.now()));
  } catch (_) {
    // Best-effort -- a failed write just means this diagnostic is unavailable
  }
}

function clearRecordingActiveMarker() {
  try {
    fs.unlinkSync(getRecordingActiveMarkerPath());
  } catch (_) {
    // Already gone / never written -- fine
  }
}

// Called once at startup, after initTelemetry. Emits a synthetic
// recording_stopped for the previous run's recording if it never cleanly
// stopped, then clears the marker so it can't re-fire on a later launch.
function checkForOrphanedRecording() {
  try {
    if (fs.existsSync(getRecordingActiveMarkerPath())) {
      trackEvent('recording_stopped', { reason: 'unclean_shutdown' });
    }
  } catch (_) {
    // Silent fail
  } finally {
    clearRecordingActiveMarker();
  }
}

function resetRecordingRuntimeState() {
  recordingRuntimeState = {
    startedAtMs: null,
    pausedAtMs: null,
    pausedTotalMs: 0,
    isPaused: false
  };
  // Instant stop: drop the recording's predicted summary path on teardown so it
  // can't be read for a later session (open sets a fresh one). Not nulled in
  // close-system-audio-file, which races stop-recording-ui — this runs at the
  // end of stop, after the placeholder is written.
  activeSysAudioSummaryFile = null;
  // Folded in here (rather than at each of this function's call sites) so
  // every teardown path -- clean stop, a failed start, or the quit-time
  // cleanup -- consistently clears the crash/force-quit marker.
  clearRecordingActiveMarker();
}

function startRecordingRuntimeState() {
  recordingRuntimeState = {
    startedAtMs: Date.now(),
    pausedAtMs: null,
    pausedTotalMs: 0,
    isPaused: false
  };
  markRecordingActiveOnDisk();
}

function markRecordingPaused() {
  if (!recordingRuntimeState.startedAtMs || recordingRuntimeState.isPaused) {
    return;
  }
  recordingRuntimeState.isPaused = true;
  recordingRuntimeState.pausedAtMs = Date.now();
}

function markRecordingResumed() {
  if (!recordingRuntimeState.isPaused) {
    return;
  }
  if (recordingRuntimeState.pausedAtMs) {
    recordingRuntimeState.pausedTotalMs += Date.now() - recordingRuntimeState.pausedAtMs;
  }
  recordingRuntimeState.isPaused = false;
  recordingRuntimeState.pausedAtMs = null;
}

function getRecordingElapsedSeconds() {
  if (!recordingRuntimeState.startedAtMs) {
    return 0;
  }

  let pausedMs = recordingRuntimeState.pausedTotalMs;
  if (recordingRuntimeState.isPaused && recordingRuntimeState.pausedAtMs) {
    pausedMs += Date.now() - recordingRuntimeState.pausedAtMs;
  }

  return Math.max(
    0,
    Math.floor((Date.now() - recordingRuntimeState.startedAtMs - pausedMs) / 1000)
  );
}

// Inactivity watchdog for long-running backend subprocesses (transcribe +
// summarise). A fixed kill-timeout punishes slow-but-alive work — a 3-hour
// meeting transcribing on a cold or CPU-only machine can legitimately run
// past 30 minutes — while no timeout at all wedges the processing queue
// forever behind a hung process. Instead we kill only after a window with
// zero stdout/stderr activity. The Python pipeline emits HEARTBEAT: lines
// per transcription chunk precisely so this timer keeps resetting while
// real work is happening. 8 minutes covers a cold model load plus a stalled
// chunk with margin, and still reaps a truly hung process ~4x faster than
// the old fixed 30-minute timer.
const TRANSCRIBE_INACTIVITY_MS = 8 * 60 * 1000;

// Live watchdogs, frozen across system sleep. Node's timer clock advances
// during sleep on Apple Silicon and Windows, so a lid-close while processing
// would otherwise fire the inactivity deadline the moment the machine wakes —
// killing a suspended-but-healthy subprocess before it gets a chance to emit
// its next heartbeat. Freezing on 'suspend' (before sleep, so there's no race
// with an already-expired timer on wake) and re-arming on 'resume' gives the
// resumed process a full fresh window.
const activeInactivityWatchdogs = new Set();
// True between powerMonitor 'suspend' and 'resume'. A watchdog created in
// the suspend→sleep gap (the queue can start its next job there) must not
// arm — its deadline would include the slept wall-clock and fire on wake.
let systemSuspendedForWatchdogs = false;

function makeInactivityWatchdog(proc, ms, label) {
  let timer = null;
  const arm = () => {
    timer = setTimeout(() => {
      timer = null;
      activeInactivityWatchdogs.delete(watchdog);
      console.error(`${label} produced no output for ${Math.round(ms / 60000)} minutes, killing`);
      sendDebugLog(`${label} inactive for ${Math.round(ms / 60000)} minutes — killing process`);
      try { proc.kill(); } catch (e) { /* process already gone */ }
    }, ms);
  };
  const watchdog = {
    // Any stdout/stderr activity proves liveness — push the deadline out.
    reset() {
      if (timer === null) return; // fired, cleared, or frozen — don't re-arm
      clearTimeout(timer);
      arm();
    },
    // System sleep: stop the clock entirely (keeps membership in the set).
    freeze() {
      if (timer !== null) {
        clearTimeout(timer);
        timer = null;
      }
    },
    // System wake: restart with a full window. Unconditional re-arm for set
    // members (an already-armed timer just gets a fresh, generous window);
    // a cleared/fired watchdog left the set and stays dead.
    thaw() {
      if (!activeInactivityWatchdogs.has(watchdog)) return;
      if (timer !== null) clearTimeout(timer);
      arm();
    },
    clear() {
      if (timer !== null) clearTimeout(timer);
      timer = null;
      activeInactivityWatchdogs.delete(watchdog);
    }
  };
  if (!systemSuspendedForWatchdogs) arm(); // else thaw() arms on wake
  activeInactivityWatchdogs.add(watchdog);
  return watchdog;
}

function freezeInactivityWatchdogsForSleep() {
  systemSuspendedForWatchdogs = true;
  if (activeInactivityWatchdogs.size === 0) return;
  sendDebugLog(`[power] system suspending — freezing ${activeInactivityWatchdogs.size} inactivity watchdog(s)`);
  for (const wd of activeInactivityWatchdogs) wd.freeze();
}

function thawInactivityWatchdogsAfterWake() {
  systemSuspendedForWatchdogs = false;
  if (activeInactivityWatchdogs.size === 0) return;
  sendDebugLog(`[power] system resumed — re-arming ${activeInactivityWatchdogs.size} inactivity watchdog(s)`);
  for (const wd of activeInactivityWatchdogs) wd.thaw();
}

// Processing queue management
async function processNextInQueue() {
  if (isProcessing || processingQueue.length === 0) {
    return;
  }

  isProcessing = true;
  currentProcessingJob = processingQueue.shift();
  currentProcessingStartedAtMs = Date.now();

  console.log(`🔄 Processing queued job: ${currentProcessingJob.sessionName}`);

  // Coarse pipeline-stage tracker for error_occurred's `stage` property
  // (processing_queue is ~96% of all logged errors with no detail today —
  // this is the cheapest signal to distinguish a transcription crash from a
  // summarization crash without parsing stderr). Declared in the outer scope
  // so the catch block below can still read it after the inner Promise
  // executor's scope has closed.
  let processingStage = 'transcription';
  // Captured from a STREAM_ERROR: line during the summarization stage, so the
  // catch block below can classify the real failure reason for error_occurred
  // instead of only seeing "exited with code N" (see classifySummarizationStreamError).
  let summarizationStreamError = null;
  // Read once per job (not per marker) -- engine/model/language/provider
  // don't change mid-job, and this avoids a repeated config.json read on
  // every stdout line.
  const transcriptionCtx = loadTranscriptionContext();
  const summarizationCtx = loadSummarizationContext();
  // Set when TRANSCRIPTION_COMPLETE arrives, so summarization_completed's
  // processing_bucket measures summarization time alone, not the whole job.
  let transcriptionEndedAtMs = null;
  // Set true only when STREAM_COMPLETE arrives (summarization actually ran).
  // Stays false on the transcript-only path (auto_summarize off → the backend
  // prints SUMMARY_SKIPPED, never STREAM_COMPLETE), so the renderer can fire
  // "Note ready" only when notes really exist, and a "Transcript ready —
  // generate notes?" prompt otherwise (#bug2/#bug3).
  let summarizationCompleted = false;

  try {
    const queueAiEnv = getAiEnv();
    const queueEnv = Object.keys(queueAiEnv).length > 0 ? { ...require('process').env, ...queueAiEnv } : undefined;
    const processArgs = ['process-streaming', currentProcessingJob.audioFile, '--name', currentProcessingJob.sessionName];
    if (currentProcessingJob.notesFile && fs.existsSync(currentProcessingJob.notesFile)) {
      processArgs.push('--notes', currentProcessingJob.notesFile);
    }
    // Live-transcript fallback (#207): hand Python the live transcript snapshot
    // so it can rescue the meeting if the batch transcription comes back empty.
    if (currentProcessingJob.liveTranscriptFile && fs.existsSync(currentProcessingJob.liveTranscriptFile)) {
      processArgs.push('--live-transcript', currentProcessingJob.liveTranscriptFile);
    }
    // Continue-recording: fold this segment into an existing note instead of
    // creating a new one. The backend appends the transcript, marks the note
    // notes_stale, and emits SAVED:<target> so the completion event points at
    // the continued note.
    if (currentProcessingJob.appendTo && fs.existsSync(currentProcessingJob.appendTo)) {
      processArgs.push('--append-to', currentProcessingJob.appendTo);
    }

    await new Promise((resolve, reject) => {
      const proc = spawn(getBackendPath(), processArgs, {
        cwd: getBackendCwd(),
        env: queueEnv
      });

      let stderrBuf = '';
      // Captured from `SAVED:<path>` so processing-complete can include
      // meetingData and the renderer can auto-navigate to the new note.
      // Without this the renderer-driven (system audio) flow leaves the
      // user stranded on /meetings/processing after the summary streams in.
      let savedSummaryFile = null;
      // Captured from `TRANSCRIPTION_FAILED:<msg>` — the Python pipeline
      // gracefully marks a transcription crash (e.g. an OOM on a long file),
      // preserves the audio, and still emits SAVED: for a reprocessable
      // meeting. We thread the flag into processing-complete so the renderer
      // surfaces the failure honestly instead of as a normal saved note.
      let transcriptionFailedMsg = null;
      // Last time a HEARTBEAT: line was forwarded to the debug log (the
      // watchdog reset itself is unconditional). 0 → log the first one.
      let lastHeartbeatLogAt = 0;

      // Liveness watchdog: kills the process only after a window of zero
      // output. HEARTBEAT:/CHUNK: lines from the backend keep it alive, so
      // a long transcription on a slow machine is never killed mid-work.
      const watchdog = makeInactivityWatchdog(proc, TRANSCRIBE_INACTIVITY_MS, 'process-streaming');

      proc.on('error', (err) => {
        watchdog.clear();
        reject(new Error(`process-streaming spawn error: ${err.message}`));
      });

      const stdoutReader = makeLineReader();
      proc.stdout.on('data', (data) => {
        watchdog.reset();
        // Parse protocol lines (CRLF-tolerant: Windows stdout is \r\n, and the
        // STREAM_COMPLETE exact-match below must not carry a trailing \r).
        // Buffered across chunk boundaries via makeLineReader — a sentinel
        // like SAVED: or STREAM_COMPLETE can straddle two 'data' events.
        for (const line of stdoutReader.feed(data)) {
          logPipelineStdoutLine(line, 'process-streaming');
          if (line.startsWith('CHUNK:')) {
            try {
              const encoded = line.slice(6);
              const chunk = Buffer.from(encoded, 'base64').toString('utf-8');
              if (mainWindow && !mainWindow.isDestroyed()) {
                // Stamp the summaryFile (instant-stop) so MeetingDetail's
                // filtered StreamingView listener renders a new note's first
                // summary inline; undefined for Whisper/import → Processing dock.
                mainWindow.webContents.send('summary-chunk', { chunk, sessionName: currentProcessingJob.sessionName, summaryFile: currentProcessingJob.summaryFile });
              }
            } catch (e) { console.log('CHUNK decode error:', e.message); }
          } else if (line.startsWith('TRANSCRIPTION_COMPLETE:')) {
            sendDebugLog(`Transcription complete (${line.split(':')[1]} chars)`);
            processingStage = 'summarization';
            transcriptionEndedAtMs = Date.now();
            trackEvent('transcription_completed', {
              success: true,
              engine: transcriptionCtx.engine,
              model: transcriptionCtx.model,
              language: transcriptionCtx.language,
              processing_bucket: durationBucket((transcriptionEndedAtMs - currentProcessingStartedAtMs) / 1000),
            });
          } else if (line.startsWith('TITLE:')) {
            const title = line.slice(6);
            if (mainWindow && !mainWindow.isDestroyed()) {
              mainWindow.webContents.send('summary-title', { title, sessionName: currentProcessingJob.sessionName });
            }
          } else if (line === 'STREAM_COMPLETE') {
            summarizationCompleted = true;
            const summarizationStartMs = transcriptionEndedAtMs || currentProcessingStartedAtMs;
            trackEvent('summarization_completed', {
              success: true,
              model: summarizationCtx.model,
              provider: summarizationCtx.provider,
              processing_bucket: durationBucket((Date.now() - summarizationStartMs) / 1000),
            });
          } else if (line.startsWith('SAVED:')) {
            savedSummaryFile = line.slice(6).trim();
            sendDebugLog(`Summary saved: ${savedSummaryFile}`);
          } else if (line.startsWith('TRANSCRIPTION_FAILED:')) {
            transcriptionFailedMsg = line.slice('TRANSCRIPTION_FAILED:'.length).trim();
            sendDebugLog(`Transcription failed (audio preserved): ${transcriptionFailedMsg}`);
            trackEvent('transcription_completed', {
              success: false,
              engine: transcriptionCtx.engine,
              model: transcriptionCtx.model,
              language: transcriptionCtx.language,
            });
          } else if (line.startsWith('STREAM_ERROR:')) {
            // Guarded on the WRITE (not just read at trackEvent time): today
            // process_streaming only ever prints STREAM_ERROR during the
            // summarization stage, but if that ever changed, an unguarded
            // capture here would let a transcription-stage STREAM_ERROR
            // masquerade as (or be overwritten by) a later summarization
            // failure that dies without its own message.
            if (processingStage === 'summarization') {
              summarizationStreamError = line.slice('STREAM_ERROR:'.length).trim();
            }
            forwardDiagnosticStdout(line, 'process-streaming');
          } else if (line.startsWith('PROGRESS:')) {
            if (mainWindow && !mainWindow.isDestroyed()) {
              // Instant stop stamps the (deterministic) summaryFile so the
              // note's own map-reduce progress bar tracks it; undefined for
              // Whisper/import, which the single-job Processing view consumes.
              mainWindow.webContents.send('processing-progress', { line, summaryFile: currentProcessingJob.summaryFile });
            }
          } else if (line.startsWith('HEARTBEAT:')) {
            // Liveness signal — its real job (resetting the watchdog) already
            // happened at the top of this handler. Throttle debug-log output
            // by TIME, not beat value: the MLX backend reports sample counts
            // and whisper.cpp reports segment counts, so any value-based
            // filter floods on at least one backend. One line per ~30 s keeps
            // a 3-hour meeting to a handful of entries.
            const now = Date.now();
            if (now - lastHeartbeatLogAt >= 30_000) {
              lastHeartbeatLogAt = now;
              sendDebugLog(line.trim());
            }
          } else {
            // Unclassified stdout: forward only diagnostic markers (e.g.
            // STREAM_ERROR:), drop content. HEARTBEAT is handled above with its
            // own 30s throttle, so it never double-logs here.
            forwardDiagnosticStdout(line, 'process-streaming');
          }
        }
      });

      proc.stderr.on('data', (data) => {
        watchdog.reset();
        const msg = data.toString().trim();
        if (msg) {
          stderrBuf += msg + '\n';
          sendDebugLog(`STDERR: ${msg}`);
        }
      });

      attachProcessingStderr(proc, 'process-streaming');

      proc.on('close', (code) => {
        watchdog.clear();
        if (code === 0) {
          console.log(`✅ Completed streaming processing: ${currentProcessingJob.sessionName}`);
          const sessionNameAtClose = currentProcessingJob.sessionName;
          // Mirror the finished note into an Obsidian vault when sync is on
          // (#413). Best-effort — a vault write must never affect processing.
          try {
            const finishedSummary = savedSummaryFile
              || (currentProcessingJob && currentProcessingJob.summaryFile);
            if (finishedSummary) obsidianSync.syncNoteBySummaryPath(finishedSummary);
          } catch (_) {}
          // Notify frontend that streaming is done and meeting is saved
          if (mainWindow && !mainWindow.isDestroyed()) {
            mainWindow.webContents.send('summary-complete', {
              success: true,
              sessionName: sessionNameAtClose,
              summaryFile: currentProcessingJob.summaryFile
            });
          }
          // Look up the saved meeting so we can include meetingData in the
          // processing-complete event. The renderer's processing-complete
          // handler navigates to /meetings/<file> only when meetingData is
          // present — without this the user gets stuck on the processing
          // page after the summary streams in.
          runPythonScript('simple_recorder.py', ['list-meetings'], true)
            .then(meetingsResult => {
              const allMeetings = JSON.parse(meetingsResult);
              let processedMeeting = null;
              if (savedSummaryFile) {
                processedMeeting = allMeetings.find(
                  m => m.session_info?.summary_file === savedSummaryFile
                );
              }
              if (!processedMeeting) {
                processedMeeting = allMeetings.find(
                  m => m.session_info?.name === sessionNameAtClose
                );
              }
              if (mainWindow && !mainWindow.isDestroyed()) {
                mainWindow.webContents.send('processing-complete', {
                  success: true,
                  sessionName: sessionNameAtClose,
                  message: transcriptionFailedMsg
                    ? 'Transcription failed; recording preserved (not deleted)'
                    : 'Processing completed successfully',
                  meetingData: processedMeeting,
                  notesGenerated: summarizationCompleted,
                  transcriptionFailed: Boolean(transcriptionFailedMsg),
                  transcriptionError: transcriptionFailedMsg || undefined
                });
              }
            })
            .catch(error => {
              console.error('Error fetching processed meeting:', error);
              // Fall back to firing without meetingData — frontend will
              // refresh the list but skip the auto-navigation.
              if (mainWindow && !mainWindow.isDestroyed()) {
                mainWindow.webContents.send('processing-complete', {
                  success: true,
                  sessionName: sessionNameAtClose,
                  message: transcriptionFailedMsg
                    ? 'Transcription failed; recording preserved (not deleted)'
                    : 'Processing completed successfully',
                  notesGenerated: summarizationCompleted,
                  transcriptionFailed: Boolean(transcriptionFailedMsg),
                  transcriptionError: transcriptionFailedMsg || undefined
                });
              }
            });
          resolve();
        } else {
          reject(new Error(`process-streaming exited with code ${code}: ${stderrBuf.slice(-500)}`));
        }
      });
    });

  } catch (error) {
    console.error(`❌ Processing failed for ${currentProcessingJob.sessionName}:`, error);
    trackEvent('error_occurred', {
      error_type: 'processing_queue',
      stage: processingStage,
      reason: classifyErrorReason(error),
      // A STREAM_ERROR: line during the summarization stage carries the real
      // failure reason (Ollama down, model missing, empty reduce result, ...)
      // that classifyErrorReason can't see -- it only looked at stderr, which
      // otherwise collapses every summarization crash into subprocess_exit_1.
      ...(processingStage === 'summarization' && summarizationStreamError
        ? { summarization_reason: classifySummarizationStreamError(summarizationStreamError) }
        : {}),
    });

    // A processing crash (e.g. a metal::malloc OOM that SIGABRTs the
    // subprocess with a non-zero exit before Python can mark the failure)
    // means the transcript was never produced. DO NOT delete the source
    // audio here — it's the only copy and the user's retry material.
    // Preserving it regardless of keep_recordings mirrors the Python
    // failure path, which also keeps the audio.
    if (currentProcessingJob.audioFile && fs.existsSync(currentProcessingJob.audioFile)) {
      sendDebugLog(`Preserved audio after processing failure: ${currentProcessingJob.audioFile}`);
    }

    // Instant stop: the batch pass died before rewriting the note, so clear the
    // placeholder's stuck `processing: true` — it stays a valid, reprocessable
    // transcript-only note instead of spinning forever. No-op for the append
    // case (its note has no processing flag).
    clearNoteProcessingFlag(currentProcessingJob.summaryFile);

    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('processing-complete', {
        success: false,
        sessionName: currentProcessingJob.sessionName,
        error: error.message,
        // The source audio is preserved above; hand its path to the renderer
        // so the Processing screen's "Try again" can re-queue it via
        // process-recording instead of dead-ending on an infinite spinner.
        audioFile: currentProcessingJob.audioFile || undefined
      });
    }
  } finally {
    // Remove the live-transcript snapshot temp file (#207) — it's consumed by
    // the Python process and not needed once the job is done.
    if (currentProcessingJob && currentProcessingJob.liveTranscriptFile) {
      try {
        if (fs.existsSync(currentProcessingJob.liveTranscriptFile)) {
          fs.unlinkSync(currentProcessingJob.liveTranscriptFile);
        }
      } catch (_) { /* best-effort cleanup */ }
    }
    // Remove the per-job notes snapshot temp (only temps under tmpdir reach the
    // job now; the shared draft was already deleted at queue time).
    if (
      currentProcessingJob &&
      currentProcessingJob.notesFile &&
      currentProcessingJob.notesFile.startsWith(os.tmpdir())
    ) {
      try {
        if (fs.existsSync(currentProcessingJob.notesFile)) {
          fs.unlinkSync(currentProcessingJob.notesFile);
        }
      } catch (_) { /* best-effort cleanup */ }
    }
    isProcessing = false;
    currentProcessingJob = null;
    currentProcessingStartedAtMs = null;
    // Process next job in queue
    setTimeout(processNextInQueue, 1000);
  }
}

// Live-transcript fallback for #207. The user watched the live transcript
// stream in during the recording, so if the post-stop batch transcription
// comes back empty (a quiet ASR failure), that live transcript should rescue
// the meeting instead of being silently discarded as "No speech detected".
//
// We snapshot the accumulated live segments to a temp file at stop time and
// hand the path to process-streaming via --live-transcript. Python owns the
// decision of whether to USE it (only when the batch result is empty/trivial),
// because that's where the batch length and failure markers are known.
//
// Returns the temp file path, or null when there's no usable live transcript
// (different session, too short, or write failed — never blocks processing).
const LIVE_TRANSCRIPT_FALLBACK_MIN_CHARS = 100;
// Bound the fallback snapshot's wait for the sidecar to flush its FINAL
// utterance. The drain primarily awaits the per-process `_drainPromise` (which
// resolves on `close`); this timeout is only a safety-net for a zombie that
// never closes. It MUST exceed SIDECAR_KILL_WATCHDOG_MS: the watchdog lets the
// process run that long before SIGTERM, and after the kill Python still needs a
// moment to finalize() and let `close` fire. If the timeout equalled the
// watchdog it could win the race against `close` and lose the last segment
// (#207 review, Blocker 2). Watchdog (5 s) + grace (3 s) for finalize + close.
const LIVE_TRANSCRIPT_SNAPSHOT_DRAIN_GRACE_MS = 3000;
const LIVE_TRANSCRIPT_SNAPSHOT_DRAIN_MS =
  SIDECAR_KILL_WATCHDOG_MS + LIVE_TRANSCRIPT_SNAPSHOT_DRAIN_GRACE_MS;

// Wait (bounded) for the live sidecar to finish exiting so its FINAL segments
// are in liveTranscriptState before we snapshot (#207, Fix 2). stop-recording-ui
// already closed stdin via stopLiveTranscribe(); here we just give Python up to
// LIVE_TRANSCRIPT_SNAPSHOT_DRAIN_MS to drain its VAD and emit that last
// utterance. Resolves early the moment the process is gone.
function waitForLiveTranscribeDrain() {
  const proc = liveTranscribeProcess;
  if (!proc) return Promise.resolve();
  // Bind to THIS process's drain promise (resolves on its `close`). A quick
  // stop→start can't have us awaiting the wrong process (review-2, Finding 2).
  const drain = proc._drainPromise || Promise.resolve();
  return new Promise((resolve) => {
    let settled = false;
    const done = () => {
      if (settled) return;
      settled = true;
      resolve();
    };
    const timer = setTimeout(() => {
      sendDebugLog('Live transcript drain timed out before snapshot; using segments collected so far');
      done();
    }, LIVE_TRANSCRIPT_SNAPSHOT_DRAIN_MS);
    drain.then(() => {
      clearTimeout(timer);
      done();
    });
  });
}

async function snapshotLiveTranscriptForFallback(sessionName) {
  try {
    if (!liveTranscriptState || liveTranscriptState.sessionName !== sessionName) {
      return null;
    }
    // Let the sidecar flush its final utterance before we read segments.
    await waitForLiveTranscribeDrain();
    if (!liveTranscriptState || liveTranscriptState.sessionName !== sessionName) {
      return null;
    }
    // Only FINAL segments go into the snapshot (#207, Fix 3). Finalised
    // segments don't replace the partial tails they supersede — a final is
    // pushed and the next partial is pushed after it — so including partials
    // would duplicate sentences in the fallback transcript. The non-final
    // tail is a preview of speech that a final segment will (or already did)
    // cover, so dropping it loses nothing but the duplication.
    const text = (liveTranscriptState.segments || [])
      .filter(s => s && s.isFinal && s.text)
      .map(s => String(s.text).trim())
      .filter(Boolean)
      .join('\n\n')
      .trim();
    if (text.length < LIVE_TRANSCRIPT_FALLBACK_MIN_CHARS) {
      return null;
    }
    // Write to the OS temp dir (cross-platform) with a unique name so
    // overlapping recordings can't clobber each other's snapshot.
    const fileName = `stenoai-live-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.txt`;
    const filePath = path.join(os.tmpdir(), fileName);
    fs.writeFileSync(filePath, text, 'utf-8');
    sendDebugLog(`Captured live transcript fallback (${text.length} chars): ${filePath}`);
    return filePath;
  } catch (e) {
    sendDebugLog(`Failed to snapshot live transcript fallback: ${e.message}`);
    return null;
  }
}

// ── Instant stop (transcript-first at stop) ──────────────────────────────
// The summary-file path is deterministic from the audio stem, so on stop we
// write a placeholder note from the already-captured live transcript and land
// the user on it immediately; the batch pipeline then upgrades it in place.
// Parakeet recordings only (Whisper has no live transcript → processing dock).

function summaryFileForAudio(audioFilePath) {
  const stem = path.basename(audioFilePath, path.extname(audioFilePath));
  return path.join(getOutputDir(), `${stem}_summary.md`);
}

// Finalised live-transcript text for the current session (mirrors the snapshot
// filter — final segments only, joined). '' when there's nothing usable.
function liveTranscriptTextForPlaceholder(sessionName) {
  if (!liveTranscriptState || liveTranscriptState.sessionName !== sessionName) return '';
  return (liveTranscriptState.segments || [])
    .filter((s) => s && s.isFinal && s.text)
    .map((s) => String(s.text).trim())
    .filter(Boolean)
    .join('\n\n')
    .trim();
}

// Write the instant-stop placeholder note atomically. `processing: true` marks
// it as still upgrading; process-streaming rewrites it fresh on success (which
// drops the flag), and a failure/startup sweep clears it otherwise. Always
// `notes_generated: false` — a valid transcript-only note is the correct
// fallback if the batch pass never completes (the user can Generate notes).
function writeInstantPlaceholderNote({ summaryFile, name, transcriptText, notesText }) {
  const yamlQuote = (s) =>
    '"' + String(s).replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n').replace(/\r/g, '') + '"';
  const lines = [
    '---',
    `title: ${yamlQuote(name)}`,
    `date: ${yamlQuote(new Date().toISOString())}`,
    'is_diarised: false',
    'is_live_transcript: true',
    'processing: true',
    'notes_generated: false',
    '---',
    '',
    '## Transcript',
    '',
    transcriptText || '',
  ];
  if (notesText && notesText.trim()) {
    lines.push('', '## User Notes', '', notesText.trim());
  }
  const content = lines.join('\n') + '\n';
  const tmp = `${summaryFile}.tmp-${Date.now()}`;
  fs.writeFileSync(tmp, content, 'utf-8');
  fs.renameSync(tmp, summaryFile);
}

// Clear a stuck `processing: true` flag (pipeline crash / app-quit sweep),
// leaving a valid transcript-only note. Line-based frontmatter surgery — the
// body (transcript, notes) is untouched. No-op unless a processing line is
// actually present, so it never mutates a normal note.
function clearNoteProcessingFlag(summaryFile) {
  try {
    if (!summaryFile || !summaryFile.endsWith('.md') || !fs.existsSync(summaryFile)) return;
    const raw = fs.readFileSync(summaryFile, 'utf8');
    if (!raw.startsWith('---')) return;
    // Split with NO limit and rejoin the tail: split('---', 3) would DISCARD
    // any '---' in the body (markdown thematic breaks in summaries, resumed-
    // segment separators), silently truncating the note. Mirrors
    // parseMeetingMarkdown's split/slice(2).join('---') for the same reason.
    const parts = raw.split('---');
    if (parts.length < 3) return;
    const frontmatter = parts[1];
    const body = parts.slice(2).join('---');
    let removed = false;
    let sawNotesGenerated = false;
    const kept = [];
    for (const line of frontmatter.split('\n')) {
      const key = line.slice(0, line.indexOf(':')).trim();
      if (key === 'processing') { removed = true; continue; }
      if (key === 'notes_generated') sawNotesGenerated = true;
      kept.push(line);
    }
    if (!removed) return;
    if (!sawNotesGenerated) {
      const at = kept[kept.length - 1] === '' ? kept.length - 1 : kept.length;
      kept.splice(at, 0, 'notes_generated: false');
    }
    const out = `---${kept.join('\n')}---${body}`;
    const tmp = `${summaryFile}.tmp-${Date.now()}`;
    fs.writeFileSync(tmp, out, 'utf8');
    fs.renameSync(tmp, summaryFile);
    sendDebugLog(`[instant-stop] cleared stuck processing flag: ${path.basename(summaryFile)}`);
  } catch (e) {
    sendDebugLog(`[instant-stop] failed to clear processing flag: ${e.message}`);
  }
}

// Startup sweep: clear `processing: true` on any note left mid-process by an
// app quit (its pipeline child died with it). Runs once at startup — there is
// no active queue then, so any such flag is stale. Reads only the frontmatter
// head (not whole transcripts) to decide, so a large library isn't fully
// re-read on every launch — only notes that actually carry the flag are opened
// in full by clearNoteProcessingFlag.
function noteFrontmatterHasProcessing(filePath) {
  let fd;
  try {
    fd = fs.openSync(filePath, 'r');
    const buf = Buffer.alloc(2048);
    const n = fs.readSync(fd, buf, 0, 2048, 0);
    const head = buf.toString('utf8', 0, n);
    if (!head.startsWith('---')) return false;
    const end = head.indexOf('\n---', 3);
    const frontmatter = end === -1 ? head : head.slice(0, end);
    return /(^|\n)processing:\s*true\s*(\n|$)/.test(frontmatter);
  } catch {
    return false;
  } finally {
    if (fd !== undefined) { try { fs.closeSync(fd); } catch { /* */ } }
  }
}

function sweepStuckProcessingFlags() {
  try {
    const dir = getOutputDir();
    if (!fs.existsSync(dir)) return;
    for (const f of fs.readdirSync(dir)) {
      if (!f.endsWith('_summary.md')) continue;
      const p = path.join(dir, f);
      if (noteFrontmatterHasProcessing(p)) clearNoteProcessingFlag(p);
    }
  } catch (e) {
    sendDebugLog(`[instant-stop] startup sweep failed: ${e.message}`);
  }
}

function addToProcessingQueue(audioFile, sessionName, notesFile, liveTranscriptFile, appendTo, summaryFile) {
  processingQueue.push({ audioFile, sessionName, notesFile, liveTranscriptFile, appendTo, summaryFile });
  console.log(`📋 Added to processing queue: ${sessionName} (Queue size: ${processingQueue.length})`);
  processNextInQueue();
}

// Continue-recording (append) target: set at start-recording-ui when the
// renderer asked to record INTO an existing note, consumed (and cleared) when
// the finished WebM is queued — the pipeline then runs with --append-to so
// the segment's transcript is folded into that note instead of creating a
// new one.
let currentRecordingAppendTarget = null;

// Valid recording_started `trigger` values. Whitelisted so a stale/forged
// renderer arg can't smuggle an arbitrary string into PostHog.
const RECORDING_TRIGGERS = new Set(['manual', 'notification_click', 'hotkey', 'tray', 'url_scheme']);

ipcMain.handle('start-recording-ui', async (_, sessionName, trigger, appendTo) => {
  try {
    if (currentRecordingProcess) {
      return { success: false, error: 'Recording already in progress' };
    }
    if (systemAudioRecordingActive) {
      return { success: false, error: 'Recording already in progress' };
    }

    // Validate the append target up front: it must be an existing, canonical
    // meeting file (`*_summary.md`/`.json`) scoped to an `output/` dir — the
    // SAME check every summaryFile-taking handler uses (validateMeetingFilePath),
    // NOT the broad getAllowedBaseDirs() check. The broad roots include the whole
    // userData dir + project root, so a renderer-supplied `config.json` (or any
    // JSON under them) would otherwise pass and get rewritten into a "note" by
    // _append_segment_to_note. A bad target degrades to a normal new-note
    // recording rather than failing the start.
    currentRecordingAppendTarget = null;
    if (appendTo && typeof appendTo === 'string') {
      const validatedAppend = await validateMeetingFilePath(appendTo);
      if (!validatedAppend.error) {
        currentRecordingAppendTarget = validatedAppend.realPath;
      } else {
        sendDebugLog('[append] invalid or missing append target; recording as a new note');
      }
    }

    const actualSessionName = sessionName || 'Note';
    // Clear any stale name-keyed draft notes before this recording starts, so a
    // PREVIOUS recording that was abandoned (never processed → never
    // consumed-and-cleared) can't leak its notes into this same-named one. The
    // normal path clears it at processing; this covers the abandoned case. Not
    // an append (which records into an existing note; its notes stay put).
    if (!appendTo) {
      try {
        const staleDraft = userNotesFilePath(getOutputDir(), actualSessionName);
        if (fs.existsSync(staleDraft)) fs.unlinkSync(staleDraft);
      } catch (_) { /* best-effort */ }
    }
    // Whisper recordings use the post-stop pipeline (no live drawer, no
    // sidecar). Parakeet recordings spawn the VAD-gated live consumer
    // so the renderer can show real-time text. Cached read — avoids a
    // Python subprocess on every recording start.
    const engine = loadTranscriptionEngine();
    const liveEnabled = isLiveTranscriptionEngine(engine);

    // Renderer-driven capture (useSystemAudioCapture) is the ONLY recording
    // path: it captures the mic (+ system loopback when the Settings toggle is
    // on) and streams its WebM to disk, queued through the
    // process-system-audio-recording IPC. The legacy Python `record`
    // subprocess — signal-controlled and thus unworkable on Windows — is
    // retired, so there is no longer a mic-XOR-system fork here.
    sendDebugLog(`Starting renderer-driven recording (name ${String(actualSessionName || '').length} chars)`);
    currentRecordingSessionName = actualSessionName;
    startRecordingRuntimeState();
    // Flip the active flag immediately so the queue handler reports
    // hasRecording=true on the very next poll, which is what cues the renderer
    // hook to fire startCapture. reportSystemAudioState then re-affirms it on
    // success / clears it on failure.
    systemAudioRecordingActive = true;
    applyRecordingBackgroundThrottling();
    // Reset the live transcript buffer before the sidecar starts emitting.
    // On a resume/continue into the SAME note, preserve the previous session's
    // finalised segments as display-only `priorSegments` so the live bar shows
    // the earlier speech instead of starting blank. Guarded on the append
    // target matching the note the previous buffer belonged to (summary-file
    // identity, not the display name — two "Note"-named notes would collide);
    // falls back to empty on a fresh launch or a different note. Prepends any
    // existing priorSegments so a SECOND continue keeps the first recording's
    // carried-over text as well, not just the latest tail.
    const carryPrior =
      currentRecordingAppendTarget &&
      liveTranscriptState.summaryFile === currentRecordingAppendTarget
        ? [
            ...(liveTranscriptState.priorSegments || []),
            ...(liveTranscriptState.segments || []).filter((s) => s && s.isFinal && s.text),
          ]
        : [];
    liveTranscriptState = {
      sessionName: actualSessionName,
      summaryFile: currentRecordingAppendTarget || null,
      segments: [],
      priorSegments: carryPrior,
      ready: false,
      error: null,
    };
    // Spawn the Parakeet+Silero transcribe-stream sidecar for live partials.
    // Whisper recordings skip it — the renderer gates its live-tap IPC on the
    // same engine, so no chunks are produced when the sidecar isn't running.
    if (liveEnabled) {
      try {
        spawnLiveTranscribe(actualSessionName);
      } catch (e) {
        sendDebugLog(`Failed to spawn live transcribe sidecar: ${e.message}`);
      }
    } else {
      sendDebugLog(`Live transcription off — engine=${engine}`);
    }
    updateTrayIcon(true);
    // Fire-and-forget: the calendar lookup (network call) must never delay
    // the actual recording start or the response below. Once it resolves we
    // fire the single recording_started event with full context -- PostHog
    // events are immutable, so this is one deferred call rather than an
    // initial fire + a later "patch". Wrapped in withTimeout because
    // getCalendarEventForNow's own 1.5s AbortController only bounds the
    // calendar event fetch -- a stuck OAuth token-refresh request upstream of
    // that (no timeout of its own) could otherwise hang this indefinitely
    // and silently drop recording_started for the recording entirely.
    const recordingTrigger = RECORDING_TRIGGERS.has(trigger) ? trigger : 'manual';
    withTimeout(getCalendarEventForNow(), 2500)
      .then((calEvent) => {
        trackEvent('recording_started', {
          trigger: recordingTrigger,
          matched_calendar_event: Boolean(calEvent),
          provider: calendarMeetingProvider(calEvent?.meeting_url),
        });
      })
      // withTimeout itself never rejects, but the fulfillment handler above
      // could in principle throw (e.g. a future change to it) -- and since
      // the global unhandledRejection listener now calls process.exit(1),
      // ANY floating promise here is a latent full-app-crash risk over
      // nothing more than a missed telemetry event. Telemetry must never be
      // able to take down the app.
      .catch(() => {});
    return {
      success: true,
      sessionName: actualSessionName,
      message: 'Renderer-driven recording started',
    };
  } catch (error) {
    console.error('Start recording UI error:', error.message);
    systemAudioRecordingActive = false;
    currentRecordingSessionName = null;
    currentRecordingAppendTarget = null;
    resetRecordingRuntimeState();
    updateTrayIcon(false);
    trackEvent('error_occurred', { error_type: 'start_recording_ui', reason: classifyErrorReason(error) });
    return { success: false, error: error.message };
  }
});

// ── Auto-pause on system sleep ──
// Closing the laptop lid (or any suspend) used to leave an active recording
// "running" with a broken audio stream. We pause on suspend and deliberately
// do NOT auto-resume on wake — waking the machine doesn't mean the meeting
// is still going. Instead a notification offers Resume, reusing the same
// auto-resume-requested renderer affordance as meeting-end auto-pause.
//
// Capture is renderer-driven (MediaRecorder) on every platform now, so this is
// uniform: markRecordingPaused + auto-pause-requested to the renderer, which
// pauses its MediaRecorder (possibly only after wake — the renderer is
// suspended too — but nothing records during sleep either way).
let pausedBySleep = false;
// Live "Recording paused / Resume" notification, so a manual resume/stop can
// dismiss it — a stale banner clicked later would fire auto-resume-requested
// at a recording in a different state.
let sleepPausedNotif = null;

function closeSleepPausedNotification() {
  if (sleepPausedNotif) {
    try { sleepPausedNotif.close(); } catch (_) {}
    sleepPausedNotif = null;
  }
}

function autoPauseForSleep() {
  try {
    if (recordingRuntimeState.isPaused) return;
    if (!systemAudioRecordingActive) return;
    // Capture is renderer-driven (MediaRecorder). Mark paused and ask the
    // renderer to pause — possibly only honoured after wake, since the renderer
    // is suspended too, but nothing records during sleep either way.
    sendDebugLog('[power] system suspend — pausing recording');
    markRecordingPaused();
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('auto-pause-requested');
    }
    pausedBySleep = true;
  } catch (e) {
    sendDebugLog(`[power] auto-pause on suspend failed: ${e.message}`);
  }
}

function promptResumeAfterWake() {
  if (!pausedBySleep) return;
  pausedBySleep = false;
  if (!recordingRuntimeState.isPaused) return;
  sendDebugLog('[power] system resumed — recording stays paused, offering Resume');
  showSleepPausedNotification();
}

function showSleepPausedNotification() {
  closeSleepPausedNotification();
  // Deliberately NOT gated on notificationsEnabled(): unlike the
  // convenience notifications (meeting detected, note ready), this one is
  // state-critical — the user believes they're capturing and they are not.
  const notif = new Notification({
    title: 'Recording paused',
    body: 'Paused while your computer was asleep. Resume to keep capturing.',
    iconType: 'alert',
    // The Resume action button is always rendered by the custom toast (both
    // platforms); the click handler below covers a body tap as well.
    actions: [{ type: 'button', text: 'Resume' }],
  });
  const resume = () => {
    sleepPausedNotif = null;
    sendDebugLog('[power] user chose to resume after wake');
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('auto-resume-requested');
    }
  };
  notif.on('action', (_evt, _index) => resume());
  notif.on('click', resume);
  trackNotificationLifecycle(notif, 'sleep_paused');
  notif.show();
  sleepPausedNotif = notif;
}

ipcMain.handle('pause-recording-ui', async () => {
  try {
    // Capture is renderer-driven (MediaRecorder via useSystemAudioCapture).
    // Flip the runtime-state flag — the queue endpoint reports isPaused=true,
    // status becomes 'paused', and the renderer effect pauses the MediaRecorder.
    if (systemAudioRecordingActive) {
      sendDebugLog('Pause: marking paused, renderer will pause MediaRecorder');
      markRecordingPaused();
      return { success: true, message: 'Recording paused' };
    }
    sendDebugLog('Pause failed: No recording in progress');
    return { success: false, error: 'No recording in progress' };
  } catch (error) {
    console.error('Pause recording UI error:', error.message);
    sendDebugLog(`Pause error: ${error.message}`);
    return { success: false, error: error.message };
  }
});

ipcMain.handle('resume-recording-ui', async () => {
  try {
    // Any resume (manual or notification-driven) ends the sleep-pause state.
    pausedBySleep = false;
    closeSleepPausedNotification();
    if (systemAudioRecordingActive) {
      sendDebugLog('Resume: marking resumed, renderer will resume MediaRecorder');
      markRecordingResumed();
      return { success: true, message: 'Recording resumed' };
    }
    sendDebugLog('Resume failed: No recording in progress');
    return { success: false, error: 'No recording in progress' };
  } catch (error) {
    console.error('Resume recording UI error:', error.message);
    sendDebugLog(`Resume error: ${error.message}`);
    return { success: false, error: error.message };
  }
});

ipcMain.handle('stop-recording-ui', async () => {
  try {
    // Stopping ends any sleep-pause state — don't prompt Resume on a
    // recording that no longer exists.
    pausedBySleep = false;
    closeSleepPausedNotification();

    // ── Instant stop ──────────────────────────────────────────────────────
    // Decide (and write) the note to land the user on immediately, BEFORE we
    // tear down recording state below. The live sidecar hasn't been stopped
    // yet, so liveTranscriptState still holds this session's segments.
    //   - continue-recording (append): the note already exists → navigate there.
    //   - new Parakeet recording with live content: write a placeholder note
    //     from the live transcript + draft notes → navigate there.
    //   - Whisper / no live content / import: null → renderer uses the dock.
    let instantSummaryFile = null;
    try {
      const sessionName = currentRecordingSessionName || 'Note';
      if (currentRecordingAppendTarget) {
        instantSummaryFile = currentRecordingAppendTarget;
      } else if (isLiveTranscriptionEngine(loadTranscriptionEngine()) && activeSysAudioSummaryFile) {
        const transcriptText = liveTranscriptTextForPlaceholder(sessionName);
        const notesFile = userNotesFilePath(getOutputDir(), sessionName);
        let notesText = '';
        try {
          if (fs.existsSync(notesFile)) notesText = fs.readFileSync(notesFile, 'utf-8');
        } catch (_) { /* notes are best-effort */ }
        if (transcriptText.trim() || notesText.trim()) {
          writeInstantPlaceholderNote({
            summaryFile: activeSysAudioSummaryFile,
            name: sessionName,
            transcriptText,
            notesText,
          });
          instantSummaryFile = activeSysAudioSummaryFile;
          sendDebugLog(`[instant-stop] wrote placeholder note: ${path.basename(activeSysAudioSummaryFile)}`);
        }
      }
    } catch (e) {
      // A placeholder-write failure must never block the stop — fall back to
      // the processing dock (instantSummaryFile stays null).
      sendDebugLog(`[instant-stop] placeholder skipped: ${e.message}`);
      instantSummaryFile = null;
    }

    // Capture is renderer-driven; the renderer's stopCapture flow finalises the
    // WebM and reports systemAudioRecordingActive=false. Clear it here too in
    // case a race (renderer torn down / recorder errored before reporting) left
    // it stuck true. Closing the live sidecar lets Python drain its final
    // utterance; a watchdog SIGTERM in stopLiveTranscribe covers stuck cases.
    // Stamp the buffer with the note it landed on (fresh recordings only learn
    // their summary file here). A later resume/continue matches on this to
    // decide whether to carry the prior segments over — see the carry guard in
    // start-recording-ui. Skipped when there's no landing note (Whisper/import
    // → no live buffer to carry anyway).
    if (instantSummaryFile) {
      liveTranscriptState.summaryFile = instantSummaryFile;
    }
    systemAudioRecordingActive = false;
    applyRecordingBackgroundThrottling();
    stopLiveTranscribe();
    currentRecordingSessionName = null;
    // Captured before resetRecordingRuntimeState() clears startedAtMs.
    const recordingDurationBucket = durationBucket(getRecordingElapsedSeconds());
    resetRecordingRuntimeState();
    updateTrayIcon(false);
    trackEvent('recording_stopped', { duration_bucket: recordingDurationBucket, reason: 'normal' });
    return { success: true, message: 'Recording stopped', summaryFile: instantSummaryFile };
  } catch (error) {
    console.error('Stop recording UI error:', error.message);
    systemAudioRecordingActive = false;
    currentRecordingSessionName = null;
    resetRecordingRuntimeState();
    updateTrayIcon(false);
    trackEvent('error_occurred', { error_type: 'stop_recording_ui', reason: classifyErrorReason(error) });
    return { success: false, error: error.message };
  }
});

// Setup IPC handlers

ipcMain.handle('startup-setup-check', async () => {
  try {
    console.log('Running startup setup check...');

    // Ask the backend for machine-readable JSON rather than scraping emoji out
    // of the human-readable report. The `--json` path emits a single object:
    //   { allGood: boolean, checks: [{ name, ok, status, detail }, ...] }
    const result = await runPythonScript('simple_recorder.py', ['setup-check', '--json']);
    console.log('Setup check result:', result);

    // Extract + validate the JSON payload from stdout. We don't JSON.parse the
    // whole buffer because the checks import third-party libs that can print to
    // stdout; parseSetupCheckOutput scans for the JSON line and validates the
    // schema, throwing (→ caught below as an error) if the backend is broken so a
    // malformed payload isn't masked as a clean "setup incomplete".
    const { allGood, checks } = parseSetupCheckOutput(result);

    console.log('Parsed checks:', checks);
    console.log('All good:', allGood);

    return {
      success: true,
      allGood,
      checks
    };
  } catch (error) {
    console.error('Setup check error:', error);
    return { success: false, error: error.message };
  }
});

async function runSpeakerModelCommand(command) {
  if (process.platform !== 'darwin') {
    return {
      success: false,
      ready: false,
      error: 'Speaker diarization is unavailable on this system',
    };
  }
  const output = await runPythonScript('simple_recorder.py', [command]);
  return parseSpeakerModelStatusOutput(output);
}

ipcMain.handle('speaker-model-status', async () => {
  try {
    return await runSpeakerModelCommand('speaker-model-status');
  } catch (error) {
    sendDebugLog('Speaker diarization model status check failed');
    return {
      success: false,
      ready: false,
      error: 'Could not check the speaker diarization models',
    };
  }
});

ipcMain.handle('setup-speaker-models', async () => {
  try {
    sendDebugLog('Preparing local speaker diarization models...');
    const result = await runSpeakerModelCommand('prepare-speaker-models');
    if (result.success && result.ready) {
      sendDebugLog('Speaker diarization models ready');
    }
    return result;
  } catch (error) {
    sendDebugLog('Speaker diarization model setup failed');
    return {
      success: false,
      ready: false,
      error: 'Speaker diarization model setup failed',
    };
  }
});

// ── Auto-updater ──
// Mirrors the autoUpdater event sequence (available -> progress* ->
// downloaded) so AboutTab can recover its state on every mount instead of
// only reacting to whichever one-shot IPC event fires while it happens to be
// mounted — Settings tabs unmount on switch, so a download in progress (or
// already finished) when the user is on a different tab would otherwise be
// invisible until they'd already missed it. pendingDownloadPercent is
// non-null only while a download is actively in flight (cleared once it
// lands in pendingUpdateVersion); get-update-status exposes both.
let pendingUpdateVersion = null;
let pendingDownloadPercent = null;
// The last surfaced auto-updater error, persisted the same way as the two
// above so a freshly-mounted About tab can rehydrate it via get-update-status.
// The one-shot 'update-error' event only reaches a listener mounted at the
// instant it fires — without this, navigating away from About and back after
// a failed background update would show nothing. Cleared when a new cycle
// starts (check / available / progress) or a download completes.
let pendingUpdateError = null;
// Whether that error survives a later successful check. A dropped connection
// is disproved by one; a full disk, a missing update feed or a permission
// problem is not, and clearing those on an unrelated success would hide a
// condition that is still true. See update-error-copy.js.
let pendingUpdateErrorSticky = false;
// True between calling quitAndInstall and the app actually going away, so an
// error that fires in that window is reported as a failed install rather than
// as a failed check.
let installingUpdate = false;

// ── Idle auto-install ──
// True once an update has finished downloading and is staged for install.
// The safety gate (update-idle-gate.js) requires this before it will relaunch.
let updateDownloadedReady = false;
// The periodic idle checker's timer, and a one-shot latch so we call
// quitAndInstall at most once even if a tick races the relaunch.
let idleAutoInstallInterval = null;
let autoInstallFired = false;
// Idle threshold: the machine must have had no user input for this long before
// we relaunch, so an auto-install never interrupts someone mid-task. 10 min.
const IDLE_AUTO_INSTALL_THRESHOLD_SECONDS = 600;
// How often to re-evaluate the gate. Cheap (a config read + a few booleans).
const IDLE_AUTO_INSTALL_CHECK_MS = 60 * 1000;

// Snapshot every input the safety gate needs, read fresh at call time. Kept in
// one place so the initial check and the post-settle re-check (below) can't
// drift — they must gather identical state or the re-check is meaningless.
//   - streaming: in-flight AI query/summary/chat streams register a killable
//     proc in activeQueryProcs.
//   - otherJobsActive: reprocess (re-summarize), report generation, and title
//     regeneration all run OUTSIDE isProcessing/processingQueue; each handler
//     registers its job in activeReprocessJobs for the duration, so a non-empty
//     map means one of those is in flight and a relaunch would kill it.
function gatherIdleInstallState() {
  return {
    enabled: loadAutoInstallWhenIdleEnabled(),
    updateReady: updateDownloadedReady,
    isRecording: currentRecordingProcess !== null || systemAudioRecordingActive,
    isProcessing,
    queueLength: processingQueue.length,
    liveActive: liveTranscribeProcess != null,
    streaming: activeQueryProcs.size > 0,
    otherJobsActive: activeReprocessJobs.size > 0,
    idleSeconds: powerMonitor.getSystemIdleTime(),
    idleThresholdSeconds: IDLE_AUTO_INSTALL_THRESHOLD_SECONDS,
  };
}

// Gather the live in-flight state and, when the pure gate says it's safe,
// relaunch into the downloaded update. Latches autoInstallFired to guarantee a
// single quitAndInstall, clears the interval, and — critically — re-checks the
// gate AFTER the autosave settle so a recording/job that started during that
// window aborts the install (and re-arms the checker) instead of being killed.
// No-op under E2E (never scheduled) and before an update is staged.
async function maybeAutoInstallWhenIdle() {
  if (autoInstallFired) return;
  if (!isSafeToAutoInstall(gatherIdleInstallState())) return;

  // Latch immediately (synchronously, before any await) so a second invocation
  // — e.g. a powerMonitor resume firing during the settle — bails at the guard
  // above and can't race us to a double quitAndInstall.
  autoInstallFired = true;
  if (idleAutoInstallInterval) {
    clearInterval(idleAutoInstallInterval);
    idleAutoInstallInterval = null;
  }

  sendDebugLog('Auto-updater: idle + nothing in flight — installing update and relaunching.');

  // Best-effort: notes autosave in the renderer on every edit (there's no
  // explicit flush IPC to await), so give any in-flight debounced autosave a
  // short settle window before we relaunch. Never blocks the relaunch.
  try {
    await new Promise((resolve) => setTimeout(resolve, 500));
  } catch (_) { /* best-effort only */ }

  // Re-check after the await: work may have started during the 500ms settle
  // (a recording, a queued/reprocess job, a chat stream). If it's no longer
  // safe, ABORT rather than kill live work — reset the one-shot latch and
  // re-arm the checker so a later idle window can retry.
  if (!isSafeToAutoInstall(gatherIdleInstallState())) {
    sendDebugLog('Auto-updater: work started during settle — aborting auto-install, will retry later.');
    autoInstallFired = false;
    startIdleAutoInstallChecker();
    return;
  }

  trackEvent('update_auto_installed', {
    version: pendingUpdateVersion || 'unknown',
    idle_seconds: Math.round(powerMonitor.getSystemIdleTime()),
  });

  // Bypass the mainWindow 'close' handler's preventDefault+hide (same reason as
  // the manual install-update path) so quitAndInstall actually quits + applies.
  isQuitting = true;
  // From here on, an updater error is an INSTALL failure, not a failed check.
  installingUpdate = true;
  // isSilent=true, isForceRunAfter=true — install without the wizard and
  // relaunch the app afterwards.
  autoUpdater.quitAndInstall(true, true);
}

// Start the periodic idle checker once an update is staged. Idempotent, and
// inert under E2E (mirrors setupAutoUpdater's e2e no-op) so the suite never
// schedules a timer or risks a quitAndInstall.
function startIdleAutoInstallChecker() {
  if (IS_E2E) return;
  if (idleAutoInstallInterval || autoInstallFired) return;
  idleAutoInstallInterval = setInterval(() => {
    maybeAutoInstallWhenIdle().catch((e) => sendDebugLog(`Idle auto-install check failed: ${e.message}`));
  }, IDLE_AUTO_INSTALL_CHECK_MS);
  // Don't let this timer keep the event loop alive on its own.
  if (idleAutoInstallInterval.unref) idleAutoInstallInterval.unref();
}

// Current OS version for the update gate, '' if it can't be read (→ fail open).
function currentSystemVersionSafe() {
  try { return process.getSystemVersion(); } catch (_) { return ''; }
}

// Whether electron-updater may run on this OS. See update-os-gate.js — darwin
// below the 14.4 floor (MIN_MACOS_FOR_AUTOUPDATE) is blocked (so nothing
// downloads and the idle installer has nothing to apply); non-darwin and
// unparseable versions are eligible, with the manifest `minimumSystemVersion`
// in latest-mac.yml as the authoritative backstop.
function autoUpdateOSEligible() {
  return isOSUpdateEligible({
    platform: process.platform,
    osVersion: currentSystemVersionSafe(),
    minVersion: MIN_MACOS_FOR_AUTOUPDATE,
  });
}

function setupAutoUpdater() {
  if (IS_E2E) {
    sendDebugLog('Auto-updater: skipped (E2E mode)');
    return;
  }
  // Don't check for updates in dev mode
  if (!app.isPackaged) {
    sendDebugLog('Auto-updater: skipped (dev mode)');
    return;
  }
  // Never auto-download/install onto a Mac below the launch floor — the build
  // wouldn't start, and with idle auto-install (#425) it would replace a
  // working install unattended. Skipping the whole setup means no download
  // ever fires, so `update-downloaded` never fires and the idle checker never
  // arms. (latest-mac.yml's minimumSystemVersion is the second layer.)
  if (!autoUpdateOSEligible()) {
    sendDebugLog(`Auto-updater: skipped — macOS ${currentSystemVersionSafe()} is below the ${MIN_MACOS_FOR_AUTOUPDATE} floor; this build won't launch here (#432).`);
    return;
  }

  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = true;

  // Drop a stale non-sticky failure AND tell a mounted About tab, so the banner
  // never outlives the state it describes. Sticky ones are left alone: a full
  // disk, a permission problem or a missing feed is not disproved by starting or
  // finding an update, only by bytes actually arriving (download-progress).
  // Both callers need exactly this, and having it in one place is what stops the
  // two from drifting apart — the earlier version cleared here but only emitted
  // there, so the event never fired and About kept showing a settled failure
  // next to a running download.
  const clearNonStickyUpdateError = () => {
    if (!pendingUpdateError || pendingUpdateErrorSticky) return;
    pendingUpdateError = null;
    if (mainWindow) mainWindow.webContents.send('update-error-cleared');
  };

  autoUpdater.on('checking-for-update', () => {
    sendDebugLog('Auto-updater: checking for updates...');
    // Fresh cycle — clear any stale error from a previous failed check so a
    // rehydrating About tab doesn't show an error that's now being retried.
    // Sticky ones stay: starting a check does not free disk space, grant write
    // permission, or give this build an update feed, and those conditions are
    // still true until something actually succeeds. They are cleared where that
    // happens: a version found and fetched (update-available / download-progress
    // / update-downloaded below), or a poll that comes back clean in the
    // check-for-updates handler.
    clearNonStickyUpdateError();
  });

  autoUpdater.on('update-available', (info) => {
    sendDebugLog(`Auto-updater: update available (v${info.version})`);
    // Matches the renderer's own `setDownloadPercent((p) => p ?? 0)` — marks
    // a download as started before the first real progress tick arrives.
    if (pendingDownloadPercent === null) pendingDownloadPercent = 0;
    // Only the non-sticky ones. This event says a version was FOUND, i.e. the
    // feed was readable — it does not say a single byte was written, so it
    // cannot disprove a full disk or a permission problem. Those clear one
    // event later, on the first download-progress tick, which does prove it.
    // (Clearing them here made the banner vanish and come straight back when
    // the unchanged condition failed the download again.)
    //
    // Usually a no-op, since checking-for-update already ran for this cycle —
    // it covers a failure that arrived between the two events.
    clearNonStickyUpdateError();
    if (mainWindow) {
      mainWindow.webContents.send('update-available', { version: info.version });
    }
  });

  autoUpdater.on('update-not-available', () => {
    sendDebugLog('Auto-updater: up to date');
    // A completed cycle with nothing pending — clear even a sticky failure.
    // This is the updater itself reporting success, unlike the GitHub poll in
    // the check-for-updates handler (our own request, which proves nothing
    // about whether the updater can read its feed or write to disk). Nothing is
    // waiting to download or install any more, so a banner about a past attempt
    // is describing a state that no longer exists — and a condition that really
    // is still broken (no update feed) errors before ever reaching this event.
    pendingUpdateError = null;
    pendingUpdateErrorSticky = false;
    // Tell a mounted About tab too — it keeps its own copy, and the events it
    // already listens to (available/progress/downloaded) don't fire on a clean
    // cycle, so without this the banner would sit there until a remount.
    if (mainWindow) mainWindow.webContents.send('update-error-cleared');
  });

  autoUpdater.on('download-progress', (progress) => {
    sendDebugLog(`Auto-updater: downloading ${Math.round(progress.percent)}%`);
    pendingDownloadPercent = Math.round(progress.percent);
    pendingUpdateError = null;
    pendingUpdateErrorSticky = false;
    if (mainWindow) {
      mainWindow.webContents.send('update-download-progress', { percent: Math.round(progress.percent) });
    }
  });

  autoUpdater.on('update-downloaded', (info) => {
    sendDebugLog(`Auto-updater: v${info.version} ready to install`);
    pendingDownloadPercent = null;
    pendingUpdateError = null;
    pendingUpdateErrorSticky = false;
    pendingUpdateVersion = info.version;
    if (mainWindow) {
      mainWindow.webContents.send('update-downloaded', { version: info.version });
    }
    // The notification above is unchanged. Additionally, mark the update as
    // staged and start the idle checker so it can install + relaunch on its
    // own when the machine is idle and nothing is in flight. Try once right
    // away in case the app is already idle (e.g. downloaded overnight).
    updateDownloadedReady = true;
    startIdleAutoInstallChecker();
    maybeAutoInstallWhenIdle().catch(() => {});
  });

  autoUpdater.on('error', (err) => {
    const msg = (err && err.message) || String(err);
    // Which phase failed, captured BEFORE the state is cleared below. Note it
    // does NOT consider a staged update: a periodic check can fail long after a
    // download succeeded, and calling that a failed download is the lie this
    // whole path exists to stop telling.
    //
    // Known limit: electron-updater's error event does not say which attempt it
    // belongs to, so a periodic check that fails WHILE a download is genuinely
    // running is attributed to the download. That case was already reported as
    // a download failure before this module existed, so the heuristic is not a
    // regression — closing it needs per-attempt correlation the library does
    // not expose.
    const phase = updateErrorPhase({
      downloadInFlight: pendingDownloadPercent !== null,
      installing: installingUpdate,
    });
    // Clear any in-flight download state regardless of which branch below
    // fires — otherwise a failure after 'update-available' (which seeds
    // pendingDownloadPercent to 0) leaves get-update-status reporting a
    // download is still running forever, and About would show a stuck
    // progress bar with no way to tell it failed.
    pendingDownloadPercent = null;
    // Until a release carrying this platform's update feed (latest.yml on
    // Windows) is published, the updater 404s on the feed file. That's an
    // expected transitional state, not a real failure — log it quietly so it
    // doesn't read as a scary stack trace for alpha testers, and don't
    // surface it to the renderer as an error.
    if (/latest(-mac)?\.yml/i.test(msg) && /(404|cannot find)/i.test(msg)) {
      sendDebugLog('Auto-updater: no update feed published for this release yet — skipping.');
      return;
    }
    // The raw text stays here, where it's useful for diagnosis. What reaches
    // the About tab is one sentence naming the phase that failed and whether
    // the user has to do anything — see update-error-copy.js.
    sendDebugLog(`Auto-updater error: ${msg}`);
    const { message: userMessage, sticky } = describeUpdateError(msg, { phase });
    // The install attempt (if any) is over — a later error is a fresh cycle.
    installingUpdate = false;
    // Persist so a later About-tab mount can rehydrate it (the event below is
    // one-shot and only reaches an already-mounted listener).
    pendingUpdateError = userMessage;
    pendingUpdateErrorSticky = sticky;
    if (mainWindow) {
      mainWindow.webContents.send('update-error', { message: userMessage });
    }
  });

  // Check on launch (after a short delay to not block startup)
  setTimeout(() => {
    autoUpdater.checkForUpdates().catch(() => {});
  }, 10000);

  // Re-check every 30 minutes
  setInterval(() => {
    autoUpdater.checkForUpdates().catch(() => {});
  }, 30 * 60 * 1000);
}

ipcMain.on('install-update', () => {
  // Defense in depth for #432: today the renderer only shows "Restart to
  // Update" once a real 'update-downloaded' fired (impossible under the floor,
  // since setupAutoUpdater is skipped), so this is unreachable on an under-floor
  // Mac. Gate it here too so a future renderer change can't reintroduce an
  // ungated quitAndInstall onto a build this OS can't launch.
  if (!autoUpdateOSEligible()) {
    sendDebugLog('install-update: ignored — OS below the auto-update floor (#432).');
    return;
  }
  // Bypass the mainWindow 'close' handler's preventDefault+hide so that
  // quitAndInstall's window-close step actually quits the app. Without this
  // the app just minimises and Squirrel never gets to apply the update.
  isQuitting = true;
  // From here on, an updater error is an INSTALL failure, not a failed check.
  installingUpdate = true;
  autoUpdater.quitAndInstall(false, true);
});

// ── Auto-detect meetings (mic-monitor) ──
// Spawns the bundled mic-monitor helper and reacts to its JSON-line events.
// When any non-Steno app starts capturing the microphone, we surface a native
// macOS notification ("Meeting detected — App") with a Take Notes action.
// The actual recording start is delegated back to the renderer's existing
// startRecording flow via the auto-record-requested event, so we don't have
// to duplicate any of the recording lifecycle code.
const STENO_BUNDLE_ID = 'com.stenoai.recorder';
const AUTO_DETECT_ENV = 'STENOAI_AUTO_DETECT';
const MIC_NOTIFICATION_DEBOUNCE_MS = 60_000;
const MIC_MONITOR_BACKOFF_BASE_MS = 1000;
const MIC_MONITOR_BACKOFF_MAX_MS = 30_000;
const MIC_MONITOR_HEALTHY_RESET_MS = 30_000;

// Browsers route media capture through helper sub-processes (Safari →
// com.apple.WebKit.GPU, Chrome → com.google.Chrome.helper, etc.), so the raw
// app_name reads as "Safari Graphics and Media" / "Google Chrome Helper".
// Translate those back to the user-recognisable parent app name.
const APP_NAME_OVERRIDES = [
  { match: /^com\.apple\.WebKit/, name: 'Safari' },
  { match: /^com\.google\.Chrome/, name: 'Google Chrome' },
  { match: /^org\.chromium\./, name: 'Chromium' },
  { match: /^com\.microsoft\.edgemac/, name: 'Microsoft Edge' },
  { match: /^company\.thebrowser\.Browser/, name: 'Arc' },
  { match: /^com\.brave\.Browser/, name: 'Brave' },
  { match: /^org\.mozilla\./, name: 'Firefox' },
];

// Allowlist of bundle-id patterns we treat as "meeting apps". Anything not
// matching is ignored — without this filter, dictation tools (Wispr Flow,
// Superwhisper, MacWhisper, Apple Dictation, VoiceInk) and music apps that
// open the mic would all trigger "Meeting detected".
// Browsers are included as a class because most web meetings (Meet, Teams
// web, Whereby, Around, etc.) route mic capture through the browser bundle
// id or a helper sub-process (see APP_NAME_OVERRIDES). Tradeoff: in-browser
// dictation extensions also match, but browser meetings are far more common.
// The allowlist + isMeetingApp live in ./meeting-detect (unit-tested). Whether
// an app_id-less device-level event is treated as a meeting is decided once at
// startup from the OS version: macOS 12/13 emit such events legitimately;
// macOS 14+ always carries an app_id, so an app_id-less event there is an
// AEC / system-audio artifact, not a meeting (see #262).
const ALLOW_DEVICE_LEVEL_FALLBACK = allowsDeviceLevelFallback(
  process.platform,
  (() => { try { return process.getSystemVersion(); } catch (_) { return ''; } })(),
);

// Wait this long after the meeting app releases the mic before auto-pausing.
// Verified empirically that Zoom/Meet/Teams use software-mute (keep the
// OS-level stream open while muted), so muting in-meeting does NOT emit a stop
// event and won't trip this debounce — the only remaining false-positive source
// is a brief device switch. 3s feels near-instant after a real meeting end;
// auto-resume handles any rare device-switch case if the mic comes back within
// the window.
const MEETING_END_DEBOUNCE_MS = 3_000;

// After auto-pausing on mic-release, hold the recording paused this long before
// auto-stopping (finalizing). The grace absorbs the one real false positive — a
// brief device switch — since auto-resume cancels the auto-stop if the mic
// returns within it. Because a released mic reliably means the call ended (not
// mute), we finalize automatically after this rather than prompting the user.
const MEETING_END_AUTOSTOP_GRACE_MS = 10_000;

let micMonitorProc = null;
let micMonitorRespawnTimer = null;
let micMonitorRespawnDelay = MIC_MONITOR_BACKOFF_BASE_MS;
const lastNotifiedAt = new Map();
// When the user accepts a "Meeting detected" notification we remember the
// originating app so we can pair its subsequent mic-stop with the recording and
// auto-stop when the meeting ends.
let autoStartedSession = null; // { pid, app_id, appName, paused, pauseTimer, autoStopTimer }

function humanizeAppName(evt) {
  for (const o of APP_NAME_OVERRIDES) {
    if (evt.app_id && o.match.test(evt.app_id)) return o.name;
  }
  return evt.app_name || 'an app';
}

function startMicMonitor() {
  if (micMonitorProc) return;
  if (micMonitorRespawnTimer) {
    clearTimeout(micMonitorRespawnTimer);
    micMonitorRespawnTimer = null;
  }
  const binPath = getMicMonitorPath();
  if (!fs.existsSync(binPath)) {
    sendDebugLog(`[auto-detect] mic-monitor missing at ${binPath}; auto-detect disabled`);
    return;
  }
  sendDebugLog(`[auto-detect] spawning ${binPath}`);
  const proc = spawn(binPath, [], { stdio: ['ignore', 'pipe', 'pipe'] });
  micMonitorProc = proc;

  // Reset backoff once the process has stayed alive for a while.
  const healthyTimer = setTimeout(() => {
    if (micMonitorProc === proc) micMonitorRespawnDelay = MIC_MONITOR_BACKOFF_BASE_MS;
  }, MIC_MONITOR_HEALTHY_RESET_MS);

  let buf = '';
  proc.stdout.setEncoding('utf8');
  proc.stdout.on('data', (chunk) => {
    buf += chunk;
    let nl;
    while ((nl = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (line) handleMicEvent(line);
    }
  });
  proc.stderr.on('data', (chunk) => {
    sendDebugLog(`[auto-detect] stderr: ${String(chunk).trim()}`);
  });
  proc.on('exit', (code, signal) => {
    clearTimeout(healthyTimer);
    sendDebugLog(`[auto-detect] mic-monitor exited (code=${code}, signal=${signal})`);
    if (micMonitorProc === proc) {
      micMonitorProc = null;
      micMonitorRespawnTimer = setTimeout(() => {
        micMonitorRespawnTimer = null;
        startMicMonitor();
      }, micMonitorRespawnDelay);
      micMonitorRespawnDelay = Math.min(micMonitorRespawnDelay * 2, MIC_MONITOR_BACKOFF_MAX_MS);
    }
  });
  proc.on('error', (err) => {
    sendDebugLog(`[auto-detect] spawn error: ${err.message}`);
  });
}

function stopMicMonitor() {
  if (micMonitorRespawnTimer) {
    clearTimeout(micMonitorRespawnTimer);
    micMonitorRespawnTimer = null;
  }
  if (micMonitorProc) {
    sendDebugLog('[auto-detect] stopping mic-monitor');
    const proc = micMonitorProc;
    micMonitorProc = null;
    try { proc.kill(); } catch (_) {}
  }
  lastNotifiedAt.clear();
  clearAutoStartedSession();
}

async function handleMicEvent(line) {
  let evt;
  try {
    evt = JSON.parse(line);
  } catch (_) {
    sendDebugLog(`[auto-detect] bad json: ${line.slice(0, 200)}`);
    return;
  }
  if (evt.app_id === STENO_BUNDLE_ID) return; // never react to our own recording

  if (evt.event === 'stop') {
    handleMicStop(evt);
    return;
  }
  if (evt.event !== 'start') return;

  // Meeting briefly went silent then came back — same app resuming. Cancel any
  // pending pause AND any pending auto-stop, and auto-resume the recording so
  // the user doesn't have to do anything. Cancelling the auto-stop is the whole
  // point of the grace window: a brief mic drop (device switch) must not
  // finalize a still-live meeting.
  if (autoStartedSession && evt.app_id === autoStartedSession.app_id) {
    if (autoStartedSession.pauseTimer) {
      clearTimeout(autoStartedSession.pauseTimer);
      autoStartedSession.pauseTimer = null;
      sendDebugLog(`[auto-detect] meeting resumed before pause fired: ${autoStartedSession.appName}`);
    }
    if (autoStartedSession.paused) {
      autoStartedSession.paused = false;
      if (autoStartedSession.autoStopTimer) {
        clearTimeout(autoStartedSession.autoStopTimer);
        autoStartedSession.autoStopTimer = null;
      }
      // Meeting came back before the grace window elapsed — cancel the auto-stop
      // and keep capturing.
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('auto-resume-requested');
      }
      sendDebugLog(`[auto-detect] auto-resumed: ${autoStartedSession.appName}`);
    }
    return;
  }

  if (!isMeetingApp(evt, { allowDeviceLevelFallback: ALLOW_DEVICE_LEVEL_FALLBACK })) {
    sendDebugLog(`[auto-detect] ignoring non-meeting app: ${evt.app_name || evt.app_id || 'device-level (no app_id)'}`);
    return;
  }

  if (currentRecordingProcess || systemAudioRecordingActive) {
    sendDebugLog(`[auto-detect] ignoring start (${evt.app_name || evt.app_id || 'unknown'}) — already recording`);
    return;
  }

  const debounceKey = evt.app_id || `pid:${evt.pid || 'unknown'}`;
  const lastAt = lastNotifiedAt.get(debounceKey) || 0;
  if (Date.now() - lastAt < MIC_NOTIFICATION_DEBOUNCE_MS) return;
  lastNotifiedAt.set(debounceKey, Date.now());

  const appName = humanizeAppName(evt);
  sendDebugLog(`[auto-detect] meeting detected: ${appName} (${evt.app_id || 'no-bundle-id'})`);
  const calEvent = await getCalendarEventForNow();
  if (calEvent) {
    sendDebugLog(`[auto-detect] matched a calendar event`);
  }
  showMeetingDetectedNotification(appName, evt, calEvent);
}

function handleMicStop(evt) {
  if (!autoStartedSession) return;
  // Recording may have been stopped manually (Stop button, hotkey, shortcut)
  // since we accepted the auto-start. The autoStartedSession isn't notified
  // of that today, so without this guard the mic-stop event would schedule
  // a phantom pause + auto-stop for a recording that's already gone. Drop the
  // session here so the next start is clean.
  if (!currentRecordingProcess && !systemAudioRecordingActive) {
    clearAutoStartedSession();
    return;
  }
  const matches = evt.pid === autoStartedSession.pid || evt.app_id === autoStartedSession.app_id;
  if (!matches) return;

  if (autoStartedSession.pauseTimer) clearTimeout(autoStartedSession.pauseTimer);
  autoStartedSession.pauseTimer = setTimeout(() => {
    autoStartedSession.pauseTimer = null;
    autoStartedSession.paused = true;
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('auto-pause-requested');
    }
    sendDebugLog(`[auto-detect] meeting ended (paused): ${autoStartedSession.appName}`);
    // Meeting ended: auto-stop silently after a short grace, then let the shared
    // post-stop pipeline run. The summarise decision happens AFTER transcription
    // via the same transcript-ready → "Summarise?" → note-ready notifications as
    // a manual stop — no separate meeting-end prompt (it was redundant and made
    // summarise a two-step flow). If the mic comes back within the grace,
    // handleMicEvent above cancels this timer and auto-resumes. Otherwise the
    // meeting has genuinely ended (a released mic ≠ mute — Zoom/Meet/Teams keep
    // the stream open while muted, see MEETING_END_DEBOUNCE_MS), so we auto-stop
    // — a meeting is never left stranded paused.
    if (autoStartedSession.autoStopTimer) clearTimeout(autoStartedSession.autoStopTimer);
    autoStartedSession.autoStopTimer = setTimeout(() => {
      autoStartedSession.autoStopTimer = null;
      sendDebugLog(`[auto-detect] auto-stopping ended meeting: ${autoStartedSession.appName}`);
      autoStopEndedMeeting();
    }, MEETING_END_AUTOSTOP_GRACE_MS);
  }, MEETING_END_DEBOUNCE_MS);
}

function showMeetingDetectedNotification(appName, originatingEvt, calEvent) {
  // Notification rendering quirk: setting `closeButtonText` alongside a single
  // `actions` entry causes macOS to collapse everything into an "Options"
  // dropdown instead of showing the action inline. Leaving closeButtonText
  // unset gives us Granola's layout — single inline button to the right.
  const notif = new Notification({
    title: 'Meeting detected',
    body: calEvent?.title || appName,
    actions: [{ type: 'button', text: 'Take Notes' }],
  });
  // Both the "Take Notes" button and the notification body start recording — one
  // action, so a single tap anywhere works.
  const trigger = () => requestAutoRecord(appName, originatingEvt, calEvent);
  notif.on('action', (_evt, _index) => trigger()); // shown when banner style = Alerts
  notif.on('click', () => trigger());              // body tap (always available)
  trackNotificationLifecycle(notif, 'meeting_detected');
  notif.show();
}

function requestAutoRecord(appName, originatingEvt, calEvent) {
  // Prefer the calendar event title when we matched one — it's user-authored
  // and recognisable weeks later. Otherwise fall back to the neutral
  // 'Note' placeholder that simple_recorder.py recognises in
  // _AUTO_NAMED_PATTERN and lets the post-summary LLM-title step rewrite.
  // The previous "<App> — YYYY-MM-DD HH:MM" format leaked the internal
  // app-detection string (e.g. "an app — 2026-06-01 17:00") to the user
  // whenever title regeneration produced nothing.
  const sessionName = calEvent?.title || 'Note';
  sendDebugLog(`[auto-detect] user requested record (calendar-titled: ${calEvent?.title ? 'yes' : 'no'})`);

  // Track the originating app so we can pair its mic-stop with this recording
  // and auto-stop when the meeting ends.
  autoStartedSession = {
    pid: originatingEvt?.pid ?? null,
    app_id: originatingEvt?.app_id ?? null,
    appName,
    paused: false,
    pauseTimer: null,
    autoStopTimer: null,
  };

  // Tapping "Take Notes" is an explicit "I'm going to take notes" — so bring
  // Steno to the front and open the live note so the user can start typing.
  // (The notification itself is passive and never steals focus; only this
  // explicit tap does.) The renderer's auto-record handler then starts the
  // recording and opens the live-note editor.
  if (mainWindow && !mainWindow.isDestroyed()) {
    exposeMainWindow();
    mainWindow.webContents.send('auto-record-requested', { sessionName, appName });
  }
}

// Auto-stop an ended auto-detected meeting once the mic has stayed released
// through the grace window (see handleMicStop). STOPS the paused recording,
// which drives the shared post-stop pipeline; the *summarise* decision then
// happens after transcription (transcript-ready / note-ready notifications),
// not here — identical to a manual stop. Sent on the `auto-summarise-requested`
// channel (whose renderer handler just stops the recording); the channel name
// predates the auto-stop rework and is kept to avoid 4-file churn.
function autoStopEndedMeeting() {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('auto-summarise-requested', {});
  }
  clearAutoStartedSession();
}

function clearAutoStartedSession() {
  if (!autoStartedSession) return;
  if (autoStartedSession.pauseTimer) clearTimeout(autoStartedSession.pauseTimer);
  if (autoStartedSession.autoStopTimer) clearTimeout(autoStartedSession.autoStopTimer);
  autoStartedSession = null;
}

// Opt-in dev tool: global shortcuts to fire each completion notification on
// demand, so their native macOS click/action behavior is verifiable in
// `npm start` without a real meeting or a DMG rebuild. Enabled only in a dev
// build with STENOAI_DEV_NOTIF_TRIGGERS=1 (never packaged, never E2E) so it
// doesn't grab shortcuts from other contributors by default. These fire the SAME
// functions the real flow uses (showMeetingDetected/TranscriptReady/NoteReady),
// so what you see here matches a real meeting.
//   Ctrl+Alt+1 → "Meeting detected" (Take Notes)
//   Ctrl+Alt+2 → "Transcript ready" (Summarise) for the most recent note
//   Ctrl+Alt+3 → "Note ready" for the most recent note
const DEV_NOTIF_TRIGGERS_ENV = 'STENOAI_DEV_NOTIF_TRIGGERS';
function setupDevNotificationTriggers() {
  if (IS_E2E || app.isPackaged || !process.env[DEV_NOTIF_TRIGGERS_ENV]) return;
  const latestNote = async () => {
    try {
      const meetings = JSON.parse(await runPythonScript('simple_recorder.py', ['list-meetings'], true));
      const withNotes = meetings.filter((m) => m.session_info?.summary_file);
      const m = withNotes[0];
      return m
        ? { summaryFile: m.session_info.summary_file, title: m.session_info.name || 'Untitled note' }
        : null;
    } catch (e) {
      sendDebugLog(`[dev-notify] list-meetings failed: ${e.message}`);
      return null;
    }
  };
  const register = (accel, label, fn) => {
    try {
      if (!globalShortcut.register(accel, fn)) {
        console.warn(`[dev-notify] failed to register ${accel} (${label})`);
      }
    } catch (e) {
      console.warn(`[dev-notify] register threw for ${accel}: ${e.message}`);
    }
  };
  register('Control+Alt+1', 'meeting-detected', () => {
    showMeetingDetectedNotification('DevMeeting', { pid: 0, app_id: 'dev.meeting' }, null);
  });
  register('Control+Alt+2', 'transcript-ready', async () => {
    const note = await latestNote();
    if (!note) { sendDebugLog('[dev-notify] no note for transcript-ready'); return; }
    void showTranscriptReadyNotification({ title: note.title, summaryFile: note.summaryFile, name: note.title });
  });
  register('Control+Alt+3', 'note-ready', async () => {
    const note = await latestNote();
    if (!note) { sendDebugLog('[dev-notify] no note for note-ready'); return; }
    void showNoteReadyNotification({ title: note.title, summaryFile: note.summaryFile });
  });
  sendDebugLog('[dev-notify] triggers registered (Ctrl+Alt+1/2/3)');
}

function setupAutoMeetingDetector() {
  if (IS_E2E) return;
  // Dev mode still requires the env var so a developer running `npm start`
  // doesn't get notification spam — they have to opt in. Packaged builds
  // honour the persisted user setting.
  if (!app.isPackaged && !process.env[AUTO_DETECT_ENV]) {
    sendDebugLog(`[auto-detect] dev mode without ${AUTO_DETECT_ENV}=1; not starting`);
    return;
  }
  if (!loadAutoDetectMeetingsEnabled()) {
    sendDebugLog('[auto-detect] disabled in settings; not starting');
    return;
  }
  if (!isAutoDetectSupported()) {
    sendDebugLog('[auto-detect] requires macOS 14 (Sonoma) or later; not starting');
    return;
  }
  startMicMonitor();
}

app.on('before-quit', () => {
  stopMicMonitor();
  if (premeetingRescheduleTimer) {
    clearInterval(premeetingRescheduleTimer);
    premeetingRescheduleTimer = null;
  }
  clearPreMeetingTimers();
});

// sendDebugLog now comes from ./debug-log via createDebugLog(...) wired near the
// top of this file (the main-window sink is injected as an accessor).

// Feed a child process's stderr into the persistent processing log, one record
// per complete line. Node 'data' events deliver arbitrary chunks (not lines),
// so we keep a residual buffer and flush the remainder on close. Additive: this
// does NOT replace the existing per-pipeline sendDebugLog calls (renderer panel)
// — it persists the same low-PII backend logger output to disk alongside them.
const STDERR_BUF_CAP = 64 * 1024; // flush a newline-less stream so buf can't grow unbounded
function attachProcessingStderr(proc, label) {
  if (!proc || !proc.stderr) return;
  let buf = '';
  proc.stderr.on('data', (data) => {
    buf += data.toString();
    let nl;
    while ((nl = buf.indexOf('\n')) !== -1) {
      const line = buf.slice(0, nl);
      buf = buf.slice(nl + 1);
      if (line.trim()) processingLog.logLine(label, line);
    }
    // Flood guard: a backend that emits stderr without newlines (e.g. \r-based
    // progress) would grow buf unboundedly. Flush the residual as one record
    // (processing-log truncates it to its own per-line cap) and reset.
    if (buf.length > STDERR_BUF_CAP) {
      if (buf.trim()) processingLog.logLine(label, buf);
      buf = '';
    }
  });
  proc.on('close', () => {
    if (buf.trim()) processingLog.logLine(label, buf);
    buf = '';
  });
}

// Persist only an allowlist of pipeline stdout protocol events. Excludes
// CHUNK/CHAT_CHUNK/TITLE/LIVE_SEG and any free-text/query answer (privacy).
// HEARTBEAT is throttled to once per 10s, keyed per source so concurrent
// pipelines (e.g. a queued process-streaming run during a live record) don't
// mask each other's heartbeats. Records are logged under the source label.
const lastHeartbeatLoggedAt = new Map();
const lastProgressLoggedAt = new Map();
function logPipelineStdoutLine(line, source) {
  const l = line.trim();
  if (!l) return;
  if (l.startsWith('HEARTBEAT')) {
    const now = Date.now();
    if (now - (lastHeartbeatLoggedAt.get(source) || 0) < 10_000) return;
    lastHeartbeatLoggedAt.set(source, now);
    processingLog.logLine(source, l);
    return;
  }
  if (l.startsWith('PROGRESS:')) {
    // Stage-transition markers (diarize start/done, summarize
    // step/reducing) are rare and always worth a line. Per-chunk
    // sub-progress (transcribe chunks, diarize embedding chunks) can tick
    // roughly once a second for many minutes on a long recording --
    // throttle those the same way HEARTBEAT already is, or they'd flood
    // the on-disk log.
    const isHighFrequency = l.startsWith('PROGRESS:transcribe:') || l.includes(':embedding:');
    if (isHighFrequency) {
      const now = Date.now();
      if (now - (lastProgressLoggedAt.get(source) || 0) < 10_000) return;
      lastProgressLoggedAt.set(source, now);
    }
    processingLog.logLine(source, l);
    return;
  }
  if (
    l.startsWith('TRANSCRIPTION_COMPLETE') ||
    l.startsWith('TRANSCRIPTION_FAILED') ||
    l.startsWith('SAVED:') ||
    l === 'STREAM_COMPLETE'
  ) {
    processingLog.logLine(source, l);
  }
}

// Forward a backend stdout line to the shareable debug buffer ONLY if it is a
// structural diagnostic marker (see isDiagnosticStdoutLine). Content — query
// answers, summary CHUNK:/TITLE:, settings-command JSON replies — is dropped so
// it never enters the buffer. This is the sendDebugLog counterpart to the
// on-disk logPipelineStdoutLine allowlist above; `source` is accepted for
// call-site symmetry with that function (heartbeat throttling stays at the
// per-handler call site, not here).
function forwardDiagnosticStdout(line, source) { // eslint-disable-line no-unused-vars
  if (isDiagnosticStdoutLine(line)) sendDebugLog(line.trim());
}

ipcMain.handle('setup-ollama-and-model', async () => {
  try {
    // Check AI provider -- skip local Ollama setup for remote/cloud
    try {
      const providerResult = await runPythonScript('simple_recorder.py', ['get-ai-provider'], true);
      const providerConfig = JSON.parse(providerResult.trim());
      if (providerConfig.ai_provider === 'remote' || providerConfig.ai_provider === 'cloud') {
        sendDebugLog(`AI provider is "${providerConfig.ai_provider}" -- skipping local Ollama setup`);
        return { success: true, skipped: true };
      }
    } catch (e) {
      sendDebugLog(`Could not read AI provider, proceeding with local setup: ${e.message}`);
    }

    // Check macOS version — bundled Ollama requires macOS 14 (Sonoma) or later.
    // os.release() reports the kernel version, which is Darwin on mac but the
    // Windows NT build on Windows; gate the version check to darwin so a non-mac
    // OS doesn't get rejected by the < 23 comparison.
    if (process.platform === 'darwin') {
      const macosRelease = os.release(); // e.g. "23.1.0" for macOS 14.1
      const darwinMajor = parseInt(macosRelease.split('.')[0], 10);
      // Darwin 23 = macOS 14 (Sonoma), Darwin 22 = macOS 13 (Ventura), etc.
      if (darwinMajor < 23) {
        const macosVersion = darwinMajor >= 22 ? '13 (Ventura)' : darwinMajor >= 21 ? '12 (Monterey)' : `(Darwin ${darwinMajor})`;
        sendDebugLog(`macOS ${macosVersion} detected — Ollama requires macOS 14 (Sonoma) or later`);
        return { success: false, error: 'Steno requires macOS 14 (Sonoma) or later for local AI summarization. Please update your macOS or use a remote Ollama server in Settings.' };
      }
    }

    sendDebugLog('Locating bundled Ollama...');
    const finalOllamaPath = await findOllamaExecutable();
    if (!finalOllamaPath) {
      sendDebugLog('Error: Bundled Ollama not found');
      return { success: false, error: 'Bundled Ollama not found. Please reinstall Steno.' };
    }
    sendDebugLog(`Found bundled Ollama at: ${finalOllamaPath}`);

    // Reuse already-running Ollama if its API is reachable on 11434.
    // Avoids "address already in use" when the user (or a previous launch)
    // already has Ollama up.
    const httpProbe = require('http');
    const ollamaAlreadyRunning = await new Promise((resolve) => {
      const req = httpProbe.get('http://127.0.0.1:11434/api/tags', { timeout: 1500 }, (res) => {
        resolve(res.statusCode === 200);
      });
      req.on('error', () => resolve(false));
      req.on('timeout', () => { req.destroy(); resolve(false); });
    });
    if (ollamaAlreadyRunning) {
      sendDebugLog('Ollama already running on 127.0.0.1:11434 — reusing existing instance');
    }

    let ollamaExited = false;
    let ollamaExitCode = null;
    let ollamaDyldError = false;
    if (!ollamaAlreadyRunning) {
      sendDebugLog('Starting Ollama service...');
      sendDebugLog(`$ ${finalOllamaPath} serve`);
      ollamaProcess = spawn(finalOllamaPath, ['serve'], { detached: true, stdio: ['ignore', 'ignore', 'pipe'], env: getOllamaEnv() });
      ollamaPid = ollamaProcess.pid;
      // Write PID file so quit handler can find the process
      try { require('fs').writeFileSync(path.join(getBackendCwd(), '_internal', 'ollama.pid'), String(ollamaPid)); } catch (_) {}
      ollamaProcess.stderr.on('data', (data) => {
        const msg = data.toString().trim();
        if (msg) sendDebugLog(`Ollama: ${msg}`);
        if (msg.includes('Symbol not found') || msg.includes('dyld')) ollamaDyldError = true;
      });
      ollamaProcess.on('exit', (code) => {
        ollamaExited = true;
        ollamaExitCode = code;
        ollamaPid = null;
        if (code !== 0 && code !== null) {
          sendDebugLog(`Ollama process exited with code ${code}`);
        }
      });
      ollamaProcess.unref();
      ollamaStartedByUs = true;
    }

    // Wait for Ollama to be ready (poll with early exit detection).
    // When we reused an existing instance, skip the wait — it's already up.
    sendDebugLog('Waiting for Ollama service to be ready...');
    const maxAttempts = ollamaAlreadyRunning ? 1 : 30;
    let ready = ollamaAlreadyRunning;
    for (let i = 0; i < maxAttempts && !ready; i++) {
      await new Promise(resolve => setTimeout(resolve, 1000));
      if (ollamaExited) {
        sendDebugLog(`Ollama process died during startup (exit code: ${ollamaExitCode})`);
        break;
      }
      try {
        const http = require('http');
        ready = await new Promise((resolve) => {
          const req = http.get('http://127.0.0.1:11434/api/tags', { timeout: 2000 }, (res) => {
            resolve(res.statusCode === 200);
          });
          req.on('error', () => resolve(false));
          req.on('timeout', () => { req.destroy(); resolve(false); });
        });
        if (ready) {
          sendDebugLog(`Ollama ready after ${i + 1} seconds`);
          break;
        }
      } catch (e) {
        // Continue polling
      }
    }

    if (!ready) {
      if (ollamaExited) {
        if (ollamaDyldError) {
          return { success: false, error: 'Ollama crashed due to incompatible macOS version. Steno requires macOS 14 (Sonoma) or later for local AI. Please update macOS or use a remote Ollama server in Settings.' };
        }
        return { success: false, error: `Ollama failed to start (exit code: ${ollamaExitCode}). Check debug logs for details.` };
      }
      sendDebugLog('Warning: Ollama may not be fully ready, attempting pull anyway...');
    }

    // #123: don't re-download the default if the connected Ollama already has a
    // supported model. The backend matches installed models against the supported
    // registry (single source of truth in config.py); on a hit we set it active
    // and skip the pull entirely, so the default Local path needs no network for
    // anyone with a usable Ollama already set up. Best-effort: any failure here
    // falls through to the normal download below.
    let pullTarget = DEFAULT_AI_MODEL;
    try {
      const resolvedRaw = await runPythonScript('simple_recorder.py', ['resolve-setup-model'], true);
      const resolved = JSON.parse(resolvedRaw.trim());
      if (resolved && resolved.pull_target) {
        pullTarget = resolved.pull_target;
      }
      if (resolved && resolved.installed) {
        sendDebugLog(`Found already-installed model "${resolved.installed}" — skipping download`);
        // Persist it as the active model, and only report success once that
        // write actually succeeded. set-model now exits non-zero on a
        // config-write failure (runPythonScript rejects) AND prints
        // success:false, so we check both: swallowing the failure here would
        // have setup claim success with no active model saved.
        try {
          const setRaw = await runPythonScript('simple_recorder.py', ['set-model', resolved.installed], true);
          // set-model prints a human line before the JSON, so grab the last
          // JSON-looking line rather than parsing the whole stdout.
          const jsonLine = setRaw.trim().split('\n').reverse().find((l) => l.trim().startsWith('{'));
          const setRes = jsonLine ? JSON.parse(jsonLine) : null;
          if (!setRes || setRes.success !== true) {
            return { success: false, error: (setRes && setRes.error) || 'Failed to save the selected model.' };
          }
        } catch (e) {
          return { success: false, error: `Failed to save the selected model: ${e.message}` };
        }
        trackEvent('setup_completed', { step: 'ollama_existing_model' });
        return { success: true, message: `Using already-installed model ${resolved.installed}` };
      }
    } catch (e) {
      sendDebugLog(`Could not check for installed models, proceeding to download: ${e.message}`);
    }

    sendDebugLog('Downloading AI model (this may take several minutes)...');
    sendDebugLog(`POST http://127.0.0.1:11434/api/pull {name: "${pullTarget}"}`);

    const http = require('http');
    return new Promise((resolve) => {
      const postData = JSON.stringify({ name: pullTarget });
      // Resolve exactly once. A streamed error must be terminal, so guard the
      // 'end' handler from resolving success after we've already reported a
      // failure line.
      let settled = false;
      const settle = (result) => {
        if (settled) return;
        settled = true;
        resolve(result);
      };
      // Emit progress to the renderer's setup wizard. Dedicated channel (not
      // the Settings 'model-pull-progress') because that one's listeners expect
      // a { model, progress: string } shape and would throw on this payload.
      const sendOllamaProgress = (payload) => {
        if (mainWindow && !mainWindow.isDestroyed()) {
          mainWindow.webContents.send('setup-ollama-progress', payload);
        }
      };
      const req = http.request({
        hostname: '127.0.0.1',
        port: 11434,
        path: '/api/pull',
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        timeout: 600000
      }, (res) => {
        let lastStatus = '';
        // Ollama streams newline-delimited JSON. A single socket chunk can end
        // mid-record, so buffer across chunks and only parse complete lines -
        // splitting each chunk in isolation would corrupt a split record.
        let buffer = '';
        // Ollama reports byte progress PER LAYER/blob, so completed/total reset
        // for each new layer. Track every layer's { completed, total } keyed by
        // digest, then report progress from the SINGLE largest layer (the model
        // blob dominates the pull at ~2GB of ~2.05GB total). That approximates
        // overall progress and stays near-monotonic, without the aggregate's
        // premature-100%-then-drop when a small layer finishes before the blob
        // even appears.
        const layers = new Map();
        // Last emitted pct, so status-only lines (e.g. "verifying sha256",
        // "success") keep the bar where it was instead of dropping it back to 0.
        let lastPct = 0;
        // Dedupe the IPC emit the same way the debug log dedupes via lastStatus:
        // Ollama emits many records/sec and the renderer flickers if every one
        // is forwarded. Skip the emit when both status and pct are unchanged.
        let lastEmittedStatus = null;
        let lastEmittedPct = -1;

        // Fold one parsed NDJSON record into the largest-layer tracker and emit
        // progress. Returns true when the record is a terminal error so callers
        // stop.
        const handleRecord = (json) => {
          if (json.error) {
            sendDebugLog(`Pull error: ${json.error}`);
            trackEvent('setup_failed', { step: 'ollama_and_model' });
            req.destroy();
            settle({ success: false, error: 'Failed to download AI model', details: json.error });
            return true;
          }
          const status = json.status || '';
          if (json.total) {
            // Key by digest so each blob is tracked independently; fall back to
            // the status label when a record carries no digest.
            const key = json.digest || status || 'unkeyed';
            layers.set(key, { completed: json.completed || 0, total: json.total });
          }
          // Drive the bar from the single layer with the largest total seen so
          // far - the model blob. Computed from the map so status-only records
          // (no total) still report that layer's bytes instead of dropping to 0.
          let largest = null;
          for (const layer of layers.values()) {
            if (!largest || layer.total > largest.total) {
              largest = layer;
            }
          }
          const largestCompleted = largest ? largest.completed : 0;
          const largestTotal = largest ? largest.total : 0;
          if (json.total) {
            // Guard divide-by-zero: leave the bar at its last position.
            if (largestTotal > 0) {
              lastPct = Math.round((100 * largestCompleted) / largestTotal);
            }
            const msg = `${status} ${lastPct}%`;
            if (msg !== lastStatus) {
              sendDebugLog(msg);
              lastStatus = msg;
            }
          } else if (status !== lastStatus) {
            // No byte counts on this line - retain the last bar position so
            // phase changes update the label without a misleading reset.
            sendDebugLog(status);
            lastStatus = status;
          }
          // Emit only when status or pct actually changed, to avoid flicker.
          if (status !== lastEmittedStatus || lastPct !== lastEmittedPct) {
            lastEmittedStatus = status;
            lastEmittedPct = lastPct;
            sendOllamaProgress({ status, pct: lastPct, completed: largestCompleted, total: largestTotal });
          }
          return false;
        };

        res.on('data', (chunk) => {
          buffer += chunk.toString();
          let nl;
          while ((nl = buffer.indexOf('\n')) !== -1) {
            const line = buffer.slice(0, nl).trim();
            buffer = buffer.slice(nl + 1);
            if (!line) continue;
            let json;
            try {
              json = JSON.parse(line);
            } catch (e) {
              // Non-JSON line, log as-is
              sendDebugLog(line);
              continue;
            }
            if (handleRecord(json)) return;
          }
        });

        res.on('end', async () => {
          // The in-stream { error } path calls settle() synchronously (via
          // handleRecord) before 'end' fires, so `settled` already covers it —
          // no separate streamError check is needed here.
          if (settled) return;
          // A final NDJSON record without a trailing newline stays in the buffer.
          // If that trailing line is an { error } record, an HTTP-200 end would
          // otherwise resolve success even though the pull failed - so parse it
          // and treat a trailing error exactly like the in-stream error path.
          const trailing = buffer.trim();
          if (trailing) {
            let json = null;
            try { json = JSON.parse(trailing); } catch (_) { /* not JSON */ }
            if (json && json.error) {
              sendDebugLog(`Pull error: ${json.error}`);
              trackEvent('setup_failed', { step: 'ollama_and_model' });
              settle({ success: false, error: 'Failed to download AI model', details: json.error });
              return;
            }
          }
          if (res.statusCode === 200) {
            sendDebugLog('AI model download completed successfully');
            try {
              await runPythonScript('simple_recorder.py', ['set-model', DEFAULT_AI_MODEL], true);
            } catch (e) {
              // Non-fatal -- config reset is best-effort
            }
            trackEvent('setup_completed', { step: 'ollama_and_model' });
            settle({ success: true, message: 'Ollama and AI model ready' });
          } else {
            sendDebugLog(`AI model download failed with status: ${res.statusCode}`);
            trackEvent('setup_failed', { step: 'ollama_and_model' });
            settle({ success: false, error: 'Failed to download AI model', details: `HTTP ${res.statusCode}` });
          }
        });
      });

      req.on('error', (error) => {
        sendDebugLog(`Pull request error: ${error.message}`);
        settle({ success: false, error: 'Failed to download AI model', details: error.message });
      });

      req.on('timeout', () => {
        req.destroy();
        sendDebugLog('Model pull timed out after 10 minutes');
        settle({ success: false, error: 'Model download timed out' });
      });

      req.write(postData);
      req.end();
    });
  } catch (error) {
    return { success: false, error: error.message };
  }
});

ipcMain.handle('setup-parakeet', async () => {
  try {
    // Download Parakeet TDT v3 (~572 MB) via the bundled backend. Used by
    // the Setup wizard's step 2 for fresh installs. Emits coarse stage
    // lines (PARAKEET_PULL_STAGE:downloading / :loading) rather than
    // byte-level progress — see src/parakeet_models.py for why.
    const backendPath = getBackendPath();
    sendDebugLog('Downloading Parakeet TDT v3 (~572 MB)...');
    sendDebugLog(`$ ${backendPath} download-parakeet-model`);

    return new Promise((resolve) => {
      const proc = spawn(backendPath, ['download-parakeet-model'], { stdio: 'pipe' });
      let lastStdoutLine = '';

      proc.stdout.on('data', (data) => {
        const text = data.toString();
        for (const line of text.split('\n')) {
          const trimmed = line.trim();
          if (!trimmed) continue;
          sendDebugLog(trimmed);
          if (trimmed.startsWith('PARAKEET_PULL_STAGE:')) {
            const stage = trimmed.slice('PARAKEET_PULL_STAGE:'.length);
            if (mainWindow && !mainWindow.isDestroyed()) {
              mainWindow.webContents.send('parakeet-pull-progress', { stage });
            }
          } else {
            lastStdoutLine = trimmed;
          }
        }
      });

      proc.stderr.on('data', (data) => {
        const text = data.toString().trim();
        if (text) sendDebugLog('STDERR: ' + text);
      });

      proc.on('close', (code) => {
        let parsed = null;
        try { parsed = JSON.parse(lastStdoutLine); } catch (_) { /* not JSON */ }
        const ok = code === 0 && (!parsed || parsed.success !== false);
        if (ok) {
          sendDebugLog('Parakeet model ready');
          resolve({ success: true, message: 'Parakeet model ready' });
        } else {
          const err = (parsed && parsed.error) || `Parakeet download exited with code ${code}`;
          sendDebugLog(err);
          resolve({ success: false, error: err });
        }
      });

      proc.on('error', (error) => {
        sendDebugLog(`Process error: ${error.message}`);
        resolve({ success: false, error: error.message });
      });
    });
  } catch (error) {
    return { success: false, error: error.message };
  }
});

ipcMain.handle('setup-test', async () => {
  try {
    sendDebugLog('Running system test...');
    sendDebugLog('$ python simple_recorder.py test');

    // Test the complete system
    const result = await runPythonScript('simple_recorder.py', ['test']);

    // Log the full result to debug console
    result.split('\n').forEach(line => {
      if (line.trim()) sendDebugLog(line.trim());
    });

    if (result.includes('System check passed') || result.includes('SUCCESS')) {
      sendDebugLog('System test completed successfully');
      trackEvent('setup_completed', { step: 'system_test' });
      return { success: true, message: 'System test passed' };
    } else {
      // Extract specific error details from the output
      const errorLines = result.split('\n').filter(line => line.includes('ERROR:'));
      const specificError = errorLines.length > 0 ? errorLines[errorLines.length - 1].replace('ERROR: ', '') : 'Unknown error';
      sendDebugLog(`System test failed: ${specificError}`);
      trackEvent('setup_failed', { step: 'system_test' });
      return { success: false, error: `System test failed: ${specificError}`, details: result };
    }
  } catch (error) {
    sendDebugLog(`System test error: ${error.message}`);
    return { success: false, error: error.message };
  }
});

// Settings window IPC handlers
ipcMain.handle('trigger-setup-wizard', async () => {
  try {
    console.log('🔧 Starting setup wizard from settings...');

    // Trigger the main window's setup flow
    if (mainWindow) {
      mainWindow.webContents.send('trigger-setup-flow');
    }

    return { success: true, message: 'Setup wizard triggered in main window' };
  } catch (error) {
    console.error('Setup wizard failed:', error);
    return { success: false, error: error.message };
  }
});

ipcMain.handle('get-app-version', async () => {
  try {
    const packagePath = path.join(__dirname, 'package.json');
    const packageContent = JSON.parse(fs.readFileSync(packagePath, 'utf8'));
    return {
      success: true,
      version: packageContent.version,
      name: packageContent.productName || packageContent.name
    };
  } catch (error) {
    return { success: false, error: error.message };
  }
});

// Folders + storage-layout IPC handlers (RFC #327 Folders pilot) — extracted to
// ./folders-ipc and registered here in place, so registration timing + behavior
// are identical to the inline handlers this replaces. The storage-path cache
// stays a main.js `let`; the module updates it through the injected setter, and
// the readers (getOutputDir / getAllowedBaseDirs / resolveRecordingsDir /
// validateMeetingFilePath) keep reading the live binding.
registerFoldersIpc({
  ipcMain,
  runPythonScript,
  dialog,
  getMainWindow: () => mainWindow,
  getUserDataDir,
  validateMeetingFilePath,
  setCachedCustomStoragePath: (v) => { _cachedCustomStoragePath = v; },
  // A folder add/remove rewrites the note's `folders:` frontmatter but fires no
  // processing-complete — mirror it so the vault subfolder tracks (#413).
  onNoteFoldersChanged: (summaryPath) => {
    try { obsidianSync.syncNoteBySummaryPath(summaryPath); } catch (_) {}
  },
});

// Obsidian vault sync IPC (#413): config toggle + vault picker + conflicts read.
registerObsidianIpc({
  ipcMain,
  runPythonScript,
  dialog,
  getMainWindow: () => mainWindow,
  obsidianSync,
  sendDebugLog,
});

ipcMain.handle('get-ai-prompts', async () => {
  try {
    // Read the summarization prompt from the Python backend
    const summarizerPath = path.join(__dirname, '..', 'src', 'summarizer.py');

    if (fs.existsSync(summarizerPath)) {
      const content = fs.readFileSync(summarizerPath, 'utf8');

      // Extract the full prompt from the _create_permissive_prompt method
      const promptMatch = content.match(/def _create_permissive_prompt[\s\S]*?return f"""([\s\S]*?)"""/);

      if (promptMatch) {
        return {
          success: true,
          summarization: promptMatch[1].trim()
        };
      }
    }

    return {
      success: true,
      summarization: 'Prompt not found in summarizer.py'
    };
  } catch (error) {
    return { success: false, error: error.message };
  }
});

// Helper function to ensure Ollama service is running
async function ensureOllamaRunning() {
  try {
    // Check if Ollama service is responding
    const http = require('http');
    const response = await new Promise((resolve) => {
      const req = http.get('http://127.0.0.1:11434/api/version', { timeout: 3000 }, (res) => {
        resolve(res.statusCode === 200);
      });
      req.on('error', () => resolve(false));
      req.on('timeout', () => { req.destroy(); resolve(false); });
    });

    if (response) {
      return true; // Service is running
    }

    // Service not running, try to start it.
    // The macOS-14 gate only applies to mac (os.release() is the NT build on
    // Windows, which would always trigger the < 23 check).
    if (process.platform === 'darwin') {
      const macRelease = os.release();
      if (parseInt(macRelease.split('.')[0], 10) < 23) {
        sendDebugLog('macOS version too old for bundled Ollama — requires macOS 14 (Sonoma) or later');
        return false;
      }
    }

    const ollamaPath = await findOllamaExecutable();
    if (!ollamaPath) {
      return false;
    }

    // Start Ollama service in background with proper env vars for dylibs
    ollamaProcess = spawn(ollamaPath, ['serve'], { detached: true, stdio: 'ignore', env: getOllamaEnv() });
    ollamaPid = ollamaProcess.pid;
    try { require('fs').writeFileSync(path.join(getBackendCwd(), '_internal', 'ollama.pid'), String(ollamaPid)); } catch (_) {}
    ollamaProcess.on('exit', () => { ollamaPid = null; });
    ollamaProcess.unref();
    ollamaStartedByUs = true;

    // Wait for service to start
    await new Promise(resolve => setTimeout(resolve, 2000));
    return true;
  } catch (error) {
    console.error('Error ensuring Ollama is running:', error);
    return false;
  }
}

// Check if Ollama is installed (for setup wizard)
ipcMain.handle('check-ollama-installed', async () => {
  try {
    const ollamaPath = await findOllamaExecutable();
    if (!ollamaPath) {
      return { success: true, installed: false };
    }
    return { success: true, installed: true, path: ollamaPath };
  } catch (error) {
    return { success: false, installed: false, error: error.message };
  }
});

// Model management handlers
ipcMain.handle('check-model-installed', async (event, modelName) => {
  try {
    const result = await runPythonScript('simple_recorder.py', ['check-model', modelName]);
    // Parse the last JSON line from output (skip any log lines)
    const lines = result.trim().split('\n');
    for (let i = lines.length - 1; i >= 0; i--) {
      try {
        const data = JSON.parse(lines[i]);
        return { success: true, installed: data.installed };
      } catch (e) {
        continue;
      }
    }
    return { success: false, installed: false, error: 'Could not parse backend response' };
  } catch (error) {
    return { success: false, installed: false, error: error.message };
  }
});

ipcMain.handle('list-models', async () => {
  try {
    const result = await runPythonScript('simple_recorder.py', ['list-models']);
    const jsonData = JSON.parse(result);

    // Machine RAM (GB), used by the renderer to flag local models that may
    // exceed available memory. macOS-only: the heuristic + the "your Mac" copy
    // are calibrated for Apple Silicon unified memory; on Windows the field is
    // omitted so no badge shows (Windows VRAM/DirectML detection is out of
    // scope — #248). Computed once per Settings-open list() call.
    if (process.platform === 'darwin') {
      jsonData.total_ram_gb = os.totalmem() / (1024 ** 3);
    }

    return {
      success: true,
      ...jsonData
    };
  } catch (error) {
    sendDebugLog(`Error listing models: ${error.message}`);
    return { success: false, error: error.message };
  }
});

ipcMain.handle('get-current-model', async () => {
  try {
    const result = await runPythonScript('simple_recorder.py', ['get-model']);
    const jsonData = JSON.parse(result);

    return {
      success: true,
      ...jsonData
    };
  } catch (error) {
    sendDebugLog(`Error getting current model: ${error.message}`);
    return { success: false, error: error.message };
  }
});

ipcMain.handle('set-model', async (event, modelName) => {
  try {
    sendDebugLog(`Setting model to: ${modelName}`);
    const result = await runPythonScript('simple_recorder.py', ['set-model', modelName]);

    // Extract JSON from output (might have other text before it)
    const jsonMatch = result.match(/\{.*\}/s);
    if (jsonMatch) {
      const jsonData = JSON.parse(jsonMatch[0]);
      trackEvent('model_changed', { model: sanitizeModelForAnalytics(modelName), kind: 'summarization' });
      return jsonData;
    }

    trackEvent('model_changed', { model: sanitizeModelForAnalytics(modelName), kind: 'summarization' });
    return { success: true, model: modelName };
  } catch (error) {
    sendDebugLog(`Error setting model: ${error.message}`);
    return { success: false, error: error.message };
  }
});

ipcMain.handle('verify-model', async (event, modelName) => {
  try {
    sendDebugLog(`Verifying model: ${modelName}`);
    const result = await runPythonScript('simple_recorder.py', ['verify-model', modelName]);
    const jsonMatch = result.match(/\{.*\}/s);
    if (jsonMatch) {
      return JSON.parse(jsonMatch[0]);
    }
    return { success: true };
  } catch (error) {
    sendDebugLog(`Error verifying model: ${error.message}`);
    return { success: false, error: error.message };
  }
});

ipcMain.handle('delete-model', async (event, modelName) => {
  try {
    sendDebugLog(`Deleting model: ${modelName}`);
    const result = await runPythonScript('simple_recorder.py', ['delete-model', modelName]);
    const jsonMatch = result.match(/\{.*\}/s);
    if (jsonMatch) {
      return JSON.parse(jsonMatch[0]);
    }
    return { success: true };
  } catch (error) {
    sendDebugLog(`Error deleting model: ${error.message}`);
    return { success: false, error: error.message };
  }
});

ipcMain.handle('list-templates', async () => {
  try {
    const out = await runPythonScript('simple_recorder.py', ['list-templates']);
    return { success: true, ...JSON.parse(out) };
  } catch (error) {
    return { success: false, error: error.message };
  }
});

ipcMain.handle('save-template', async (_e, template) => {
  try {
    const out = await runPythonScript('simple_recorder.py', ['save-template', JSON.stringify(template)]);
    return JSON.parse(out);
  } catch (error) {
    return { success: false, error: error.message };
  }
});

ipcMain.handle('delete-template', async (_e, id) => {
  try {
    const out = await runPythonScript('simple_recorder.py', ['delete-template', id]);
    return JSON.parse(out);
  } catch (error) {
    return { success: false, error: error.message };
  }
});

ipcMain.handle('set-default-template', async (_e, id) => {
  try {
    const out = await runPythonScript('simple_recorder.py', ['set-default-template', id]);
    return JSON.parse(out);
  } catch (error) {
    return { success: false, error: error.message };
  }
});

ipcMain.handle('reset-template', async (_e, id) => {
  try {
    const out = await runPythonScript('simple_recorder.py', ['reset-template', id]);
    return JSON.parse(out);
  } catch (error) {
    return { success: false, error: error.message };
  }
});

ipcMain.handle('get-transcription-engine', async () => {
  try {
    const result = await runPythonScript('simple_recorder.py', ['get-transcription-engine'], true);
    const jsonData = JSON.parse(result.trim());
    return { success: true, ...jsonData };
  } catch (e) { return { success: false, error: e.message }; }
});

ipcMain.handle('set-transcription-engine', async (event, engine) => {
  try {
    const result = await runPythonScript('simple_recorder.py', ['set-transcription-engine', engine]);
    const jsonData = JSON.parse(result.trim());
    trackEvent('model_changed', { model: engine, kind: 'transcription_engine' });
    return { success: true, ...jsonData };
  } catch (e) { return { success: false, error: e.message }; }
});

ipcMain.handle('apple-speech-status', async (_event, language = 'auto') => {
  try {
    const requested = typeof language === 'string' ? language : 'auto';
    const result = await runPythonScript(
      'simple_recorder.py',
      ['apple-speech-status', requested],
      true,
    );
    return JSON.parse(result.trim());
  } catch (e) {
    return parsePythonFailureJson(e);
  }
});

ipcMain.handle('prepare-apple-speech', async (_event, language = 'auto') => {
  try {
    const requested = typeof language === 'string' ? language : 'auto';
    const result = await runPythonScript(
      'simple_recorder.py',
      ['prepare-apple-speech', requested],
    );
    return JSON.parse(result.trim());
  } catch (e) {
    return parsePythonFailureJson(e);
  }
});

ipcMain.handle('list-parakeet-models', async () => {
  try {
    const result = await runPythonScript('simple_recorder.py', ['list-parakeet-models'], true);
    const jsonData = JSON.parse(result.trim());
    return { success: true, ...jsonData };
  } catch (e) { return { success: false, error: e.message }; }
});

ipcMain.handle('parakeet-status', async () => {
  try {
    const result = await runPythonScript('simple_recorder.py', ['parakeet-status'], true);
    const jsonData = JSON.parse(result.trim());
    return { success: true, ...jsonData };
  } catch (e) { return { success: false, error: e.message }; }
});

ipcMain.handle('get-whisper-model', async () => {
  try {
    const result = await runPythonScript('simple_recorder.py', ['get-whisper-model'], true);
    const jsonData = JSON.parse(result.trim());
    return { success: true, ...jsonData };
  } catch (e) { return { success: false, error: e.message }; }
});

ipcMain.handle('set-whisper-model', async (event, modelSize) => {
  try {
    const result = await runPythonScript('simple_recorder.py', ['set-whisper-model', modelSize]);
    const jsonData = JSON.parse(result.trim());
    trackEvent('model_changed', { model: sanitizeModelForAnalytics(modelSize), kind: 'transcription' });
    return { success: true, ...jsonData };
  } catch (e) { return { success: false, error: e.message }; }
});

ipcMain.handle('list-whisper-models', async () => {
  try {
    const result = await runPythonScript('simple_recorder.py', ['list-whisper-models'], true);
    const jsonData = JSON.parse(result.trim());
    return { success: true, ...jsonData };
  } catch (e) { return { success: false, error: e.message }; }
});

ipcMain.handle('pull-whisper-model', async (event, modelName) => {
  try {
    sendDebugLog(`Pulling whisper model: ${modelName}`);
    return new Promise((resolve) => {
      const proc = spawn(getBackendPath(), ['pull-whisper-model', modelName], {
        cwd: getBackendCwd(),
      });
      let lastStdoutLine = '';
      let timedOut = false;
      // Single settle-gate so SIGKILL-escalation / 'close' / 'error' /
      // force-settle can all race without double-resolving or double-sending
      // whisper-pull-complete. Critical for the timeout path: if the child
      // ignores SIGTERM we must still resolve the Promise eventually,
      // otherwise the renderer spinner hangs forever.
      let settled = false;
      let sigkillTimer = null;
      let forceSettleTimer = null;
      const finishOnce = (result, completeEvent) => {
        if (settled) return;
        settled = true;
        clearTimeout(procTimeout);
        if (sigkillTimer) clearTimeout(sigkillTimer);
        if (forceSettleTimer) clearTimeout(forceSettleTimer);
        if (mainWindow && !mainWindow.isDestroyed() && completeEvent) {
          mainWindow.webContents.send('whisper-pull-complete', completeEvent);
        }
        resolve(result);
      };

      // The 3.1 GB large-v3 weights take 5-10 min on a typical home
      // connection. 30 min covers everything short of a stalled socket,
      // matching the process-streaming timeout. Without this, a hung HF
      // download leaves the spinner spinning indefinitely with no recovery.
      const procTimeout = setTimeout(() => {
        timedOut = true;
        sendDebugLog('pull-whisper-model timed out after 30 minutes, killing');
        try { proc.kill('SIGTERM'); } catch (_) { /* already exited */ }
        // SIGTERM can be ignored (signal handler, uninterruptible syscall).
        // Escalate to SIGKILL which the kernel cannot block.
        sigkillTimer = setTimeout(() => {
          sendDebugLog('SIGTERM unresponsive, escalating to SIGKILL');
          try { proc.kill('SIGKILL'); } catch (_) { /* already exited */ }
        }, 5000);
        // Final guarantee: even if 'close' never fires (zombie / uninterruptible
        // wait), settle the Promise so the renderer's whisper-pull-complete
        // listener flushes the progress map and the spinner clears.
        forceSettleTimer = setTimeout(() => {
          sendDebugLog('Force-settling pull-whisper-model Promise after kill grace');
          finishOnce(
            { success: false, error: 'Download timed out after 30 minutes' },
            { model: modelName, success: false, error: 'Download timed out after 30 minutes' },
          );
        }, 15000);
      }, 30 * 60 * 1000);
      const relayProgress = (output) => {
        if (!output) return;
        if (mainWindow && !mainWindow.isDestroyed()) {
          mainWindow.webContents.send('whisper-pull-progress', {
            model: modelName,
            progress: output,
          });
        }
      };
      proc.stdout.on('data', (data) => {
        const output = data.toString().trim();
        sendDebugLog(output);
        if (output) lastStdoutLine = output;
        relayProgress(output);
      });
      proc.stderr.on('data', (data) => {
        const output = data.toString().trim();
        if (output) sendDebugLog(`STDERR: ${output}`);
        relayProgress(output);
      });
      proc.on('close', (code) => {
        let pullResult = null;
        try { pullResult = JSON.parse(lastStdoutLine); } catch (_) { /* not JSON */ }
        const succeeded = !timedOut && code === 0 && (!pullResult || pullResult.success !== false);
        if (succeeded) {
          finishOnce(
            { success: true, model: modelName },
            { model: modelName, success: true },
          );
        } else {
          const errorMsg = timedOut
            ? 'Download timed out after 30 minutes'
            : (pullResult && pullResult.error) || `Process exited with code ${code}`;
          finishOnce(
            { success: false, error: errorMsg },
            { model: modelName, success: false, error: errorMsg },
          );
        }
      });
      proc.on('error', (error) => {
        finishOnce(
          { success: false, error: error.message },
          { model: modelName, success: false, error: error.message },
        );
      });
    });
  } catch (e) {
    return { success: false, error: e.message };
  }
});

ipcMain.handle('pull-parakeet-model', async (event, modelId) => {
  // Mirrors pull-whisper-model: settle-gate + SIGTERM-then-SIGKILL escalation
  // so a stalled HF download can never leave the renderer spinner hanging.
  // Progress is coarse — we relay PARAKEET_PULL_STAGE:<stage> lines from the
  // Python child rather than byte counts. See src/parakeet_models.py for why.
  try {
    sendDebugLog(`Pulling Parakeet model: ${modelId || '<default>'}`);
    return new Promise((resolve) => {
      const args = ['download-parakeet-model'];
      if (modelId) args.push(modelId);
      const proc = spawn(getBackendPath(), args, { cwd: getBackendCwd() });
      let lastStdoutLine = '';
      let timedOut = false;
      let settled = false;
      let sigkillTimer = null;
      let forceSettleTimer = null;
      const finishOnce = (result, completeEvent) => {
        if (settled) return;
        settled = true;
        clearTimeout(procTimeout);
        if (sigkillTimer) clearTimeout(sigkillTimer);
        if (forceSettleTimer) clearTimeout(forceSettleTimer);
        if (mainWindow && !mainWindow.isDestroyed() && completeEvent) {
          mainWindow.webContents.send('parakeet-pull-complete', completeEvent);
        }
        resolve(result);
      };
      const procTimeout = setTimeout(() => {
        timedOut = true;
        sendDebugLog('pull-parakeet-model timed out after 30 minutes, killing');
        try { proc.kill('SIGTERM'); } catch (_) { /* already exited */ }
        sigkillTimer = setTimeout(() => {
          sendDebugLog('SIGTERM unresponsive, escalating to SIGKILL');
          try { proc.kill('SIGKILL'); } catch (_) { /* already exited */ }
        }, 5000);
        forceSettleTimer = setTimeout(() => {
          sendDebugLog('Force-settling pull-parakeet-model Promise after kill grace');
          finishOnce(
            { success: false, error: 'Download timed out after 30 minutes' },
            { model: modelId, success: false, error: 'Download timed out after 30 minutes' },
          );
        }, 15000);
      }, 30 * 60 * 1000);
      proc.stdout.on('data', (data) => {
        const text = data.toString();
        for (const line of text.split('\n')) {
          const trimmed = line.trim();
          if (!trimmed) continue;
          sendDebugLog(trimmed);
          if (trimmed.startsWith('PARAKEET_PULL_STAGE:')) {
            const stage = trimmed.slice('PARAKEET_PULL_STAGE:'.length);
            if (mainWindow && !mainWindow.isDestroyed()) {
              mainWindow.webContents.send('parakeet-pull-progress', { model: modelId, stage });
            }
          } else {
            lastStdoutLine = trimmed;
          }
        }
      });
      proc.stderr.on('data', (data) => {
        const text = data.toString().trim();
        if (text) sendDebugLog(`STDERR: ${text}`);
      });
      proc.on('close', (code) => {
        let pullResult = null;
        try { pullResult = JSON.parse(lastStdoutLine); } catch (_) { /* not JSON */ }
        const succeeded = !timedOut && code === 0 && (!pullResult || pullResult.success !== false);
        if (succeeded) {
          finishOnce(
            { success: true, model: modelId },
            { model: modelId, success: true },
          );
        } else {
          const errorMsg = timedOut
            ? 'Download timed out after 30 minutes'
            : (pullResult && pullResult.error) || `Process exited with code ${code}`;
          finishOnce(
            { success: false, error: errorMsg },
            { model: modelId, success: false, error: errorMsg },
          );
        }
      });
      proc.on('error', (error) => {
        finishOnce(
          { success: false, error: error.message },
          { model: modelId, success: false, error: error.message },
        );
      });
    });
  } catch (e) {
    return { success: false, error: e.message };
  }
});

// Settings-toggle IPC handlers (RFC #327 Phase 2.2) — the self-contained config
// get/set toggles (keep-recordings, auto-summarize, silence-auto-stop,
// system-audio, language, microphone, user-name, privacy-notice-seen) extracted
// to ./settings-ipc and registered here in place, so registration timing +
// behavior are identical to the inline handlers this replaces. Settings-shaped
// handlers coupled to another domain (telemetry, models, mic-monitor, calendar,
// tray) deliberately stay in main.js until that domain's own extraction.
registerSettingsIpc({
  ipcMain,
  runPythonScript,
  sendDebugLog,
  onLanguageChanged: restartActiveAppleLiveTranscribeAfterLanguageChange,
});
registerPersonSampleIpc({ ipcMain, runPythonScript });
registerSpeakerIpc({ ipcMain, runPythonScript, parsePythonFailureJson });

// Fired by the renderer's silence detector. The renderer has already
// asked main to stop the recording via pause/stop; this just surfaces
// the reason to the user via a system-tray notification so they know
// what happened when they come back to the laptop. sessionName matches
// what they'll see in the sidebar — calendar event title for
// auto-detect recordings, "Note" for the default placeholder.
ipcMain.handle('show-silence-auto-stop-notification', async (_event, payload) => {
  try {
    // `shown` reflects whether the notifications_enabled toggle let it through —
    // the observable signal e2e uses to confirm gating, since a native banner
    // isn't otherwise inspectable. Additive (renderer only reads `success`); not
    // in the typed renderer Result<> — intentional, don't drop it as dead code.
    if (!(await notificationsEnabled())) return { success: true, shown: false };
    // Back-compat: earlier callers passed `minutes` as a number directly.
    // Accept both shapes so older renderer bundles don't crash this handler
    // until they're rebuilt.
    const minutes = typeof payload === 'number' ? payload : payload?.minutes;
    const sessionName = typeof payload === 'object' ? payload?.sessionName : null;
    const body = sessionName
      ? `${sessionName} — ${minutes} minutes of silence`
      : `${minutes} minutes of silence — your note is being processed.`;
    const notif = new Notification({
      title: 'Recording stopped',
      body,
      iconType: 'recording',
    });
    notif.on('click', () => {
      if (mainWindow && !mainWindow.isDestroyed()) {
        exposeMainWindow();
      }
    });
    trackNotificationLifecycle(notif, 'silence_auto_stop');
    notif.show();
    return { success: true, shown: true };
  } catch (e) {
    sendDebugLog(`Failed to show silence auto-stop notification: ${e.message}`);
    return { success: false, error: e.message };
  }
});

// Fired by useSystemAudioCapture.ts when an enabled loopback acquisition
// genuinely fails (for example, System Audio Recording permission is denied).
// It is not fired when the user turns system audio off or the OS is unsupported.
// Clicking it opens Settings via the same tray-open-settings event the tray
// menu uses.
ipcMain.handle('show-system-audio-mic-only-notification', async () => {
  try {
    if (!(await notificationsEnabled())) return { success: true, shown: false };
    const notif = new Notification({
      title: 'Recording mic-only',
      body: 'System audio could not be captured. Check Steno’s Screen & System Audio Recording access in System Settings.',
      iconType: 'alert',
    });
    notif.on('click', () => {
      if (mainWindow && !mainWindow.isDestroyed()) {
        exposeMainWindow();
        mainWindow.webContents.send('tray-open-settings');
      }
    });
    trackNotificationLifecycle(notif, 'system_audio_mic_only');
    notif.show();
    return { success: true, shown: true };
  } catch (e) {
    sendDebugLog(`Failed to show system-audio mic-only notification: ${e.message}`);
    return { success: false, error: e.message };
  }
});

// Fired by the renderer's processing-complete handler when we skipped
// auto-navigate (user was on a route other than /meetings/processing).
// Clicking the banner is an explicit "take me there" from the user (unlike
// the idle auto-navigate case this mirrors in spirit), so it navigates
// straight to the finished note when one was written — via the
// navigate-to-meeting event — and only falls back to focus-only when
// `summaryFile` is absent (the hardFailure case: nothing was ever written,
// so there's nothing to open).
async function showNoteReadyNotification(payload) {
  // `shown` = passed the notifications_enabled gate (see show-silence-auto-stop).
  if (!(await notificationsEnabled())) return { success: true, shown: false };
  const { summaryFile } = payload || {};
  const { title, body, iconType, outcome } = buildNoteReadyNotificationOptions(payload);
  const notif = new Notification({ title, body, iconType });
  notif.on('click', () => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      exposeMainWindow();
      if (summaryFile) mainWindow.webContents.send('navigate-to-meeting', { summaryFile });
    }
  });
  trackNotificationLifecycle(notif, 'note_ready', { outcome });
  notif.show();
  return { success: true, shown: true };
}

ipcMain.handle('show-note-ready-notification', async (_event, payload) => {
  try {
    return await showNoteReadyNotification(payload);
  } catch (e) {
    sendDebugLog(`Failed to show note-ready notification: ${e.message}`);
    return { success: false, error: e.message };
  }
});

// Fired by the renderer's processing-complete handler when a recording finished
// transcription but NO notes were generated (auto_summarize off → transcript-
// only note). Unlike note-ready, this prompts the user to summarise, and is the
// correctly-timed replacement for the old premature meeting-end "Summarise?"
// prompt (#bug2/#bug3). One-click, matching "Take Notes": tapping "Summarise" —
// the button OR the notification body — brings the window forward, opens the
// note, and starts generation there, so the user watches it stream in-place;
// "Note ready" still fires on completion.
async function showTranscriptReadyNotification(payload) {
  // `shown` = passed the notifications_enabled gate (see show-note-ready).
  if (!(await notificationsEnabled())) return { success: true, shown: false };
  const { title, summaryFile, name } = payload || {};
  const notif = new Notification({
    title: 'Transcript ready',
    body: buildTranscriptReadyBody(title),
    actions: [{ type: 'button', text: 'Summarise' }],
    iconType: 'success',
  });
  // The whole notification means "yes, summarise": a body tap AND the "Summarise"
  // button both open the note and start generation there, so the user watches it
  // stream in-place ("Note ready" still fires on completion). Wiring both to the
  // same action is what makes it one-click (like "Take Notes") — a body tap that
  // only navigated was the source of the two-click ("first click opens, second
  // click summarises"). Bring the window forward, navigate to the note, THEN
  // kick off generation.
  const startSummarise = () => {
    if (mainWindow && !mainWindow.isDestroyed() && summaryFile) {
      exposeMainWindow();
      mainWindow.webContents.send('navigate-to-meeting', { summaryFile });
      mainWindow.webContents.send('generate-notes-requested', { summaryFile, name });
    }
  };
  notif.on('action', () => startSummarise());
  notif.on('click', () => startSummarise());
  trackNotificationLifecycle(notif, 'transcript_ready');
  notif.show();
  return { success: true, shown: true };
}

ipcMain.handle('show-transcript-ready-notification', async (_event, payload) => {
  try {
    return await showTranscriptReadyNotification(payload);
  } catch (e) {
    sendDebugLog(`Failed to show transcript-ready notification: ${e.message}`);
    return { success: false, error: e.message };
  }
});

ipcMain.handle('get-notifications', handleGetNotifications);

ipcMain.handle('set-notifications', async (event, enabled) => {
  try {
    sendDebugLog(`Setting notifications to: ${enabled}`);
    const result = await runPythonScript('simple_recorder.py', ['set-notifications', enabled ? 'True' : 'False']);

    // Extract JSON from output
    const jsonMatch = result.match(/\{.*\}/s);
    if (jsonMatch) {
      const jsonData = JSON.parse(jsonMatch[0]);
      refreshIdentitySuperProperties();
      return jsonData;
    }

    refreshIdentitySuperProperties();
    return { success: true, notifications_enabled: enabled };
  } catch (error) {
    sendDebugLog(`Error setting notifications: ${error.message}`);
    return { success: false, error: error.message };
  }
});

// Both the persisted preference AND the live registration state — the UI needs
// to know if the shortcut is enabled but failed to register (another app owns
// the accelerator) so it can surface a hint.
ipcMain.handle('get-record-hotkey', () => ({
  success: true,
  enabled: recordHotkeyEnabledFromDisk(),
  registered: globalShortcut.isRegistered(RECORD_HOTKEY_ACCEL),
}));

ipcMain.handle('set-record-hotkey', async (event, enabled) => {
  try {
    sendDebugLog(`Setting record hotkey to: ${enabled}`);
    const result = await runPythonScript('simple_recorder.py', ['set-record-hotkey', enabled ? 'True' : 'False']);

    // Surface a persist failure rather than silently applying the shortcut.
    const jsonMatch = result.match(/\{.*\}/s);
    if (jsonMatch) {
      const persisted = JSON.parse(jsonMatch[0]);
      if (persisted.success === false) {
        return {
          success: false,
          error: persisted.error || 'Failed to save record shortcut preference',
        };
      }
    }

    // Live-apply so the change takes effect without a relaunch. Idempotent and
    // never unregisterAll() — see applyRecordHotkey (guards on isRegistered() so
    // a repeat-enable can't report a spurious failure, and only ever touches
    // this specific accelerator).
    const registered = applyRecordHotkey(enabled);
    if (enabled && !registered) {
      console.error(`Failed to register global hotkey: ${RECORD_HOTKEY_ACCEL}`);
    }
    return { success: true, enabled, registered };
  } catch (error) {
    sendDebugLog(`Error setting record hotkey: ${error.message}`);
    return { success: false, error: error.message };
  }
});

ipcMain.handle('get-telemetry', async () => {
  try {
    const result = await runPythonScript('simple_recorder.py', ['get-telemetry']);
    const jsonData = JSON.parse(result);

    return {
      success: true,
      ...jsonData
    };
  } catch (error) {
    sendDebugLog(`Error getting telemetry settings: ${error.message}`);
    return { success: false, error: error.message };
  }
});

// Where the telemetry toggle was flipped -- 'setup' names the Setup.tsx
// screen and 'consent' names the one-time privacy notice modal. 'setup' is
// also reachable later via "run setup wizard" from Settings (see
// trigger-setup-wizard), so this deliberately does NOT claim to mean "first
// run". Whitelisted so a stale/forged renderer arg can't smuggle an arbitrary
// string into PostHog.
const TELEMETRY_TOGGLE_SOURCES = new Set(['setup', 'settings', 'consent']);

ipcMain.handle('set-telemetry', async (event, enabled, source) => {
  try {
    sendDebugLog(`Setting telemetry to: ${enabled}`);
    const toggleSource = TELEMETRY_TOGGLE_SOURCES.has(source) ? source : 'settings';
    const result = await runPythonScript('simple_recorder.py', ['set-telemetry', enabled ? 'True' : 'False']);

    // telemetry_toggled is the one event that MUST fire around the opposite
    // side of its own gate -- otherwise disabling telemetry makes the
    // disable itself invisible (trackEvent no-ops once telemetryEnabled is
    // false and posthogClient is torn down), and re-enabling would identify
    // stale/absent super-properties until the next app launch.
    if (enabled && !posthogClient) {
      // Bring the client up and identify FIRST so both the super-properties
      // and this event land fresh, rather than waiting for next launch.
      posthogClient = new PostHog(POSTHOG_API_KEY, { host: POSTHOG_HOST, disableGeoip: true });
      telemetryEnabled = true;
      refreshIdentitySuperProperties();
      trackEvent('telemetry_toggled', { enabled: true, source: toggleSource });
      console.log('Telemetry re-enabled');
    } else if (!enabled && posthogClient) {
      // Capture the opt-out BEFORE closing the gate -- flipping the flag or
      // shutting down first would make this trackEvent call a silent no-op.
      trackEvent('telemetry_toggled', { enabled: false, source: toggleSource });
      telemetryEnabled = false;
      await shutdownTelemetry(); // flushes the event above, then closes
      console.log('Telemetry disabled');
    } else {
      telemetryEnabled = enabled;
    }

    // Extract JSON from output
    const jsonMatch = result.match(/\{.*\}/s);
    if (jsonMatch) {
      const jsonData = JSON.parse(jsonMatch[0]);
      return jsonData;
    }

    return { success: true, telemetry_enabled: enabled };
  } catch (error) {
    sendDebugLog(`Error setting telemetry: ${error.message}`);
    return { success: false, error: error.message };
  }
});

// Hide dock icon IPC handlers
ipcMain.handle('get-dock-icon', async () => {
  try {
    const result = await runPythonScript('simple_recorder.py', ['get-dock-icon']);
    const jsonData = JSON.parse(result);

    return {
      success: true,
      ...jsonData
    };
  } catch (error) {
    sendDebugLog(`Error getting dock icon settings: ${error.message}`);
    return { success: false, error: error.message };
  }
});

ipcMain.handle('set-dock-icon', async (event, hidden) => {
  try {
    sendDebugLog(`Setting hide dock icon to: ${hidden}`);
    const result = await runPythonScript('simple_recorder.py', ['set-dock-icon', hidden ? 'True' : 'False']);

    // Apply immediately
    if (process.platform === 'darwin' && app.dock) {
      if (hidden) {
        app.dock.hide();
      } else {
        app.dock.show();
      }
    }

    // Extract JSON from output
    const jsonMatch = result.match(/\{.*\}/s);
    if (jsonMatch) {
      const jsonData = JSON.parse(jsonMatch[0]);
      return jsonData;
    }

    return { success: true, hide_dock_icon: hidden };
  } catch (error) {
    sendDebugLog(`Error setting dock icon: ${error.message}`);
    return { success: false, error: error.message };
  }
});

ipcMain.handle('get-menu-bar-icon', async () => {
  try {
    const result = await runPythonScript('simple_recorder.py', ['get-menu-bar-icon']);
    const jsonData = JSON.parse(result);

    return {
      success: true,
      ...jsonData
    };
  } catch (error) {
    sendDebugLog(`Error getting menu bar icon settings: ${error.message}`);
    return { success: false, error: error.message };
  }
});

ipcMain.handle('set-menu-bar-icon', async (event, enabled) => {
  try {
    sendDebugLog(`Setting show menu bar icon to: ${enabled}`);
    const result = await runPythonScript('simple_recorder.py', ['set-menu-bar-icon', enabled ? 'True' : 'False']);

    // Extract JSON from output
    const jsonMatch = result.match(/\{.*\}/s);
    const jsonData = jsonMatch
      ? JSON.parse(jsonMatch[0])
      : { success: true, show_menu_bar_icon: enabled };

    // Apply immediately — create or destroy the live Tray instance — but
    // only once the preference actually persisted. Otherwise a failed save
    // (e.g. a disk/permission error) would still flip the live tray, leaving
    // it out of sync with both the on-disk config and the {success:false}
    // this handler returns to the UI. No process.platform gate here (unlike
    // dock icon): Electron's Tray API is cross-platform (macOS menu bar /
    // Windows system tray) and createTray() itself has no platform branch.
    if (jsonData.success && !IS_E2E) {
      if (enabled) {
        if (!tray) {
          createTray();
          // createTray() always builds the idle icon — sync it to the
          // actual recording state immediately, since this can now run
          // mid-recording (unlike the startup-only call), not just when
          // the app launches with nothing recording yet.
          updateTrayIcon(currentRecordingProcess !== null || systemAudioRecordingActive);
        }
      } else if (tray) {
        tray.destroy();
        tray = null;
      }
    }

    return jsonData;
  } catch (error) {
    sendDebugLog(`Error setting menu bar icon: ${error.message}`);
    return { success: false, error: error.message };
  }
});

// System audio capture IPC handlers
ipcMain.handle('get-auto-detect-meetings', async () => {
  try {
    const result = await runPythonScript('simple_recorder.py', ['get-auto-detect-meetings'], true);
    const jsonData = JSON.parse(result);
    return { success: true, ...jsonData };
  } catch (error) {
    sendDebugLog(`Error getting auto-detect setting: ${error.message}`);
    return { success: false, error: error.message };
  }
});

ipcMain.handle('set-auto-detect-meetings', async (_event, enabled) => {
  try {
    sendDebugLog(`Setting auto-detect to: ${enabled}`);
    const result = await runPythonScript('simple_recorder.py', ['set-auto-detect-meetings', enabled ? 'True' : 'False']);
    const jsonMatch = result.match(/\{.*\}/s);
    const parsed = jsonMatch ? JSON.parse(jsonMatch[0]) : { success: true, auto_detect_meetings_enabled: enabled };
    // Apply the change live — spin the mic-monitor up or kill it without
    // making the user restart. Mirror all the same gates as
    // setupAutoMeetingDetector(): E2E mode and dev-without-env-var both
    // skip the spawn so toggling the setting during tests / dev work
    // doesn't accidentally start the watcher.
    if (parsed.success) {
      if (enabled) {
        if (IS_E2E) {
          sendDebugLog('[auto-detect] E2E mode; setting saved but watcher not started');
        } else if (!app.isPackaged && !process.env[AUTO_DETECT_ENV]) {
          sendDebugLog(`[auto-detect] dev mode without ${AUTO_DETECT_ENV}=1; setting saved but watcher not started`);
        } else if (!isAutoDetectSupported()) {
          sendDebugLog('[auto-detect] requires macOS 14 (Sonoma) or later; setting saved but watcher not started');
        } else {
          startMicMonitor();
        }
      } else {
        stopMicMonitor();
      }
    }
    return parsed;
  } catch (error) {
    sendDebugLog(`Error setting auto-detect: ${error.message}`);
    return { success: false, error: error.message };
  }
});

ipcMain.handle('get-premeeting-notifications', handleGetPremeetingNotifications);

ipcMain.handle('set-premeeting-notifications', async (_event, enabled) => {
  try {
    sendDebugLog(`Setting pre-meeting notifications to: ${enabled}`);
    const result = await runPythonScript('simple_recorder.py', ['set-premeeting-notifications', enabled ? 'True' : 'False']);
    const jsonMatch = result.match(/\{.*\}/s);
    const jsonData = jsonMatch
      ? JSON.parse(jsonMatch[0])
      : { success: true, premeeting_notifications_enabled: enabled };

    // Re-arm live instead of waiting for the next periodic re-poll
    // (PREMEETING_RESCHEDULE_MS, 10 minutes): schedulePreMeetingNotifications
    // skips events already inside the lead window ("don't backfire"), so a
    // meeting that starts soon after the user re-enables this toggle could
    // otherwise silently miss its reminder for up to 10 minutes. Same E2E
    // gate as startPreMeetingScheduler() — a spec drives the fire path
    // directly via the show-premeeting-notification test seam, not this
    // live scheduler.
    if (jsonData.success && !IS_E2E) {
      void schedulePreMeetingNotifications();
    }

    return jsonData;
  } catch (error) {
    sendDebugLog(`Error setting pre-meeting notifications: ${error.message}`);
    return { success: false, error: error.message };
  }
});

ipcMain.handle('get-launch-on-login', async () => {
  try {
    const result = await runPythonScript('simple_recorder.py', ['get-launch-on-login'], true);
    const jsonData = JSON.parse(result);
    return { success: true, ...jsonData };
  } catch (error) {
    sendDebugLog(`Error getting launch-on-login setting: ${error.message}`);
    return { success: false, error: error.message };
  }
});

ipcMain.handle('set-launch-on-login', async (_event, enabled) => {
  try {
    sendDebugLog(`Setting launch-on-login to: ${enabled}`);
    const result = await runPythonScript('simple_recorder.py', ['set-launch-on-login', enabled ? 'True' : 'False']);
    const jsonMatch = result.match(/\{.*\}/s);
    const parsed = jsonMatch ? JSON.parse(jsonMatch[0]) : { success: true, launch_on_login: enabled };
    if (parsed.success) {
      // Apply the OS login item live so the user doesn't need to restart, and
      // re-identify so the launch_on_login super-property reflects the change.
      applyLoginItemSetting(enabled);
      refreshIdentitySuperProperties();
    }
    return parsed;
  } catch (error) {
    sendDebugLog(`Error setting launch-on-login: ${error.message}`);
    return { success: false, error: error.message };
  }
});

// Language IPC handlers
// AI Provider IPC handlers

// One-time forward-migration of an app-managed credential from its pre-fix
// hardcoded location. Before the getUserDataDir() path fix, the cloud key and
// calendar tokens were written to a hardcoded ~/Library/Application Support
// literal — correct on macOS (so this is a NO-OP there: legacy === current), but
// a bogus dir on Windows. If a user configured cloud/calendar on an older Windows
// build, copy that file forward to the current path so they don't have to
// re-enter. safeStorage/DPAPI is user-scoped (not path-scoped), so the copied
// ciphertext still decrypts. Best-effort + non-destructive (copy, leave legacy).
//
// HARD GUARD: never run under the STENOAI_USER_DATA_DIR e2e override — otherwise
// a test would pull the dev's REAL ~/Library credential into the temp dir.
function migrateLegacyCredentialFile(currentPath, filename) {
  if (process.env.STENOAI_USER_DATA_DIR) return;
  if (fs.existsSync(currentPath)) return;
  const legacy = path.join(os.homedir(), 'Library', 'Application Support', 'stenoai', filename);
  if (legacy === currentPath || !fs.existsSync(legacy)) return;
  try {
    fs.mkdirSync(path.dirname(currentPath), { recursive: true });
    fs.copyFileSync(legacy, currentPath);
    console.log(`Migrated ${filename} forward from the legacy path`);
  } catch (e) {
    console.error(`Legacy ${filename} migration failed (best-effort):`, e.message);
  }
}

function getCloudKeyPath() {
  // Use getUserDataDir() like every other app-managed file (.org-session,
  // .pre-adapter-provider, config.json). The old hardcoded
  // ~/Library/Application Support literal was macOS-only (wrong dir on Windows)
  // and ignored the STENOAI_USER_DATA_DIR e2e override, so the encrypted cloud
  // key escaped test isolation into the real user dir. On real macOS this
  // resolves to the identical path, so existing keys are unaffected.
  return path.join(getUserDataDir(), '.cloud-api-key');
}

function saveCloudApiKey(key) {
  try {
    const keyDir = path.dirname(getCloudKeyPath());
    if (!fs.existsSync(keyDir)) {
      fs.mkdirSync(keyDir, { recursive: true });
    }
    const encrypted = getSafeStorage().encryptString(key);
    fs.writeFileSync(getCloudKeyPath(), encrypted);
    return true;
  } catch (error) {
    console.error('Failed to save cloud API key:', error.message);
    return false;
  }
}

function loadCloudApiKey() {
  try {
    const keyPath = getCloudKeyPath();
    migrateLegacyCredentialFile(keyPath, '.cloud-api-key');
    if (!fs.existsSync(keyPath)) return null;
    const encrypted = fs.readFileSync(keyPath);
    return getSafeStorage().decryptString(encrypted);
  } catch (error) {
    console.error('Failed to load cloud API key:', error.message);
    return null;
  }
}

function hasCloudApiKey() {
  return fs.existsSync(getCloudKeyPath());
}

// Build the env additions a Python AI-driven subprocess needs. Merges
// the encrypted-on-disk cloud key (decrypted only here, never written
// to the env if absent) AND the org adapter URL+JWT when a session
// exists. Either or both may be empty — the Python summariser picks
// the right path based on the configured ai_provider, and we just
// surface whatever's available.
function getAiEnv() {
  const env = {};
  const cloudKey = loadCloudApiKey();
  if (cloudKey) env.STENOAI_CLOUD_API_KEY = cloudKey;
  const session = loadOrgSession();
  if (session && session.adapterUrl && session.token && !isJwtExpired(session.token)) {
    env.STENOAI_ADAPTER_URL = session.adapterUrl;
    env.STENOAI_ADAPTER_TOKEN = session.token;
  }
  return env;
}

// Read the Python-side ai_provider config so we can react to it on sign-in
// / sign-out events. Returns 'local' on any error so an unreadable config
// can't accidentally keep us in 'adapter' mode after logout.
async function readAiProvider() {
  try {
    const raw = await runPythonScript('simple_recorder.py', ['get-ai-provider'], true);
    const data = JSON.parse(raw.trim());
    return typeof data.ai_provider === 'string' ? data.ai_provider : 'local';
  } catch (e) {
    sendDebugLog(`readAiProvider failed, treating as 'local': ${e.message}`);
    return 'local';
  }
}

// Tiny on-disk marker so the auto-switch can remember which provider
// the user was on before we flipped them to 'adapter'. Restored on
// sign-out so a user previously on 'cloud' goes back to 'cloud' rather
// than getting silently downgraded to 'local'. Cleared whenever the
// user manually picks a non-adapter provider — at that point there's
// no longer a stale value to restore to.
function getPreAdapterProviderPath() {
  return path.join(getUserDataDir(), '.pre-adapter-provider');
}

function loadPreAdapterProvider() {
  try {
    const p = getPreAdapterProviderPath();
    if (!fs.existsSync(p)) return null;
    const value = fs.readFileSync(p, 'utf8').trim();
    return value || null;
  } catch (_) {
    return null;
  }
}

function savePreAdapterProvider(provider) {
  try {
    const p = getPreAdapterProviderPath();
    if (!fs.existsSync(path.dirname(p))) fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, String(provider || ''));
  } catch (e) {
    sendDebugLog(`savePreAdapterProvider failed: ${e.message}`);
  }
}

function clearPreAdapterProvider() {
  try {
    const p = getPreAdapterProviderPath();
    if (fs.existsSync(p)) fs.unlinkSync(p);
  } catch (_) {}
}

// Bidirectional reconciliation between the org session and the Python-side
// ai_provider. Hard-lock policy: while a valid org session exists the
// provider must be 'adapter' — the adapter brokers AI for org users
// (zero-config was the customer ask), and any drift (a wiped config.json,
// a hand edit, a CLI call) self-heals on the next check. The reverse
// direction keeps the old stale-adapter recovery: config says 'adapter'
// but the session file is genuinely gone → restore the remembered
// pre-adapter provider so the next AI call doesn't die with "adapter not
// configured".
//
// A safeStorage decrypt failure (locked keychain right after wake, denied
// prompt) is transient and changes NOTHING — acting on it is how signed-in
// users used to end up silently summarising on local llama. Expired-but-
// present sessions are also left alone here: expiry is owned by org-status
// and adapterFetch's 401 path (clear session + restore provider), and
// acting on it from two places would race.
//
// Serialized, not merely coalesced: every provider-state mutation (this
// reconcile AND the sign-out restore) runs through one queue, so a sign-out's
// restore can never interleave with an in-flight reconcile's write — the
// race that could strand ai_provider='adapter' with no session, or clobber
// the restore marker. Late callers get a FRESH run that starts after the
// previous one finishes, so a sign-in that lands while a pre-sign-in run is
// in flight still gets post-sign-in truth.
let providerStateQueue = Promise.resolve();
function enqueueProviderStateOp(op) {
  const run = providerStateQueue.then(op);
  // Keep the chain alive whether the op resolves or rejects.
  providerStateQueue = run.then(() => undefined, () => undefined);
  return run;
}

// Bumped whenever the org session file changes (save or clear) so a queued
// reconcile can detect that the session it read mid-run is no longer
// current and abort its write instead of acting on stale state.
let orgSessionGeneration = 0;

// Start of the current decrypt-failure streak (null while reads succeed or
// no session file exists). Distinguishes a transiently locked keychain
// (seconds-to-minutes after boot/wake) from a session that will never
// decrypt again (corrupt file, lost keychain entry after an OS reinstall) —
// the org-lock gate fails closed only inside this grace window, so a
// permanently unreadable session can't lock the user out of provider
// changes forever.
let orgSessionDecryptFailingSince = null;
const DECRYPT_FAILURE_GRACE_MS = 10 * 60 * 1000;

// Memo of the last reconcile that confirmed session/provider consistency.
// org-status is refetched on focus/mount by the sidebar; without this every
// refetch would spawn a Python subprocess (~100-300ms PyInstaller startup)
// for a no-op check. The memoed fast path returns null ("nothing to
// change") so callers never patch their response from a possibly-stale memo.
let lastConsistentCheck = { generation: -1, at: 0 };
const RECONCILE_CONSISTENT_TTL_MS = 30_000;

function reconcileAiProviderWithOrgSession(opts = {}) {
  const { knownProvider } = opts;
  const memoFresh = () =>
    lastConsistentCheck.generation === orgSessionGeneration &&
    Date.now() - lastConsistentCheck.at < RECONCILE_CONSISTENT_TTL_MS;
  let bypassMemo = false;
  if (memoFresh()) {
    if (knownProvider === undefined) return Promise.resolve(null);
    // The caller just read the provider from disk (get-ai-provider passes
    // its own response in). Cross-check it against the session file — a
    // sync read, no subprocess — so external drift inside the memo's TTL
    // (terminal CLI call, hand-edited config) is caught immediately
    // instead of after the memo expires.
    const { exists, decryptFailed } = loadOrgSessionEx();
    const consistent = decryptFailed
      ? true // transient — never act on it
      : exists
        ? knownProvider === 'adapter'
        : knownProvider !== 'adapter';
    if (consistent) return Promise.resolve(null);
    bypassMemo = true;
  }
  return enqueueProviderStateOp(async () => {
    // Re-check the memo now that we actually run: a burst of callers with a
    // cold memo enqueues several runs, and by the time the later ones
    // execute, the first has already confirmed consistency — skip their
    // subprocess spawns instead of repeating the full check serially.
    // Skipped when this run was enqueued BECAUSE of a memo-contradicting
    // drift observation — that drift still needs repairing.
    if (!bypassMemo && memoFresh()) {
      return null;
    }
    const genAtRead = orgSessionGeneration;
    const { session, exists, decryptFailed } = loadOrgSessionEx();
    if (decryptFailed) return null; // transient — never act on it
    const current = await readAiProvider();
    const sessionValid = Boolean(
      session && session.adapterUrl && session.token && !isJwtExpired(session.token)
    );
    if (sessionValid && current !== 'adapter') {
      if (orgSessionGeneration !== genAtRead) {
        sendDebugLog('Org lock: session changed mid-reconcile; aborting relock');
        return null;
      }
      // Seed the restore marker only when none exists: in a drift repair
      // `current` may be a wiped-to-default 'local' while the marker still
      // holds the user's true pre-sign-in choice (e.g. 'cloud').
      const hadMarker = loadPreAdapterProvider() !== null;
      if (!hadMarker) savePreAdapterProvider(current);
      sendDebugLog(`Org lock: switching ai_provider from ${current} to adapter (org session active)`);
      try {
        const out = await runPythonScript('simple_recorder.py', ['set-ai-provider', 'adapter']);
        // The CLI prints {"success": false} with exit 0 on a failed config
        // save — surface that as a failure too, not just spawn errors.
        const jsonMatch = out.match(/\{.*\}/s);
        if (jsonMatch && JSON.parse(jsonMatch[0]).success === false) {
          throw new Error('set-ai-provider reported a failed config save');
        }
      } catch (e) {
        sendDebugLog(`Org lock: switch to adapter failed: ${e.message}`);
        // Don't leave a marker WE created if the switch never landed; a
        // pre-existing marker stays — it still describes the user's choice.
        if (!hadMarker) clearPreAdapterProvider();
        return await readAiProvider();
      }
      const settled = await readAiProvider();
      if (orgSessionGeneration === genAtRead && settled === 'adapter') {
        lastConsistentCheck = { generation: orgSessionGeneration, at: Date.now() };
      }
      return settled;
    }
    if (!exists && current === 'adapter') {
      if (orgSessionGeneration !== genAtRead) return null;
      sendDebugLog('Org lock: ai_provider=adapter but no org session backing it; restoring pre-adapter provider');
      // Direct call, not the queued wrapper — we already hold the queue.
      await doRestorePreAdapterProvider();
      return await readAiProvider();
    }
    if (orgSessionGeneration === genAtRead) {
      lastConsistentCheck = { generation: orgSessionGeneration, at: Date.now() };
    }
    return current;
  });
}

// Wired into the org sign-in flows (password + Google SSO). Kept as a named
// wrapper so the call sites read as intent; the reconcile does the work.
async function autoSwitchToAdapterOnSignIn() {
  await reconcileAiProviderWithOrgSession();
}

// On sign-out (or stale-session clear), restore the pre-adapter provider
// if we still have it. Falls back to 'local' if the marker is missing
// (e.g. user manually switched to adapter without coming via auto-switch).
// Serialized on the same queue as the reconcile so the two state machines
// can't interleave; doRestorePreAdapterProvider is the unqueued body, used
// by the reconcile when it already holds the queue.
function restorePreAdapterProvider() {
  return enqueueProviderStateOp(doRestorePreAdapterProvider);
}

async function doRestorePreAdapterProvider() {
  lastConsistentCheck = { generation: -1, at: 0 }; // state is changing
  const current = await readAiProvider();
  if (current !== 'adapter') {
    clearPreAdapterProvider(); // tidy: if not on adapter, the marker is stale
    return;
  }
  const restored = loadPreAdapterProvider() || 'local';
  sendDebugLog(`Org sign-out: restoring ai_provider from adapter to ${restored}`);
  let restoreLanded = true;
  try {
    const out = await runPythonScript('simple_recorder.py', ['set-ai-provider', restored]);
    // The CLI prints {"success": false} with exit 0 on a failed config
    // save — treat that as a failure, same as the relock path does.
    const jsonMatch = out.match(/\{.*\}/s);
    if (jsonMatch && JSON.parse(jsonMatch[0]).success === false) {
      throw new Error('set-ai-provider reported a failed config save');
    }
  } catch (e) {
    restoreLanded = false;
    sendDebugLog(`restore to ${restored} failed: ${e.message}`);
  }
  // Keep the marker when the restore didn't land — it's the only record
  // of the user's pre-adapter choice, and a later retry needs it.
  if (restoreLanded) clearPreAdapterProvider();
}

ipcMain.handle('get-ai-provider', async () => {
  try {
    const result = await runPythonScript('simple_recorder.py', ['get-ai-provider'], true);
    const jsonData = JSON.parse(result.trim());
    // Override cloud_api_key_set with safeStorage check
    jsonData.cloud_api_key_set = hasCloudApiKey();

    // Reconcile the provider with org-session reality before answering, so
    // the renderer's first paint already reflects a working provider:
    //  - valid session but provider drifted (wiped config, hand edit, CLI
    //    call) → relock to 'adapter' (hard-lock policy)
    //  - provider says 'adapter' but the session file is gone (manually
    //    deleted, crashed mid-sign-out) → restore the pre-adapter provider
    // Decrypt failures (locked keychain) deliberately change nothing. The
    // reconcile re-reads the provider from disk after any write, so the
    // patched response never diverges from what Python persisted.
    try {
      // knownProvider lets the reconcile detect drift even inside its
      // consistency-memo window — this handler already paid for a fresh
      // disk read, so the cross-check costs nothing.
      const reconciled = await reconcileAiProviderWithOrgSession({
        knownProvider: jsonData.ai_provider,
      });
      if (reconciled && reconciled !== jsonData.ai_provider) {
        jsonData.ai_provider = reconciled;
      }
    } catch (e) {
      sendDebugLog(`AI provider reconcile failed: ${e.message}`);
      // Return the unreconciled value — pre-fix behaviour, not a regression.
    }

    return { success: true, ...jsonData };
  } catch (error) {
    sendDebugLog(`Error getting AI provider: ${error.message}`);
    return { success: false, error: error.message };
  }
});

ipcMain.handle('set-ai-provider', async (event, provider) => {
  try {
    sendDebugLog(`Setting AI provider to: ${provider}`);
    // Queued so a manual write can't interleave with an in-flight
    // reconcile or sign-out restore (last-writer-wins races on the same
    // config value); the org-lock gate is evaluated inside the op so it
    // sees post-queue session state.
    const result = await enqueueProviderStateOp(async () => {
      if (provider !== 'adapter') {
        // Hard lock: while a valid org session exists the provider is
        // managed by the organisation. The Settings picker is disabled
        // too — this backstops any other IPC caller and future UI paths,
        // and it leaves the restore marker untouched. Fail closed on a
        // decrypt failure (locked keychain): the user IS signed in, the
        // session is just transiently unreadable, and letting the switch
        // through would have the next reconcile fight them.
        const { session, decryptFailed } = loadOrgSessionEx();
        const sessionValid = Boolean(
          session && session.adapterUrl && session.token && !isJwtExpired(session.token)
        );
        // Fail closed on decrypt failure only inside the grace window — a
        // streak that has lasted longer than a keychain-unlock plausibly
        // can means the session will never decrypt again, and rejecting
        // forever would dead-end the user.
        const decryptRecentlyFailed =
          decryptFailed &&
          orgSessionDecryptFailingSince !== null &&
          Date.now() - orgSessionDecryptFailingSince < DECRYPT_FAILURE_GRACE_MS;
        if (decryptFailed && !decryptRecentlyFailed) {
          sendDebugLog(`Org lock: allowing set-ai-provider ${provider} — session unreadable for >${DECRYPT_FAILURE_GRACE_MS / 60000}min, treating as dead`);
        }
        if (sessionValid || decryptRecentlyFailed) {
          sendDebugLog(`Org lock: rejecting set-ai-provider ${provider} (${decryptFailed ? 'session unreadable' : 'org session active'})`);
          return {
            success: false,
            managedByOrg: true,
            error: 'AI provider is managed by your organisation while you are signed in.',
          };
        }
        // A manual switch away from 'adapter' invalidates the pre-adapter
        // marker — without this, a user who auto-switched on sign-in and
        // then manually moved to a different provider would still be
        // restored to the stale "before adapter" value on sign-out.
        clearPreAdapterProvider();
      }
      // Provider state is changing under the memo's feet.
      lastConsistentCheck = { generation: -1, at: 0 };
      const result = await runPythonScript('simple_recorder.py', ['set-ai-provider', provider]);
      const jsonMatch = result.match(/\{.*\}/s);
      if (jsonMatch) return JSON.parse(jsonMatch[0]);
      return { success: true, ai_provider: provider };
    });
    if (result && result.success !== false) refreshIdentitySuperProperties();
    return result;
  } catch (error) {
    sendDebugLog(`Error setting AI provider: ${error.message}`);
    return { success: false, error: error.message };
  }
});

ipcMain.handle('set-remote-ollama-url', async (event, url) => {
  try {
    const result = await runPythonScript('simple_recorder.py', ['set-remote-ollama-url', url]);
    const jsonMatch = result.match(/\{.*\}/s);
    if (jsonMatch) return JSON.parse(jsonMatch[0]);
    return { success: true };
  } catch (error) {
    return { success: false, error: error.message };
  }
});

ipcMain.handle('set-cloud-api-url', async (event, url) => {
  try {
    const result = await runPythonScript('simple_recorder.py', ['set-cloud-api-url', url]);
    const jsonMatch = result.match(/\{.*\}/s);
    if (jsonMatch) return JSON.parse(jsonMatch[0]);
    return { success: true };
  } catch (error) {
    return { success: false, error: error.message };
  }
});

ipcMain.handle('set-cloud-api-key', async (event, key) => {
  try {
    const saved = saveCloudApiKey(key);
    if (saved) {
      trackEvent(key ? 'ai_key_added' : 'ai_key_removed');
    }
    return { success: saved, cloud_api_key_set: saved };
  } catch (error) {
    return { success: false, error: error.message };
  }
});

ipcMain.handle('set-cloud-provider', async (event, provider) => {
  try {
    const result = await runPythonScript('simple_recorder.py', ['set-cloud-provider', provider]);
    const jsonMatch = result.match(/\{.*\}/s);
    if (jsonMatch) return JSON.parse(jsonMatch[0]);
    return { success: true };
  } catch (error) {
    return { success: false, error: error.message };
  }
});

ipcMain.handle('set-cloud-model', async (event, model) => {
  try {
    const result = await runPythonScript('simple_recorder.py', ['set-cloud-model', model]);
    const jsonMatch = result.match(/\{.*\}/s);
    if (jsonMatch) return JSON.parse(jsonMatch[0]);
    return { success: true };
  } catch (error) {
    return { success: false, error: error.message };
  }
});

ipcMain.handle('set-bedrock-region', async (event, region) => {
  try {
    const result = await runPythonScript('simple_recorder.py', ['set-bedrock-region', region]);
    const jsonMatch = result.match(/\{.*\}/s);
    if (jsonMatch) return JSON.parse(jsonMatch[0]);
    return { success: true };
  } catch (error) {
    return { success: false, error: error.message };
  }
});

ipcMain.handle('set-bedrock-inference-profile', async (event, profile) => {
  try {
    // Click's required=False + default='' lets us clear the field by passing
    // the empty string; pass through as a single positional arg.
    const result = await runPythonScript(
      'simple_recorder.py',
      ['set-bedrock-inference-profile', profile || ''],
    );
    const jsonMatch = result.match(/\{.*\}/s);
    if (jsonMatch) return JSON.parse(jsonMatch[0]);
    return { success: true };
  } catch (error) {
    return { success: false, error: error.message };
  }
});

ipcMain.handle('test-remote-ollama', async (event, url) => {
  try {
    sendDebugLog(`Testing remote Ollama at: ${url}`);
    const result = await runPythonScript('simple_recorder.py', ['test-remote-ollama', url]);
    const jsonMatch = result.match(/\{.*\}/s);
    if (jsonMatch) return JSON.parse(jsonMatch[0]);
    return { success: false, error: 'No response' };
  } catch (error) {
    sendDebugLog(`Remote Ollama test failed: ${error.message}`);
    return { success: false, error: error.message };
  }
});

ipcMain.handle('test-cloud-api', async () => {
  try {
    sendDebugLog('Testing cloud API connection...');
    const apiKey = loadCloudApiKey();
    const env = apiKey ? { STENOAI_CLOUD_API_KEY: apiKey } : {};
    const result = await runPythonScript('simple_recorder.py', ['test-cloud-api'], false, env);
    const jsonMatch = result.match(/\{.*\}/s);
    if (jsonMatch) return JSON.parse(jsonMatch[0]);
    return { success: false, error: 'No response' };
  } catch (error) {
    sendDebugLog(`Cloud API test failed: ${error.message}`);
    return { success: false, error: error.message };
  }
});

ipcMain.handle('get-recordings-dir', async () => {
  try {
    // Get recordings directory from Python config
    const result = await runPythonScript('simple_recorder.py', ['get-storage-path'], true);
    const jsonData = JSON.parse(result.trim());

    let recordingsDir;
    if (jsonData.storage_path && !process.env.STENOAI_USER_DATA_DIR) {
      recordingsDir = path.join(jsonData.storage_path, 'recordings');
    } else {
      // getUserDataDir() resolves the per-OS data dir when packaged (Windows
      // %APPDATA%; identical on macOS) AND honors STENOAI_USER_DATA_DIR (the
      // e2e temp dir). The old hardcoded REPO/recordings dev branch disagreed
      // with the frozen backend (which writes under ~/Library even in dev),
      // breaking import-collision dedup in `npm start` (#233). The override
      // guard mirrors get_data_dirs() precedence (config.py): e2e isolation
      // beats custom storage. Mirrors resolveRecordingsDir().
      recordingsDir = path.join(getUserDataDir(), 'recordings');
    }

    // Ensure directory exists
    if (!fs.existsSync(recordingsDir)) {
      fs.mkdirSync(recordingsDir, { recursive: true });
    }

    return { success: true, path: recordingsDir };
  } catch (error) {
    sendDebugLog(`Error getting recordings dir: ${error.message}`);
    return { success: false, error: error.message };
  }
});

// Renderer-driven system audio capture streams its WebM/Opus blob into the
// same recordings/ folder the mic path uses, written INCREMENTALLY as each
// MediaRecorder timeslice arrives rather than buffered in renderer memory
// until stop. A crash / force-quit then leaves a valid WebM prefix on disk
// (the container is streamable, so ffmpeg decodes a truncated file) instead
// of losing the whole recording. Keeping both capture paths in one folder
// means `keep_recordings` semantics + cleanup are symmetric, and users have
// a single canonical place to find saved audio.
//
// Only one recording is active at a time (the renderer serialises starts via
// activeRef/startTokenRef), so the open file is keyed on a single module-level
// WriteStream rather than threading a handle through every IPC. open() also
// reclaims a stream left over from an abnormal prior teardown (renderer reload
// mid-capture) so a stale fd can't outlive its recording.
let activeSysAudioWriteStream = null;
let activeSysAudioFilePath = null;
let activeSysAudioBytesWritten = 0;
// Deterministic summary-file path for the current recording, derived from the
// audio filename at open. Kept separate from activeSysAudioFilePath (which the
// renderer's close nulls) so stop-recording-ui can still write the instant-stop
// placeholder even if close raced ahead. Reset at the next open.
let activeSysAudioSummaryFile = null;

ipcMain.handle('open-system-audio-file', async (_event, sessionName) => {
  try {
    // Reclaim a stream left open by a prior recording that never cleanly
    // stopped (e.g. a renderer reload mid-capture). End (flush) it and leave
    // its partial file on disk under recordings/ — abandoned rather than
    // processed, since no clean stop handed it to the queue.
    if (activeSysAudioWriteStream) {
      sendDebugLog(`[sysaudio] abandoning unclosed prior recording ${path.basename(activeSysAudioFilePath || '')}`);
      try { activeSysAudioWriteStream.end(); } catch (_) { /* already ended */ }
      activeSysAudioWriteStream = null;
      activeSysAudioFilePath = null;
      activeSysAudioSummaryFile = null;
    }
    const dir = resolveRecordingsDir();
    const safeName = String(sessionName || 'Note').replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 64);
    const filename = `sysaudio-${Date.now()}-${safeName}.webm`;
    const filePath = path.join(dir, filename);
    const stream = fs.createWriteStream(filePath);
    // Attach an 'error' listener at creation time. A WriteStream that emits
    // 'error' with no listener re-throws as an uncaught exception and would
    // crash the main process (and the in-progress recording) — e.g. on ENOSPC
    // mid-write. Instead, log and drop the stream so subsequent append/close
    // report a clean failure rather than taking the app down.
    stream.on('error', (err) => {
      sendDebugLog(`[sysaudio] write stream error: ${err.message}`);
      if (activeSysAudioWriteStream === stream) {
        activeSysAudioWriteStream = null;
        activeSysAudioFilePath = null;
        activeSysAudioBytesWritten = 0;
      }
    });
    activeSysAudioWriteStream = stream;
    activeSysAudioFilePath = filePath;
    activeSysAudioSummaryFile = summaryFileForAudio(filePath);
    activeSysAudioBytesWritten = 0;
    sendDebugLog(`[sysaudio] opened ${filename} for incremental write`);
    return { success: true, filePath };
  } catch (error) {
    sendDebugLog(`Error opening system audio file: ${error.message}`);
    return { success: false, error: error.message };
  }
});

ipcMain.handle('append-system-audio-chunk', async (_event, payload) => {
  try {
    if (!activeSysAudioWriteStream) {
      return { success: false, error: 'No open system audio file' };
    }
    const buf = Buffer.isBuffer(payload) ? payload : Buffer.from(payload);
    // Await the write callback so a disk-write failure (ENOSPC, EIO) is
    // reported as a failed append rather than acked as success — the renderer
    // checks this envelope to know the on-disk file is truncated. Ordering is
    // preserved because the renderer chains its appends (each awaits the prior
    // round-trip) and the WriteStream is FIFO.
    const stream = activeSysAudioWriteStream;
    await new Promise((resolve, reject) => {
      stream.write(buf, (err) => (err ? reject(err) : resolve()));
    });
    // Only credit the byte count if this is still the active stream — a
    // concurrent open() could have rotated it during the await, and crediting
    // a rotated-in recording with this chunk's size would corrupt its
    // empty-file accounting. If rotated, the write landed on an abandoned
    // stream, so report failure rather than a false success.
    if (activeSysAudioWriteStream !== stream) {
      return { success: false, error: 'Recording rotated during write' };
    }
    activeSysAudioBytesWritten += buf.length;
    return { success: true };
  } catch (error) {
    sendDebugLog(`Error appending system audio chunk: ${error.message}`);
    return { success: false, error: error.message };
  }
});

ipcMain.handle('close-system-audio-file', async () => {
  const stream = activeSysAudioWriteStream;
  const filePath = activeSysAudioFilePath;
  const bytesWritten = activeSysAudioBytesWritten;
  activeSysAudioWriteStream = null;
  activeSysAudioFilePath = null;
  activeSysAudioBytesWritten = 0;
  if (!stream) {
    return { success: false, error: 'No open system audio file' };
  }
  try {
    await new Promise((resolve, reject) => {
      stream.on('error', reject);
      stream.end(resolve);
    });
    // A zero-byte file means no audio was captured (immediate stop, or a
    // failed start that still opened the file). Remove it rather than queue an
    // empty recording or leave a stray .webm, and report no usable file.
    if (bytesWritten === 0) {
      try { fs.unlinkSync(filePath); } catch (_) { /* */ }
      sendDebugLog(`[sysaudio] closed empty recording, removed ${path.basename(filePath)}`);
      return { success: false, error: 'Empty recording (no audio captured)' };
    }
    sendDebugLog(`[sysaudio] closed ${path.basename(filePath)} (${bytesWritten} bytes)`);
    return { success: true, filePath };
  } catch (error) {
    sendDebugLog(`Error closing system audio file: ${error.message}`);
    return { success: false, error: error.message };
  }
});

// A failed renderer-side capture (mic permission denied, no audio device)
// would otherwise be silent — the optimistic "recording" pill is dropped via
// system-audio-recording-state, but the user gets no reason. Surface a native
// notification so a failed start is visible. Not gated on the notifications
// toggle: that governs routine note-ready/silence notices, whereas this is an
// error the user needs to see to know their recording didn't start.
function showRecordingFailedNotification(body) {
  try {
    if (!Notification.isSupported()) return;
    new Notification({
      title: 'Steno',
      body: body || "Recording couldn't start.",
      iconType: 'alert',
    }).show();
  } catch (error) {
    console.error('Failed to show recording-failed notification:', error.message);
  }
}

ipcMain.on('recording-capture-error', (_event, message) => {
  sendDebugLog(`[sysaudio] capture error: ${message}`);
  showRecordingFailedNotification(
    message ? `Recording couldn't start: ${message}` : "Recording couldn't start.",
  );
});

ipcMain.handle('process-system-audio-recording', async (event, audioFilePath, sessionName) => {
  try {
    sendDebugLog(`Queuing system audio recording for processing: ${audioFilePath}`);

    // Validate file path
    const allowedBaseDirs = getAllowedBaseDirs();
    if (!validateSafeFilePath(audioFilePath, allowedBaseDirs)) {
      return { success: false, error: 'Invalid file path' };
    }

    if (!fs.existsSync(audioFilePath)) {
      return { success: false, error: 'Audio file not found' };
    }

    const actualSessionName = sessionName || 'Note';

    // Draft notes are keyed by session NAME (`{name}_notes.txt`), so back-to-
    // back recordings with the default name 'Note' all share one file. If it
    // isn't consumed-and-cleared, the NEXT same-named recording (that typed no
    // notes) inherits the previous meeting's notes — a real, persisted leak
    // (surfaced by the My notes tab). Snapshot it to a per-job temp (mirrors
    // the live-transcript snapshot) and DELETE the shared draft, so each job
    // owns its notes and the draft can't leak forward. The temp is cleaned up
    // in the queue's finally.
    const notesFile = userNotesFilePath(getOutputDir(), actualSessionName);
    let notesPath;
    if (fs.existsSync(notesFile)) {
      try {
        const draft = fs.readFileSync(notesFile, 'utf-8');
        fs.unlinkSync(notesFile);
        if (draft.trim()) {
          notesPath = path.join(
            os.tmpdir(),
            `stenoai-notes-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.txt`,
          );
          fs.writeFileSync(notesPath, draft, 'utf-8');
        }
      } catch (e) {
        sendDebugLog(`[notes] failed to snapshot draft notes: ${e.message}`);
      }
    }

    // Snapshot the live transcript captured during this recording (#207) so the
    // backend can fall back to it if the batch transcription comes back empty.
    // Done here at stop time, before liveTranscriptState gets reset by the next
    // recording.
    const liveTranscriptFile = await snapshotLiveTranscriptForFallback(actualSessionName);

    // Consume the continue-recording target (set at start-recording-ui) so
    // this segment is appended to its note; cleared so the next recording
    // starts clean.
    const appendTo = currentRecordingAppendTarget;
    currentRecordingAppendTarget = null;

    // Instant stop: the note the pipeline will write to. For an append it's the
    // existing note; for a new Parakeet recording it's the deterministic
    // placeholder path (stop-recording-ui already wrote the placeholder there).
    // Whisper/import leave it undefined → the summary stream stays anonymous and
    // is consumed by the Processing dock, not routed to a note's StreamingView.
    const engine = loadTranscriptionEngine();
    const jobSummaryFile = appendTo
      ? appendTo
      : isLiveTranscriptionEngine(engine)
        ? summaryFileForAudio(audioFilePath)
        : undefined;

    // Use the existing processing queue to avoid concurrent Ollama/Whisper runs
    addToProcessingQueue(audioFilePath, actualSessionName, notesPath, liveTranscriptFile, appendTo, jobSummaryFile);

    // recording_stopped is NOT tracked here -- stop-recording-ui already
    // fires it (with the real duration_bucket) for every stop. This handler
    // fires moments later, once the renderer's MediaRecorder finishes
    // flushing to disk and useSystemAudioCapture's own effect reacts to the
    // status change and calls processSystemAudio -- for every normal
    // recording that would double the count. `recording_mode: 'system_audio'`
    // was also vestigial: this renderer-driven path is the only recording
    // path today, so it no longer distinguishes anything.
    return { success: true, message: 'Added to processing queue' };
  } catch (error) {
    sendDebugLog(`Error queuing system audio: ${error.message}`);
    trackEvent('error_occurred', { error_type: 'process_system_audio', reason: classifyErrorReason(error) });
    return { success: false, error: error.message };
  }
});

// Track system audio recording state for tray icon. Also resets the elapsed
// counter when the renderer reports inactive without a Python process —
// covers the case where startCapture failed (permission denied) and we'd
// otherwise leak recordingRuntimeState.startedAtMs.
ipcMain.on('system-audio-recording-state', (event, isRecording) => {
  sendDebugLog(`[sysaudio] state -> ${isRecording ? 'true' : 'false'} (was ${systemAudioRecordingActive})`);
  systemAudioRecordingActive = isRecording;
  applyRecordingBackgroundThrottling();
  if (!isRecording && !currentRecordingProcess) {
    // Reset the elapsed counter (avoids leaking startedAtMs when startCapture
    // fails), but DON'T blank currentRecordingSessionName here: this is a
    // transient capture-state report, and a brief renderer-capture flap
    // (fail→recover) would otherwise drop the "which meeting is live" label
    // mid-recording. The name is authoritatively cleared on real stop
    // (stop-recording-ui); a stale name while hasRecording is false is inert.
    resetRecordingRuntimeState();
  }
  updateTrayIcon(isRecording);
  updateTrayMenu();
});

// Tracks in-flight pull-model downloads (model -> last progress string) so a
// renderer that remounts (e.g. navigating away from Settings and back) can
// ask "is anything still downloading?" instead of only finding out via
// events it wasn't subscribed to receive while unmounted. The download
// itself lives in this main process regardless of what the renderer is
// doing, so this map is the source of truth for "is it still going".
const activePulls = new Map();

// Tracks a pull's terminal outcome (model -> {success, error}) after it
// leaves activePulls, so a renderer that was unmounted for the whole
// download (missed the live model-pull-progress/model-pull-complete events
// entirely) can still discover on remount that it finished, rather than
// silently going back to "not started". A client clears its own entry via
// 'ack-pull-complete' once it has acted on it (see useSwitchToFasterBuild).
const completedPulls = new Map();

// The live ChildProcess per in-flight pull, so 'cancel-pull' can kill the
// right one. Deliberately NOT exposed via get-active-pulls -- a ChildProcess
// handle isn't IPC-serializable, and nothing outside this handler needs it.
const activeProcs = new Map();

// Models whose pull was explicitly cancelled, so the close handler below
// can report "Cancelled" instead of a confusing "exited with code null".
const cancelledPulls = new Set();

ipcMain.handle('pull-model', async (event, modelName) => {
  // Guards against a duplicate pull of the SAME model racing in (e.g. a
  // double-click before React re-renders the button as disabled) -- without
  // this, two subprocesses would run concurrently and the first one's close
  // handler would delete activePulls' entry out from under the second.
  if (activePulls.has(modelName)) {
    return { success: false, error: `A pull for ${modelName} is already in progress.` };
  }
  try {
    sendDebugLog(`Pulling model: ${modelName}`);
    sendDebugLog('This may take several minutes...');
    activePulls.set(modelName, '');

    return new Promise((resolve) => {
      const proc = spawn(getBackendPath(), ['pull-model', modelName], {
        cwd: getBackendCwd()
      });
      activeProcs.set(modelName, proc);

      let lastStdoutLine = '';

      // Ollama's own pull-progress stream can emit dozens of updates per
      // second on a large download (multi-GB models like the NVFP4/MLX
      // builds) — forwarding every single one drove the renderer's model
      // list to re-render faster than the compositor could keep up,
      // visible as window flicker/tearing. Throttling to 5/sec keeps the
      // UI smooth without making the progress text feel laggy.
      let lastProgressSentAt = 0;
      const PROGRESS_THROTTLE_MS = 200;
      const sendProgress = (output) => {
        activePulls.set(modelName, output);
        if (!mainWindow || mainWindow.isDestroyed()) return;
        const now = Date.now();
        if (now - lastProgressSentAt < PROGRESS_THROTTLE_MS) return;
        lastProgressSentAt = now;
        mainWindow.webContents.send('model-pull-progress', {
          model: modelName,
          progress: output
        });
      };

      proc.stdout.on('data', (data) => {
        const output = data.toString().trim();
        sendDebugLog(output);
        if (output) lastStdoutLine = output;
        sendProgress(output);
      });

      proc.stderr.on('data', (data) => {
        const output = data.toString().trim();
        sendDebugLog(output);
        sendProgress(output);
      });

      proc.on('close', (code, signal) => {
        activePulls.delete(modelName);
        activeProcs.delete(modelName);

        // Only trust this as a real cancellation if the process was
        // actually signal-killed. If cancel-pull's kill() arrived after the
        // process had already finished on its own (a narrow but real race:
        // proc.kill() is a no-op on an already-exited process, but the
        // 'close' event for that natural exit hasn't been delivered yet),
        // `signal` is null here -- treat it as its real outcome below
        // instead of reporting a successful pull as cancelled.
        if (cancelledPulls.delete(modelName) && signal) {
          sendDebugLog(`Cancelled pull: ${modelName}`);
          completedPulls.set(modelName, { success: false, error: 'Cancelled', cancelled: true });

          if (mainWindow && !mainWindow.isDestroyed()) {
            mainWindow.webContents.send('model-pull-complete', {
              model: modelName,
              success: false,
              error: 'Cancelled',
              cancelled: true
            });
          }

          resolve({ success: false, error: 'Cancelled', cancelled: true });
          return;
        }

        // The backend prints a JSON result as the last stdout line.
        // Check it even on exit code 0, since the Python CLI may
        // catch errors and still exit cleanly.
        let pullResult = null;
        try { pullResult = JSON.parse(lastStdoutLine); } catch (_) {}

        const succeeded = code === 0 && (!pullResult || pullResult.success !== false);

        if (succeeded) {
          sendDebugLog(`Successfully pulled model: ${modelName}`);
          completedPulls.set(modelName, { success: true });

          if (mainWindow && !mainWindow.isDestroyed()) {
            mainWindow.webContents.send('model-pull-complete', {
              model: modelName,
              success: true
            });
          }

          resolve({ success: true, model: modelName });
        } else {
          const errorMsg = (pullResult && pullResult.error) || `Process exited with code ${code}`;
          sendDebugLog(`Failed to pull model: ${modelName} - ${errorMsg}`);
          completedPulls.set(modelName, { success: false, error: errorMsg });

          if (mainWindow && !mainWindow.isDestroyed()) {
            mainWindow.webContents.send('model-pull-complete', {
              model: modelName,
              success: false,
              error: errorMsg
            });
          }

          resolve({ success: false, error: errorMsg });
        }
      });

      proc.on('error', (error) => {
        activePulls.delete(modelName);
        activeProcs.delete(modelName);
        cancelledPulls.delete(modelName);
        sendDebugLog(`Error pulling model: ${error.message}`);
        completedPulls.set(modelName, { success: false, error: error.message });

        if (mainWindow && !mainWindow.isDestroyed()) {
          mainWindow.webContents.send('model-pull-complete', {
            model: modelName,
            success: false,
            error: error.message
          });
        }

        resolve({ success: false, error: error.message });
      });
    });
  } catch (error) {
    activePulls.delete(modelName);
    activeProcs.delete(modelName);
    cancelledPulls.delete(modelName);
    sendDebugLog(`Error in pull-model handler: ${error.message}`);
    return { success: false, error: error.message };
  }
});

ipcMain.handle('cancel-pull', (event, modelName) => {
  const proc = activeProcs.get(modelName);
  if (!proc) {
    return { success: false, error: 'No active pull for this model.' };
  }
  cancelledPulls.add(modelName);
  proc.kill();
  return { success: true, error: null };
});

ipcMain.handle('get-active-pulls', () => {
  const result = {};
  for (const [model, progress] of activePulls) {
    result[model] = { progress, done: false };
  }
  for (const [model, outcome] of completedPulls) {
    result[model] = { done: true, ...outcome };
  }
  return result;
});

// Lets a renderer that consumed a completedPulls entry (via getActivePulls
// on remount, or the live model-pull-complete listener) tell main it's been
// handled, so a later remount doesn't replay an already-resolved outcome.
ipcMain.on('ack-pull-complete', (event, modelName) => {
  completedPulls.delete(modelName);
});

// Helper to build env vars for running the bundled Ollama binary directly.
// Mirrors src/ollama_manager.get_ollama_env() so the dylib/DLL search path
// is set correctly per-OS.
function getOllamaEnv() {
  let ollamaDir;
  if (app.isPackaged) {
    ollamaDir = path.join(process.resourcesPath, 'stenoai', '_internal', 'ollama');
  } else {
    ollamaDir = path.join(__dirname, '..', 'bin');
  }
  const env = { ...process.env };
  if (process.platform === 'darwin') {
    const existing = env.DYLD_LIBRARY_PATH || '';
    env.DYLD_LIBRARY_PATH = existing ? `${ollamaDir}:${existing}` : ollamaDir;
    // Do NOT set MLX_METAL_PATH: Ollama (v0.31.1+) ships its Metal library
    // under versioned subdirectories (mlx_metal_v3/, mlx_metal_v4/) selected
    // by its own internal GPU-family detection, not a flat
    // <ollamaDir>/mlx.metallib file. Pointing this at the old flat path
    // (stale since Ollama moved to the versioned layout) makes it point at
    // a file that no longer exists. Leaving it unset matches how a
    // standalone (non-bundled) Ollama install behaves.
  } else if (process.platform === 'win32') {
    const existing = env.PATH || '';
    env.PATH = existing ? `${ollamaDir};${existing}` : ollamaDir;
  } else {
    const existing = env.LD_LIBRARY_PATH || '';
    env.LD_LIBRARY_PATH = existing ? `${ollamaDir}:${existing}` : ollamaDir;
  }
  return env;
}

// Helper function to find Ollama executable (bundled only)
async function findOllamaExecutable() {
  const exe = process.platform === 'win32' ? 'ollama.exe' : 'ollama';
  let bundledOllamaPath;
  if (app.isPackaged) {
    // Production: bundled inside PyInstaller _internal directory
    bundledOllamaPath = path.join(process.resourcesPath, 'stenoai', '_internal', 'ollama', exe);
  } else {
    // Development: in project bin/ directory
    bundledOllamaPath = path.join(__dirname, '..', 'bin', exe);
  }

  if (fs.existsSync(bundledOllamaPath)) {
    console.log(`Using bundled Ollama: ${bundledOllamaPath}`);
    return bundledOllamaPath;
  }

  console.error(`Bundled Ollama not found at: ${bundledOllamaPath}`);
  return null;
}

// Where the manual "Check for updates" reads the latest release from. Kept as a
// named constant so the repo path has a single source of truth (and is the one
// line to change if the repo is renamed/transferred — though the redirect
// following below means an old build keeps working through GitHub's 301 too).
const UPDATE_CHECK_URL = 'https://api.github.com/repos/stenolabs/stenoai/releases/latest';

// Update checking functionality. Follows HTTP redirects (301/302/307/308):
// GitHub's REST API returns a 301 to the new owner/repo path when a repo is
// renamed or transferred, and Node's https.request does NOT follow redirects on
// its own — so without this, a transfer would silently break the manual update
// check for every already-installed app.
async function checkForUpdates() {
  const MAX_REDIRECTS = 5;
  // One 10s budget shared across the whole redirect chain, so a slow chain of
  // hops can't keep the check hanging for redirects × 10s (each hop used to
  // reset its own timeout).
  const deadline = Date.now() + 10000;

  function fetchLatest(urlStr, redirectsLeft) {
    return new Promise((resolve) => {
      let url;
      try {
        url = new URL(urlStr);
      } catch (e) {
        resolve({ success: false, error: 'Invalid update URL' });
        return;
      }
      const options = {
        hostname: url.hostname,
        path: url.pathname + url.search,
        method: 'GET',
        headers: { 'User-Agent': 'Steno-Updater' },
      };

      const req = https.request(options, (res) => {
        // Follow a redirect (repo rename/transfer → 301 to the new path).
        if ([301, 302, 307, 308].includes(res.statusCode) && res.headers.location) {
          res.resume(); // drain the response so the socket can be reused/freed
          if (redirectsLeft <= 0) {
            resolve({ success: false, error: 'Too many redirects' });
            return;
          }
          // location may be relative; resolve it against the current URL. A
          // malformed Location would make new URL() throw synchronously inside
          // this callback (crashing the main process), so guard it and fail the
          // check normally instead.
          let next;
          try {
            next = new URL(res.headers.location, urlStr).toString();
          } catch (e) {
            resolve({ success: false, error: 'Invalid redirect URL' });
            return;
          }
          resolve(fetchLatest(next, redirectsLeft - 1));
          return;
        }

        let data = '';
        res.on('data', (chunk) => {
          data += chunk;
        });

        res.on('end', () => {
          try {
            const release = JSON.parse(data);
            const latestVersion = release.tag_name.replace(/^v/, ''); // Remove 'v' prefix if present

            // Get current version from package.json
            const packagePath = path.join(__dirname, 'package.json');
            const packageContent = JSON.parse(fs.readFileSync(packagePath, 'utf8'));
            const currentVersion = packageContent.version;

            console.log(`Current version: ${currentVersion}, Latest version: ${latestVersion}`);

            // Simple version comparison (works for semantic versioning)
            const isUpdateAvailable = compareVersions(currentVersion, latestVersion) < 0;

            resolve({
              success: true,
              updateAvailable: isUpdateAvailable,
              currentVersion: currentVersion,
              latestVersion: latestVersion,
              releaseUrl: release.html_url,
              releaseName: release.name || `Version ${latestVersion}`,
              downloadUrl: getDownloadUrl(release.assets)
            });
          } catch (error) {
            console.error('Error parsing GitHub API response:', error);
            resolve({ success: false, error: 'Failed to parse update data' });
          }
        });
      });

      req.on('error', (error) => {
        console.error('Error checking for updates:', error);
        resolve({ success: false, error: error.message });
      });

      // Share the single deadline across all hops (min 1ms so an already-expired
      // budget still fires promptly rather than being treated as "no timeout").
      req.setTimeout(Math.max(1, deadline - Date.now()), () => {
        req.destroy();
        resolve({ success: false, error: 'Update check timeout' });
      });

      req.end();
    });
  }

  return fetchLatest(UPDATE_CHECK_URL, MAX_REDIRECTS);
}

function compareVersions(current, latest) {
  const currentParts = current.split('.').map(Number);
  const latestParts = latest.split('.').map(Number);

  for (let i = 0; i < Math.max(currentParts.length, latestParts.length); i++) {
    const currentPart = currentParts[i] || 0;
    const latestPart = latestParts[i] || 0;

    if (currentPart < latestPart) return -1;
    if (currentPart > latestPart) return 1;
  }

  return 0;
}

function getDownloadUrl(assets) {
  // Find the appropriate download URL based on platform/architecture
  const platform = process.platform;
  const arch = process.arch;

  if (platform === 'darwin') {
    // Look for macOS DMG files
    const armAsset = assets.find(asset =>
      asset.name.includes('arm64') && asset.name.includes('dmg')
    );
    const intelAsset = assets.find(asset =>
      asset.name.includes('x64') && asset.name.includes('dmg')
    );

    // Prefer ARM64 for Apple Silicon, fallback to Intel
    if (arch === 'arm64' && armAsset) return armAsset.browser_download_url;
    if (intelAsset) return intelAsset.browser_download_url;
    if (armAsset) return armAsset.browser_download_url;
  }

  // Fallback to first asset or releases page
  return assets.length > 0 ? assets[0].browser_download_url : null;
}

ipcMain.handle('check-for-updates', async () => {
  const result = await checkForUpdates();
  const osEligible = autoUpdateOSEligible();
  // The GitHub comparison above is a read-only display poll — it never
  // itself starts a download. Kick the real autoUpdater check alongside it
  // so a manual "Check for Updates" click actually starts a background
  // download when one's available, instead of only reporting the latest
  // tag and waiting for the next scheduled interval. Same guards as
  // setupAutoUpdater(): no-op (and network-free) in e2e/dev, and never on a
  // Mac below the launch floor, which must not download a build it can't run (#432).
  if (!IS_E2E && app.isPackaged && osEligible) {
    autoUpdater.checkForUpdates().catch(() => {});
  }
  // A check that just succeeded and found nothing settles an earlier FAILED
  // check — otherwise a stale banner sits under a fresh "You're on the latest
  // version", two contradictory answers to one question. Cleared here, in the
  // state the About tab rehydrates from, so it stays cleared across a remount
  // rather than only until the user switches tabs.
  //
  // Only non-sticky errors: this poll is our own GitHub request, so it says
  // nothing about whether the updater can write to /Applications or whether
  // this build has an update feed at all. Those conditions are still true and
  // stay on screen (see update-error-copy.js).
  if (result.success && !result.updateAvailable && !pendingUpdateErrorSticky) {
    pendingUpdateError = null;
  }
  // Surface eligibility so the About tab can explain why an "update available"
  // won't auto-install on an under-floor Mac, rather than offering a broken
  // Restart. (Display-only; the safety is the gated kick above.)
  return { ...result, osUpdateEligible: osEligible };
});

// Lets a freshly-(re)mounted About tab recover "an update already
// downloaded" state — the 'update-downloaded' IPC event only reaches a
// listener that's mounted at the exact moment it fires; this is the seam
// for everyone else.
ipcMain.handle('get-update-status', async () => {
  return {
    success: true,
    downloadedVersion: pendingUpdateVersion,
    downloadPercent: pendingDownloadPercent,
    downloadError: pendingUpdateError,
  };
});

ipcMain.handle('open-release-page', async (event, url) => {
  try {
    if (typeof url !== 'string' || !url) {
      return { success: false, error: 'invalid url' };
    }
    let parsed;
    try { parsed = new URL(url); } catch {
      return { success: false, error: 'invalid url' };
    }
    // Release pages live on github.com -- restrict to that origin so a
    // compromised renderer cannot launch arbitrary external URLs through
    // this channel.
    if (parsed.protocol !== 'https:' || parsed.hostname !== 'github.com') {
      return { success: false, error: 'unsupported url' };
    }
    await shell.openExternal(url);
    return { success: true };
  } catch (error) {
    return { success: false, error: error.message };
  }
});

// Generic external-URL opener for renderer-triggered links (e.g. meeting
// join URLs on Home). Http/https only — rejects custom schemes so a
// compromised renderer cannot launch arbitrary protocol handlers.
ipcMain.handle('open-external', async (event, url) => {
  try {
    if (typeof url !== 'string' || !url) {
      return { success: false, error: 'invalid url' };
    }
    let parsed;
    try { parsed = new URL(url); } catch {
      return { success: false, error: 'invalid url' };
    }
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      return { success: false, error: 'unsupported scheme' };
    }
    await shell.openExternal(url);
    return { success: true };
  } catch (error) {
    return { success: false, error: error.message };
  }
});
// Decodes the payload of a JWT (e.g. an OAuth id_token) without verifying
// its signature — safe here because the token came straight from the
// provider's own token endpoint over TLS, not from an untrusted party.
// Used only to read the `email`/`preferred_username` claim; best-effort,
// callers must not let a decode failure block the OAuth flow.
function decodeJwtPayload(jwt) {
  const payload = jwt.split('.')[1];
  return JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
}

// ── Google Calendar: Token Storage ──────────────────────────────────────

function getTokenFilePath() {
  // getUserDataDir() like every other app-managed file — the old hardcoded
  // ~/Library/Application Support literal was macOS-only (wrong dir on Windows)
  // and ignored the STENOAI_USER_DATA_DIR e2e override. Resolves identically on
  // real macOS, so existing tokens are unaffected.
  return path.join(getUserDataDir(), '.google-tokens');
}

function saveGoogleTokens(tokens) {
  try {
    const tokenDir = path.dirname(getTokenFilePath());
    if (!fs.existsSync(tokenDir)) {
      fs.mkdirSync(tokenDir, { recursive: true });
    }
    const encrypted = getSafeStorage().encryptString(JSON.stringify(tokens));
    fs.writeFileSync(getTokenFilePath(), encrypted);
    console.log('Google tokens saved');
  } catch (error) {
    console.error('Failed to save Google tokens:', error.message);
  }
}

function loadGoogleTokens() {
  try {
    const tokenPath = getTokenFilePath();
    migrateLegacyCredentialFile(tokenPath, '.google-tokens');
    if (!fs.existsSync(tokenPath)) return null;
    const encrypted = fs.readFileSync(tokenPath);
    const decrypted = getSafeStorage().decryptString(encrypted);
    return JSON.parse(decrypted);
  } catch (error) {
    console.error('Failed to load Google tokens:', error.message);
    return null;
  }
}

function deleteGoogleTokens() {
  try {
    const tokenPath = getTokenFilePath();
    if (fs.existsSync(tokenPath)) {
      fs.unlinkSync(tokenPath);
      console.log('Google tokens deleted');
    }
  } catch (error) {
    console.error('Failed to delete Google tokens:', error.message);
  }
}

// ── Outlook Calendar: Token Storage ─────────────────────────────────────

function getOutlookTokenFilePath() {
  // See getTokenFilePath — route through getUserDataDir() for cross-platform +
  // e2e isolation; identical path on real macOS.
  return path.join(getUserDataDir(), '.outlook-tokens');
}

function saveOutlookTokens(tokens) {
  try {
    const tokenDir = path.dirname(getOutlookTokenFilePath());
    if (!fs.existsSync(tokenDir)) {
      fs.mkdirSync(tokenDir, { recursive: true });
    }
    const encrypted = getSafeStorage().encryptString(JSON.stringify(tokens));
    fs.writeFileSync(getOutlookTokenFilePath(), encrypted);
    console.log('Outlook tokens saved');
  } catch (error) {
    console.error('Failed to save Outlook tokens:', error.message);
  }
}

function loadOutlookTokens() {
  try {
    const tokenPath = getOutlookTokenFilePath();
    migrateLegacyCredentialFile(tokenPath, '.outlook-tokens');
    if (!fs.existsSync(tokenPath)) return null;
    const encrypted = fs.readFileSync(tokenPath);
    const decrypted = getSafeStorage().decryptString(encrypted);
    return JSON.parse(decrypted);
  } catch (error) {
    console.error('Failed to load Outlook tokens:', error.message);
    return null;
  }
}

function deleteOutlookTokens() {
  try {
    const tokenPath = getOutlookTokenFilePath();
    if (fs.existsSync(tokenPath)) {
      fs.unlinkSync(tokenPath);
      console.log('Outlook tokens deleted');
    }
  } catch (error) {
    console.error('Failed to delete Outlook tokens:', error.message);
  }
}

// ── Google Calendar: OAuth2 Flow with PKCE ──────────────────────────────

// Tracks an in-flight OAuth handshake so `google-auth-cancel` can close
// the loopback server and reject the pending promise — otherwise the
// user is stuck on "Connecting…" until the timeout fires.
let activeGoogleAuth = null;

function cancelActiveGoogleAuth() {
  if (!activeGoogleAuth) return false;
  const handle = activeGoogleAuth;
  activeGoogleAuth = null;
  if (handle.timeoutId) clearTimeout(handle.timeoutId);
  // Flip the closure flag first so an in-flight token exchange knows to
  // throw away its result instead of saving tokens.
  if (handle.markCancelled) handle.markCancelled();
  try { handle.server.close(); } catch (_) {}
  handle.reject(new Error('Cancelled'));
  return true;
}

function startGoogleAuth() {
  return new Promise((resolve, reject) => {
    // If a previous click is still pending, abort it before starting a
    // new flow — keeps state from desyncing if the user double-clicks.
    cancelActiveGoogleAuth();

    // Generate PKCE code verifier and challenge
    const codeVerifier = crypto.randomBytes(32).toString('base64url');
    const codeChallenge = crypto.createHash('sha256').update(codeVerifier).digest('base64url');
    const state = crypto.randomBytes(16).toString('hex');
    let timeoutId = null;
    let isCancelled = false;
    const clearActive = () => {
      if (activeGoogleAuth && activeGoogleAuth.server === server) {
        activeGoogleAuth = null;
      }
    };

    // Start temporary HTTP server on loopback for OAuth redirect
    const server = http.createServer(async (req, res) => {
      try {
        const reqUrl = new URL(req.url, `http://127.0.0.1`);
        if (!reqUrl.pathname.startsWith('/callback')) {
          res.writeHead(404);
          res.end();
          return;
        }

        const code = reqUrl.searchParams.get('code');
        const error = reqUrl.searchParams.get('error');
        const returnedState = reqUrl.searchParams.get('state');

        if (returnedState !== state) {
          res.writeHead(400, { 'Content-Type': 'text/html' });
          res.end('<html><body><h2>Invalid state parameter</h2><p>Possible CSRF attack. Please try again.</p></body></html>');
          return;
        }

        if (error) {
          res.writeHead(200, { 'Content-Type': 'text/html' });
          res.end('<html><body><h2>Authorization denied</h2><p>You can close this tab.</p></body></html>');
          server.close();
          if (timeoutId) clearTimeout(timeoutId);
          clearActive();
          reject(new Error(`Auth denied: ${error}`));
          return;
        }

        if (!code) {
          res.writeHead(400, { 'Content-Type': 'text/html' });
          res.end('<html><body><h2>Missing authorization code</h2></body></html>');
          return;
        }

        // Exchange code for tokens
        const port = server.address().port;
        const tokens = await exchangeCodeForTokens(code, codeVerifier, port);
        // The user may have cancelled while we were waiting on Google's
        // /token endpoint. Discard the tokens rather than silently
        // persist them — otherwise the next calendar poll would surface
        // a "ghost" connection seconds after the user said "Cancel".
        // Still respond to the open browser tab so it doesn't spin
        // forever — the request only ends when we write a body.
        if (isCancelled) {
          res.writeHead(200, { 'Content-Type': 'text/html' });
          res.end('<html><body style="font-family: -apple-system, sans-serif; text-align: center; padding: 60px;"><h2>Cancelled</h2><p>You can close this tab.</p></body></html>');
          return;
        }
        if (tokens.id_token) {
          try {
            const claims = decodeJwtPayload(tokens.id_token);
            if (claims && claims.email) tokens.email = claims.email;
          } catch (e) {
            console.error('Failed to decode Google id_token:', e.message);
          }
        }
        saveGoogleTokens(tokens);

        res.writeHead(200, { 'Content-Type': 'text/html' });
        res.end('<html><body style="font-family: -apple-system, sans-serif; text-align: center; padding: 60px;"><h2>Connected to Google Calendar</h2><p>You can close this tab and return to Steno.</p></body></html>');

        server.close();
        if (timeoutId) clearTimeout(timeoutId);
        clearActive();

        // Notify renderer and bring app to foreground
        if (mainWindow && !mainWindow.isDestroyed()) {
          mainWindow.webContents.send('google-auth-changed');
          exposeMainWindow();
        }

        resolve({ success: true });
      } catch (err) {
        res.writeHead(500, { 'Content-Type': 'text/html' });
        res.end('<html><body><h2>Authentication failed</h2><p>Please try again.</p></body></html>');
        server.close();
        if (timeoutId) clearTimeout(timeoutId);
        clearActive();
        reject(err);
      }
    });

    // Listen on loopback only (security: not 0.0.0.0)
    server.listen(0, '127.0.0.1', () => {
      const port = server.address().port;
      const redirectUri = `http://127.0.0.1:${port}/callback`;

      const authParams = new URLSearchParams({
        client_id: GOOGLE_CLIENT_ID,
        redirect_uri: redirectUri,
        response_type: 'code',
        scope: GOOGLE_SCOPES,
        access_type: 'offline',
        prompt: 'consent',
        state: state,
        code_challenge: codeChallenge,
        code_challenge_method: 'S256'
      });

      const authUrl = `${GOOGLE_AUTH_URL}?${authParams.toString()}`;
      shell.openExternal(authUrl);
    });

    // 60s, not 5min. A real Google OAuth flow (consent + maybe MFA)
    // completes in seconds. The old 5-minute ceiling left users staring
    // at "Connecting…" for 5 full minutes if they closed the browser tab
    // — the inline Cancel button in the nudge mitigates this, but the
    // tighter ceiling is the safety net for users who walk away. The
    // org-SSO flow elsewhere in this file is a different beast and keeps
    // its own (longer) timeout.
    timeoutId = setTimeout(() => {
      if (server.listening) {
        // Set the closure flag BEFORE close+clear+reject so an in-flight
        // request handler (mid-await on exchangeCodeForTokens) sees the
        // cancellation when it resumes and discards the tokens instead
        // of writing them to disk. Without this, a race between Google's
        // /token response and our 60 s timeout produces a "ghost"
        // connection seconds after the user was told it timed out.
        isCancelled = true;
        server.close();
        clearActive();
        reject(new Error('Timed out — no response from Google.'));
      }
    }, 60 * 1000);
    activeGoogleAuth = {
      server,
      reject,
      timeoutId,
      markCancelled: () => { isCancelled = true; },
    };
  });
}

function exchangeCodeForTokens(code, codeVerifier, port) {
  return new Promise((resolve, reject) => {
    const redirectUri = `http://127.0.0.1:${port}/callback`;
    const postData = new URLSearchParams({
      code,
      client_id: GOOGLE_CLIENT_ID,
      client_secret: GOOGLE_CLIENT_SECRET,
      redirect_uri: redirectUri,
      grant_type: 'authorization_code',
      code_verifier: codeVerifier
    }).toString();

    const options = {
      hostname: 'oauth2.googleapis.com',
      path: '/token',
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'Content-Length': Buffer.byteLength(postData)
      }
    };

    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => {
        try {
          const parsed = JSON.parse(data);
          if (parsed.error) {
            reject(new Error(`Token exchange failed: ${parsed.error_description || parsed.error}`));
            return;
          }
          // Store expiry as absolute timestamp
          parsed.expires_at = Date.now() + (parsed.expires_in * 1000);
          resolve(parsed);
        } catch (err) {
          reject(new Error('Failed to parse token response'));
        }
      });
    });

    req.on('error', reject);
    req.write(postData);
    req.end();
  });
}

// ── Google Calendar: Token Refresh ──────────────────────────────────────

async function getValidAccessToken() {
  const tokens = loadGoogleTokens();
  if (!tokens) return null;

  // Check if token is expired or about to expire (5-min buffer)
  const bufferMs = 5 * 60 * 1000;
  if (tokens.expires_at && Date.now() < tokens.expires_at - bufferMs) {
    return tokens.access_token;
  }

  // Token expired, try to refresh
  if (!tokens.refresh_token) {
    deleteGoogleTokens();
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('google-auth-changed');
    }
    return null;
  }

  try {
    const newTokens = await refreshAccessToken(tokens.refresh_token);
    // Preserve the refresh token (Google may not return it again)
    newTokens.refresh_token = newTokens.refresh_token || tokens.refresh_token;
    newTokens.expires_at = Date.now() + (newTokens.expires_in * 1000);
    // Preserve the email captured at connect time — a refresh response
    // doesn't reliably carry a fresh id_token, and even if it did, a
    // refresh grant can't upgrade a pre-existing connection to scopes it
    // wasn't originally consented to.
    newTokens.email = newTokens.email || tokens.email;
    saveGoogleTokens(newTokens);
    return newTokens.access_token;
  } catch (error) {
    console.error('Token refresh failed:', error.message);
    if (error.message && (error.message.includes('invalid_grant') || error.message.includes('Token has been expired or revoked'))) {
      deleteGoogleTokens();
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('google-auth-changed');
      }
    }
    return null;
  }
}

function refreshAccessToken(refreshToken) {
  return new Promise((resolve, reject) => {
    const postData = new URLSearchParams({
      client_id: GOOGLE_CLIENT_ID,
      client_secret: GOOGLE_CLIENT_SECRET,
      refresh_token: refreshToken,
      grant_type: 'refresh_token'
    }).toString();

    const options = {
      hostname: 'oauth2.googleapis.com',
      path: '/token',
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'Content-Length': Buffer.byteLength(postData)
      }
    };

    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => {
        try {
          const parsed = JSON.parse(data);
          if (parsed.error) {
            reject(new Error(`Refresh failed: ${parsed.error_description || parsed.error}`));
            return;
          }
          resolve(parsed);
        } catch (err) {
          reject(new Error('Failed to parse refresh response'));
        }
      });
    });

    req.on('error', reject);
    req.write(postData);
    req.end();
  });
}

// ── Google Calendar: Fetch Events ───────────────────────────────────────

// 50 covers a busy week (~7/day) without bloating the response. The previous
// cap of 7 was set when the carousel showed top-3 today only — but a single
// all-day block + a few morning meetings would burn through the cap before
// noon, hiding everything past lunch. Renderer-side pagination + the "today
// only" filter handle the visual slicing; the fetch just needs to return
// enough raw events to draw from.
async function fetchGoogleCalendarList(accessToken, signal) {
  return new Promise((resolve, reject) => {
    const options = {
      hostname: 'www.googleapis.com',
      path: '/calendar/v3/users/me/calendarList',
      method: 'GET',
      headers: { 'Authorization': `Bearer ${accessToken}` }
    };
    if (signal) options.signal = signal;
    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => {
        try {
          const parsed = JSON.parse(data);
          if (parsed.error) {
            reject(new Error(`Calendar API error: ${parsed.error.message || parsed.error}`));
            return;
          }
          resolve(parsed.items || []);
        } catch (err) {
          reject(new Error('Failed to parse calendar list response'));
        }
      });
    });
    req.on('error', reject);
    req.end();
  });
}

function fetchGoogleEventsForCalendar(accessToken, calendarId, params, signal) {
  return new Promise((resolve, reject) => {
    const options = {
      hostname: 'www.googleapis.com',
      path: `/calendar/v3/calendars/${encodeURIComponent(calendarId)}/events?${params.toString()}`,
      method: 'GET',
      headers: { 'Authorization': `Bearer ${accessToken}` }
    };
    if (signal) options.signal = signal;
    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => {
        try {
          const parsed = JSON.parse(data);
          if (parsed.error) {
            resolve([]);
            return;
          }
          resolve(parsed.items || []);
        } catch (err) {
          console.warn(`Failed to parse Google events for calendar ${calendarId}:`, err);
          resolve([]);
        }
      });
    });
    req.on('error', () => resolve([]));
    req.end();
  });
}

async function fetchCalendarEvents(accessToken, maxResults = 50, signal) {
  const now = new Date();
  const weekAhead = new Date(now);
  weekAhead.setDate(weekAhead.getDate() + 7);
  const params = new URLSearchParams({
    timeMin: now.toISOString(),
    timeMax: weekAhead.toISOString(),
    maxResults: String(maxResults),
    singleEvents: 'true',
    orderBy: 'startTime',
    fields: 'items(id,status,summary,description,start,end,attendees,htmlLink,conferenceData,colorId)'
  });

  try {
    const calendars = await fetchGoogleCalendarList(accessToken, signal);
    const selectedCalendars = calendars.filter(c => c.selected);
    if (selectedCalendars.length === 0) return [];

    const results = [];
    const concurrency = 3;
    for (let i = 0; i < selectedCalendars.length; i += concurrency) {
      const chunk = selectedCalendars.slice(i, i + concurrency);
      const chunkPromises = chunk.map(async (cal) => {
        const items = await fetchGoogleEventsForCalendar(accessToken, cal.id, params, signal);
        items.forEach(item => { 
          item.calendarBackgroundColor = cal.backgroundColor; 
          item._sourceCalendarId = cal.id;
        });
        return items;
      });
      const chunkResults = await Promise.all(chunkPromises);
      results.push(...chunkResults);
    }
    let allEvents = results.flat();
    
    allEvents.sort((a, b) => {
      const startA = new Date(a.start?.dateTime || a.start?.date || 0);
      const startB = new Date(b.start?.dateTime || b.start?.date || 0);
      return startA.getTime() - startB.getTime();
    });

    return allEvents.slice(0, maxResults);
  } catch (err) {
    throw err;
  }
}

// ── Outlook Calendar: OAuth2 Flow with PKCE ─────────────────────────────

// Mirror of activeGoogleAuth — see comment there.
let activeOutlookAuth = null;

function cancelActiveOutlookAuth() {
  if (!activeOutlookAuth) return false;
  const handle = activeOutlookAuth;
  activeOutlookAuth = null;
  if (handle.timeoutId) clearTimeout(handle.timeoutId);
  if (handle.markCancelled) handle.markCancelled();
  try { handle.server.close(); } catch (_) {}
  handle.reject(new Error('Cancelled'));
  return true;
}

function startOutlookAuth() {
  return new Promise((resolve, reject) => {
    cancelActiveOutlookAuth();

    const codeVerifier = crypto.randomBytes(32).toString('base64url');
    const codeChallenge = crypto.createHash('sha256').update(codeVerifier).digest('base64url');
    const state = crypto.randomBytes(16).toString('hex');
    let timeoutId = null;
    let isCancelled = false;
    const clearActive = () => {
      if (activeOutlookAuth && activeOutlookAuth.server === server) {
        activeOutlookAuth = null;
      }
    };

    const server = http.createServer(async (req, res) => {
      try {
        const reqUrl = new URL(req.url, `http://localhost`);
        // Ignore favicon and other noise — only handle the root path
        if (reqUrl.pathname !== '/') {
          res.writeHead(404);
          res.end();
          return;
        }

        const code = reqUrl.searchParams.get('code');
        const error = reqUrl.searchParams.get('error');
        const returnedState = reqUrl.searchParams.get('state');

        if (returnedState !== state) {
          res.writeHead(400, { 'Content-Type': 'text/html' });
          res.end('<html><body><h2>Invalid state parameter</h2><p>Possible CSRF attack. Please try again.</p></body></html>');
          return;
        }

        if (error) {
          res.writeHead(200, { 'Content-Type': 'text/html' });
          res.end('<html><body><h2>Authorization denied</h2><p>You can close this tab.</p></body></html>');
          server.close();
          if (timeoutId) clearTimeout(timeoutId);
          clearActive();
          reject(new Error(`Auth denied: ${error}`));
          return;
        }

        if (!code) {
          res.writeHead(400, { 'Content-Type': 'text/html' });
          res.end('<html><body><h2>Missing authorization code</h2></body></html>');
          return;
        }

        const port = server.address().port;
        const tokens = await exchangeOutlookCodeForTokens(code, codeVerifier, port);
        // See the Google counterpart — discard tokens if the user
        // cancelled while we awaited Microsoft's /token endpoint, and
        // still send a response so the open browser tab doesn't hang.
        if (isCancelled) {
          res.writeHead(200, { 'Content-Type': 'text/html' });
          res.end('<html><body style="font-family: -apple-system, sans-serif; text-align: center; padding: 60px;"><h2>Cancelled</h2><p>You can close this tab.</p></body></html>');
          return;
        }
        if (tokens.id_token) {
          try {
            const claims = decodeJwtPayload(tokens.id_token);
            // Work/school accounts often have a null `email` claim but a
            // usable `preferred_username` (the UPN, which is email-shaped).
            const email = claims && (claims.email || claims.preferred_username);
            if (email) tokens.email = email;
          } catch (e) {
            console.error('Failed to decode Outlook id_token:', e.message);
          }
        }
        saveOutlookTokens(tokens);

        res.writeHead(200, { 'Content-Type': 'text/html' });
        res.end('<html><body style="font-family: -apple-system, sans-serif; text-align: center; padding: 60px;"><h2>Connected to Outlook Calendar</h2><p>You can close this tab and return to Steno.</p></body></html>');

        server.close();
        if (timeoutId) clearTimeout(timeoutId);
        clearActive();

        if (mainWindow && !mainWindow.isDestroyed()) {
          mainWindow.webContents.send('outlook-auth-changed');
          exposeMainWindow();
        }

        resolve({ success: true });
      } catch (err) {
        res.writeHead(500, { 'Content-Type': 'text/html' });
        res.end('<html><body><h2>Authentication failed</h2><p>Please try again.</p></body></html>');
        server.close();
        if (timeoutId) clearTimeout(timeoutId);
        clearActive();
        reject(err);
      }
    });

    server.listen(0, '127.0.0.1', () => {
      const port = server.address().port;
      // Use the literal IP we listen on. `localhost` resolves via the host
      // resolver, which a tampered /etc/hosts or local DNS could point
      // elsewhere — a low-but-not-zero risk for OAuth callback hijack on
      // shared dev machines. 127.0.0.1 bypasses name resolution entirely.
      const redirectUri = `http://127.0.0.1:${port}`;

      const authParams = new URLSearchParams({
        client_id: OUTLOOK_CLIENT_ID,
        redirect_uri: redirectUri,
        response_type: 'code',
        scope: OUTLOOK_SCOPES,
        response_mode: 'query',
        state: state,
        code_challenge: codeChallenge,
        code_challenge_method: 'S256'
      });

      const authUrl = `${OUTLOOK_AUTH_URL}?${authParams.toString()}`;
      shell.openExternal(authUrl);
    });

    // See the Google counterpart for the 60s-vs-5min rationale AND the
    // isCancelled-before-clearActive race fix.
    timeoutId = setTimeout(() => {
      if (server.listening) {
        isCancelled = true;
        server.close();
        clearActive();
        reject(new Error('Timed out — no response from Outlook.'));
      }
    }, 60 * 1000);
    activeOutlookAuth = {
      server,
      reject,
      timeoutId,
      markCancelled: () => { isCancelled = true; },
    };
  });
}

function exchangeOutlookCodeForTokens(code, codeVerifier, port) {
  return new Promise((resolve, reject) => {
    // Must match the redirect_uri used in startOutlookAuth's auth request.
    // See the comment there — bypass name resolution by using the IP literal.
    const redirectUri = `http://127.0.0.1:${port}`;
    const postData = new URLSearchParams({
      code,
      client_id: OUTLOOK_CLIENT_ID,
      redirect_uri: redirectUri,
      grant_type: 'authorization_code',
      code_verifier: codeVerifier
    }).toString();

    const tokenUrl = new URL(OUTLOOK_TOKEN_URL);
    const options = {
      hostname: tokenUrl.hostname,
      path: tokenUrl.pathname,
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'Content-Length': Buffer.byteLength(postData)
      }
    };

    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => {
        try {
          const parsed = JSON.parse(data);
          if (parsed.error) {
            reject(new Error(`Token exchange failed: ${parsed.error_description || parsed.error}`));
            return;
          }
          parsed.expires_at = Date.now() + (parsed.expires_in * 1000);
          resolve(parsed);
        } catch (err) {
          reject(new Error('Failed to parse token response'));
        }
      });
    });

    req.on('error', reject);
    req.write(postData);
    req.end();
  });
}

// ── Outlook Calendar: Token Refresh ─────────────────────────────────────

async function getValidOutlookAccessToken() {
  const tokens = loadOutlookTokens();
  if (!tokens) return null;

  const bufferMs = 5 * 60 * 1000;
  if (tokens.expires_at && Date.now() < tokens.expires_at - bufferMs) {
    return tokens.access_token;
  }

  if (!tokens.refresh_token) {
    deleteOutlookTokens();
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('outlook-auth-changed');
    }
    return null;
  }

  try {
    const newTokens = await refreshOutlookAccessToken(tokens.refresh_token);
    newTokens.refresh_token = newTokens.refresh_token || tokens.refresh_token;
    newTokens.expires_at = Date.now() + (newTokens.expires_in * 1000);
    // See the Google counterpart — preserve the email captured at connect
    // time rather than relying on the refresh response to carry it again.
    newTokens.email = newTokens.email || tokens.email;
    saveOutlookTokens(newTokens);
    return newTokens.access_token;
  } catch (error) {
    console.error('Outlook token refresh failed:', error.message);
    // Only delete tokens for irrecoverable errors (revoked/expired grant)
    // Transient network errors should not force re-authentication
    if (error.message && (error.message.includes('invalid_grant') || error.message.includes('interaction_required'))) {
      deleteOutlookTokens();
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('outlook-auth-changed');
      }
    }
    return null;
  }
}

function refreshOutlookAccessToken(refreshToken) {
  return new Promise((resolve, reject) => {
    // No `scope` param: Microsoft defaults a refresh to whatever the
    // refresh_token was originally granted. Sending OUTLOOK_SCOPES here
    // would ask pre-existing connections (granted before openid/email were
    // added) for scope they never consented to, and Microsoft rejects
    // that — breaking their calendar connection the next time the access
    // token expires. New connections still get the full scope, since it's
    // requested at initial authorization (startOutlookAuth) and a refresh
    // without `scope` inherits it.
    const postData = new URLSearchParams({
      client_id: OUTLOOK_CLIENT_ID,
      refresh_token: refreshToken,
      grant_type: 'refresh_token'
    }).toString();

    const tokenUrl = new URL(OUTLOOK_TOKEN_URL);
    const options = {
      hostname: tokenUrl.hostname,
      path: tokenUrl.pathname,
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'Content-Length': Buffer.byteLength(postData)
      }
    };

    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => {
        try {
          const parsed = JSON.parse(data);
          if (parsed.error) {
            reject(new Error(`Refresh failed: ${parsed.error_description || parsed.error}`));
            return;
          }
          resolve(parsed);
        } catch (err) {
          reject(new Error('Failed to parse refresh response'));
        }
      });
    });

    req.on('error', reject);
    req.write(postData);
    req.end();
  });
}

// ── Outlook Calendar: Fetch Events ──────────────────────────────────────

async function fetchOutlookCalendarList(accessToken, signal) {
  return new Promise((resolve, reject) => {
    const options = {
      hostname: 'graph.microsoft.com',
      path: '/v1.0/me/calendars',
      method: 'GET',
      headers: { 'Authorization': `Bearer ${accessToken}` }
    };
    if (signal) options.signal = signal;
    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => {
        try {
          const parsed = JSON.parse(data);
          if (parsed.error) {
            reject(new Error(`Outlook API error: ${parsed.error.message || parsed.error}`));
            return;
          }
          resolve(parsed.value || []);
        } catch (err) {
          reject(new Error('Failed to parse Outlook calendar list response'));
        }
      });
    });
    req.on('error', reject);
    req.end();
  });
}

function fetchOutlookEventsForCalendar(accessToken, calendarId, params, signal) {
  return new Promise((resolve, reject) => {
    const options = {
      hostname: 'graph.microsoft.com',
      path: `/v1.0/me/calendars/${encodeURIComponent(calendarId)}/calendarView?${params.toString()}`,
      method: 'GET',
      headers: {
        'Authorization': `Bearer ${accessToken}`,
        'Prefer': 'outlook.timezone="UTC"'
      }
    };
    if (signal) options.signal = signal;
    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => {
        try {
          const parsed = JSON.parse(data);
          if (parsed.error) {
            resolve([]);
            return;
          }
          const events = (parsed.value || []).map(normalizeOutlookEvent);
          resolve(events);
        } catch (err) {
          console.warn(`Failed to parse Outlook events for calendar ${calendarId}:`, err);
          resolve([]);
        }
      });
    });
    req.on('error', () => resolve([]));
    req.end();
  });
}

async function fetchOutlookCalendarEvents(accessToken, maxResults = 50, signal) {
  const now = new Date();
  const weekAhead = new Date(now);
  weekAhead.setDate(weekAhead.getDate() + 7);

  const params = new URLSearchParams({
    startDateTime: now.toISOString(),
    endDateTime: weekAhead.toISOString(),
    $top: String(maxResults),
    $orderby: 'start/dateTime',
    $select: 'id,subject,body,start,end,attendees,webLink,onlineMeeting,isOnlineMeeting,isAllDay,isCancelled,responseStatus,categories'
  });

  try {
    const calendars = await fetchOutlookCalendarList(accessToken, signal);
    if (calendars.length === 0) return [];

    const results = [];
    const concurrency = 3;
    for (let i = 0; i < calendars.length; i += concurrency) {
      const chunk = calendars.slice(i, i + concurrency);
      const chunkPromises = chunk.map(async (cal) => {
        const items = await fetchOutlookEventsForCalendar(accessToken, cal.id, params, signal);
        
        let hexColor = undefined;
        switch (cal.color) {
          case 'lightBlue': hexColor = '#3B82F6'; break;
          case 'lightGreen': hexColor = '#10B981'; break;
          case 'lightOrange': hexColor = '#F97316'; break;
          case 'lightGray': hexColor = '#6B7280'; break;
          case 'lightYellow': hexColor = '#EAB308'; break;
          case 'lightTeal': hexColor = '#14B8A6'; break;
          case 'lightPink': hexColor = '#EC4899'; break;
          case 'lightBrown': hexColor = '#92400E'; break;
          case 'lightRed': hexColor = '#EF4444'; break;
          default: hexColor = '#3B82F6';
        }
        
        items.forEach(item => { 
          item.calendarBackgroundColor = hexColor; 
          item.id = `${cal.id}_${item.id}`;
        });
        return items;
      });
      const chunkResults = await Promise.all(chunkPromises);
      results.push(...chunkResults);
    }
    let allEvents = results.flat();
    
    allEvents.sort((a, b) => {
      const startA = new Date(a.start?.dateTime || a.start?.date || 0);
      const startB = new Date(b.start?.dateTime || b.start?.date || 0);
      return startA.getTime() - startB.getTime();
    });

    return allEvents.slice(0, maxResults);
  } catch (err) {
    throw err;
  }
}

function normalizeOutlookEvent(event) {
  // Map Microsoft Graph event shape to Google Calendar shape for renderer compatibility
  const stripHtml = (html) => {
    if (!html) return '';
    return html
      .replace(/<br\s*\/?>/gi, '\n')
      .replace(/<\/(?:div|p|tr|li|h[1-6])>/gi, '\n')
      .replace(/<[^>]*>/g, '')
      .replace(/&nbsp;/g, ' ')
      .replace(/&amp;/g, '&')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"')
      .replace(/\r\n/g, '\n')
      .replace(/[ \t]+/g, ' ')
      .replace(/(\s*\n){3,}/g, '\n\n')
      .trim();
  };

  const ensureUtcSuffix = (dt) => {
    if (!dt) return undefined;
    return dt.endsWith('Z') ? dt : dt + 'Z';
  };

  // Map Outlook responseStatus.response → the common enum used downstream.
  // 'tentativelyAccepted' is the Outlook wire name for what Google calls 'tentative';
  // 'notResponded' maps to Google's 'needsAction'. 'none' / missing → 'unknown'
  // so the downstream filter defaults to "show" rather than guessing.
  const mapOutlookResponse = (r) => {
    switch (r) {
      case 'accepted': return 'accepted';
      case 'declined': return 'declined';
      case 'tentativelyAccepted': return 'tentative';
      case 'notResponded': return 'needsAction';
      case 'organizer': return 'organizer';
      default: return 'unknown';
    }
  };

  return {
    id: event.id,
    summary: event.subject || 'No title',
    description: stripHtml(event.body?.content),
    start: {
      dateTime: ensureUtcSuffix(event.start?.dateTime),
      timeZone: 'UTC'
    },
    end: {
      dateTime: ensureUtcSuffix(event.end?.dateTime),
      timeZone: 'UTC'
    },
    attendees: (event.attendees || []).map(a => ({
      email: a.emailAddress?.address || '',
      displayName: a.emailAddress?.name || '',
      responseStatus: a.status?.response || ''
    })),
    htmlLink: event.webLink,
    conferenceData: event.isOnlineMeeting && event.onlineMeeting ? {
      entryPoints: [{ uri: event.onlineMeeting.joinUrl, entryPointType: 'video' }]
    } : undefined,
    // Carried forward for normalizeCalendarEvent — Outlook reports these at the
    // top level so we don't need to inspect attendees to find "self".
    isAllDay: event.isAllDay === true,
    isCancelled: event.isCancelled === true,
    selfResponseStatus: mapOutlookResponse(event.responseStatus?.response)
  };
}

// ── Google Calendar: IPC Handlers ───────────────────────────────────────

ipcMain.handle('google-auth-start', async () => {
  try {
    await startGoogleAuth();
    // Only disconnect Outlook after Google auth succeeds
    deleteOutlookTokens();
    trackEvent('calendar_connected', { provider: 'google' });
    refreshIdentitySuperProperties();
    return { success: true };
  } catch (error) {
    console.error('Google auth failed:', error.message);
    return { success: false, error: error.message };
  }
});

ipcMain.handle('google-auth-status', async () => {
  try {
    const tokens = loadGoogleTokens();
    return { success: true, connected: !!tokens, email: tokens?.email ?? null };
  } catch (error) {
    return { success: false, connected: false };
  }
});

ipcMain.handle('google-auth-cancel', async () => {
  const cancelled = cancelActiveGoogleAuth();
  return { success: true, cancelled };
});

ipcMain.handle('google-auth-disconnect', async () => {
  try {
    // Best-effort token revocation
    const tokens = loadGoogleTokens();
    if (tokens && tokens.access_token) {
      try {
        await new Promise((resolve) => {
          const revokeParams = new URLSearchParams({ token: tokens.access_token });
          const req = https.request({
            hostname: 'oauth2.googleapis.com',
            path: `/revoke?${revokeParams.toString()}`,
            method: 'POST',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' }
          }, () => resolve());
          req.on('error', () => resolve()); // Best-effort
          req.end();
        });
      } catch (e) {
        // Best-effort revocation -- ignore errors
      }
    }

    deleteGoogleTokens();

    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('google-auth-changed');
    }

    trackEvent('calendar_disconnected', { provider: 'google' });
    refreshIdentitySuperProperties();
    return { success: true };
  } catch (error) {
    return { success: false, error: error.message };
  }
});

// Map Google attendee.responseStatus → the common enum. Google uses the same
// strings as our enum for the four "real" states, so this is mostly identity.
function mapGoogleResponse(r) {
  switch (r) {
    case 'accepted': return 'accepted';
    case 'declined': return 'declined';
    case 'tentative': return 'tentative';
    case 'needsAction': return 'needsAction';
    default: return 'unknown';
  }
}

// Returns null for cancelled events so the caller can drop them. Google marks
// them with status === 'cancelled'; Outlook with isCancelled === true (carried
// through from normalizeOutlookEvent). Declined events are also dropped here —
// the renderer used to filter them client-side, but that left any new surface
// (notifications, auto-detection, future features) one bug away from showing
// a meeting the user explicitly said "no" to. Dropping at the IPC boundary
// makes "events" the authoritative "things the user is attending" list.
function normalizeCalendarEvent(event) {
  if (event.status === 'cancelled' || event.isCancelled === true) return null;

  const start =
    event.start?.dateTime ||
    event.start?.date ||
    (typeof event.start === 'string' ? event.start : '');
  const end =
    event.end?.dateTime ||
    event.end?.date ||
    (typeof event.end === 'string' ? event.end : '');

  // All-day events have date-only start/end ("YYYY-MM-DD") on Google. Outlook
  // carries an explicit flag through normalizeOutlookEvent.
  const isAllDay =
    event.isAllDay === true ||
    (!event.start?.dateTime && !!event.start?.date);

  // Self response. Outlook hands us the answer directly (top-level
  // responseStatus → carried through as selfResponseStatus). Google requires
  // finding the attendee with self === true; if there's no attendees list at
  // all the event is calendar-only (e.g. a self-blocked focus block) so treat
  // it as 'organizer' — show it, never label it as declined.
  let responseStatus = event.selfResponseStatus;
  if (!responseStatus) {
    if (Array.isArray(event.attendees) && event.attendees.length > 0) {
      const self = event.attendees.find((a) => a && a.self === true);
      if (self) {
        // A declined response wins over the organizer flag — if the user
        // organised a meeting and then later declined their own attendance
        // (Google lets you do this), we want the event dropped just like
        // any other declined invite. The previous short-circuit
        // (`self.organizer ? 'organizer' : …`) silently kept declined-by-
        // organizer events in the carousel.
        const raw = mapGoogleResponse(self.responseStatus);
        if (raw === 'declined') {
          responseStatus = 'declined';
        } else {
          responseStatus = self.organizer ? 'organizer' : raw;
        }
      } else {
        responseStatus = 'unknown';
      }
    } else {
      responseStatus = 'organizer';
    }
  }

  // Drop events the user explicitly declined — see function header comment.
  if (responseStatus === 'declined') return null;

  const GOOGLE_COLORS = {
    '1': '#7986cb', // Lavender
    '2': '#33b679', // Sage
    '3': '#8e24aa', // Grape
    '4': '#e67c73', // Flamingo
    '5': '#f6bf26', // Banana
    '6': '#f4511e', // Tangerine
    '7': '#039be5', // Peacock
    '8': '#616161', // Graphite
    '9': '#3f51b5', // Blueberry
    '10': '#0b8043', // Basil
    '11': '#d50000'  // Tomato
  };

  let eventColor = undefined;
  if (event.colorId && GOOGLE_COLORS[event.colorId]) {
    eventColor = GOOGLE_COLORS[event.colorId];
  } else if (Array.isArray(event.categories)) {
    const OUTLOOK_CATEGORY_COLORS = {
      'red category': '#F43F5E',
      'orange category': '#F97316',
      'yellow category': '#EAB308',
      'green category': '#10B981',
      'blue category': '#3B82F6',
      'purple category': '#A855F7',
    };
    for (const cat of event.categories) {
       const lowerCat = cat.toLowerCase();
       if (OUTLOOK_CATEGORY_COLORS[lowerCat]) {
         eventColor = OUTLOOK_CATEGORY_COLORS[lowerCat];
         break;
       }
    }
  }

  if (!eventColor && event.calendarBackgroundColor) {
    eventColor = event.calendarBackgroundColor;
  }

  return {
    id: event._sourceCalendarId ? `${event._sourceCalendarId}_${event.id}` : event.id,
    title: event.summary || event.title || 'No title',
    start,
    end,
    meeting_url:
      event.hangoutLink ||
      event.onlineMeeting?.joinUrl ||
      event.meeting_url ||
      undefined,
    is_all_day: isAllDay,
    response_status: responseStatus,
    color: eventColor,
  };
}

ipcMain.handle('get-calendar-events', async () => {
  try {
    // Check which provider is connected (only one at a time)
    const googleToken = await getValidAccessToken();
    if (googleToken) {
      const raw = await fetchCalendarEvents(googleToken);
      return { success: true, events: raw.map(normalizeCalendarEvent).filter(Boolean) };
    }

    const outlookToken = await getValidOutlookAccessToken();
    if (outlookToken) {
      const raw = await fetchOutlookCalendarEvents(outlookToken);
      return { success: true, events: raw.map(normalizeCalendarEvent).filter(Boolean) };
    }

    return { success: false, needsAuth: true };
  } catch (error) {
    console.error('Failed to fetch calendar events:', error.message);
    return { success: false, error: error.message };
  }
});

// Pick the calendar event most likely to be the one the user is joining now.
// INTENTIONAL DUPLICATION: this algorithm is kept in lockstep with
// `app/renderer/src/lib/calendar.ts` → `pickInProgressEvent` (same
// constants, filters, and tie-break order). The two
// surfaces (auto-detect-meeting notification here + hero copy in the
// renderer) keep their own copy because main and renderer can't share
// ESM modules. If you change the constants or matching rules, update
// BOTH or the notification and the hero will disagree about what counts
// as "in a meeting now".
// Match window:
//   - opens 5 min before the scheduled start (early-join grace)
//   - closes at the scheduled end, OR 10 min after start, whichever is later
// The 10-min floor only matters for meetings shorter than 10 min: a 5-min
// standup that overruns by a couple of minutes still matches when the user
// joins late. Long meetings are unaffected (their end is past start+10).
// Priority:
//   1. Genuinely in-progress (now within real [start, end))
//   2. Upcoming (start is still in the future) — soonest first
//   3. Recently ended but still within the late-floor — most recently ended
// (2) beats (3) so a short event that overran the floor cannot block the next
// real upcoming meeting.
// All-day events are skipped — their start is a date-only string ("YYYY-MM-DD")
// with no 'T' separator, spans midnight to midnight, and would mistag every
// meeting that day (e.g. "On vacation" appearing in every recording's title).
function pickCurrentCalendarEvent(events, now = new Date()) {
  const EARLY_GRACE_MS = 5 * 60 * 1000;
  const LATE_FLOOR_MS = 10 * 60 * 1000;
  const nowMs = now.getTime();
  const candidates = [];
  for (const e of events) {
    if (!e || typeof e.start !== 'string' || typeof e.end !== 'string') continue;
    if (!e.start.includes('T') || !e.end.includes('T')) continue;
    if (e.is_all_day === true) continue;
    if (e.response_status === 'declined') continue;
    const startMs = new Date(e.start).getTime();
    const endMs = new Date(e.end).getTime();
    if (!isFinite(startMs) || !isFinite(endMs)) continue;
    const closesAt = Math.max(endMs, startMs + LATE_FLOOR_MS);
    if (nowMs >= startMs - EARLY_GRACE_MS && nowMs < closesAt) {
      candidates.push({ event: e, startMs, endMs });
    }
  }
  if (candidates.length === 0) return null;

  const inProgress = candidates.filter((c) => c.startMs <= nowMs && nowMs < c.endMs);
  if (inProgress.length > 0) {
    inProgress.sort((a, b) => b.startMs - a.startMs);
    return inProgress[0].event;
  }
  const upcoming = candidates.filter((c) => c.startMs > nowMs);
  if (upcoming.length > 0) {
    upcoming.sort((a, b) => a.startMs - b.startMs);
    return upcoming[0].event;
  }
  candidates.sort((a, b) => b.endMs - a.endMs);
  return candidates[0].event;
}

// Fetches from whichever provider is connected, applies a hard timeout so a
// slow API never blocks the "Meeting detected" notification. The timeout
// aborts the in-flight request (via AbortController) so we don't leak the
// HTTPS request after fallback. Returns the matched event or null.
async function getCalendarEventForNow(timeoutMs = 1500) {
  const controller = new AbortController();
  const signal = controller.signal;
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
  try {
    let events = null;
    const googleToken = await getValidAccessToken();
    if (googleToken) {
      const raw = await fetchCalendarEvents(googleToken, 50, signal);
      events = raw.map(normalizeCalendarEvent).filter(Boolean);
    } else {
      const outlookToken = await getValidOutlookAccessToken();
      if (outlookToken) {
        const raw = await fetchOutlookCalendarEvents(outlookToken, 50, signal);
        events = raw.map(normalizeCalendarEvent).filter(Boolean);
      }
    }
    if (!events) return null;
    return pickCurrentCalendarEvent(events);
  } catch (err) {
    if (signal.aborted) {
      sendDebugLog(`[auto-detect] calendar lookup timed out after ${timeoutMs}ms`);
    } else {
      sendDebugLog(`[auto-detect] calendar lookup failed: ${err.message}`);
    }
    return null;
  } finally {
    clearTimeout(timeoutId);
  }
}

// ── Pre-meeting notification ────────────────────────────────────────────
// ~2 min before a scheduled calendar meeting, fire a heads-up notification;
// clicking it focuses Steno. INDEPENDENT of auto-detect (which is mic-based and
// prompts to record): this is calendar-time based and only focuses — never
// records — so there's no recording conflict. Suppressed for a meeting we're
// already recording (matched by calendar event id).
const PREMEETING_LEAD_MS = 2 * 60 * 1000;          // fire this long before start
const PREMEETING_RESCHEDULE_MS = 10 * 60 * 1000;   // re-poll the calendar this often
const premeetingTimers = new Map();                // eventId -> setTimeout handle
const premeetingFiredIds = new Set();              // ids already fired this app session
let premeetingRescheduleTimer = null;

// Fetch upcoming events from whichever provider is connected (mirrors
// getCalendarEventForNow's fetch). Returns the normalized event array, or null
// when no calendar is connected / the fetch fails.
// Sentinel: a calendar IS connected but this fetch failed transiently (network
// blip / timeout). Distinct from "no calendar connected" so the scheduler can
// KEEP existing timers on a blip (don't drop a reminder for a meeting starting
// in the re-poll gap) but CLEAR them on a real disconnect (no stale reminders).
const SCHEDULER_FETCH_FAILED = Symbol('scheduler-fetch-failed');

async function fetchCalendarEventsForScheduler(timeoutMs = 4000) {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const googleToken = await getValidAccessToken();
    if (googleToken) {
      const raw = await fetchCalendarEvents(googleToken, 50, controller.signal);
      return raw.map(normalizeCalendarEvent).filter(Boolean);
    }
    const outlookToken = await getValidOutlookAccessToken();
    if (outlookToken) {
      const raw = await fetchOutlookCalendarEvents(outlookToken, 50, controller.signal);
      return raw.map(normalizeCalendarEvent).filter(Boolean);
    }
    return null; // no calendar connected
  } catch (err) {
    sendDebugLog(`[premeeting] calendar fetch failed: ${err.message}`);
    return SCHEDULER_FETCH_FAILED; // transient — caller keeps existing timers
  } finally {
    clearTimeout(timeoutId);
  }
}

// Content-free periodic snapshot of the connected calendar -- the usage
// denominator for "% of calendar meetings recorded" (joined against
// recording_started's matched_calendar_event/provider). Only counts,
// enums and provider breakdowns are ever sent; titles/attendees/URLs are
// discarded after the enum lookup. Throttled to <=1/day per window so the
// 10-min premeeting re-poll doesn't spam PostHog.
//
// The throttle timestamp is persisted to disk (not just an in-memory
// variable) so restarting the app doesn't reset it -- an in-memory-only
// throttle would re-fire on every single launch, since a fresh process
// always starts with "never sent", defeating the <=1/day intent for anyone
// who quits and reopens the app more than once a day.
function getCalendarSnapshotMarkerPath() {
  return path.join(getUserDataDir(), '.last-calendar-snapshot');
}

function readLastCalendarSnapshotAtMs() {
  try {
    const parsed = parseInt(fs.readFileSync(getCalendarSnapshotMarkerPath(), 'utf-8').trim(), 10);
    return Number.isFinite(parsed) ? parsed : 0;
  } catch (_) {
    return 0;
  }
}

function writeLastCalendarSnapshotAtMs(ms) {
  try {
    fs.writeFileSync(getCalendarSnapshotMarkerPath(), String(ms));
  } catch (_) {
    // Best-effort -- a failed write just means the throttle resets on next launch
  }
}

// null = not yet loaded from disk this process. Loaded lazily on first call
// (rather than at module load) since this only matters once the premeeting
// scheduler actually starts ticking.
let lastCalendarSnapshotAtMs = null;
const CALENDAR_SNAPSHOT_INTERVAL_MS = 24 * 60 * 60 * 1000;

function maybeTrackCalendarSnapshot(events, now = new Date()) {
  // Skip entirely -- including the marker read/write -- when telemetry is
  // off. trackEvent() would no-op below regardless, but writing the marker
  // anyway would advance the <=1/day throttle for a snapshot that was never
  // actually sent, silently suppressing the first REAL snapshot for up to
  // 24h after the user later re-enables telemetry.
  if (!telemetryEnabled || !posthogClient || !anonymousId) return;
  if (lastCalendarSnapshotAtMs === null) {
    lastCalendarSnapshotAtMs = readLastCalendarSnapshotAtMs();
  }
  const nowMs = now.getTime();
  if (nowMs - lastCalendarSnapshotAtMs < CALENDAR_SNAPSHOT_INTERVAL_MS) return;
  lastCalendarSnapshotAtMs = nowMs;
  writeLastCalendarSnapshotAtMs(nowMs);

  const { today, week } = summarizeCalendarSnapshot(events, now);
  trackEvent('calendar_snapshot', { window: 'today', ...today });
  trackEvent('calendar_snapshot', { window: 'week', ...week });
}

// Mirrors the per-event predicates of Home.tsx's `upcomingToday` (timed/
// not-all-day, not declined, start in the future) — but deliberately WITHOUT
// Home's start-of-tomorrow upper bound: a 2-min-before reminder should arm for
// any upcoming meeting in the fetch window, not just today's.
function isPremeetingEligible(e, nowMs) {
  if (!e || typeof e.start !== 'string') return false;
  if (!e.start.includes('T')) return false;      // all-day events are date-only
  if (e.is_all_day === true) return false;
  if (e.response_status === 'declined') return false;
  const startMs = new Date(e.start).getTime();
  return isFinite(startMs) && startMs > nowMs;
}

// The single fire path, shared by the armed timer and the
// show-premeeting-notification test seam. Returns whether the banner was shown.
// No internal firedIds dedupe (the scheduler owns that, skipping already-fired
// ids on re-poll) so the seam can drive it repeatedly in tests.
async function firePreMeetingNotification(event) {
  premeetingTimers.delete(event.id);
  // Gate: the dedicated "Scheduled meetings" toggle — independent of the
  // "Post meeting notifications" master switch (see premeetingNotificationsEnabled).
  if (!(await premeetingNotificationsEnabled())) return false;
  // Suppress only while we're recording THIS meeting — matched by name. A
  // recording started from a calendar event is named after its title (auto-detect
  // accept + Home upcoming-card both pass event.title), so the live session name
  // equals the reminder's event title. Key off currentRecordingSessionName — the
  // AUTHORITATIVE "which meeting is live" signal: set on start, cleared only on a
  // real stop (NOT on a transient capture flap, see system-audio-recording-state),
  // and null whenever there's no active session. Deliberately NOT gated on the
  // volatile systemAudioRecordingActive, which flips false on every capture blip
  // and would let a reminder through mid-recording during a flap. A name can't be
  // stale here (stop clears it), so there's no risk of suppressing a later
  // meeting. Title collisions (two same-named meetings) are an accepted edge for a
  // heads-up notification.
  if (currentRecordingSessionName && currentRecordingSessionName === event.title) {
    sendDebugLog(`[premeeting] suppressed — already recording "${event.title}"`);
    return false;
  }

  const notif = new Notification({ title: event.title || 'Meeting starting' });
  // The pre-meeting toast carries a richer payload (time / meeting URL /
  // attendees) and keeps its legacy renderer-side handlers (Join & take notes,
  // focus-on-body-tap) plus its own click/dismiss analytics. `premeeting: true`
  // tells NotificationToast to use that path instead of the generic
  // action/body-click bridge the other notifications use.
  notif.payload.premeeting = true;
  notif.payload.time = event.start
    ? new Date(event.start).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
    : '';
  notif.payload.meeting_url = event.meeting_url;
  notif.payload.attendees = event.attendees
    ? event.attendees.map((a) => a.name || a.email).join(', ')
    : '';
  // Only count a PASSIVE dismiss here (15s auto-close or being superseded). An
  // active click/X-dismiss is tracked by the renderer, which also flags
  // _analyticsInteracted via close-notification-window — so skip it here to
  // avoid double-counting. This is the same split the old createNotificationWindow
  // used, preserved verbatim.
  //
  // Read THIS notif's own window (notif._window), never the module-level
  // `notificationWindow`: when this toast is superseded, the successor reassigns
  // `notificationWindow` (and resets its `_analyticsInteracted` to false) before
  // this 'close' fires, so reading the module-level var would attribute this
  // toast's dismissal to the NEXT toast's interaction flag — dropping or
  // duplicating the dismiss. The per-instance window keeps the flag correct.
  notif.on('close', () => {
    if (!notif._window || !notif._window._analyticsInteracted) {
      trackEvent('notification_dismissed', { type: 'premeeting' });
    }
  });
  notif.show();
  trackEvent('notification_shown', { type: 'premeeting' });

  // Mark fired only after we've actually shown it, so an unshowable notif
  // (no OS support) isn't permanently skipped by the scheduler's dedupe.
  premeetingFiredIds.add(event.id);
  return true;
}

// Renderer → main: the active toast was closed by an explicit user action (a
// Join/body tap, an action button, or the X). Flags _analyticsInteracted so the
// pre-meeting path doesn't ALSO count a passive dismiss for the same toast, then
// closes the window (which fires the notification's 'close' event).
ipcMain.handle('close-notification-window', () => {
  if (notificationWindow && !notificationWindow.isDestroyed()) {
    notificationWindow._analyticsInteracted = true;
    notificationWindow.close();
  }
});

// Renderer → main: an action button was tapped on the generic (non-pre-meeting)
// toast. Re-emit as the notification's 'action' event (with the button index,
// matching Electron's Notification 'action' signature) so the call site's
// existing `.on('action', ...)` handler + trackNotificationLifecycle both fire.
ipcMain.on('notification-action-clicked', (_event, { actionId, notifId } = {}) => {
  if (notificationWindow && !notificationWindow.isDestroyed()) {
    const notif = notificationWindow._activeCustomNotification;
    if (notif && notif.payload.id === notifId) {
      notificationWindow._analyticsInteracted = true;
      const index = notif.payload.actions.findIndex((a) => a.id === actionId);
      notif.emit('action', {}, index);
    }
  }
});

// Renderer → main: the body of the generic toast was tapped. Re-emit as the
// notification's 'click' event so the call site's `.on('click', ...)` handler +
// trackNotificationLifecycle both fire.
ipcMain.on('notification-body-clicked', (_event, { notifId } = {}) => {
  if (notificationWindow && !notificationWindow.isDestroyed()) {
    const notif = notificationWindow._activeCustomNotification;
    if (notif && notif.payload.id === notifId) {
      notificationWindow._analyticsInteracted = true;
      notif.emit('click');
    }
  }
});

function clearPreMeetingTimers() {
  for (const t of premeetingTimers.values()) clearTimeout(t);
  premeetingTimers.clear();
}

// (Re)arm timers from the latest calendar fetch. Idempotent: clears prior timers
// and re-arms, so moved/cancelled events drop out and new ones get picked up.
// Skips ids already fired this session and events already inside the lead window
// (don't backfire). Gated on the master notifications toggle + a connected
// calendar: a disconnect clears armed timers; a transient fetch blip keeps them.
// Three uncoalesced callers can invoke this (the periodic re-poll timer, the
// premeeting-notifications toggle, and app-ready startup) — without this
// guard, two overlapping runs both clear + rebuild premeetingTimers, and
// whichever finishes last wins the re-arm. In practice the two calendar
// snapshots involved are seconds apart and the next re-poll self-heals, but
// coalescing overlapping calls onto the same in-flight run closes it outright.
let premeetingScheduleInFlight = null;

function schedulePreMeetingNotifications() {
  if (premeetingScheduleInFlight) return premeetingScheduleInFlight;
  premeetingScheduleInFlight = schedulePreMeetingNotificationsImpl().finally(() => {
    premeetingScheduleInFlight = null;
  });
  return premeetingScheduleInFlight;
}

async function schedulePreMeetingNotificationsImpl() {
  // Fetched once, shared by the calendar_snapshot metric (below) and the
  // premeeting-arming logic (further down) -- avoids a second calendar API
  // call every 10-min re-poll. The snapshot is intentionally NOT gated on
  // the notifications toggle -- it's a usage metric, not a notification, and
  // gating it would bias the "% of meetings recorded" metric toward users
  // who have notifications on.
  const events = await fetchCalendarEventsForScheduler();
  if (events && events !== SCHEDULER_FETCH_FAILED) {
    maybeTrackCalendarSnapshot(events);
  }

  if (!(await premeetingNotificationsEnabled())) {
    clearPreMeetingTimers();
    return;
  }
  if (events === SCHEDULER_FETCH_FAILED) return; // transient blip — keep existing timers
  if (!events) {
    // No calendar connected — drop any reminders armed while it was. (A transient
    // fetch error returns the sentinel above and is handled differently.)
    clearPreMeetingTimers();
    return;
  }
  const nowMs = Date.now();
  // Forget fired ids that are no longer a just-fired occurrence: pruned if the
  // event dropped out of the fetch (cancelled / rolled past the window) OR its
  // start is now in the future again (a recurring meeting reusing the same id —
  // re-firing in the pre-start gap is already prevented by the delay<=0 guard
  // below). Keeps the Set bounded across a long-running session.
  const startById = new Map(events.map((e) => [e.id, new Date(e.start).getTime()]));
  for (const id of premeetingFiredIds) {
    const startMs = startById.get(id);
    if (startMs === undefined || (isFinite(startMs) && startMs > nowMs)) {
      premeetingFiredIds.delete(id);
    }
  }
  clearPreMeetingTimers();
  for (const e of events) {
    if (!isPremeetingEligible(e, nowMs)) continue;
    if (premeetingFiredIds.has(e.id)) continue;
    const delay = new Date(e.start).getTime() - PREMEETING_LEAD_MS - nowMs;
    if (delay <= 0) continue; // already within the lead window — don't backfire
    premeetingTimers.set(e.id, setTimeout(() => { void firePreMeetingNotification(e); }, delay));
  }
  sendDebugLog(`[premeeting] armed ${premeetingTimers.size} notification(s)`);
}

// Run once at app ready + on a periodic re-poll so newly-added/moved events get
// armed and cancelled ones drop. Safe to call repeatedly.
function startPreMeetingScheduler() {
  void schedulePreMeetingNotifications();
  if (premeetingRescheduleTimer) clearInterval(premeetingRescheduleTimer);
  premeetingRescheduleTimer = setInterval(() => {
    void schedulePreMeetingNotifications();
  }, PREMEETING_RESCHEDULE_MS);
}

// Test seam + the production render path's IPC mirror. The armed timer calls
// firePreMeetingNotification directly; this lets e2e drive the gate + suppression
// deterministically (returns `shown` like the other notification handlers). The
// renderer never calls this in production.
ipcMain.handle('show-premeeting-notification', async (_event, payload) => {
  try {
    const event = payload && payload.event;
    if (!event || !event.id) return { success: false, error: 'event with id required' };
    const shown = await firePreMeetingNotification(event);
    return { success: true, shown };
  } catch (e) {
    sendDebugLog(`Failed to show pre-meeting notification: ${e.message}`);
    return { success: false, error: e.message };
  }
});

// ── Outlook Calendar: IPC Handlers ──────────────────────────────────────

ipcMain.handle('outlook-auth-start', async () => {
  try {
    await startOutlookAuth();
    // Only disconnect Google after Outlook auth succeeds
    deleteGoogleTokens();
    trackEvent('calendar_connected', { provider: 'outlook' });
    refreshIdentitySuperProperties();
    return { success: true };
  } catch (error) {
    console.error('Outlook auth failed:', error.message);
    return { success: false, error: error.message };
  }
});

ipcMain.handle('outlook-auth-status', async () => {
  try {
    const tokens = loadOutlookTokens();
    return { success: true, connected: !!tokens, email: tokens?.email ?? null };
  } catch (error) {
    return { success: false, connected: false };
  }
});

ipcMain.handle('outlook-auth-cancel', async () => {
  const cancelled = cancelActiveOutlookAuth();
  return { success: true, cancelled };
});

ipcMain.handle('outlook-auth-disconnect', async () => {
  try {
    deleteOutlookTokens();

    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('outlook-auth-changed');
    }

    trackEvent('calendar_disconnected', { provider: 'outlook' });
    refreshIdentitySuperProperties();
    return { success: true };
  } catch (error) {
    return { success: false, error: error.message };
  }
});

// ─── Organisation adapter (enterprise mode) ──────────────────────────────────
// Talks to the customer's self-hosted Steno adapter for shared notes, AI
// proxying, and S3-backed artifacts. Session token + adapter URL are
// persisted with safeStorage; the renderer never sees the JWT directly,
// it goes through these IPC handlers.

function getOrgSessionPath() {
  return path.join(getUserDataDir(), '.org-session');
}

// Decode the JWT's payload segment and check whether it's already past its
// `exp` claim. The adapter signs with HS256 so we *cannot* verify the
// signature client-side, but the `exp` timestamp is the part the adapter
// itself enforces — if it's in the past, the next authenticated request
// will get a 401 anyway. Checking here lets org-status and the sidebar
// reflect reality without first having to make a request and watch it fail.
//
// We treat malformed/unparseable tokens as expired (defensive) so a corrupt
// session file kicks the user back to sign-in instead of leaving them in a
// "signed in but every request fails" limbo.
function decodeJwtExp(token) {
  try {
    const parts = String(token || '').split('.');
    if (parts.length !== 3) return null;
    const payload = JSON.parse(
      Buffer.from(parts[1].replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8'),
    );
    return typeof payload.exp === 'number' ? payload.exp : null;
  } catch (_) {
    return null;
  }
}

function isJwtExpired(token) {
  const exp = decodeJwtExp(token);
  if (exp === null) return true;
  // 30-second skew buffer so a request fired right at the boundary doesn't
  // race the adapter to "valid → expired" mid-flight.
  return exp <= Math.floor(Date.now() / 1000) + 30;
}

function saveOrgSession(session) {
  try {
    const dir = path.dirname(getOrgSessionPath());
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    const encrypted = getSafeStorage().encryptString(JSON.stringify(session));
    fs.writeFileSync(getOrgSessionPath(), encrypted);
    orgSessionGeneration++;
    return true;
  } catch (e) {
    console.error('Failed to save org session:', e.message);
    return false;
  }
}

// Read the org session distinguishing the three states callers care about:
//   file missing        → { session: null, exists: false, decryptFailed: false }
//   present, unreadable → { session: null, exists: true,  decryptFailed: true  }
//   present, readable   → { session,      exists: true,  decryptFailed: false }
// The middle state matters: getSafeStorage().decryptString throws while the
// keychain is locked (right after wake / login, or a denied prompt after an
// app re-sign) — treating that like "signed out" is exactly what used to
// downgrade signed-in users to local AI via the stale-adapter recovery.
function loadOrgSessionEx() {
  const p = getOrgSessionPath();
  if (!fs.existsSync(p)) {
    orgSessionDecryptFailingSince = null;
    return { session: null, exists: false, decryptFailed: false };
  }
  try {
    const encrypted = fs.readFileSync(p);
    // Decrypt + parse BEFORE clearing the streak — clearing first would
    // reset it moments before the decrypt throws, and the catch below
    // would restamp it to now on every call, so the grace window could
    // never elapse and the org lock would stay fail-closed forever.
    const session = JSON.parse(getSafeStorage().decryptString(encrypted));
    orgSessionDecryptFailingSince = null;
    return { session, exists: true, decryptFailed: false };
  } catch (e) {
    if (orgSessionDecryptFailingSince === null) orgSessionDecryptFailingSince = Date.now();
    console.error('Failed to load org session:', e.message);
    sendDebugLog(`org session present but unreadable (keychain locked?): ${e.message}`);
    return { session: null, exists: true, decryptFailed: true };
  }
}

function loadOrgSession() {
  return loadOrgSessionEx().session;
}

function clearOrgSession() {
  try {
    const p = getOrgSessionPath();
    if (fs.existsSync(p)) fs.unlinkSync(p);
    orgSessionGeneration++;
    return true;
  } catch (e) {
    return false;
  }
}

// Persistent marker — survives sign-out, gets written on the FIRST successful
// org sign-in (password OR Google SSO). Used by the sidebar to decide whether
// to surface the "Sign in to org" CTA: personal users who never sign in see
// nothing; enterprise users get a one-click recovery path after their first
// connection. Empty file content; existence is the only signal.
function getOrgKnownMarkerPath() {
  return path.join(getUserDataDir(), '.org-known');
}

function markOrgKnown() {
  try {
    const p = getOrgKnownMarkerPath();
    if (!fs.existsSync(path.dirname(p))) fs.mkdirSync(path.dirname(p), { recursive: true });
    if (!fs.existsSync(p)) fs.writeFileSync(p, '');
    return true;
  } catch (e) {
    console.error('Failed to write org-known marker:', e.message);
    return false;
  }
}

function hasOrgEverBeenSignedIn() {
  try {
    return fs.existsSync(getOrgKnownMarkerPath());
  } catch (_) {
    return false;
  }
}

// Tracks which summary files we've already auto-backed-up so an unshare
// sticks: once a note has been shared (manually or automatically), we never
// re-upload it. The state lives outside the meeting JSON so the meeting
// files stay byte-stable and the share/unshare cycle leaves no residue in
// the user's notes.
function getOrgBackupStatePath() {
  return path.join(getUserDataDir(), '.org-backup-state.json');
}

function loadOrgBackupState() {
  try {
    const p = getOrgBackupStatePath();
    if (!fs.existsSync(p)) return { attempts: {} };
    const raw = JSON.parse(fs.readFileSync(p, 'utf8'));
    return raw && typeof raw === 'object' && raw.attempts ? raw : { attempts: {} };
  } catch (e) {
    console.error('Failed to load org backup state:', e.message);
    return { attempts: {} };
  }
}

function saveOrgBackupState(state) {
  try {
    const p = getOrgBackupStatePath();
    const dir = path.dirname(p);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(p, JSON.stringify(state, null, 2));
    return true;
  } catch (e) {
    console.error('Failed to save org backup state:', e.message);
    return false;
  }
}

function isOrgBackupAttempted(summaryFile) {
  const state = loadOrgBackupState();
  return Boolean(state.attempts[summaryFile]);
}

function recordOrgBackupAttempt(summaryFile, meetingId) {
  const state = loadOrgBackupState();
  state.attempts[summaryFile] = {
    attempted_at: new Date().toISOString(),
    meeting_id: meetingId || null,
  };
  // A successful share clears any prior recorded failure for this note, so
  // the "Backup failed · Retry" affordance disappears once it actually lands.
  if (state.failures && state.failures[summaryFile]) {
    delete state.failures[summaryFile];
  }
  return saveOrgBackupState(state);
}

// Record an upload failure WITHOUT marking the note as attempted — kept in a
// separate map so isOrgBackupAttempted() (and thus the auto-backup
// dedup/retry gate) stays driven by successes only, leaving the door open
// for a retry. Surfaced per-note via getOrgBackupEntry (the note-detail "Not
// backed up" status chip) AND written to the persistent diagnostic log so a
// failure is discoverable by support/IT even though the user-facing signal is
// deliberately quiet (an end user can't fix e.g. a corporate-proxy failure).
function recordOrgBackupFailure(summaryFile, errorMessage) {
  const state = loadOrgBackupState();
  if (!state.failures) state.failures = {};
  state.failures[summaryFile] = {
    failed_at: new Date().toISOString(),
    error: errorMessage ? String(errorMessage).slice(0, 500) : null,
  };
  // Best-effort diagnostic logging (never throws): the persistent processing
  // log on disk for support, plus the in-app debug panel.
  try {
    // Drop the meeting-title basename (content); keep the failure + the
    // non-content error so both the on-disk log and the debug panel stay useful.
    const msg = `org backup failed: ${errorMessage || 'unknown error'}`;
    processingLog.logLine('org-backup', msg);
    sendDebugLog(`[org-backup] ${msg}`);
  } catch (_) { /* logging is best-effort */ }
  return saveOrgBackupState(state);
}

function clearOrgBackupAttempt(summaryFile) {
  const state = loadOrgBackupState();
  const hadAttempt = Boolean(state.attempts[summaryFile]);
  const hadFailure = Boolean(state.failures && state.failures[summaryFile]);
  if (!hadAttempt && !hadFailure) return true;
  delete state.attempts[summaryFile];
  if (state.failures) delete state.failures[summaryFile];
  return saveOrgBackupState(state);
}

function getOrgBackupEntry(summaryFile) {
  const state = loadOrgBackupState();
  const entry = state.attempts[summaryFile];
  const failure = state.failures ? state.failures[summaryFile] : null;
  if (!entry) {
    return {
      shared: false,
      meeting_id: null,
      attempted_at: null,
      failed_at: failure?.failed_at || null,
      error: failure?.error || null,
    };
  }
  return {
    shared: true,
    meeting_id: entry.meeting_id || null,
    attempted_at: entry.attempted_at || null,
    // A successful attempt always clears its failure (see
    // recordOrgBackupAttempt), so a shared note reports no failure.
    failed_at: null,
    error: null,
  };
}

// Matches anything that looks like a loopback authority — covers
// `localhost`, `127.0.0.1`, IPv6 `::1` (bare or bracketed), with or
// without a port and/or path. Used to pick the right default scheme
// when the user types a hostname without one.
const _LOOPBACK_HOST_RE = /^(localhost|127\.0\.0\.1|\[::1\]|::1)(?::\d+)?(?:\/|$)/i;

function normaliseAdapterUrl(url) {
  let u = String(url || '').trim();
  if (!u) return '';
  if (!/^https?:\/\//i.test(u)) {
    // No scheme provided. Default to https — the adapter is the holder of
    // org JWTs, AWS credentials, and the AI provider key; sending its
    // bearer tokens over plain http would expose them on the wire to any
    // network observer. Loopback addresses are the one documented dev
    // exception where http is fine because the traffic never leaves the
    // machine.
    const isLoopback = _LOOPBACK_HOST_RE.test(u);
    u = (isLoopback ? 'http://' : 'https://') + u;
  }
  return u.replace(/\/+$/, '');
}

async function adapterFetch(pathname, opts = {}) {
  const session = loadOrgSession();
  if (!session) throw new Error('not signed in to org adapter');
  const headers = {
    'content-type': 'application/json',
    authorization: 'Bearer ' + session.token,
    ...(opts.headers || {}),
  };
  // net.fetch (Chromium's network stack) rather than Node's global fetch
  // (undici): undici ignores the OS system proxy + certificate store, so on a
  // corporate-proxied machine every adapter call — and the S3 PUT below — would
  // fail. net.fetch honours the system proxy (incl. PAC) and the OS trust store
  // on both Windows and macOS. Same for every other org/S3 call in this file.
  // credentials:'omit' — the adapter authenticates via the Bearer header above,
  // not session cookies; net.fetch defaults to 'include', so be explicit.
  const res = await net.fetch(session.adapterUrl + pathname, { ...opts, headers, credentials: 'omit' });
  const text = await res.text();
  let body;
  try {
    body = text ? JSON.parse(text) : {};
  } catch {
    body = { detail: text };
  }
  if (!res.ok) {
    if (res.status === 401) {
      // Server-side session revocation / token reuse / org removed our
      // user. Same response surface as a sign-out: clear the local
      // session AND restore the pre-adapter provider. Without the
      // restore, ai_provider stays on 'adapter' with no session, and
      // the next summarisation call errors out with "adapter not
      // configured". Fire-and-forget — the awaiting caller already
      // has an HTTP error to handle and shouldn't block on a Python
      // subprocess.
      clearOrgSession();
      restorePreAdapterProvider().catch(() => {});
    }
    const err = new Error(body.detail || ('HTTP ' + res.status));
    err.status = res.status;
    throw err;
  }
  return body;
}

ipcMain.handle('org-status', async () => {
  const session = loadOrgSession();
  // Backfill the marker on first org-status hit when a session already
  // exists from before the marker code shipped — without this, anyone
  // who signed in on a previous build would lose the sidebar CTA on
  // their next sign-out / expiry because their session predates the
  // marker file. `everSignedIn` therefore treats "has live session OR
  // marker file" as equivalent past-sign-in proof.
  const knownBefore = hasOrgEverBeenSignedIn();
  if (session && !knownBefore) markOrgKnown();
  const everSignedIn = knownBefore || Boolean(session);
  if (!session) {
    // The session file may have vanished without a sign-out/expiry trigger
    // (crashed mid-sign-out, manual delete) while Python still says
    // 'adapter' — heal that here too, not just in get-ai-provider. The
    // reconcile no-ops on decrypt failures, so a locked keychain landing
    // in this branch changes nothing.
    reconcileAiProviderWithOrgSession().catch(() => {});
    return { signedIn: false, everSignedIn };
  }
  // Previously this returned signedIn:true as long as the session file
  // existed, even if the JWT had long since expired. The renderer would
  // happily show a "signed in" sticker until the user actually triggered
  // an authenticated request and got booted by a 401. Validate the JWT's
  // exp claim here so the UI reflects truth at startup.
  if (isJwtExpired(session.token)) {
    clearOrgSession();
    // If the user was on 'adapter', drop them back to 'local' so the next
    // summary attempt doesn't error out with "adapter not configured".
    // Same reasoning as the explicit-logout path; both end the session.
    restorePreAdapterProvider().catch(() => {});
    return { signedIn: false, everSignedIn };
  }
  // Hard lock: heal any provider drift while the session is valid.
  // Fire-and-forget — this handler is hot (the sidebar refetches it on
  // focus/mount) and must not block on a Python subprocess; the memoed
  // fast path makes repeated consistent checks free.
  reconcileAiProviderWithOrgSession().catch(() => {});
  return {
    signedIn: true,
    everSignedIn,
    // Surfaced so the renderer can schedule a precise setTimeout to
    // invalidate this query the instant the JWT expires — no polling,
    // no stale UI in the "app left open all day" case.
    exp: decodeJwtExp(session.token) ?? undefined,
    adapterUrl: session.adapterUrl,
    email: session.email,
    name: session.name,
    orgId: session.orgId,
  };
});

ipcMain.handle('org-login', async (_event, payload) => {
  try {
    const { adapterUrl, email, password } = payload || {};
    const url = normaliseAdapterUrl(adapterUrl);
    if (!url) return { success: false, error: 'adapter URL is required' };
    if (!email || !password) return { success: false, error: 'email and password are required' };
    const res = await net.fetch(url + '/auth/login', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email, password }),
      credentials: 'omit',
    });
    const text = await res.text();
    let body;
    try {
      body = text ? JSON.parse(text) : {};
    } catch {
      body = { detail: text };
    }
    if (!res.ok) return { success: false, error: body.detail || ('HTTP ' + res.status) };
    const session = {
      adapterUrl: url,
      token: body.token,
      email: body.email,
      name: body.name,
      orgId: body.org_id,
    };
    if (!saveOrgSession(session)) return { success: false, error: 'failed to persist session' };
    markOrgKnown();
    // Fire-and-forget — sign-in shouldn't wait on a config write.
    autoSwitchToAdapterOnSignIn().catch(() => {});
    // Seed the auto-backup toggle from the org's auto_share_default (only
    // if the user hasn't set it). Fire-and-forget for the same reason.
    seedOrgAutoBackupDefault().catch(() => {});
    return {
      success: true,
      signedIn: true,
      adapterUrl: url,
      email: body.email,
      name: body.name,
      orgId: body.org_id,
    };
  } catch (e) {
    return { success: false, error: e.message };
  }
});

ipcMain.handle('org-logout', async () => {
  clearOrgSession();
  // Await the restore — the user just clicked sign-out and expects the
  // app to settle into the signed-out state before returning. If we
  // fire-and-forget here there's a race window where Python config
  // still says 'adapter' but the env vars are already gone, and any
  // AI op triggered in that window fails with "adapter not configured".
  // org-status's stale-session path stays fire-and-forget because that
  // handler is called frequently and any blocking would slow the UI.
  try {
    await restorePreAdapterProvider();
  } catch (_) {}
  return { success: true };
});

// ─── Google OIDC sign-in ─────────────────────────────────────────────────────
// Loopback-redirect OAuth flow for installed apps (RFC 8252):
//   1. Generate state + PKCE code_verifier locally.
//   2. Start a one-shot HTTP server on a random localhost port.
//   3. Ask the adapter to mint the Google authorize_url (it knows the
//      client_id; the client_secret never leaves the adapter).
//   4. Open the user's system browser. They sign in with Google; Google
//      redirects back to http://127.0.0.1:<port>/callback?code=...&state=...
//   5. Capture code + state, verify state, send (code, code_verifier,
//      redirect_uri) to the adapter's /callback. The adapter exchanges +
//      verifies the ID token + mints a session JWT in the same shape as
//      /auth/login.
//   6. Persist the session via the existing saveOrgSession path.
//
// Times out after 5 minutes of inactivity to avoid stranded servers.

function _ssoRandUrlSafe(bytes) {
  return crypto.randomBytes(bytes).toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/g, '');
}

function _ssoCodeChallenge(verifier) {
  return crypto.createHash('sha256').update(verifier).digest('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/g, '');
}

async function _ssoOpenLoopback() {
  // Returns { server, port, waitForCallback(state, timeoutMs) }. The callback
  // promise resolves with the validated `code`, or rejects on state mismatch /
  // user denial / timeout. Always closes the server on resolution.
  return new Promise((resolve, reject) => {
    const server = http.createServer();
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      let resolved = false;
      const waitForCallback = (state, timeoutMs = 5 * 60 * 1000) =>
        new Promise((res, rej) => {
          const timer = setTimeout(() => {
            cleanup();
            rej(new Error('SSO timed out waiting for browser callback'));
          }, timeoutMs);
          const cleanup = () => {
            clearTimeout(timer);
            if (!resolved) {
              resolved = true;
              try { server.close(); } catch (_) {}
            }
          };
          server.on('request', (req, sres) => {
            // We only care about the /callback path; ignore favicon etc.
            const u = new URL(req.url, `http://127.0.0.1:${port}`);
            if (u.pathname !== '/callback') {
              sres.writeHead(404).end('not found');
              return;
            }
            const code = u.searchParams.get('code');
            const cbState = u.searchParams.get('state');
            const error = u.searchParams.get('error');
            sres.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
            if (error) {
              sres.end(
                `<html><body style="font:14px -apple-system;padding:40px">` +
                `Sign-in failed: <code>${String(error).slice(0, 80)}</code>. ` +
                `You can close this window.</body></html>`,
              );
              cleanup();
              rej(new Error(`Google returned error: ${error}`));
              return;
            }
            if (!code || cbState !== state) {
              sres.end(
                `<html><body style="font:14px -apple-system;padding:40px">` +
                `Sign-in failed: bad state or missing code. Close this window and retry.` +
                `</body></html>`,
              );
              cleanup();
              rej(new Error('Bad state or missing code on callback'));
              return;
            }
            sres.end(
              `<html><body style="font:14px -apple-system;padding:40px;color:#1B1B19;background:#FAF9F5">` +
              `<h2 style="font-family:Georgia,serif;font-weight:400;margin:0 0 8px">Signed in.</h2>` +
              `You can close this window and return to Steno.</body></html>`,
            );
            cleanup();
            res(code);
          });
        });
      resolve({ server, port, waitForCallback });
    });
  });
}

ipcMain.handle('org-sso-google-start', async (_event, payload) => {
  let loopback = null;
  try {
    const adapterUrl = normaliseAdapterUrl(payload && payload.adapterUrl);
    if (!adapterUrl) return { success: false, error: 'adapter URL is required' };

    // 1. PKCE + state.
    const codeVerifier = _ssoRandUrlSafe(64);
    const codeChallenge = _ssoCodeChallenge(codeVerifier);
    const state = _ssoRandUrlSafe(16);

    // 2. Open the loopback server. Keep the handle so any pre-callback
    //    failure (adapter /start 4xx, openExternal throws) can close it
    //    immediately instead of waiting for the 5-minute timeout to fire.
    loopback = await _ssoOpenLoopback();
    const { port, waitForCallback } = loopback;
    const redirectUri = `http://127.0.0.1:${port}/callback`;

    // 3. Ask the adapter to mint the authorize URL.
    const startRes = await net.fetch(adapterUrl + '/auth/sso/google/start', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        redirect_uri: redirectUri,
        code_challenge: codeChallenge,
        state,
      }),
      credentials: 'omit',
    });
    const startBody = await startRes.json().catch(() => ({}));
    if (!startRes.ok) {
      try { loopback.server.close(); } catch (_) {}
      return { success: false, error: startBody.detail || `HTTP ${startRes.status}` };
    }

    // 4. Open browser.
    await shell.openExternal(startBody.authorize_url);

    // 5. Wait for the callback (5-minute hard cap). waitForCallback closes
    //    the server itself on resolve/reject.
    const code = await waitForCallback(state, 5 * 60 * 1000);

    // 6. Exchange via the adapter.
    const cbRes = await net.fetch(adapterUrl + '/auth/sso/google/callback', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        code,
        code_verifier: codeVerifier,
        redirect_uri: redirectUri,
      }),
      credentials: 'omit',
    });
    const cbBody = await cbRes.json().catch(() => ({}));
    if (!cbRes.ok) {
      return { success: false, error: cbBody.detail || `HTTP ${cbRes.status}` };
    }

    // 7. Persist + return same envelope as /org-login.
    const session = {
      adapterUrl,
      token: cbBody.token,
      email: cbBody.email,
      name: cbBody.name,
      orgId: cbBody.org_id,
    };
    if (!saveOrgSession(session)) return { success: false, error: 'failed to persist session' };
    markOrgKnown();
    // Fire-and-forget — sign-in shouldn't wait on a config write.
    autoSwitchToAdapterOnSignIn().catch(() => {});
    // Seed the auto-backup toggle from the org's auto_share_default (only
    // if the user hasn't set it). Fire-and-forget for the same reason.
    seedOrgAutoBackupDefault().catch(() => {});
    return {
      success: true,
      signedIn: true,
      adapterUrl,
      email: cbBody.email,
      name: cbBody.name,
      orgId: cbBody.org_id,
    };
  } catch (e) {
    // Any other throw (openExternal failed, etc.) — make sure the loopback
    // server isn't orphaned.
    if (loopback && loopback.server && loopback.server.listening) {
      try { loopback.server.close(); } catch (_) {}
    }
    return { success: false, error: e.message };
  }
});

ipcMain.handle('org-list-meetings', async () => {
  try {
    const body = await adapterFetch('/meetings');
    return { success: true, meetings: body.meetings || [] };
  } catch (e) {
    return { success: false, error: e.message };
  }
});

ipcMain.handle('org-get-meeting', async (_event, id) => {
  try {
    const meeting = await adapterFetch('/meetings/' + encodeURIComponent(String(id)));
    return { success: true, meeting };
  } catch (e) {
    return { success: false, error: e.message };
  }
});

ipcMain.handle('org-create-meeting', async (_event, payload) => {
  try {
    const meeting = await adapterFetch('/meetings', {
      method: 'POST',
      body: JSON.stringify(payload || {}),
    });
    return { success: true, meeting };
  } catch (e) {
    return { success: false, error: e.message };
  }
});

ipcMain.handle('org-delete-meeting', async (_event, id) => {
  try {
    const body = await adapterFetch('/meetings/' + encodeURIComponent(String(id)), {
      method: 'DELETE',
    });
    return { success: true, id: body.id };
  } catch (e) {
    return { success: false, error: e.message };
  }
});

// Per-note share state lookup for the meeting detail page's Share/Unshare
// toggle. Reads the persistent `.org-backup-state.json` flag rather than
// transient UI state — so a note that was auto-backed-up at processing
// time, or shared from a different window, still reads as `shared: true`.
ipcMain.handle('org-get-backup-state', async (_event, summaryFile) => {
  try {
    if (!summaryFile) return { success: false, error: 'summaryFile is required' };
    return { success: true, ...getOrgBackupEntry(summaryFile) };
  } catch (e) {
    return { success: false, error: e.message };
  }
});

// Unshare by summary file. Reads the local backup-state for `summaryFile`,
// deletes the org-side meeting via the adapter (best-effort — 404 means
// it's already gone), then clears the local attempt flag so a subsequent
// Share / auto-share re-uploads instead of being skipped as already-attempted.
// Any non-404 adapter error aborts before we touch the local flag so the
// two stores can't desync (local says "not shared", org still has the
// meeting). If the local clear fails (disk full / permissions), we surface
// the failure rather than reporting success — otherwise the toggle would
// keep showing "Unshare" against an org that's already empty and the user
// would have no signal that they need to retry.
ipcMain.handle('org-unshare-by-summary', async (_event, summaryFile) => {
  try {
    if (!summaryFile) return { success: false, error: 'summaryFile is required' };
    const entry = getOrgBackupEntry(summaryFile);
    let adapterStatus = 'no-meeting-id';
    if (entry.meeting_id) {
      try {
        await adapterFetch('/meetings/' + encodeURIComponent(String(entry.meeting_id)), {
          method: 'DELETE',
        });
        adapterStatus = 'deleted';
      } catch (e) {
        if (e && e.status === 404) {
          adapterStatus = 'already-gone';
        } else {
          return { success: false, error: e.message };
        }
      }
    }
    if (!clearOrgBackupAttempt(summaryFile)) {
      return {
        success: false,
        error: 'unshared on the org but could not clear the local share flag — retry',
      };
    }
    return { success: true, meeting_id: entry.meeting_id, adapter_status: adapterStatus };
  } catch (e) {
    return { success: false, error: e.message };
  }
});

// Three-step upload reused by both org-share-meeting and org-try-auto-backup:
// presign → PUT bytes to S3 → register meeting metadata with the s3_key.
// Throws on any failure; callers shape the IPC return value and persist
// attempt state. Centralised in main so the renderer doesn't have to do
// raw PUT (and so we can keep the bytes off the renderer when the bucket
// has stricter CORS).
async function uploadMeetingToOrg({ title, body, transcript = '', visibility = 'org' }) {
  const safeTitle = String(title)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60) || 'note';
  const filename = `${safeTitle}.md`;

  // Step 1: presign — adapter returns a 15-minute PUT URL + s3_key
  const presign = await adapterFetch('/uploads/presign', {
    method: 'POST',
    body: JSON.stringify({ filename, content_type: 'text/markdown' }),
  });

  // Step 2: PUT the markdown bytes straight to S3. Bucket has SSE-AES256
  // by default; the upload inherits that.
  const putRes = await net.fetch(presign.upload_url, {
    method: 'PUT',
    headers: { 'content-type': 'text/markdown' },
    body,
    // Presigned URL carries its own auth in the query string — don't let the
    // session attach cookies/credentials to the S3 request.
    credentials: 'omit',
  });
  if (!putRes.ok) {
    const detail = await putRes.text().catch(() => '');
    throw new Error(`s3 upload failed (${putRes.status}): ${detail.slice(0, 200)}`);
  }

  // Step 2b (optional): second presign+PUT for the transcript when one was
  // supplied. Kept as a separate S3 object (rather than appended to the
  // markdown body) so the desktop can lazily render it in the floating
  // transcript panel instead of inline below the summary — matches the
  // local-note UX. Failure here is non-fatal: the body upload already
  // succeeded, so we POST /meetings without a transcript_s3_key rather
  // than orphan an S3 object after rolling everything back.
  let transcriptKey = null;
  const transcriptText = String(transcript || '').trim();
  if (transcriptText) {
    try {
      const tPresign = await adapterFetch('/uploads/presign', {
        method: 'POST',
        body: JSON.stringify({
          filename: `${safeTitle}.transcript.txt`,
          content_type: 'text/plain',
        }),
      });
      const tPut = await net.fetch(tPresign.upload_url, {
        method: 'PUT',
        headers: { 'content-type': 'text/plain' },
        body: transcriptText,
        credentials: 'omit',
      });
      if (tPut.ok) {
        transcriptKey = tPresign.s3_key;
      } else {
        const detail = await tPut.text().catch(() => '');
        console.warn(`transcript upload failed (${tPut.status}): ${detail.slice(0, 200)}`);
      }
    } catch (err) {
      console.warn(
        'transcript upload skipped:',
        err instanceof Error ? err.message : String(err),
      );
    }
  }

  // Step 3: register metadata in the adapter. The body field is empty —
  // the adapter holds only the s3_key (+ optional transcript_s3_key) and
  // serves a presigned GET / inlined body when someone in the org opens
  // the note.
  const meeting = await adapterFetch('/meetings', {
    method: 'POST',
    body: JSON.stringify({
      title,
      body: '',
      visibility,
      s3_key: presign.s3_key,
      ...(transcriptKey ? { transcript_s3_key: transcriptKey } : {}),
    }),
  });

  return { meeting, s3_key: presign.s3_key, transcript_s3_key: transcriptKey };
}

ipcMain.handle('org-share-meeting', async (_event, payload) => {
  try {
    const { title, body, transcript, visibility = 'org', summaryFile } = payload || {};
    if (!title) return { success: false, error: 'title is required' };
    if (typeof body !== 'string') return { success: false, error: 'body is required' };

    const { meeting, s3_key } = await uploadMeetingToOrg({ title, body, transcript, visibility });
    // Mark this note as having been attempted so a later auto-backup
    // trigger (e.g. a reprocess that re-fires processing-complete)
    // doesn't push a second copy into the org.
    if (summaryFile) recordOrgBackupAttempt(summaryFile, meeting?.id);
    return { success: true, meeting, s3_key };
  } catch (e) {
    // Record the failure so a manual Share that fails also leaves a
    // persistent, retryable indicator on the note (mirrors auto-backup).
    const sf = payload?.summaryFile;
    if (sf) recordOrgBackupFailure(sf, e.message);
    return { success: false, error: e.message };
  }
});

ipcMain.handle('org-get-auto-backup', async () => {
  try {
    const result = await runPythonScript('simple_recorder.py', ['get-org-auto-backup']);
    const jsonData = JSON.parse(result.trim());
    return { success: true, ...jsonData };
  } catch (e) {
    return { success: false, error: e.message };
  }
});

ipcMain.handle('org-set-auto-backup', async (_event, enabled) => {
  try {
    const result = await runPythonScript(
      'simple_recorder.py',
      ['set-org-auto-backup', enabled ? 'True' : 'False'],
    );
    const jsonMatch = result.match(/\{.*\}/s);
    if (jsonMatch) return JSON.parse(jsonMatch[0]);
    return { success: true, org_auto_backup_enabled: enabled };
  } catch (e) {
    return { success: false, error: e.message };
  }
});

// Enterprise policy published by the adapter (GET /policy, authenticated).
// Shape: { auto_share_default, shared_notes_enabled }. The desktop honors
// these in the UI; the adapter also enforces the security-relevant half
// (shared_notes_enabled) server-side.
async function fetchOrgPolicy() {
  return adapterFetch('/policy');
}

ipcMain.handle('org-get-policy', async () => {
  try {
    const policy = await fetchOrgPolicy();
    return { success: true, policy };
  } catch (e) {
    return { success: false, error: e.message };
  }
});

// Seed the local auto-backup toggle from the adapter's auto_share_default
// on sign-in. "Default only" contract: Python only writes the value when
// the user has no stored preference, so an explicit user choice is never
// clobbered on a later sign-in. Fire-and-forget — on any failure the
// historical default (true) stays in place.
async function seedOrgAutoBackupDefault() {
  try {
    const policy = await fetchOrgPolicy();
    const def = policy?.auto_share_default !== false; // default true
    await runPythonScript('simple_recorder.py', ['seed-org-auto-backup', def ? 'True' : 'False']);
  } catch (e) {
    sendDebugLog('seed-org-auto-backup-default: ' + (e?.message || e));
  }
}

// Single-shot auto-backup gateway. The renderer fires this once per
// processing-complete event; main does all the gating (signed in + toggle
// on + not previously attempted) so the renderer doesn't have to chain
// three IPC calls. Records the attempt only on a successful upload so a
// transient failure can self-heal next time. After a successful upload we
// mark the summary as attempted *permanently* — that's what makes unshare
// stick (the user pressed unshare, we won't re-push it without an explicit
// manual Share).
ipcMain.handle('org-try-auto-backup', async (_event, payload) => {
  try {
    const { summaryFile, title, body, transcript, visibility = 'org' } = payload || {};
    if (!summaryFile) return { attempted: false, reason: 'missing-summary-file' };
    if (!title) return { attempted: false, reason: 'missing-title' };
    if (typeof body !== 'string') return { attempted: false, reason: 'missing-body' };

    const session = loadOrgSession();
    if (!session) return { attempted: false, reason: 'not-signed-in' };

    // Read the stored preference first. get-org-auto-backup reports whether a
    // preference actually exists (org_auto_backup_preference_set), which lets
    // us skip the /policy fetch + seed subprocess entirely once one does —
    // steady-state backups only need the stored value (issue #192).
    //
    // Fail closed: any error / unparseable output treats the toggle as
    // disabled. A privacy + sharing setting should never default ON via a
    // transient read failure — if the user enabled it, they can do so again
    // explicitly. The regex match guards against stray Python stderr/stdout
    // noise around the JSON payload.
    const readAutoBackup = async () => {
      const cfg = await runPythonScript('simple_recorder.py', ['get-org-auto-backup']);
      const jsonMatch = cfg.match(/\{.*\}/s);
      const parsed = jsonMatch ? JSON.parse(jsonMatch[0]) : null;
      return {
        enabled: parsed ? parsed.org_auto_backup_enabled !== false : false,
        isSet: parsed ? parsed.org_auto_backup_preference_set === true : false,
      };
    };

    let enabled = false;
    let isSet = false;
    try {
      ({ enabled, isSet } = await readAutoBackup());
    } catch (_) {
      sendDebugLog('org-try-auto-backup: failed to read auto-backup pref, treating as disabled');
      return { attempted: false, reason: 'disabled' };
    }

    // Only when the preference is genuinely unset do we close the sign-in
    // seeding race (cubic P1): the sign-in handler seeds the auto-backup
    // default fire-and-forget, so a recording that finishes right after
    // sign-in could reach this gate before the org's auto_share_default has
    // been written — and an unset pref reads as enabled (!== false), which
    // would auto-share against an org policy of auto_share_default=false.
    // seedOrgAutoBackupDefault is idempotent (writes only when no pref exists,
    // swallows its own errors), so awaiting it here deterministically
    // materialises the policy default before we re-read and decide. The
    // adapter is necessarily reachable on the path that actually uploads, so
    // this fetch is the same reachability the share itself needs. Once a
    // preference exists we skip this entirely.
    if (!isSet) {
      await seedOrgAutoBackupDefault();
      try {
        ({ enabled, isSet } = await readAutoBackup());
      } catch (_) {
        sendDebugLog('org-try-auto-backup: failed to read auto-backup pref, treating as disabled');
        return { attempted: false, reason: 'disabled' };
      }
      // If the seed didn't actually materialise a preference — adapter
      // unreachable, seed subprocess failure, or a failed config write —
      // the pref is still unset and `enabled` is only the historical default
      // (true). Fail closed rather than auto-share against an org policy of
      // auto_share_default=false that we couldn't read/persist. The user can
      // re-enable explicitly, and the next recording re-attempts the seed.
      if (!isSet) return { attempted: false, reason: 'disabled' };
    }
    if (!enabled) return { attempted: false, reason: 'disabled' };

    if (isOrgBackupAttempted(summaryFile)) {
      return { attempted: false, reason: 'already-attempted' };
    }

    // Reuse the proven manual-share path verbatim. On failure we do NOT
    // record the attempt — leaves the door open for a retry next time
    // something pokes this path.
    try {
      const { meeting, s3_key } = await uploadMeetingToOrg({ title, body, transcript, visibility });
      recordOrgBackupAttempt(summaryFile, meeting?.id);
      return { attempted: true, meeting, s3_key };
    } catch (e) {
      // Persist the failure (without marking the note attempted) so the
      // renderer can surface a "Backup failed · Retry" affordance instead
      // of the failure being silently console.warn'd. Scoped to the actual
      // upload attempt — pre-upload faults (session read, policy seed) fall
      // through to the outer catch and are NOT recorded as a backup failure,
      // so a transient setup hiccup doesn't surface a misleading
      // "Not backed up" chip.
      recordOrgBackupFailure(summaryFile, e.message);
      return { attempted: false, reason: 'upload-failed', error: e.message };
    }
  } catch (e) {
    return { attempted: false, reason: 'error', error: e.message };
  }
});

ipcMain.handle('org-ai-chat', async (_event, payload) => {
  try {
    const body = await adapterFetch('/ai/chat', {
      method: 'POST',
      body: JSON.stringify(payload || {}),
    });
    return { success: true, ...body };
  } catch (e) {
    return { success: false, error: e.message };
  }
});

// Streaming variant of /ai/chat. Renderer hands us a streamId; we forward
// chunks via the same query-chunk / query-done events the local Python
// stream uses, so the existing useStreamingQuery infra works unchanged.
const orgStreamAborters = new Map();

ipcMain.on('org-chat-stream', async (event, streamId, payload) => {
  const sender = event.sender;
  // Wrap every send through this guard — the renderer can be destroyed
  // (window close, hard reload) mid-stream, after which sender.send() will
  // throw "Object has been destroyed". We also abort the upstream HTTP
  // stream when the sender goes away so we stop pulling bytes from the
  // adapter for a renderer that no longer exists.
  const safeSend = (channel, payload) => {
    if (sender.isDestroyed()) return;
    try { sender.send(channel, payload); } catch (_) { /* destroyed mid-send */ }
  };

  const session = loadOrgSession();
  if (!session) {
    safeSend('query-done', { queryId: streamId, success: false, error: 'not signed in to org adapter' });
    return;
  }
  const controller = new AbortController();
  orgStreamAborters.set(streamId, controller);
  const onDestroyed = () => {
    try { controller.abort(); } catch (_) {}
  };
  sender.once('destroyed', onDestroyed);

  try {
    const res = await net.fetch(session.adapterUrl + '/ai/chat/stream', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: 'Bearer ' + session.token,
      },
      body: JSON.stringify(payload || {}),
      signal: controller.signal,
      credentials: 'omit',
    });
    if (!res.ok) {
      let detail = '';
      try { detail = await res.text(); } catch (_) {}
      if (res.status === 401) {
        // Same reasoning as the orgFetch 401 path above — clear the
        // session AND restore pre-adapter provider so future processing
        // doesn't hit "adapter not configured".
        clearOrgSession();
        restorePreAdapterProvider().catch(() => {});
      }
      safeSend('query-done', { queryId: streamId, success: false, error: `HTTP ${res.status}: ${detail.slice(0, 200)}` });
      return;
    }
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let success = true;
    let errorMsg = null;
    while (true) {
      if (sender.isDestroyed()) {
        try { controller.abort(); } catch (_) {}
        return;
      }
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let nl;
      while ((nl = buffer.indexOf('\n')) !== -1) {
        const line = buffer.slice(0, nl);
        buffer = buffer.slice(nl + 1);
        const trimmed = line.trim();
        if (!trimmed) continue;
        let obj;
        try { obj = JSON.parse(trimmed); } catch (_) { continue; }
        if (obj.type === 'chunk' && obj.text) {
          safeSend('query-chunk', { queryId: streamId, chunk: obj.text });
        } else if (obj.type === 'error') {
          success = false;
          errorMsg = obj.error;
        }
        // 'done' lines carry usage info; we don't surface it for now.
      }
    }
    safeSend('query-done', { queryId: streamId, success, error: errorMsg });
  } catch (e) {
    if (e.name === 'AbortError') {
      safeSend('query-done', { queryId: streamId, success: false, error: 'cancelled' });
    } else {
      safeSend('query-done', { queryId: streamId, success: false, error: e.message });
    }
  } finally {
    orgStreamAborters.delete(streamId);
    try { sender.removeListener('destroyed', onDestroyed); } catch (_) {}
  }
});
