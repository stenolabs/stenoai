#!/usr/bin/env node
// Writes a stereo 16-bit WAV of a steady sine tone, for the PipeWire loopback
// CI check (.github/workflows/e2e.yml, linux-loopback-pipewire). Dependency-free
// on purpose: the job needs a known non-silent signal to play into the test
// sink, and pulling ffmpeg in just to synthesise one would be a heavier
// dependency than the twelve lines it takes to write the samples.
//
// Left and right carry DIFFERENT frequencies so a channel swap or a
// frame-alignment slip is detectable in the captured PCM, not just presence of
// sound. See scripts/measure-pcm.js for the analysis side.
const fs = require('fs');

const RATE = 48000;
const SECONDS = Number(process.argv[3] || 10);
const LEFT_HZ = 440;
const RIGHT_HZ = 880;
const AMPLITUDE = 0.35 * 32767; // well clear of silence, well clear of clipping

const frames = RATE * SECONDS;
const data = Buffer.alloc(frames * 4); // 2 channels * 2 bytes
for (let i = 0; i < frames; i++) {
  const t = i / RATE;
  data.writeInt16LE(Math.round(AMPLITUDE * Math.sin(2 * Math.PI * LEFT_HZ * t)), i * 4);
  data.writeInt16LE(Math.round(AMPLITUDE * Math.sin(2 * Math.PI * RIGHT_HZ * t)), i * 4 + 2);
}

const header = Buffer.alloc(44);
header.write('RIFF', 0);
header.writeUInt32LE(36 + data.length, 4);
header.write('WAVE', 8);
header.write('fmt ', 12);
header.writeUInt32LE(16, 16);        // PCM chunk size
header.writeUInt16LE(1, 20);         // PCM
header.writeUInt16LE(2, 22);         // stereo
header.writeUInt32LE(RATE, 24);
header.writeUInt32LE(RATE * 4, 28);  // byte rate
header.writeUInt16LE(4, 32);         // block align
header.writeUInt16LE(16, 34);        // bits per sample
header.write('data', 36);
header.writeUInt32LE(data.length, 40);

const out = process.argv[2] || 'tone.wav';
fs.writeFileSync(out, Buffer.concat([header, data]));
console.log(`wrote ${out}: ${SECONDS}s stereo ${LEFT_HZ}Hz/${RIGHT_HZ}Hz @ ${RATE}Hz`);
