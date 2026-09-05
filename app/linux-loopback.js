// Linux system-audio loopback.
//
// WHY NOT getDisplayMedia (the mac/Windows path): on Wayland its video capture
// goes through xdg-desktop-portal's ScreenCast interface, which shows a
// screen-share picker — for a video track we discard immediately. mac/Windows
// show no dialog, so that would be a real UX regression.
//
// PipeWire exposes every sink's monitor ports to any client with normal
// desktop-session access, so talking to it directly needs no portal and shows
// no picker. The renderer (lib/linuxLoopbackStream.ts) wraps the PCM in a
// MediaStreamTrackGenerator, landing in the same createMediaStreamSource call
// mac/Windows already use.

const { spawn, spawnSync } = require('child_process');

// Both tools ship in `pipewire-bin`, which Ubuntu's desktop image installs by
// default — nothing to bundle. A runtime capability check, not a platform one:
// status === 0 (rather than just "not ENOENT") so a present-but-unexecutable
// binary reports unsupported instead of failing mid-recording. pw-dump is
// checked too because getDefaultSinkName needs it.
function isRunnable(bin) {
  const probe = spawnSync(bin, ['--version']);
  return !probe.error && probe.status === 0;
}

function isLinuxLoopbackSupported() {
  if (process.platform !== 'linux') return false;
  return isRunnable('pw-record') && isRunnable('pw-dump');
}

// Runs queued operations one at a time. main.js serialises loopback start/stop
// on this: the start handler reads the active-capture ref and then awaits twice
// before assigning it, so two overlapping starts would each pass that check and
// the loser's pw-record would be orphaned. A rejected operation settles the
// queue without wedging later ones.
function createSerialQueue() {
  let tail = Promise.resolve();
  return (fn) => {
    const run = tail.then(fn, fn);
    tail = run.then(() => {}, () => {});
    return run;
  };
}

// Emits only whole frames, carrying a partial trailing frame into the next
// call — the renderer floors away any remainder it receives, which swaps L/R
// for the rest of the recording. Returns null when no complete frame is ready.
function createFrameAligner(frameBytes) {
  let pending = null;
  return (chunk) => {
    const buf = pending ? Buffer.concat([pending, chunk]) : chunk;
    const whole = buf.length - (buf.length % frameBytes);
    pending = whole < buf.length ? buf.subarray(whole) : null;
    return whole > 0 ? buf.subarray(0, whole) : null;
  };
}

// Resolves the current default output device's PipeWire node NAME (not a
// numeric id — ids are per-session and can change; the name survives device
// hot-swaps and is what PipeWire's own "default" metadata object tracks).
// pw-record accepts a node name directly via --target, confirmed by hand.
function getDefaultSinkName() {
  const result = spawnSync('pw-dump', [], { maxBuffer: 32 * 1024 * 1024 });
  // A spawn failure (pw-dump missing/unexecutable) leaves status null, so
  // report result.error first — otherwise this read as "pw-dump failed: null".
  if (result.error) throw new Error(`pw-dump could not run: ${result.error.message}`);
  if (result.status !== 0) {
    throw new Error(`pw-dump failed: ${result.stderr?.toString() || `exit ${result.status}`}`);
  }
  const objects = JSON.parse(result.stdout.toString());
  const defaultMeta = objects.find(
    (o) => o.type === 'PipeWire:Interface:Metadata' && o.props?.['metadata.name'] === 'default',
  );
  if (!defaultMeta) throw new Error('no PipeWire "default" metadata object found');
  const sinkEntry = defaultMeta.metadata.find((m) => m.key === 'default.audio.sink');
  const name = sinkEntry?.value?.name;
  if (!name) throw new Error('no default.audio.sink set in PipeWire metadata');
  return name;
}

// Captures the default sink's monitor as raw interleaved PCM on stdout.
// Resolves only once pw-record has actually spawned — otherwise a spawn error
// surfaces after the IPC handler already reported success, leaving the
// recording with a dead system channel. stop() SIGTERMs and awaits exit.
function startLoopbackCapture({ sinkName, sampleRate = 48000, channels = 2, onError } = {}) {
  const target = sinkName || getDefaultSinkName();
  const proc = spawn('pw-record', [
    `--target=${target}`,
    '--format=s16',
    `--rate=${sampleRate}`,
    `--channels=${channels}`,
    '-', // stdout, raw PCM
  ]);
  proc.stderr.on('data', () => {}); // pw-record logs progress to stderr; not an error signal
  const stop = () =>
    new Promise((resolve) => {
      if (proc.exitCode !== null || proc.signalCode !== null) return resolve();
      proc.once('exit', () => resolve());
      proc.kill('SIGTERM');
    });
  return new Promise((resolve, reject) => {
    proc.once('spawn', () => {
      // Past startup: further errors are a live-capture problem for the
      // caller's onError, not a failed start.
      proc.on('error', (err) => onError?.(err));
      resolve({ proc, stdout: proc.stdout, stop, target, sampleRate, channels });
    });
    proc.once('error', reject);
  });
}

module.exports = {
  isLinuxLoopbackSupported,
  getDefaultSinkName,
  startLoopbackCapture,
  createFrameAligner,
  createSerialQueue,
};
