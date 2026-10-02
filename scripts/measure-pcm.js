// Shared by the Linux loopback verification scripts (scripts/linux-loopback-poc-demo.js,
// app/scripts/linux-loopback-e2e-check.js): peak/RMS over raw interleaved s16le PCM,
// proving a captured buffer isn't just silence.
function measurePeakRms(buf) {
  const n = buf.length / 2;
  let peak = 0;
  let sumSq = 0;
  for (let i = 0; i < n; i++) {
    const s = buf.readInt16LE(i * 2);
    peak = Math.max(peak, Math.abs(s));
    sumSq += s * s;
  }
  return { peak, rms: Math.sqrt(sumSq / n), samples: n };
}

module.exports = { measurePeakRms };
