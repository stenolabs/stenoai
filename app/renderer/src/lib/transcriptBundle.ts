import type { Meeting } from '@/lib/ipc';
import { parseTranscript } from '@/lib/transcriptSegments';

const COALESCE_MAX_GAP_S = 2.5;
const COALESCE_MAX_SPAN_S = 20;
const COALESCE_MAX_CHARS = 400;
const TIMED_DIARISED_TURN_AT_HEAD_RE =
  /^\[\d{1,3}:\d{2}(?::\d{2})?(?:\.\d+)?\]\s*\[[^\]]+\]\s*([\s\S]*?)(?=(?:\[\d{1,3}:\d{2}(?::\d{2})?(?:\.\d+)?\]\s*)?\[[^\]]+\]|$)/;

// Build a clean, metadata-rich Markdown bundle for pasting into an external LLM.
// Pure: takes the in-memory Meeting, returns a string. Returns '' when there is no
// transcript at all (callers disable their action on empty output).
export function buildTranscriptBundle(meeting: Meeting | null | undefined): string {
  if (!meeting) return '';

  const info = meeting.session_info;
  const title = (info?.name ?? '').trim() || 'Untitled note';

  // Prefer the diarised ([You]/[Others]) text when present; else the flat transcript.
  const body = (
    meeting.is_diarised && (meeting.diarised_text ?? '').trim()
      ? (meeting.diarised_text as string)
      : (meeting.transcript ?? '')
  ).trim();
  if (!body) return '';

  const metaParts: string[] = [];
  const dateStr = meetingDate(info);
  if (dateStr) metaParts.push(`Date: ${dateStr}`);
  const durStr = secondsToMinutes(info?.duration_seconds);
  if (durStr) metaParts.push(`Duration: ${durStr}`);
  const people = participantNames(meeting.participants);
  if (people) metaParts.push(`Participants: ${people}`);

  const lines: string[] = [`# ${title}`];
  if (metaParts.length) lines.push(metaParts.join(' · '));

  const notes = (meeting.user_notes ?? meeting.notes ?? '').trim();
  if (notes) lines.push('', '## Notes', notes);

  const conversation = meeting.is_diarised ? coalesceConversation(body) : null;
  if (conversation) {
    lines.push('', '## Transcript', conversation);
    lines.push('', '## Timestamped transcript', body);
  } else {
    lines.push('', '## Transcript', body);
  }
  return lines.join('\n');
}

// e.g. "2026-06-19-epsilon-planning.md" (or ".pdf" for the notes export).
// `ext` is the bare extension without a dot; defaults to 'md' so existing
// callers are unchanged.
export function defaultExportFilename(
  meeting: Meeting | null | undefined,
  ext = 'md',
): string {
  const info = meeting?.session_info;
  const date = meetingDate(info) ?? isoToDate(new Date().toISOString())!;
  const slug =
    transliterate(info?.name ?? '')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      // Cap the slug so a very long title can't push the filename past the
      // ~255-byte filesystem limit (date prefix + extension leave headroom).
      .slice(0, 80)
      .replace(/-+$/g, '') || 'transcript';
  return `${date}-${slug}.${ext}`;
}

// Map the common non-ASCII characters (esp. German umlauts/ß) to ASCII before
// slugging, so a title like "Ärztegespräch über Änderungen" yields a readable
// "aerztegespraech-ueber-aenderungen" filename instead of being stripped to
// dashes. Deliberately a small hand-rolled table (no Unicode dependency): the
// explicit umlaut map handles the ae/oe/ue/ss expansions, then NFD + combining-
// mark removal strips the remaining accents (é→e, ñ→n, …) for free.
function transliterate(input: string): string {
  const umlauts: Record<string, string> = {
    ä: 'ae',
    ö: 'oe',
    ü: 'ue',
    Ä: 'Ae',
    Ö: 'Oe',
    Ü: 'Ue',
    ß: 'ss',
  };
  return input
    .replace(/[äöüÄÖÜß]/g, (ch) => umlauts[ch] ?? ch)
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '');
}

