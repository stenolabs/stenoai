'use strict';

// Bundle-id allowlist for auto-detect "Meeting detected" notifications.
// Prefix match catches helper sub-processes.
const MEETING_APP_ALLOWLIST = [
  // Native videoconf / meeting apps
  /^us\.zoom\.xos/,                    // Zoom
  /^com\.microsoft\.teams/,            // Microsoft Teams (classic + new "teams2")
  /^com\.cisco\.webexmeetingsapp/,     // Cisco Webex
  /^com\.webex\.meetingmanager/,       // Cisco Webex (alt id)
  /^com\.apple\.FaceTime/,             // FaceTime
  /^com\.apple\.avconferenced/,        // FaceTime / Phone.app / Continuity call audio
  /^com\.hnc\.Discord/,                // Discord
  /^com\.tinyspeck\.slackmacgap/,      // Slack (huddles)
  /^com\.logmein\.GoToMeeting/,        // GoToMeeting
  /^com\.bluejeansnet\.BlueJeans/,     // BlueJeans
  /^co\.pop\.desktop/,                 // Pop
  /^com\.google\.meetings/,            // Google Meet (standalone PWA)
  /^com\.apple\.VoiceMemos/,           // Apple Voice Memos
  // Browsers — most web meetings route mic capture through here
  /^com\.apple\.WebKit/,               // Safari (helper)
  /^com\.apple\.Safari/,               // Safari (main)
  /^com\.google\.Chrome/,              // Chrome (+ helpers)
  /^org\.chromium\./,                  // Chromium
  /^com\.microsoft\.edgemac/,          // Edge
  /^company\.thebrowser\./i,           // Arc (app: …thebrowser.Browser, helpers: …thebrowser.browser.helper)
  /^com\.brave\.Browser/,              // Brave
  /^org\.mozilla\./,                   // Firefox
];

// Decide whether an app_id-less ("device-level") mic event should still be
// treated as a meeting. macOS 12/13 emit device-level signals with no app_id,
// so the legacy fallback notifies regardless. macOS 14+ always provides an
// app_id, so an app_id-less event there is an AEC / system-audio artifact
// (e.g. a notification ping briefly opening the mic), NOT a meeting — see #262.
function allowsDeviceLevelFallback(platform, systemVersion) {
  if (platform !== 'darwin') return false;
  const major = parseInt(String(systemVersion).split('.')[0], 10);
  if (!Number.isFinite(major)) return false;
  return major < 14;
}

// Whether the auto-detect-meetings watcher may run on this OS. The mic-monitor
// only has a reliable per-app signal on macOS 14+; on macOS 12/13 it falls back
// to a coarse device-level ("an app") signal that misfires (see #116, #262), so
// we gate the whole feature to macOS 14+ and never spawn the watcher below it.
// Non-darwin returns false — auto-detect is a macOS-only feature.
//
// Parse direction on failure is PERMISSIVE: an unparseable version returns true.
// Auto-detect is opt-in and the <14 device-level path is exactly what we're
// removing, so a parse hiccup must not silently disable the feature for a real
// 14+ user. The worst case — a genuinely old-but-unparseable system — is the
// pre-existing coarse fallback, which the mic-monitor binary itself still guards.
function isMacos14Plus(platform, systemVersion) {
  if (platform !== 'darwin') return false;
  const major = parseInt(String(systemVersion).split('.')[0], 10);
  if (!Number.isFinite(major)) return true; // permissive on parse failure — see above
  return major >= 14;
}

function isMeetingApp(evt, { allowDeviceLevelFallback = false } = {}) {
  if (!evt) return false;
  if (!evt.app_id) return allowDeviceLevelFallback;
  return MEETING_APP_ALLOWLIST.some((re) => re.test(evt.app_id));
}

module.exports = { MEETING_APP_ALLOWLIST, isMeetingApp, allowsDeviceLevelFallback, isMacos14Plus };
