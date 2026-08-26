import type { Meeting } from '@/lib/ipc';
import { stripReasoning } from '@/lib/markdown';

/**
 * Fields from the Meeting object used for search:
 * - session_info.name: Note title (Rank 1)
 * - summary: Markdown summary text (Rank 2)
 * - key_points: Array of bullet point strings (Rank 3)
 * - action_items: Array of action item strings or { text/description } objects (Rank 3)
 * - user_notes / notes: User notes taken during or after the meeting (Rank 4)
 * - transcript / diarised_text: Full transcript or diarised speech text (Rank 5)
 * - participants: Array of participant name strings or objects (Rank 6)
 */

export type SearchMatchField =
  | 'title'
  | 'summary'
  | 'key_point'
  | 'action_item'
  | 'user_notes'
  | 'transcript'
  | 'participant';

export interface NoteSearchMatch {
  field: SearchMatchField;
  label: string;
  snippet: string;
  rank: number;
}

export interface NoteSearchResult {
  meeting: Meeting;
  match: NoteSearchMatch;
}

const FIELD_LABELS: Record<SearchMatchField, string> = {
  title: 'Title',
  summary: 'Summary',
  key_point: 'Key point',
  action_item: 'Action item',
  user_notes: 'Notes',
  transcript: 'Transcript',
  participant: 'Participant',
};

/**
 * Character-safe snippet extraction around the first query match in text.
 * Prevents surrogate-pair splitting at window boundaries and normalizes whitespace.
 */
export function snippet(
  text: string | null | undefined,
  query: string,
  radius = 40,
): string {
  if (!text) return '';
  const clean = stripReasoning(text).replace(/\s+/g, ' ').trim();
  if (!clean) return '';
  const needle = query.trim().toLowerCase();
  if (!needle) {
    return clean.length > radius * 2 ? `${clean.slice(0, radius * 2)}…` : clean;
  }
  const idx = clean.toLowerCase().indexOf(needle);
  if (idx === -1) {
    return clean.length > radius * 2 ? `${clean.slice(0, radius * 2)}…` : clean;
  }

  let start = Math.max(0, idx - radius);
  let end = Math.min(clean.length, idx + needle.length + radius);

  // Ensure start boundary does not split a UTF-16 surrogate pair (low surrogate: 0xdc00-0xdfff)
  if (start > 0 && start < clean.length) {
    const code = clean.charCodeAt(start);
    if (code >= 0xdc00 && code <= 0xdfff) {
      start = Math.max(0, start - 1);
    }
  }

  // Ensure end boundary does not split a UTF-16 surrogate pair (high surrogate: 0xd800-0xdbff)
  if (end > 0 && end < clean.length) {
    const prevCode = clean.charCodeAt(end - 1);
    if (prevCode >= 0xd800 && prevCode <= 0xdbff) {
      end = Math.min(clean.length, end + 1);
    }
  }

  const prefix = start > 0 ? '…' : '';
  const suffix = end < clean.length ? '…' : '';
  return `${prefix}${clean.slice(start, end)}${suffix}`;
}

/**
 * Evaluates a single meeting against the search query, checking fields in priority
 * order: Title > Summary > Key points / Action items > Notes > Transcript > Participants.
 * Returns the best match metadata or null if no field contains the query.
 */
