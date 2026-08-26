// Linux system-audio loopback.
//
// macOS captures system audio via a CoreAudio Process Tap and Windows via
// Chromium's WASAPI loopback, both reached through the renderer's
// getDisplayMedia({video:true, audio:true}) call (see main.js's
// setDisplayMediaRequestHandler and electron-audio-loopback's initMain).
// That path does NOT translate cleanly to Linux: under Wayland,
// getDisplayMedia's video capture goes through xdg-desktop-portal's
// ScreenCast interface, which shows the user a screen/window picker dialog —
// even though the video track would be immediately discarded. That's a real
// UX regression versus mac/Windows, where no dialog appears.
//
// This module instead talks to PipeWire directly, bypassing Chromium's
// capture path entirely: PipeWire exposes every sink's "monitor" ports to any
// client with normal desktop-session access (the same mechanism PulseAudio's
// ".monitor" sources used), so a plain audio-only capture needs no portal
// and shows no picker. main.js wires this into isSystemAudioSupported() and
// IPC handlers (start-linux-loopback/stop-linux-loopback); the renderer side
// (useSystemAudioCapture.ts + lib/linuxLoopbackStream.ts) wraps the incoming
// PCM in a MediaStreamTrackGenerator so it drops into the SAME
// createMediaStreamSource(sysStream) call already used for mic/mac/Windows.

const { spawn, spawnSync } = require('child_process');

// pw-record ships in the `pipewire-bin` package, which Ubuntu's default
// desktop image pulls in automatically as a dependency of pipewire-audio
// (confirmed via `apt-mark showmanual` showing it was never manually
// installed) — no bundling needed, unlike ffmpeg/Ollama.
//
// True only on Linux with pw-record actually runnable. A stock Ubuntu
// desktop always has this; a minimal/headless install or a PulseAudio-only
// setup (rare on modern Ubuntu, but not impossible) does not — callers must
// treat this as a runtime capability check, not a platform check. Checking
// pw-record alone is enough: getDefaultSinkName()/startLoopbackCapture()
// below throw their own clear errors if there's no live session when
// capture actually starts.
function isLinuxLoopbackSupported() {
  if (process.platform !== 'linux') return false;
  return spawnSync('pw-record', ['--version']).error?.code !== 'ENOENT';
}

// Resolves the current default output device's PipeWire node NAME (not a
// numeric id — ids are per-session and can change; the name survives device
// hot-swaps and is what PipeWire's own "default" metadata object tracks).
// pw-record accepts a node name directly via --target, confirmed by hand.
function getDefaultSinkName() {
  const result = spawnSync('pw-dump', [], { maxBuffer: 32 * 1024 * 1024 });
  if (result.status !== 0) {
    throw new Error(`pw-dump failed: ${result.stderr?.toString() || result.status}`);
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

// Starts capturing the default sink's monitor (i.e. "what's playing") as
// raw interleaved PCM on stdout — no WAV header, no portal dialog, no video
// track to discard. This mirrors the RAW format the live-transcript tap
// already pushes over IPC (see useSystemAudioCapture.ts's tapNode), so a
// real integration could pipe this straight into the same downsample +
// IPC-push logic instead of inventing a new wire format.
//
// Returns { proc, stop } — stop() sends SIGTERM and resolves once the
// process has actually exited (matching main.js's convention elsewhere of
// awaiting subprocess teardown rather than fire-and-forget kill()).
function startLoopbackCapture({ sinkName, sampleRate = 48000, channels = 2, onError } = {}) {
  const target = sinkName || getDefaultSinkName();
  const proc = spawn('pw-record', [
    `--target=${target}`,
    '--format=s16',
    `--rate=${sampleRate}`,
    `--channels=${channels}`,
    '-', // stdout, raw PCM
  ]);
  proc.on('error', (err) => onError?.(err));
  proc.stderr.on('data', () => {}); // pw-record logs progress to stderr; not an error signal
  const stop = () =>
    new Promise((resolve) => {
      if (proc.exitCode !== null || proc.signalCode !== null) return resolve();
      proc.once('exit', () => resolve());
      proc.kill('SIGTERM');
    });
  return { proc, stdout: proc.stdout, stop, target, sampleRate, channels };
}

module.exports = { isLinuxLoopbackSupported, getDefaultSinkName, startLoopbackCapture };
