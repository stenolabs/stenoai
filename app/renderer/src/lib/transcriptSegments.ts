// Pure parsing of a saved transcript string into speaker segments. Kept out of
// TranscriptPanel.tsx (which pulls in hooks/Sidebar/localStorage) so it can be
// unit-tested in isolation, and so the live dock could share it later.

export interface Segment {
  /** 'You' / 'Others' for the channel-only fallback, or 'Speaker N' for an
   *  acoustically-diarized secondary speaker on a channel (see
   *  transcriber.py's _resolve_speaker_placeholders). */
  speaker: string | null;
  text: string;
  /** `MM:SS` / `H:MM:SS` offset parsed from a diarised line's leading
   *  `[MM:SS]` marker (transcriber.py writes it). Absent on older transcripts
   *  saved before timestamps, and on the non-diarised path. */
  timestamp?: string;
}

// A diarised line: an optional `[MM:SS]` / `[H:MM:SS]` timestamp, then a
// `[You]` / `[Others]` / `[Speaker N]` speaker marker, then the text up to
// the next marker (or end). Matched globally rather than split so the
// optional timestamp stays attached to its own segment instead of trailing
// the previous one.
const DIARISED_SEGMENT_RE =
  /(?:\[(\d{1,3}:\d{2}(?::\d{2})?)\]\s*)?\[([^\]]+)\]\s*([\s\S]*?)(?=(?:\[\d{1,3}:\d{2}(?::\d{2})?\]\s*)?\[[^\]]+\]|$)/g;

export function parseTranscript(text: string, isDiarised: boolean): Segment[] {
  if (isDiarised) {
    const segments: Segment[] = [];
    for (const m of text.matchAll(DIARISED_SEGMENT_RE)) {
      const body = m[3].trim();
      if (!body) continue;
      segments.push({ speaker: m[2], text: body, timestamp: m[1] });
    }
    return segments;
  }
  const trimmed = text.trim();
  if (!trimmed) return [];
  const sentences = trimmed
    .split(/(?<=[.!?])\s+(?=[A-Z"'([])/)
    .map((s) => s.trim())
    .filter(Boolean);
  return (sentences.length > 1 ? sentences : [trimmed]).map((s) => ({ speaker: null, text: s }));
}
