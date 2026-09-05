// Synthesizes real (non-silent, transcribable) speech into a stereo WAV
// using macOS's built-in `say` TTS, for e2e specs that need genuine ASR
// output rather than the sine-tone fixture in make-wav.js. A sine tone is
// non-speech and Parakeet/whisper.cpp both correctly return empty text for
// it (verified — that's what the plumbing-only @pipeline spec relies on),
// so it can never exercise anything downstream of real transcript segments,
// like the per-channel speaker-diarization labeling path.
//
// macOS-only: `say` doesn't exist on Windows/Linux. Callers must gate on
// isSayAvailable() (and process.platform) and skip loudly otherwise.
import { execFileSync } from 'child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';

// `say -o out.wav --data-format=LEI16@16000` writes a real (non-canonical)
// WAV header — macOS prepends a JUNK chunk before `fmt `/`data`, so the
// data chunk is not at the fixed 44-byte offset make-wav.js assumes.
// Locate it by tag instead of guessing an offset.
function readPcm16Mono(filePath: string): Buffer {
  const buf = readFileSync(filePath);
  const dataTag = buf.indexOf('data', 12);
  if (dataTag < 0) throw new Error(`no data chunk found in ${filePath}`);
  const size = buf.readUInt32LE(dataTag + 4);
  return buf.subarray(dataTag + 8, dataTag + 8 + size);
}

function synthesize(text: string, destPath: string): Buffer {
  execFileSync('say', ['-o', destPath, '--data-format=LEI16@16000', text]);
  return readPcm16Mono(destPath);
}

// A real sentence should take at least this long to speak. Guards against a
// `say` that "works" (exits 0, produces a well-formed WAV) but synthesizes
// essentially nothing -- observed on GitHub-hosted macOS runners: `say -v ?`
// (listing voices) exits 0 even when actual synthesis produces ~170 bytes of
// near-silent PCM (~5ms), presumably because the runner image ships the
// `say` binary without voice assets. Probing `-v ?` alone is a false
// positive; this measures what `say` actually wrote.
const MIN_SAY_DURATION_SECONDS = 1.0;

let sayAvailable: boolean | undefined;

export function isSayAvailable(): boolean {
  if (sayAvailable === undefined) {
    try {
      const dir = mkdtempSync(path.join(tmpdir(), 'stenoai-e2e-say-probe-'));
      try {
        const pcm = synthesize('Testing one two three.', path.join(dir, 'probe.wav'));
        const seconds = pcm.length / 2 / 16000;
        sayAvailable = seconds >= MIN_SAY_DURATION_SECONDS;
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    } catch {
      sayAvailable = false;
    }
  }
  return sayAvailable;
}

function silencePcm(seconds: number): Buffer {
  return Buffer.alloc(Math.round(seconds * 16000) * 2);
}

function writeStereoWav(destPath: string, leftPcm: Buffer, rightPcm: Buffer): void {
  const frames = Math.max(leftPcm.length, rightPcm.length) / 2;
  const bytesPerSample = 2;
  const channels = 2;
  const dataBytes = frames * channels * bytesPerSample;
  const out = Buffer.alloc(44 + dataBytes);

  out.write('RIFF', 0);
  out.writeUInt32LE(36 + dataBytes, 4);
  out.write('WAVE', 8);
  out.write('fmt ', 12);
  out.writeUInt32LE(16, 16);
  out.writeUInt16LE(1, 20);
  out.writeUInt16LE(channels, 22);
  out.writeUInt32LE(16000, 24);
  out.writeUInt32LE(16000 * channels * bytesPerSample, 28);
  out.writeUInt16LE(channels * bytesPerSample, 32);
  out.writeUInt16LE(16, 34);
  out.write('data', 36);
  out.writeUInt32LE(dataBytes, 40);

  for (let i = 0; i < frames; i++) {
    const l = i * 2 < leftPcm.length ? leftPcm.readInt16LE(i * 2) : 0;
    const r = i * 2 < rightPcm.length ? rightPcm.readInt16LE(i * 2) : 0;
    out.writeInt16LE(l, 44 + i * 4);
    out.writeInt16LE(r, 44 + i * 4 + 2);
  }
  writeFileSync(destPath, out);
}

export interface StereoSpeechResult {
  /** Seconds into the mic channel's own timeline marking the midpoint of
   *  the silence gap between micUtteranceA and micUtteranceB — the point
   *  a fixture diarizer's two speaker-cluster boundary should sit at so
   *  each utterance's ASR sentence lands in a different cluster. */
  micBoundarySeconds: number;
}

/**
 * Builds a stereo WAV (left = mic, right = system — the layout
 * transcribe_diarised splits) where the mic channel contains TWO short
 * utterances separated by exactly 1s of real digital silence (so real ASR
 * segments them into two distinct sentences with a known gap), and the
 * system channel contains one short utterance. Real speaking-rate timing
 * varies by voice/macOS version, so the returned boundary is computed from
 * the ACTUALLY measured synthesized audio, not guessed.
 */
export function makeStereoSpeechWav(
  destPath: string,
  opts: { micUtteranceA: string; micUtteranceB: string; systemUtterance: string },
): StereoSpeechResult {
  const dir = mkdtempSync(path.join(tmpdir(), 'stenoai-e2e-say-'));
  try {
    const uttA = synthesize(opts.micUtteranceA, path.join(dir, 'mic_a.wav'));
    const gapSeconds = 1.0;
    const uttB = synthesize(opts.micUtteranceB, path.join(dir, 'mic_b.wav'));
    const micPcm = Buffer.concat([uttA, silencePcm(gapSeconds), uttB]);

    const sysUtt = synthesize(opts.systemUtterance, path.join(dir, 'sys.wav'));
    const sysPcm = Buffer.concat([sysUtt, silencePcm(Math.max(0, micPcm.length / 2 / 16000 - sysUtt.length / 2 / 16000))]);

    writeStereoWav(destPath, micPcm, sysPcm);

    const durA = uttA.length / 2 / 16000;
    return { micBoundarySeconds: durA + gapSeconds / 2 };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
