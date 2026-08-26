import * as React from 'react';
import { create } from 'zustand';
import { useQueryClient } from '@tanstack/react-query';
import { ipc } from '@/lib/ipc';
import { appendDebugLog } from '@/lib/debugLogs';
import { isMac } from '@/lib/utils';
import { flushNotesThenProcess } from '@/lib/notesFlush';
import { unwrap } from '@/lib/result';
import { getLiveDraft } from './liveDraftStore';
import { useRecording } from './useRecording';
import { useTranscriptionEngine } from './useModels';
import {
  settingsKeys,
  useMicrophoneSetting,
  useSystemAudioSetting,
  useSystemAudioSupport,
  useSilenceAutoStopSetting,
} from './useSettings';

interface RecordTemplateStore {
  chosenTemplateId: string | null;
  activeTemplateId: string | null;
  setChosenTemplateId: (id: string | null) => void;
  setActiveTemplateId: (id: string | null) => void;
  resetChoice: () => void;
}

export const useRecordTemplateStore = create<RecordTemplateStore>((set) => ({
  chosenTemplateId: null,
  activeTemplateId: null,
  setChosenTemplateId: (id) => set({ chosenTemplateId: id }),
  setActiveTemplateId: (id) => set({ activeTemplateId: id }),
  resetChoice: () => set({ chosenTemplateId: null, activeTemplateId: null }),
}));
/** Hardcoded RMS floor (0..1, computed on the time-domain samples from an
 *  AnalyserNode). Above this on either mic OR system audio counts as
 *  "active." Tuned empirically to ignore desk-fan / room-tone noise but
 *  catch any actual speech or media playback. Not user-configurable —
 *  exposing this just creates a knob no one tunes correctly. */
const SILENCE_RMS_THRESHOLD = 0.01;
const SILENCE_SAMPLE_INTERVAL_MS = 1_000;

/**
 * Mounts ONCE at App level. This is the ONLY recording path — whenever the
 * user starts recording it captures the mic (getUserMedia) and, when loopback
 * is enabled (macOS toggle on; Windows always; OS must support it), also the
 * system loopback (getDisplayMedia routed through CoreAudio Process Taps via
 * `electron-audio-loopback` with forceCoreAudioTap). It emits a single STEREO
 * WebM/Opus blob with **mic in channel 0 (L), system in channel 1 (R)**,
 * streamed incrementally to disk. The backend's `transcribe_diarised`
 * (src/transcriber.py) detects the stereo layout, splits the channels,
 * transcribes each separately with per-segment timestamps, and emits a
 * chronologically interleaved `[You]` / `[Others]` transcript.
 *
 * When loopback is off/unsupported the recording is MIC-ONLY: the R channel is
 * silent and the transcript is You-only. There is no longer a Python `record`
 * subprocess fallback — capture always happens here, on every platform.
 */
