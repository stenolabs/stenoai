#!/usr/bin/env node
// Manual end-to-end check for the Linux loopback renderer bridging (spike
// branch). Drives the REAL Electron app via Playwright's _electron API
// (same mechanism the repo's own e2e/fixtures/electron.ts uses), starts a
// recording, plays real audio into the default sink while it's running,
// stops it, and inspects the resulting file's channels with ffmpeg to prove
// system audio actually made it through: IPC chunk -> AudioData ->
// MediaStreamTrackGenerator -> AudioContext mix -> MediaRecorder -> disk.
//
// Not a permanent e2e spec — a throwaway verification script for this spike.
// Requires the renderer built (npm run build:renderer) and the PyInstaller
// backend at dist/stenoai/. Run from app/: node scripts/linux-loopback-e2e-check.js

const { _electron: electron } = require('playwright');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { execFileSync, spawn } = require('child_process');
const { measurePeakRms } = require('../../scripts/measure-pcm');

const APP_DIR = path.resolve(__dirname, '..');

async function main() {
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'stenoai-linux-loopback-check-'));
  // Mirrors e2e/fixtures/user-config.ts's enableDeterministicRecording: whisper
  // engine skips the parakeet-only live-transcript tap, system_audio_enabled
  // doesn't gate anything on non-mac (loopback is always-on when supported)
  // but is set for parity with the real fixture.
  fs.writeFileSync(
    path.join(userDataDir, 'config.json'),
    JSON.stringify({ system_audio_enabled: true, transcription_engine: 'whisper' }),
  );

  console.log('userDataDir:', userDataDir);

  const app = await electron.launch({
    args: [
      '.',
      // Fake the MIC only — system audio is real (that's what we're proving).
      '--use-fake-device-for-media-stream',
      '--use-fake-ui-for-media-stream',
    ],
    cwd: APP_DIR,
    env: {
      ...process.env,
      STENOAI_E2E: '1',
      STENOAI_E2E_HEADLESS: '1',
      STENOAI_USER_DATA_DIR: userDataDir,
    },
  });

  try {
    const page = await app.firstWindow();
    await page.waitForSelector('[data-app-ready]', { timeout: 30_000 });
    console.log('app ready');

    const support = await page.evaluate(() => window.stenoai.recording.getSystemAudioSupport());
    console.log('getSystemAudioSupport():', support);
    if (!support?.data?.supported && !support?.supported) {
      throw new Error('system audio not reported as supported — cannot proceed');
    }

    const started = await page.evaluate((name) => window.stenoai.recording.start(name), 'LoopbackCheck');
    console.log('start():', started);
    if (!started.success) throw new Error('recording start failed: ' + started.error);

    // Give the capture graph a moment to spin up (mic + Linux loopback IPC
    // start + AudioContext wiring) before we start playing audio.
    await new Promise((r) => setTimeout(r, 1000));

    console.log('playing test audio into the default sink...');
    const playProc = spawn('pw-play', ['--volume=1.0', '/usr/share/sounds/alsa/Front_Center.wav']);
    // Loop the short clip a few times to fill the recording window with signal.
    for (let i = 0; i < 4; i++) {
      await new Promise((r) => setTimeout(r, 900));
      spawn('pw-play', ['--volume=1.0', '/usr/share/sounds/alsa/Front_Center.wav']);
    }
    await new Promise((r) => setTimeout(r, 600));
    try { playProc.kill(); } catch { /* likely already exited */ }

    const stopped = await page.evaluate(() => window.stenoai.recording.stop());
    console.log('stop():', stopped);
    if (!stopped.success) throw new Error('recording stop failed: ' + stopped.error);

    // Give the renderer's onstop -> appendChain -> closeSystemAudioFile
    // handoff a moment to finish flushing the last chunks to disk.
    await new Promise((r) => setTimeout(r, 1500));

    const recordingsDir = path.join(userDataDir, 'recordings');
    const files = fs.existsSync(recordingsDir)
      ? fs.readdirSync(recordingsDir).filter((f) => f.startsWith('sysaudio-'))
      : [];
    console.log('recordings dir contents:', files);
    if (files.length === 0) throw new Error('no sysaudio-*.webm file found');
    const webmPath = path.join(recordingsDir, files[0]);
    console.log('recording file:', webmPath, fs.statSync(webmPath).size, 'bytes');

    // Split L (mic, faked/silent) and R (system, real pw-record capture)
    // channels to raw PCM and measure each independently.
    const lPath = path.join(userDataDir, 'left.raw');
    const rPath = path.join(userDataDir, 'right.raw');
    // Same approach as the backend's _split_stereo_to_channels (src/transcriber.py):
    // ffmpeg's pan filter, not -map_channel (removed/finicky across ffmpeg builds).
    execFileSync('ffmpeg', ['-y', '-loglevel', 'error', '-i', webmPath, '-af', 'pan=mono|c0=c0', '-f', 's16le', lPath]);
    execFileSync('ffmpeg', ['-y', '-loglevel', 'error', '-i', webmPath, '-af', 'pan=mono|c0=c1', '-f', 's16le', rPath]);

    const left = measurePeakRms(fs.readFileSync(lPath));
    const right = measurePeakRms(fs.readFileSync(rPath));
    console.log('L (mic, faked device):', left);
    console.log('R (system loopback, real pw-record):', right);

    const THRESHOLD = 500; // out of 32768 — well above any residual noise floor
    if (right.peak < THRESHOLD) {
      throw new Error(
        `FAIL: R channel peak ${right.peak} is below threshold ${THRESHOLD} — ` +
          'system audio did not make it through the MediaStreamTrackGenerator bridge.',
      );
    }
    console.log('\nPASS: real system audio was captured end-to-end through the Linux loopback bridge into the actual recording file.');
  } finally {
    try {
      await Promise.race([
        app.close(),
        new Promise((_, reject) => setTimeout(() => reject(new Error('close-timeout')), 10_000)),
      ]);
    } catch {
      try { app.process()?.kill('SIGKILL'); } catch { /* already gone */ }
    }
    try { fs.rmSync(userDataDir, { recursive: true, force: true }); } catch { /* best-effort */ }
  }
}

main().catch((err) => {
  console.error('\nCHECK FAILED:', err.message);
  process.exit(1);
});
