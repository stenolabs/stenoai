// Formatting of the live transcript captured during a recording, for the two
// places it leaves main's memory at stop:
//
//   1. the instant-stop placeholder note (rendered by the detail view), and
//   2. the snapshot handed to `process-streaming --live-transcript`, which uses
//      it for the early summary and as the empty-batch fallback (#207).
//
// Both keep the speaker ("You" / "Others") and timestamp of every finalised
// live segment, and render them in the SAME shape the batch pipeline saves a
// diarised transcript in (src/transcriber.py _assemble_diarised_turns):
// adjacent same-speaker segments collapse into one turn, each turn is
// `[MM:SS] [Speaker] text`, turns are joined by a blank line, and a transcript
// with only one speaker is saved plain (no labels), exactly as the batch path
// does. The placeholder therefore reads like the final note will.
//
// The snapshot is JSON (`format: LIVE_SNAPSHOT_FORMAT`) so Python gets the
// structured segments rather than having to re-parse rendered text. Python
// still accepts the older plain-text snapshot (src/live_snapshot.py).

const LIVE_SNAPSHOT_FORMAT = 'stenoai-live-transcript/v1';

// 'You' | 'Others'. Anything else from the sidecar is treated as the mic
// channel, matching the lane logic in main.js's LIVE_SEG handler.
function speakerLabel(speaker) {
  return speaker === 'Others' ? 'Others' : 'You';
}

// Same MM:SS / H:MM:SS shape as src/transcriber.py _format_timestamp.
function formatTimestamp(seconds) {
  const n = Number(seconds);
  const total = Number.isFinite(n) ? Math.max(0, Math.floor(n)) : 0;
  const hh = Math.floor(total / 3600);
  const mm = Math.floor((total % 3600) / 60);
  const ss = total % 60;
  const pad = (v) => String(v).padStart(2, '0');
  return hh ? `${hh}:${pad(mm)}:${pad(ss)}` : `${pad(mm)}:${pad(ss)}`;
}

// Finalised segments only: a partial is a preview of speech a final segment
// will (or already did) cover, so including partials would duplicate text.
function finalLiveSegments(segments) {
  return (segments || [])
    .filter((s) => s && s.isFinal && typeof s.text === 'string' && s.text.trim())
    .map((s) => {
      const start = Number(s.start);
      const end = Number(s.end);
      return {
        start: Number.isFinite(start) ? Math.max(0, start) : 0,
        end: Number.isFinite(end) ? Math.max(0, end) : 0,
        speaker: speakerLabel(s.speaker),
        text: s.text.trim(),
      };
    });
}

// { plainText, diarisedText, isDiarised } for a list of FINAL segments (as
// returned by finalLiveSegments). diarisedText is null with one speaker.
function formatLiveTranscript(finals) {
  const turns = [];
  for (const seg of finals || []) {
    const last = turns[turns.length - 1];
    if (last && last.speaker === seg.speaker) {
      last.parts.push(seg.text);
    } else {
      turns.push({ start: seg.start, speaker: seg.speaker, parts: [seg.text] });
    }
  }
  const plainText = turns.map((t) => t.parts.join(' ')).join('\n\n').trim();
  const isDiarised = new Set(turns.map((t) => t.speaker)).size > 1;
  const diarisedText = isDiarised
    ? turns.map((t) => `[${formatTimestamp(t.start)}] [${t.speaker}] ${t.parts.join(' ')}`).join('\n\n')
    : null;
  return { plainText, diarisedText, isDiarised };
}

// The JSON payload written to the --live-transcript temp file.
function buildLiveSnapshot(finals) {
  return JSON.stringify({ format: LIVE_SNAPSHOT_FORMAT, segments: finals || [] });
}

module.exports = {
  LIVE_SNAPSHOT_FORMAT,
  formatTimestamp,
  finalLiveSegments,
  formatLiveTranscript,
  buildLiveSnapshot,
};