export function matchMeeting(meeting: Meeting, query: string): NoteSearchMatch | null {
  const needle = query.trim().toLowerCase();
  if (!needle) return null;

  // 1. Title (Rank 1)
  const name = meeting.session_info?.name ?? '';
  if (name.toLowerCase().includes(needle)) {
    return {
      field: 'title',
      label: FIELD_LABELS.title,
      snippet: snippet(meeting.summary || name, query),
      rank: 1,
    };
  }

  // 2. Summary (Rank 2)
  if (meeting.summary) {
    const cleanSummary = stripReasoning(meeting.summary);
    if (cleanSummary.toLowerCase().includes(needle)) {
      return {
        field: 'summary',
        label: FIELD_LABELS.summary,
        snippet: snippet(cleanSummary, query),
        rank: 2,
      };
    }
  }

  // 3. Key points (Rank 3)
  if (Array.isArray(meeting.key_points)) {
    for (const kp of meeting.key_points) {
      if (typeof kp === 'string' && kp.toLowerCase().includes(needle)) {
        return {
          field: 'key_point',
          label: FIELD_LABELS.key_point,
          snippet: snippet(kp, query),
          rank: 3,
        };
      }
    }
  }

  // 3. Action items (Rank 3)
  if (Array.isArray(meeting.action_items)) {
    for (const item of meeting.action_items) {
      let itemText = '';
      if (typeof item === 'string') {
        itemText = item;
      } else if (item && typeof item === 'object') {
        if ('text' in item && typeof (item as { text: unknown }).text === 'string') {
          itemText = (item as { text: string }).text;
        } else if ('description' in item && typeof (item as { description: unknown }).description === 'string') {
          itemText = (item as { description: string }).description;
        }
      }
      if (itemText && itemText.toLowerCase().includes(needle)) {
        return {
          field: 'action_item',
          label: FIELD_LABELS.action_item,
          snippet: snippet(itemText, query),
          rank: 3,
        };
      }
    }
  }

  // 4. Notes (Rank 4)
  const userNotes = meeting.user_notes || meeting.notes;
  if (userNotes && typeof userNotes === 'string') {
    if (userNotes.toLowerCase().includes(needle)) {
      return {
        field: 'user_notes',
        label: FIELD_LABELS.user_notes,
        snippet: snippet(userNotes, query),
        rank: 4,
      };
    }
  }

  // 5. Transcript (Rank 5)
  const transcript = meeting.transcript || meeting.diarised_text;
  if (transcript && typeof transcript === 'string') {
    if (transcript.toLowerCase().includes(needle)) {
      return {
        field: 'transcript',
        label: FIELD_LABELS.transcript,
        snippet: snippet(transcript, query),
        rank: 5,
      };
    }
  }

  // 6. Participants (Rank 6)
  if (Array.isArray(meeting.participants)) {
    for (const p of meeting.participants) {
      let pName = '';
      if (typeof p === 'string') {
        pName = p;
      } else if (p && typeof p === 'object') {
        if ('name' in p && typeof (p as { name: unknown }).name === 'string') {
          pName = (p as { name: string }).name;
        } else if ('display_name' in p && typeof (p as { display_name: unknown }).display_name === 'string') {
          pName = (p as { display_name: string }).display_name;
        }
      }
      if (pName && pName.toLowerCase().includes(needle)) {
        return {
          field: 'participant',
          label: FIELD_LABELS.participant,
          snippet: snippet(pName, query),
          rank: 6,
        };
      }
    }
  }

  return null;
}

/**
 * Searches meetings and returns detailed match results including the matched field,
 * label, snippet, and rank. Ordered deterministically by rank (Title > Summary >
 * Key points/Action items > Notes > Transcript > Participants), with input order
 * (recency) preserved as the tiebreaker.
 */
export function searchNotesDetailed(meetings: Meeting[], query: string): NoteSearchResult[] {
  const needle = query.trim();
  if (!needle) return [];

  const results: NoteSearchResult[] = [];
  for (const meeting of meetings) {
    const match = matchMeeting(meeting, needle);
    if (match) {
      results.push({ meeting, match });
    }
  }

  // Stable sort by rank ascending; equal ranks keep their relative recency order
  return results.sort((a, b) => a.match.rank - b.match.rank);
}

/**
 * Single source of truth for note search. Case-insensitive substring match
 * across title, summary, key points, action items, notes, transcript, and participants.
 *
 * Deterministically ranked by match field (title > summary > key points/action items >
 * notes > transcript > participants), preserving input order (recency) as tiebreaker.
 *
 * An empty/whitespace query returns the unfiltered list (or [] if empty list passed).
 */
export function searchNotes(meetings: Meeting[], query: string): Meeting[] {
  const needle = query.trim();
  if (!needle) return meetings;

  return searchNotesDetailed(meetings, query).map((r) => r.meeting);
}
