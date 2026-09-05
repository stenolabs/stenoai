import { ipc } from './ipc';

/** ~2s of audio at the observed ~45 chunks/sec. */
const MAX_IN_FLIGHT_CHUNKS = 96;

export interface LinuxLoopbackStream {
  /** A live MediaStream wrapping a MediaStreamTrackGenerator — drops into
   *  ctx.createMediaStreamSource() exactly like the mac/Windows loopback
   *  stream from getDisplayMedia. */
  stream: MediaStream;
  /** Unsubscribes from IPC, closes the generator, and tells main to kill the
   *  pw-record subprocess. Safe to call more than once. */
  stop: () => Promise<void>;
}

export interface LinuxLoopbackOptions {
  /** Called when pw-record dies on its own, after the track has been closed.
   *  Not called on a normal stop(). */
  onEnded?: (detail: { code: number | null; signal: string | null }) => void;
}

/**
 * Wraps the PCM main streams over on.linuxLoopbackChunk into an ordinary
 * MediaStream, so the rest of useSystemAudioCapture.ts can't tell it apart from
 * the mic or the mac/Windows loopback. See app/linux-loopback.js for why this
 * doesn't use getDisplayMedia.
 */
export async function startLinuxLoopbackStream(
  { onEnded }: LinuxLoopbackOptions = {},
): Promise<LinuxLoopbackStream> {
  const bridge = ipc();
  const result = await bridge.recording.startLinuxLoopback();
  if (!result.success) {
    throw new Error(result.error || 'Linux loopback capture failed to start');
  }
  const { sampleRate, channels } = result;
  const bytesPerFrame = 2 * channels; // s16 = 2 bytes/sample

  // main now has a live pw-record; anything throwing before we return a stop
  // handle would orphan it.
  let generator: MediaStreamTrackGenerator;
  let writer: WritableStreamDefaultWriter<AudioData>;
  try {
    generator = new MediaStreamTrackGenerator({ kind: 'audio' });
    writer = generator.writable.getWriter();
  } catch (err) {
    try {
      await bridge.recording.stopLinuxLoopback();
    } catch {
      /* best-effort — the throw below is the real failure */
    }
    throw err;
  }
  let timestampUs = 0;
  let stopped = false;
  let inFlight = 0;

  const unsubscribe = bridge.on.linuxLoopbackChunk((bytes) => {
    if (stopped) return;
    const numberOfFrames = Math.floor(bytes.length / bytesPerFrame);
    if (numberOfFrames === 0) return;
    // Drop rather than queue without bound if the consumer falls behind: stale
    // audio is worth less than unbounded renderer memory.
    if (inFlight >= MAX_IN_FLIGHT_CHUNKS) return;
    let audioData: AudioData;
    try {
      // AudioData needs a plain ArrayBuffer, not the ArrayBufferLike Electron's
      // IPC deserialiser hands back.
      const buf = new ArrayBuffer(bytes.byteLength);
      new Uint8Array(buf).set(bytes);
      audioData = new AudioData({
        format: 's16',
        sampleRate,
        numberOfFrames,
        numberOfChannels: channels,
        timestamp: timestampUs,
        data: buf,
      });
    } catch (err) {
      // One bad chunk shouldn't end the recording.
      console.error('[linuxLoopbackStream] failed to build AudioData', err);
      return;
    }
    timestampUs += Math.round((numberOfFrames / sampleRate) * 1_000_000);
    // Fire-and-forget: write() rejects once the writable is closed (a stop()
    // racing an in-flight chunk), which is expected.
    inFlight++;
    writer.write(audioData).catch(() => {}).finally(() => { inFlight--; });
  });

  const unsubscribeEnded = bridge.on.linuxLoopbackEnded(async (detail) => {
    if (stopped) return;
    stopped = true;
    unsubscribe();
    // Await the close before notifying: onEnded's contract is that the track is
    // already closed, so a caller must not observe pending frames.
    await writer.close().catch(() => {});
    onEnded?.(detail);
  });

  const stop = async () => {
    unsubscribeEnded();
    if (stopped) {
      // Already ended on its own — main's process is gone, nothing to kill.
      return;
    }
    stopped = true;
    unsubscribe();
    try {
      await writer.close();
    } catch {
      /* already closed/errored */
    }
    try {
      await bridge.recording.stopLinuxLoopback();
    } catch {
      /* best-effort — main-side process cleanup, not user-visible */
    }
  };

  return { stream: new MediaStream([generator]), stop };
}
