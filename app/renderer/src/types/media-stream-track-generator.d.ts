// MediaStreamTrackGenerator (part of Insertable Streams for MediaStreamTrack)
// isn't in this project's TypeScript lib.dom yet — only Chromium ships the
// runtime API. Minimal ambient declaration covering the 'audio' kind usage in
// lib/linuxLoopbackStream.ts; not a general-purpose typing of the whole API.
interface MediaStreamTrackGeneratorInit {
  kind: 'audio' | 'video';
}

declare class MediaStreamTrackGenerator extends MediaStreamTrack {
  constructor(init: MediaStreamTrackGeneratorInit);
  readonly writable: WritableStream<AudioData>;
}