export function useSystemAudioCapture() {
  const { status, sessionName } = useRecording();
  const systemAudio = useSystemAudioSetting();
  const systemAudioSupport = useSystemAudioSupport();
  const engineQuery = useTranscriptionEngine();
  // Whisper recordings have no live transcript: the transcribe-stream
  // sidecar isn't spawned by main.js, so any chunks we'd push would be
  // silently dropped. Skip the tap setup entirely on whisper.
  const liveTapEnabled = (engineQuery.data ?? 'parakeet') === 'parakeet';
  // Read into a ref so the tap callback (closed over once at startCapture)
  // can be a no-op if the engine flips mid-recording without rebuilding
  // the AudioContext graph.
  const liveTapEnabledRef = React.useRef(liveTapEnabled);
  React.useEffect(() => {
    liveTapEnabledRef.current = liveTapEnabled;
  }, [liveTapEnabled]);
  // Renderer-driven capture is the ONLY recording path now, so capture ALWAYS
  // runs while status === 'recording' (the mic is captured regardless). The
  // "Record system audio" setting no longer gates whether we record — it only
  // decides whether system LOOPBACK is mixed in:
  //  - Windows: always on when the OS supports it (the toggle is hidden; the
  //    product decision is always mic+system).
  //  - macOS: follows the user's setting (default on; off = mic-only).
  // When the support query is still loading we assume supported so a fast user
  // who records before the IPC resolves still gets loopback.
  const loopbackSupported = systemAudioSupport.data?.supported ?? true;
  // main.js replaces electron-audio-loopback's display-media handler with one
  // that supplies the requesting frame as the required video track and catches
  // callback failures. That keeps the CoreAudio Process Tap independent of
  // Screen Recording permission; this renderer gate only needs the user's
  // setting and the OS support check.
  const loopbackEnabled = isMac
    ? (systemAudio.data ?? true) && loopbackSupported
    : loopbackSupported;
  // Read into a ref so startCapture (closed over once) sees the current value
  // without the capture effect depending on it — toggling mid-recording must
  // not tear down or restart the active capture.
  const loopbackEnabledRef = React.useRef(loopbackEnabled);
  React.useEffect(() => {
    loopbackEnabledRef.current = loopbackEnabled;
  }, [loopbackEnabled]);


  // The pinned microphone device (Settings > Microphone). Kept mounted here
  // (App-level, per this hook's own docstring) purely to warm react-query's
  // cache from launch, so the ensureQueryData call in startCapture below is
  // normally an instant cache hit. Deliberately NOT read into a ref the way
  // loopbackEnabledRef is: a ref populated by an effect can still be stale
  // (null/unset) if a recording starts before that effect has run even once
  // — e.g. a fast user right after a cold launch — silently capturing the
  // system default instead of the pin. startCapture instead reads the query
  // cache directly (via the queryClient below) at the moment it actually
  // needs the value, which resolves that race: an instant hit in the common
  // case, and a real (if rare) short wait for the in-flight fetch otherwise.
  useMicrophoneSetting();
  const qc = useQueryClient();

  const recorderRef = React.useRef<MediaRecorder | null>(null);
  const micStreamRef = React.useRef<MediaStream | null>(null);
  const sysStreamRef = React.useRef<MediaStream | null>(null);
  const audioCtxRef = React.useRef<AudioContext | null>(null);
  const mixedStreamRef = React.useRef<MediaStream | null>(null);
  // Serialises the incremental writes: each MediaRecorder timeslice is
  // appended to the open on-disk file through this chain so chunks land in
  // arrival order regardless of how their arrayBuffer() promises resolve.
  // Disk is the buffer now — there is no in-memory chunk array.
  const appendChainRef = React.useRef<Promise<void>>(Promise.resolve());
  // Latches on the first failed chunk append so we surface the failure once
  // (not once per second) and don't claim a clean recording when the on-disk
  // file is actually truncated.
  const appendFailedRef = React.useRef(false);
  const sessionNameRef = React.useRef<string | null>(null);
  const activeRef = React.useRef(false);
  // Bumped by stopCapture so any in-flight startCapture awaiting
  // getUserMedia/getDisplayMedia knows it's been cancelled and aborts
  // before installing the streams it just acquired.
  const startTokenRef = React.useRef(0);
  // Silence-auto-stop detector lives alongside the MediaRecorder. The
  // setting and pause state are read via refs so the polling loop sees
  // current values without re-creating the interval.
  const silenceIntervalRef = React.useRef<ReturnType<typeof setInterval> | null>(null);
  const silenceConfigRef = React.useRef<{ enabled: boolean; minutes: number }>({
    enabled: true,
    minutes: 15,
  });
  const isPausedRef = React.useRef(false);
  const silenceAutoStop = useSilenceAutoStopSetting();
  React.useEffect(() => {
    if (silenceAutoStop.data) {
      silenceConfigRef.current = {
        enabled: silenceAutoStop.data.enabled,
        minutes: silenceAutoStop.data.minutes,
      };
    }
  }, [silenceAutoStop.data]);
  React.useEffect(() => {
    isPausedRef.current = status === 'paused';
  }, [status]);

  React.useEffect(() => {
    sessionNameRef.current = sessionName;
  }, [sessionName]);

  React.useEffect(() => {
    const bridge = ipc();

    const teardownSilenceDetector = () => {
      if (silenceIntervalRef.current !== null) {
        clearInterval(silenceIntervalRef.current);
        silenceIntervalRef.current = null;
      }
    };

    const teardownStreams = () => {
      teardownSilenceDetector();
      micStreamRef.current?.getTracks().forEach((t) => t.stop());
      sysStreamRef.current?.getTracks().forEach((t) => t.stop());
      mixedStreamRef.current?.getTracks().forEach((t) => t.stop());
      if (audioCtxRef.current && audioCtxRef.current.state !== 'closed') {
        audioCtxRef.current.close().catch(() => { /* already closed */ });
      }
      micStreamRef.current = null;
      sysStreamRef.current = null;
      mixedStreamRef.current = null;
      audioCtxRef.current = null;
      recorderRef.current = null;
    };

    const startCapture = async () => {
      if (activeRef.current) return;
      activeRef.current = true;
      // Capture the start-token so async aborts can detect cancellation:
      // stopCapture (or the unmount cleanup) bumps startTokenRef and we
      // bail at the next checkpoint after stopping any tracks we already
      // acquired.
      const token = ++startTokenRef.current;
      const cancelled = () => token !== startTokenRef.current;

      let micStream: MediaStream | null = null;
      let sysStream: MediaStream | null = null;
      const stopAcquired = () => {
        micStream?.getTracks().forEach((t) => t.stop());
        sysStream?.getTracks().forEach((t) => t.stop());
      };

      try {
        // 1. Mic stream. Echo cancellation ON so speaker bleed (when not
        //    using headphones) doesn't double-up the remote audio in the
        //    mix. Noise suppression and AGC OFF — whisper handles ambient
        //    noise, and AGC squashes quiet system audio when ducking.
        //    When a specific device is pinned (Settings > Microphone), request
        //    it via deviceId — this is what stops the OS silently switching to
        //    e.g. an AirPods mic from changing what gets recorded. Reads the
        //    query cache directly (usually an instant hit — see the comment
        //    by useMicrophoneSetting() above) rather than a ref, so a fast
        //    user right after a cold launch still gets the real pin instead
        //    of silently falling through to the system default. This lookup
        //    is best-effort: it's an OPTIONAL preference, so a transient
        //    failure (subprocess spawn hiccup, IPC timeout) must not abort
        //    the whole recording — treat it the same as "no pin" and let
        //    getUserMedia fall through to the system default below.
        let pinnedDeviceId: string | null = null;
        try {
          pinnedDeviceId = (
            await qc.ensureQueryData({
              queryKey: settingsKeys.microphone(),
              queryFn: async () => unwrap(await bridge.settings.getMicrophone()),
            })
          ).device_id;
        } catch (micPrefErr) {
          console.warn('[systemAudioCapture] failed to read microphone preference, using system default', micPrefErr);
        }
        if (cancelled()) { stopAcquired(); return; }
        try {
          micStream = await navigator.mediaDevices.getUserMedia({
            audio: {
              echoCancellation: true,
              noiseSuppression: false,
              autoGainControl: false,
              ...(pinnedDeviceId ? { deviceId: { exact: pinnedDeviceId } } : {}),
            },
          });
        } catch (micErr) {
          // Only fall back to the system default when the pinned device
          // itself is the problem — genuinely gone (OverconstrainedError: the
          // exact deviceId constraint couldn't be satisfied) or removed from
          // the device list entirely (NotFoundError). Anything else — the
          // mic is busy in another app (NotReadableError), permission was
          // revoked (NotAllowedError), etc. — must propagate rather than
          // silently switching to a DIFFERENT physical microphone the user
          // never chose. That silent swap is exactly the surprise pinning a
          // device is meant to prevent in the first place.
          const isMissingDeviceError =
            micErr instanceof DOMException &&
            (micErr.name === 'OverconstrainedError' || micErr.name === 'NotFoundError');
          if (!pinnedDeviceId || !isMissingDeviceError) throw micErr;
          console.warn('[systemAudioCapture] pinned microphone unavailable, falling back to system default', micErr);
          micStream = await navigator.mediaDevices.getUserMedia({
            audio: {
              echoCancellation: true,
              noiseSuppression: false,
              autoGainControl: false,
            },
          });
        }
        if (cancelled()) { stopAcquired(); return; }
        micStreamRef.current = micStream;

        // 2. System audio loopback — OPTIONAL + BEST-EFFORT. Skipped entirely
        //    when loopback is disabled (macOS toggle off) or the OS doesn't
        //    support it; otherwise attempted via getDisplayMedia (intercepted by
        //    main.js's setDisplayMediaRequestHandler and served via CoreAudio
        //    Process Taps when `forceCoreAudioTap` is set). video:true is
        //    required by the API; we drop the requesting-frame track immediately.
        //
        //    If loopback is disabled OR unavailable (permission denied, no tap,
        //    no audio track) we record MIC-ONLY rather than failing: sysStream
        //    stays null and the stereo graph below wires mic → L with a silent R
        //    channel (the backend tolerates an empty Others side). A genuine mic
        //    failure above still aborts.
        try {
          if (!loopbackEnabledRef.current) {
            throw new Error('loopback disabled');
          }
          await bridge.recording.enableLoopbackAudio();
          if (cancelled()) { stopAcquired(); return; }
          sysStream = await navigator.mediaDevices.getDisplayMedia({
            video: true,
            audio: true,
          });
          if (cancelled()) { stopAcquired(); return; }
          sysStream.getVideoTracks().forEach((t) => {
            t.stop();
            sysStream!.removeTrack(t);
          });
          if (sysStream.getAudioTracks().length === 0) {
            throw new Error('No audio track in loopback stream');
          }
          sysStreamRef.current = sysStream;
        } catch (loopbackErr) {
          // Intentionally-disabled loopback (toggle off) is the expected
          // mic-only case — don't log it as a failure; only a genuine
          // unavailability warrants a warning.
          if (loopbackEnabledRef.current) {
            // Only a genuine permission denial should surface the "grant Screen
            // & System Audio Recording access" guidance. Everything else — the
            // enableLoopbackAudio IPC call failing, an absent audio track, an
            // unsupported host, or any unexpected error — falls back to mic-only
            // SILENTLY; firing the permission toast for those would misdirect the
            // user to a setting that isn't the cause. macOS raises a
            // NotAllowedError from getDisplayMedia when Screen & System Audio
            // Recording is denied. main gates the notification on
            // notifications_enabled; it's macOS-only (Windows never fired it).
            const accessDenied =
              loopbackErr instanceof DOMException && loopbackErr.name === 'NotAllowedError';
            if (accessDenied && isMac) {
              void bridge.settings.showSystemAudioMicOnlyNotification();
            }
            // eslint-disable-next-line no-console
            console.warn('[systemAudioCapture] loopback unavailable, continuing mic-only', loopbackErr);
          }
          sysStream?.getTracks().forEach((t) => t.stop());
          sysStream = null;
          sysStreamRef.current = null;
          try { await bridge.recording.disableLoopbackAudio(); } catch { /* */ }
        }

        // 3. Build the stereo graph. AudioContext at 48 kHz matches the
        //    native loopback rate so no resampling. We route mic to
        //    channel 0 (L) and the system audio (downmixed to mono if it
        //    came in stereo) to channel 1 (R) via a ChannelMergerNode.
        //    The backend's _split_stereo_to_channels uses ffmpeg's pan
        //    filter to pull each side out for independent transcription.
        //
        //    Per-source gain at 0.7 leaves ~3 dB of headroom so a loud
        //    user + loud remote at the same instant doesn't clip.
        const ctx = new AudioContext({ sampleRate: 48000 });
        audioCtxRef.current = ctx;

        const micSource = ctx.createMediaStreamSource(micStream);
        const micGain = ctx.createGain();
        micGain.channelCount = 1;
        micGain.channelCountMode = 'explicit';
        micGain.gain.value = 0.7;
        micSource.connect(micGain);

        // System source/gain only exist when loopback was acquired. A
        // mic-only recording leaves the R channel of the merger silent.
        let sysSource: MediaStreamAudioSourceNode | null = null;
        let sysGain: GainNode | null = null;
        if (sysStream) {
          sysSource = ctx.createMediaStreamSource(sysStream);
          sysGain = ctx.createGain();
          // channelCount=1 with channelInterpretation='speakers' triggers
          // Web Audio's automatic stereo→mono downmix (L/2 + R/2) for any
          // multi-channel system loopback (ScreenCaptureKit can return
          // stereo on some macOS versions; CoreAudio Process Tap is mono).
          sysGain.channelCount = 1;
          sysGain.channelCountMode = 'explicit';
          sysGain.channelInterpretation = 'speakers';
          sysGain.gain.value = 0.7;
          sysSource.connect(sysGain);
        }

        const merger = ctx.createChannelMerger(2);
        micGain.connect(merger, 0, 0);  // mic → L
        if (sysGain) sysGain.connect(merger, 0, 1);  // sys → R (silent when mic-only)

        const dest = ctx.createMediaStreamDestination();
        merger.connect(dest);

        mixedStreamRef.current = dest.stream;

        // 4a. Live transcription tap — Parakeet only. Keeps mic and system
        //     on SEPARATE channels (mic=L, system=R) all the way to the
        //     sidecar — unlike the mono recording mix above, this tap is
        //     never summed. Each side is decimated 48 kHz → 16 kHz (exact
        //     3:1 — speech energy lives well below the 8 kHz Nyquist limit
        //     at 16 kHz, so plain decimation is adequate without an
        //     anti-alias filter), interleaved L/R, and pushed as 4096-frame
        //     (8192-sample) chunks (≈256 ms) to main's transcribe-stream
        //     sidecar via IPC. Main pipes those bytes into the Python
        //     subprocess's stdin, which de-interleaves and runs two
        //     independent Silero VAD + Parakeet pipelines — one per
        //     channel — so each LIVE_SEG's speaker label is a structural
        //     fact (which channel it came from), not a guess.
        //
        //     Whisper recordings skip this section entirely — main.js
        //     doesn't spawn the sidecar so any chunks we'd push would be
        //     silently dropped. The decision is read off liveTapEnabledRef
        //     so a mid-session engine flip is honoured without rebuilding
        //     the AudioContext graph.
        //
        //     ScriptProcessorNode is deprecated but works without a
        //     separate worklet file. The output is silenced (gain 0) and
        //     connected to ctx.destination only because the node needs a
        //     downstream consumer to fire — no audio plays.
        if (liveTapEnabledRef.current) {
          const tapMerger = ctx.createChannelMerger(2);
          micGain.connect(tapMerger, 0, 0);  // mic → L
          if (sysGain) sysGain.connect(tapMerger, 0, 1);  // sys → R (silent when mic-only)

          const TAP_BUFFER = 4096;       // 48 kHz frames per callback (~85 ms)
          const DECIMATION = 3;           // 48 kHz / 16 kHz
          const SEND_FRAMES = 4096;       // 16 kHz stereo frames per IPC push (~256 ms)
          const tapNode = ctx.createScriptProcessor(TAP_BUFFER, 2, 2);
          const micTapBuffer: number[] = [];
          const sysTapBuffer: number[] = [];
          tapNode.onaudioprocess = (ev) => {
            // Re-check each callback so a flip to whisper mid-recording
            // stops pushing (chunks would otherwise stack up in main).
            if (!liveTapEnabledRef.current) return;
            // MediaRecorder.pause() halts the WebM file growth but the
            // underlying MediaStream keeps flowing — without this guard
            // we'd keep feeding the live consumer audio during a pause
            // and the transcript would keep growing after the user
            // explicitly told us to stop. Drop the chunk buffers too so
            // the half-collected samples don't leak across the pause.
            if (isPausedRef.current) {
              micTapBuffer.length = 0;
              sysTapBuffer.length = 0;
              return;
            }
            const micInput = ev.inputBuffer.getChannelData(0);
            const sysInput = ev.inputBuffer.getChannelData(1);
            for (let i = 0; i < micInput.length; i += DECIMATION) {
              micTapBuffer.push(micInput[i]);
              sysTapBuffer.push(sysInput[i]);
            }
            while (micTapBuffer.length >= SEND_FRAMES) {
              const micSlice = micTapBuffer.splice(0, SEND_FRAMES);
              const sysSlice = sysTapBuffer.splice(0, SEND_FRAMES);
              // Interleave L/R into a single stereo buffer — the sidecar's
              // stdin protocol is a raw, undelimited byte stream, so this
              // is the only framing-free way to keep both channels
              // distinguishable on the other end (Python de-interleaves
              // via a plain reshape(-1, 2)).
              const interleaved = new Float32Array(SEND_FRAMES * 2);
              for (let i = 0; i < SEND_FRAMES; i++) {
                interleaved[i * 2] = micSlice[i];
                interleaved[i * 2 + 1] = sysSlice[i];
              }
              // Send the underlying ArrayBuffer — Electron's structured-
              // clone path encodes typed arrays as Buffers on the main side.
              ipc().liveTranscript.pushChunk(interleaved.buffer);
            }
          };
          const tapSilencer = ctx.createGain();
          tapSilencer.gain.value = 0;
          tapMerger.connect(tapNode);
          tapNode.connect(tapSilencer);
          tapSilencer.connect(ctx.destination);
        }

        // 4. Record the mix. The WebM blob is streamed to disk a timeslice at
        //    a time (see ondataavailable → appendSystemAudioChunk) rather than
        //    buffered in memory until stop, so a crash leaves a processable
        //    file. Open the on-disk file first; if that fails there's nowhere
        //    to write, so abort (caught below → mic-only would also have no
        //    file, so this is a hard failure).
        const name = sessionNameRef.current ?? 'Note';
        const opened = await bridge.recording.openSystemAudioFile(name);
        if (cancelled()) {
          // Cancelled after the file opened — close it so the main-side write
          // stream isn't leaked (it'd otherwise linger until the next open).
          stopAcquired();
          if (opened.success) void bridge.recording.closeSystemAudioFile();
          return;
        }
        if (!opened.success) {
          throw new Error(opened.error || 'Could not open recording file');
        }

        const mimeType = MediaRecorder.isTypeSupported('audio/webm;codecs=opus')
          ? 'audio/webm;codecs=opus'
          : 'audio/webm';
        const recorder = new MediaRecorder(dest.stream, {
          mimeType,
          audioBitsPerSecond: 128_000,
        });
        appendChainRef.current = Promise.resolve();
        appendFailedRef.current = false;
        recorder.ondataavailable = (e) => {
          if (!e.data || e.data.size === 0) return;
          const blob = e.data;
          // Chain appends so they serialise in arrival order — the handler
          // fires in order, and chaining synchronously here preserves that
          // even though each blob.arrayBuffer() resolves asynchronously.
          appendChainRef.current = appendChainRef.current
            .then(async () => {
              const buf = new Uint8Array(await blob.arrayBuffer());
              const res = await bridge.recording.appendSystemAudioChunk(buf);
              // A resolved {success:false} (disk error, stream gone) isn't a
              // throw — check it explicitly so a write failure isn't silently
              // dropped. Surface it once; the file is now truncated.
              if (!res.success && !appendFailedRef.current) {
                appendFailedRef.current = true;
                // eslint-disable-next-line no-console
                console.error('[systemAudioCapture] chunk append failed:', res.error);
                bridge.recording.reportCaptureError(
                  `Recording may be incomplete: ${res.error || 'failed to write audio'}`,
                );
              }
            })
            .catch((err) => {
              // eslint-disable-next-line no-console
              console.error('[systemAudioCapture] chunk append failed', err);
            });
        };
        // 1s timeslice so a crash mid-recording loses at most ~1s of audio.
        recorder.start(1_000);
        recorderRef.current = recorder;

        // 5. Silence-auto-stop detector. Taps each pre-merge source with its
        //    own AnalyserNode so we can distinguish "mic active" from
        //    "system audio playing" — auto-stop only fires when BOTH have
        //    been below SILENCE_RMS_THRESHOLD for the configured duration.
        //    Mic-only would auto-stop real meetings where the user is
        //    listening but not talking; system-only would auto-stop when
        //    the user is talking on a phone (headphones, no playback).
        const micAnalyser = ctx.createAnalyser();
        micAnalyser.fftSize = 512;
        micAnalyser.smoothingTimeConstant = 0;
        micSource.connect(micAnalyser);
        // No system analyser on a mic-only recording — sysRms is treated as 0
        // below, so auto-stop falls back to mic-only silence.
        let sysAnalyser: AnalyserNode | null = null;
        if (sysSource) {
          sysAnalyser = ctx.createAnalyser();
          sysAnalyser.fftSize = 512;
          sysAnalyser.smoothingTimeConstant = 0;
          sysSource.connect(sysAnalyser);
        }

        const computeRms = (analyser: AnalyserNode, buf: Uint8Array<ArrayBuffer>): number => {
          analyser.getByteTimeDomainData(buf);
          let sumSq = 0;
          for (let i = 0; i < buf.length; i++) {
            const v = (buf[i] - 128) / 128;
            sumSq += v * v;
          }
          return Math.sqrt(sumSq / buf.length);
        };

        const micBuf = new Uint8Array(new ArrayBuffer(micAnalyser.fftSize));
        const sysBuf = sysAnalyser
          ? new Uint8Array(new ArrayBuffer(sysAnalyser.fftSize))
          : null;
        let lastActiveAtMs = Date.now();
        // Latch the in-flight stop attempt instead of tearing the
        // interval down: a stop failure (Python crash, queue lock, race
        // with manual stop) used to permanently disarm auto-stop for the
        // rest of the recording. Now the detector keeps running; the
        // latch just prevents re-firing while one attempt is still in
        // flight, and clears on failure so a subsequent sustained silent
        // stretch can retry.
        let stopAttemptInFlight = false;
        // Observation-only state for the [auto-stop] debug logs below. These
        // do NOT affect the stop decision - they only track transitions so we
        // log state changes (not every 1 Hz tick, which would flood the
        // 1000-line buffer). `idleReason` is the last guard reason we logged,
        // `wasSilent` the last silence/activity verdict, `lastHeartbeatAtMs`
        // paces the "still silent" heartbeat.
        let idleReason = '';
        let wasSilent = false;
        let lastHeartbeatAtMs = Date.now();

        // The `[auto-stop]` lines below feed the Settings > Developer debug
        // console (the renderer ring buffer in @/lib/debugLogs) so #271-class
        // "silence auto-stop never fired" reports are remotely diagnosable:
        // the user copies the Developer log and it shows the detector's
        // decisions, which are otherwise invisible (DevTools-only console).
        const logAutoStop = (msg: string) => {
          // Observation-only: logging must never throw into the detector tick,
          // so a misbehaving debug-log subscriber can't abort the stop
          // decision. The empty catch is intentional.
          try {
            appendDebugLog(`[auto-stop] ${msg}`);
          } catch {
            /* logging must not affect the detector */
          }
        };
        {
          const armedCfg = silenceConfigRef.current;
          logAutoStop(
            `armed: enabled=${armedCfg.enabled} minutes=${armedCfg.minutes} systemAudio=${sysAnalyser !== null}`,
          );
        }

        silenceIntervalRef.current = setInterval(() => {
          const cfg = silenceConfigRef.current;
          // Treat manual-pause as activity — user paused on purpose; don't
          // auto-stop their recording out from under them. Resetting the
          // timestamp also avoids racing the resume: any silence after a
          // long pause has to re-accumulate from scratch.
          if (!cfg.enabled || isPausedRef.current || !activeRef.current) {
            lastActiveAtMs = Date.now();
            // Log the idle transition once (not every tick) so the Developer
            // log shows WHY the timer keeps resetting.
            const reason = !cfg.enabled
              ? 'disabled'
              : isPausedRef.current
                ? 'paused'
                : 'inactive';
            if (reason !== idleReason) {
              idleReason = reason;
              logAutoStop(`idle (${reason}) - timer reset`);
            }
            // Reset silence-tracking so a resume re-accumulates from scratch
            // (mirrors the lastActiveAtMs reset above).
            wasSilent = false;
            return;
          }
          if (idleReason) {
            logAutoStop('re-armed');
            idleReason = '';
          }
          if (stopAttemptInFlight) return;
          const micRms = computeRms(micAnalyser, micBuf);
          const sysRms = sysAnalyser && sysBuf ? computeRms(sysAnalyser, sysBuf) : 0;
          const silent = !(micRms > SILENCE_RMS_THRESHOLD || sysRms > SILENCE_RMS_THRESHOLD);
          if (!silent) {
            if (wasSilent) {
              wasSilent = false;
              logAutoStop(
                `activity (mic=${micRms.toFixed(4)} sys=${sysRms.toFixed(4)}) - timer reset`,
              );
            }
            lastActiveAtMs = Date.now();
            return;
          }
          if (!wasSilent) {
            wasSilent = true;
            lastHeartbeatAtMs = Date.now();
            logAutoStop(
              `silence started (mic=${micRms.toFixed(4)} sys=${sysRms.toFixed(4)})`,
            );
          }
          const silenceMs = Date.now() - lastActiveAtMs;
          const limitMs = cfg.minutes * 60 * 1000;
          // Heartbeat while silence accumulates toward the limit - shows the
          // detector is running and the window is growing (the missing signal
          // in #271, where silence never seemed to add up).
          if (Date.now() - lastHeartbeatAtMs >= 30_000) {
            lastHeartbeatAtMs = Date.now();
            const elapsedSec = Math.round((Date.now() - lastActiveAtMs) / 1000);
            const limitSec = Math.round(limitMs / 1000);
            logAutoStop(
              `still silent ${elapsedSec}s / ${limitSec}s (mic=${micRms.toFixed(4)} sys=${sysRms.toFixed(4)})`,
            );
          }
          if (silenceMs < limitMs) return;

          logAutoStop(`threshold reached (${Math.round(silenceMs / 1000)}s silent) - stopping`);
          stopAttemptInFlight = true;
          const minutes = cfg.minutes;
          void (async () => {
            try {
              // Check the IPC result envelope before claiming success —
              // if the stop failed (no active recording, Python error,
              // queue lock, etc.) we don't want to fire a "Recording
              // stopped" notification while the recording is actually
              // still running.
              const stopResult = await bridge.recording.stop();
              if (!stopResult.success) {
                // eslint-disable-next-line no-console
                console.error('[silenceAutoStop] stop failed:', stopResult.error);
                logAutoStop('stop failed: ' + stopResult.error);
                // Reset the silence window so the user gets a fresh
                // duration of silence before we retry the stop — avoids
                // hammering a failing IPC every second.
                lastActiveAtMs = Date.now();
                // Keep the logging-transition state in sync with the reset
                // window so the next silent stretch logs a clean "silence
                // started" + fresh heartbeat rather than a stale one.
                wasSilent = false;
                lastHeartbeatAtMs = Date.now();
                stopAttemptInFlight = false;
                return;
              }
              // Success — the recording is gone, so the detector has no
              // recording to watch anymore. Tear it down here (instead
              // of pre-emptively before the stop call) so a failed stop
              // doesn't permanently disarm auto-stop for the session.
              teardownSilenceDetector();
              logAutoStop('recording stopped after ' + minutes + 'min of silence');
              const notifResult = await bridge.settings.showSilenceAutoStopNotification({
                minutes,
                // Pre-processing name — calendar event title for
                // auto-detect recordings, "Note" for the default
                // placeholder, user-typed otherwise. Matches what's
                // visible in the sidebar at the moment of stop.
                sessionName: sessionNameRef.current ?? null,
              });
              if (!notifResult.success) {
                // Notification failure isn't fatal — the recording has
                // already been finalised — but worth logging for support.
                // eslint-disable-next-line no-console
                console.warn('[silenceAutoStop] notification failed:', notifResult.error);
              }
            } catch (e) {
              // eslint-disable-next-line no-console
              console.error('[silenceAutoStop] failed to stop:', e);
              logAutoStop('stop error: ' + String(e));
              lastActiveAtMs = Date.now();
              // Keep the logging-transition state in sync with the reset
              // window (see the !success branch above).
              wasSilent = false;
              lastHeartbeatAtMs = Date.now();
              stopAttemptInFlight = false;
            }
          })();
        }, SILENCE_SAMPLE_INTERVAL_MS);

        // 6. Confirm to main that the renderer-driven recording is live.
        //    Idempotent — main.js already flipped systemAudioRecordingActive
        //    when start-recording-ui ran, but this re-affirms it.
        bridge.recording.reportSystemAudioState(true);
      } catch (err) {
        // eslint-disable-next-line no-console
        console.error('[systemAudioCapture] start failed', err);
        teardownStreams();
        activeRef.current = false;
        // Close any file opened before the failure so we don't leak the
        // main-side write stream (no-op if open never ran).
        try { await bridge.recording.closeSystemAudioFile(); } catch { /* */ }
        // Tell main to drop the stuck "recording" pill — its optimistic
        // systemAudioRecordingActive flag was set on start-recording-ui.
        bridge.recording.reportSystemAudioState(false);
        // Surface the failure to the user (native notification) — otherwise a
        // denied mic permission looks like a silent no-op.
        bridge.recording.reportCaptureError(
          err instanceof Error ? err.message : 'Recording could not start',
        );
        try { await bridge.recording.disableLoopbackAudio(); } catch { /* */ }
      }
    };

    const stopCapture = async () => {
      // Invalidate any in-flight startCapture awaiting media APIs — its
      // next cancelled() check will see the token has moved and it'll
      // tear down the streams it acquired without installing them.
      startTokenRef.current++;
      if (!activeRef.current) return;
      activeRef.current = false;
      const recorder = recorderRef.current;
      if (!recorder || recorder.state === 'inactive') {
        teardownStreams();
        try { await bridge.recording.disableLoopbackAudio(); } catch { /* */ }
        bridge.recording.reportSystemAudioState(false);
        return;
      }
      // Match useRecording.startRecording's 'Note' placeholder so the
      // Python post-processor's AI-rename regex
      //   ^(Meeting|Note)(-[A-Z0-9]{6})?$
      // catches both code paths the same way. Previously this fell back
      // to 'Meeting', so a system-audio recording whose sessionName
      // never landed would persist as "Meeting" while a mic-only
      // recording from the same UI flow persisted as "Note" — visible
      // inconsistency in the user's notes list.
      const name = sessionNameRef.current ?? 'Note';
      await new Promise<void>((resolve) => {
        recorder.onstop = async () => {
          try {
            // Flush any in-flight appends, then close the on-disk file and
            // hand the finished WebM to the processing queue.
            await appendChainRef.current;
            const closed = await bridge.recording.closeSystemAudioFile();
            if (!closed.success) {
              // eslint-disable-next-line no-console
              console.error('[systemAudioCapture] close failed', closed.error);
            } else if (closed.filePath) {
              // Flush last-second notes before handoff — main reads the sidecar.
              await flushNotesThenProcess({
                name,
                filePath: closed.filePath,
                getDraftNotes: (n) => getLiveDraft(n)?.notes,
                // unwrap turns a { success:false } Result into a throw so onFlushError sees it.
                saveNotes: async (n, notes) => unwrap(await bridge.meetings.saveNotes(n, notes)),
                processRecording: (fp, n) => bridge.recording.processSystemAudio(fp, n),
                // eslint-disable-next-line no-console
                onFlushError: (err) => console.error('[systemAudioCapture] notes flush failed', err),
              });
            }
          } catch (err) {
            // eslint-disable-next-line no-console
            console.error('[systemAudioCapture] handoff failed', err);
          } finally {
            teardownStreams();
            try { await bridge.recording.disableLoopbackAudio(); } catch { /* */ }
            bridge.recording.reportSystemAudioState(false);
            resolve();
          }
        };
        recorder.stop();
      });
    };

    // Capture is driven purely by the recording status now — it is the only
    // recording path, so it always runs while recording (mic-only when loopback
    // is off/unsupported). The system-audio toggle no longer starts or stops
    // capture; it only affects whether loopback is mixed in on the NEXT start
    // (read via loopbackEnabledRef inside startCapture).
    if (status === 'recording' && !activeRef.current) {
      void startCapture();
    } else if (
      status === 'paused' &&
      recorderRef.current?.state === 'recording'
    ) {
      recorderRef.current.pause();
    } else if (
      status === 'recording' &&
      recorderRef.current?.state === 'paused'
    ) {
      recorderRef.current.resume();
    } else if (
      (status === 'idle' || status === 'processing') &&
      activeRef.current
    ) {
      useRecordTemplateStore.getState().setActiveTemplateId(null);
      void stopCapture();
    }
    // qc (useQueryClient()) is referentially stable for the app's lifetime
    // (the same QueryClient instance from the root Provider) — listing it
    // here doesn't cause extra effect re-runs, it just satisfies the rule.
  }, [status, qc]);

  // Unmount-only safety net (empty deps = no cleanup on dep changes). Runs
  // when the App tree unmounts (e.g. window close, page reload, StrictMode
  // simulated unmount) and tears down anything the status state machine
  // didn't get to. Crucially this does NOT fire on status changes — the
  // status-driven effect above owns the normal stop flow so the blob isn't
  // lost mid-stop.
  React.useEffect(() => {
    const bridge = ipc();
    return () => {
      // Clear any live intervals first — the per-recording teardown helper
      // lives in the other useEffect's scope so it isn't reachable here,
      // and without an explicit clear the silence-auto-stop poll would
      // survive across unmount/remount cycles (visible in dev hot-reload,
      // and a slow leak in any setup that conditionally mounts the app
      // shell).
      if (silenceIntervalRef.current !== null) {
        clearInterval(silenceIntervalRef.current);
        silenceIntervalRef.current = null;
      }
      // Close the incremental-write file so the partial recording is flushed
      // and the main-side stream isn't leaked across unmount. Reading
      // appendChainRef.current must be DEFERRED until after recorder.stop()'s
      // final ondataavailable has enqueued its append — otherwise we'd chain
      // the close onto a stale snapshot taken before that last chunk and drop
      // it. So close from the recorder's onstop (fires after the final
      // ondataavailable); fall back to an immediate chain when there's no live
      // recorder. Best-effort either way — unmount cleanup can't await.
      const closeFile = () => {
        void appendChainRef.current.finally(() =>
          bridge.recording.closeSystemAudioFile(),
        );
      };
      const recorder = recorderRef.current;
      // activeRef.current is still true only when THIS unmount owns the live
      // capture; if stopCapture already took over it has flipped it false (and
      // its own onstop will flush+close), so we must not clobber that handoff.
      const hadOpenFile = activeRef.current;
      if (hadOpenFile && recorder && recorder.state !== 'inactive') {
        recorder.onstop = closeFile;
        try { recorder.stop(); } catch { closeFile(); }
      } else if (hadOpenFile) {
        // Open file but no live recorder (failed mid-start) — close directly.
        closeFile();
      } else if (recorder && recorder.state !== 'inactive') {
        // stopCapture is handling the stop; just ensure the recorder stops
        // without overwriting its onstop flush+close handoff.
        try { recorder.stop(); } catch { /* already stopping */ }
      }
      micStreamRef.current?.getTracks().forEach((t) => t.stop());
      sysStreamRef.current?.getTracks().forEach((t) => t.stop());
      mixedStreamRef.current?.getTracks().forEach((t) => t.stop());
      if (audioCtxRef.current && audioCtxRef.current.state !== 'closed') {
        audioCtxRef.current.close().catch(() => { /* already closed */ });
      }
      micStreamRef.current = null;
      sysStreamRef.current = null;
      mixedStreamRef.current = null;
      audioCtxRef.current = null;
      recorderRef.current = null;
      if (hadOpenFile) {
        activeRef.current = false;
        void bridge.recording.disableLoopbackAudio();
        bridge.recording.reportSystemAudioState(false);
      }
    };
  }, []);
}
