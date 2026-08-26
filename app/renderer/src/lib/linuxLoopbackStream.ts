import { ipc } from './ipc';

export interface LinuxLoopbackStream {
  /** A live MediaStream wrapping a MediaStreamTrackGenerator — drops into
   *  ctx.createMediaStreamSource() exactly like the mac/Windows loopback
   *  stream from getDisplayMedia. */
  stream: MediaStream;
  /** Unsubscribes from IPC, closes the generator, and tells main to kill the
   *  pw-record subprocess. Safe to call more than once. */
  stop: () => Promise<void>;
}

/**
 * Linux system-audio loopback, bridged into the renderer's Web Audio graph
 * without touching getDisplayMedia. See app/linux-loopback.js for why: on
 * Wayland, getDisplayMedia's video capture goes through xdg-desktop-portal's
 * ScreenCast picker, which would show the user a screen/window-share dialog
 * just to get a video track we'd immediately discard. Chromium's own
 * PipeWire capturer AND raw pw-record land in the same place (a PipeWire
 * client), but only the portal-mediated one shows a picker — a plain
 * pw-record subprocess does not, matching the mic/mac/Windows UX of "no
 * dialog, audio just starts."
 *
 * main.js spawns pw-record (via linux-loopback.js) targeting the default
 * sink's monitor and streams raw interleaved s16 PCM back over
 * on.linuxLoopbackChunk. This wraps those chunks as AudioData frames written
 * into a MediaStreamTrackGenerator, so the caller gets back an ordinary
 * MediaStream — from that point on it is indistinguishable from the mic or
 * mac/Windows loopback streams to the rest of useSystemAudioCapture.ts.
 */
export async function startLinuxLoopbackStream(): Promise<LinuxLoopbackStream> {
  const bridge = ipc();
  const result = await bridge.recording.startLinuxLoopback();
  if (!result.success) {
    throw new Error(result.error || 'Linux loopback capture failed to start');
  }
  const { sampleRate, channels } = result;
  const bytesPerFrame = 2 * channels; // s16 = 2 bytes/sample

  const generator = new MediaStreamTrackGenerator({ kind: 'audio' });
  const writer = generator.writable.getWriter();
  let timestampUs = 0;
  let stopped = false;

  const unsubscribe = bridge.on.linuxLoopbackChunk((bytes) => {
    if (stopped) return;
    const numberOfFrames = Math.floor(bytes.length / bytesPerFrame);
    if (numberOfFrames === 0) return;
    let audioData: AudioData;
    try {
      // AudioData's `data` must be backed by a plain ArrayBuffer (not the
      // SharedArrayBuffer-compatible ArrayBufferLike Electron's IPC
      // deserialiser hands back) — copy into a fresh buffer. AudioData
      // itself copies its input at construction time, so this isn't a
      // double-copy for retention purposes, just for the type.
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
      // A malformed/truncated chunk must not take down the whole recording —
      // drop it and keep going, same tolerance the mic/system RMS paths give
      // a single bad read.
      console.error('[linuxLoopbackStream] failed to build AudioData', err);
      return;
    }
    timestampUs += Math.round((numberOfFrames / sampleRate) * 1_000_000);
    // Fire-and-forget: writer.write() rejects once the writable is closed
    // (a stop() race with an in-flight IPC chunk) — that's expected, not an
    // error worth surfacing.
    writer.write(audioData).catch(() => {});
  });

  const stop = async () => {
    if (stopped) return;
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
