// Menu bar recording indicator (macOS).
//
// The tray icon stays a template image so macOS keeps tinting it for light
// and dark menu bars. The recording state is a title beside it: a small red
// dot and the elapsed time while recording, so the time reads as "recording
// for" rather than as a second clock, even on macOS versions that don't
// highlight a menu bar item using the mic. A pause mark and the frozen time
// while paused. Electron's Tray.setTitle renders ANSI colour codes on macOS,
// which is what lets only the dot be red.
//
// Windows has no tray title, so it keeps the icon swap in main.js.

const ANSI_RED = '\x1b[31m';
const ANSI_RESET = '\x1b[0m';
const RECORDING_DOT = '•'; // bullet: about a third of the size of U+25CF
const PAUSED_MARK = '❚❚'; // heavy vertical bars

function formatTrayElapsed(totalSeconds) {
  const s = Math.max(0, Math.floor(Number(totalSeconds) || 0));
  const hours = Math.floor(s / 3600);
  const minutes = Math.floor((s % 3600) / 60);
  const seconds = s % 60;
  const ss = String(seconds).padStart(2, '0');
  if (hours > 0) {
    return `${hours}:${String(minutes).padStart(2, '0')}:${ss}`;
  }
  return `${minutes}:${ss}`;
}

// The title shown beside the tray icon. Empty when nothing is recording, so
// the idle menu bar is just the dragonfly.
function buildTrayRecordingTitle({ recording, paused, elapsedSeconds }) {
  if (!recording) return '';
  const time = formatTrayElapsed(elapsedSeconds);
  if (paused) return `${PAUSED_MARK} ${time}`;
  return `${ANSI_RED}${RECORDING_DOT}${ANSI_RESET} ${time}`;
}

function buildTrayTooltip({ recording, paused }) {
  if (!recording) return 'Steno';
  return paused ? 'Steno - Recording paused' : 'Steno - Recording';
}

module.exports = {
  formatTrayElapsed,
  buildTrayRecordingTitle,
  buildTrayTooltip,
};