// Resolve a meeting's display date, preferring `processed_at` but falling back
// to `updated_at` when the former is missing OR present-but-unparseable. The
// backend stores `processed_at` as '' for a meeting whose .md lacks a `date:`
// frontmatter (see _parse_meeting_markdown: meta.get('date', '')), and a bare
// `processed_at ?? updated_at` would stop at that empty string, dropping a valid
// `updated_at`. Validate each field through isoToDate (which rejects ''/garbage)
// and take the first that yields a real date.
function meetingDate(info: { processed_at?: string; updated_at?: string } | undefined): string | null {
  return isoToDate(info?.processed_at) ?? isoToDate(info?.updated_at);
}

function isoToDate(iso: string | undefined): string | null {
  if (!iso) return null;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

function secondsToMinutes(seconds: number | undefined): string | null {
  if (!seconds || seconds <= 0) return null;
  const mins = Math.round(seconds / 60);
  return mins < 1 ? '<1 min' : `${mins} min`;
}

function participantNames(participants: unknown): string | null {
  const names: string[] = [];
  const seen = new Set<string>();
  if (!Array.isArray(participants)) return null;
  for (const p of participants) {
    let raw = '';
    if (typeof p === 'string') raw = p;
    else if (p && typeof p === 'object' && 'name' in p && typeof p.name === 'string') {
      raw = p.name;
    }
    const name = raw.trim();
    if (!name || seen.has(name)) continue;
    seen.add(name);
    names.push(name);
  }
  return names.length ? names.join(', ') : null;
}


function conversationSpeaker(raw: string | null): string {
  if (raw === 'You') return 'Me';
  const label = raw?.trim();
  return label ? label : 'Unknown';
}

function normalizeConversationText(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

function timestampToSeconds(ts: string | undefined): number | null {
  if (!ts) return null;
  const parts = ts.split(':').map(Number);
  if (parts.length < 2 || parts.some((n) => !Number.isFinite(n))) return null;
  if (parts.length === 2) {
    if (parts[1] >= 60) return null;
    return parts[0] * 60 + parts[1];
  }
  if (parts.length === 3) {
    if (parts[1] >= 60 || parts[2] >= 60) return null;
    return parts[0] * 3600 + parts[1] * 60 + parts[2];
  }
  return null;
}

function coalesceConversation(body: string): string | null {
  const firstTurn = body.match(TIMED_DIARISED_TURN_AT_HEAD_RE);
  if (!firstTurn?.[1]?.trim()) return null;

  const segs = parseTranscript(body, true);
  if (segs.length === 0) return null;
  const timedSegments: Array<{ speaker: string; text: string; start: number }> = [];
  for (const seg of segs) {
    const start = timestampToSeconds(seg.timestamp);
    if (start == null) return null;
    timedSegments.push({
      speaker: conversationSpeaker(seg.speaker),
      text: normalizeConversationText(seg.text),
      start,
    });
  }
  type Row = {
    speaker: string;
    text: string;
    rowStart: number;
    lastStart: number;
  };
  const rows: Row[] = [];
  for (const { speaker, text, start } of timedSegments) {
    const last = rows[rows.length - 1];
    const gap = last == null ? null : start - last.lastStart;
    const span = last == null ? null : start - last.rowStart;
    const gapOk =
      last != null &&
      last.speaker === speaker &&
      gap != null &&
      gap >= 0 &&
      gap <= COALESCE_MAX_GAP_S;
    const spanOk =
      last != null &&
      span != null &&
      span >= 0 &&
      span <= COALESCE_MAX_SPAN_S;
    const charsOk = last != null && last.text.length + 1 + text.length <= COALESCE_MAX_CHARS;
    if (last && gapOk && spanOk && charsOk) {
      last.text = `${last.text} ${text}`;
      last.lastStart = start;
    } else {
      rows.push({ speaker, text, rowStart: start, lastStart: start });
    }
  }
  return rows.map((r) => `${r.speaker}: ${r.text}`).join('\n\n');
}
