import type { Meeting } from '@/lib/ipc';

export interface PersonItem {
  id: string;
  name: string;
  noteCount: number;
  lastDate: string | null;
  summaryFiles: string[];
}

/**
 * Normalise attendee string for grouping: trim, collapse internal whitespace, case-fold.
 * Preserves CJK / zh-Hant characters without space-delimited assumptions.
 */
export function normalizePersonKey(raw: string): string {
  return raw.trim().replace(/\s+/g, ' ').toLowerCase();
}

/**
 * Choose the best-looking display name among variations (e.g. "Alice Smith" vs "alice smith").
 * Prefers variations with uppercase / title-case characters.
 */
function pickBestDisplayName(current: string, candidate: string): string {
  const cleanCand = candidate.trim().replace(/\s+/g, ' ');
  if (!current) return cleanCand;
  const currentUpper = (current.match(/[A-Z\p{Lu}]/u) || []).length;
  const candUpper = (cleanCand.match(/[A-Z\p{Lu}]/u) || []).length;
  if (candUpper > currentUpper) {
    return cleanCand;
  }
  return current;
}

interface PersonAccumulator {
  id: string;
  name: string;
  noteCount: number;
  lastDate: string | null;
  latestTs: number;
  summaryFiles: string[];
}

/**
 * Single-pass indexing over meetings returning one entry per distinct attendee.
 * Deterministic ordering:
 *  1. note count DESC
 *  2. most recent note date DESC
 *  3. display name ASC
 */
export function buildPeopleIndex(meetings: Meeting[] | undefined | null): PersonItem[] {
  if (!meetings || !Array.isArray(meetings) || meetings.length === 0) {
    return [];
  }

  const map = new Map<string, PersonAccumulator>();

  for (const meeting of meetings) {
    if (!meeting) continue;
    const attendees = meeting.attendees;
    if (!Array.isArray(attendees) || attendees.length === 0) continue;

    const summaryFile = meeting.session_info?.summary_file;
    const rawDate = meeting.session_info?.processed_at ?? meeting.session_info?.updated_at ?? null;
    let ts = 0;
    if (rawDate) {
      const parsed = new Date(rawDate).getTime();
      if (!Number.isNaN(parsed)) {
        ts = parsed;
      }
    }

    const seenInMeeting = new Set<string>();

    for (const rawAttendee of attendees) {
      if (typeof rawAttendee !== 'string') continue;
      const key = normalizePersonKey(rawAttendee);
      if (!key) continue;

      if (seenInMeeting.has(key)) continue;
      seenInMeeting.add(key);

      const existing = map.get(key);
      if (!existing) {
        map.set(key, {
          id: key,
          name: pickBestDisplayName('', rawAttendee),
          noteCount: 1,
          lastDate: rawDate,
          latestTs: ts,
          summaryFiles: summaryFile ? [summaryFile] : [],
        });
      } else {
        existing.name = pickBestDisplayName(existing.name, rawAttendee);
        existing.noteCount += 1;
        if (ts > existing.latestTs || (!existing.lastDate && rawDate)) {
          existing.latestTs = ts;
          existing.lastDate = rawDate;
        }
        if (summaryFile && !existing.summaryFiles.includes(summaryFile)) {
          existing.summaryFiles.push(summaryFile);
        }
      }
    }
  }

  const result: PersonItem[] = Array.from(map.values()).map((p) => ({
    id: p.id,
    name: p.name,
    noteCount: p.noteCount,
    lastDate: p.lastDate,
    summaryFiles: p.summaryFiles,
  }));

  // Deterministic ordering:
  // 1. note count DESC
  // 2. most recent note date DESC
  // 3. name ASC
  return result.sort((a, b) => {
    if (b.noteCount !== a.noteCount) {
      return b.noteCount - a.noteCount;
    }
    const aTs = a.lastDate ? new Date(a.lastDate).getTime() : 0;
    const bTs = b.lastDate ? new Date(b.lastDate).getTime() : 0;
    if (bTs !== aTs) {
      return bTs - aTs;
    }
    const nameCmp = a.name.localeCompare(b.name, undefined, { sensitivity: 'base' });
    if (nameCmp !== 0) return nameCmp;
    return a.id.localeCompare(b.id);
  });
}
