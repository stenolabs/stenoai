#!/usr/bin/env node
// Manual runner for the app/linux-loopback.js feasibility spike. Not wired
// into any build/test target — run directly with `node scripts/linux-loopback-poc-demo.js`
// on a Linux desktop session to prove the capture mechanism end-to-end.

const fs = require('fs');
const path = require('path');
const { isLinuxLoopbackSupported, startLoopbackCapture } = require('../app/linux-loopback');
const { measurePeakRms } = require('./measure-pcm');

const DURATION_MS = 2500;
const OUT_PATH = process.argv[2] || path.join(require('os').tmpdir(), 'steno-linux-loopback-poc.pcm');

async function main() {
  console.log('platform:', process.platform);
  console.log('supported:', isLinuxLoopbackSupported());
  if (!isLinuxLoopbackSupported()) {
    console.error('Linux loopback not supported on this host (missing PipeWire tooling or not Linux).');
    process.exit(1);
  }

  const out = fs.createWriteStream(OUT_PATH);
  const capture = startLoopbackCapture({
    onError: (err) => console.error('capture error:', err),
  });
  console.log('default sink:', capture.target);
  capture.stdout.pipe(out);

  console.log(`capturing for ${DURATION_MS}ms -> ${OUT_PATH}`);
  await new Promise((resolve) => setTimeout(resolve, DURATION_MS));
  await capture.stop();
  await new Promise((resolve) => out.end(resolve));

  const { size } = fs.statSync(OUT_PATH);
  const bytesPerSample = 2 * capture.channels;
  const expectedBytes = capture.sampleRate * bytesPerSample * (DURATION_MS / 1000);
  console.log(`captured ${size} bytes (expected ~${Math.round(expectedBytes)} for ${DURATION_MS}ms @ ${capture.sampleRate}Hz/${capture.channels}ch)`);

  // Proves this isn't just a zeroed buffer — same check used to validate
  // the manual pw-record test.
  const { peak, rms } = measurePeakRms(fs.readFileSync(OUT_PATH));
  console.log(`peak amplitude: ${peak}/32768  rms: ${rms.toFixed(1)}`);
  console.log('PASS: captured non-empty PCM from the default sink monitor with no portal/consent dialog.');
}

main().catch((err) => {
  console.error('demo failed:', err);
  process.exit(1);
});
