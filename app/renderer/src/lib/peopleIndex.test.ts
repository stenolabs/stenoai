import { describe, test, expect } from 'vitest';
import type { Meeting } from '@/lib/ipc';
import { buildPeopleIndex, normalizePersonKey } from './peopleIndex';

function makeMeeting(overrides: Partial<Meeting> & {
  name?: string;
  summary_file?: string;
  processed_at?: string;
  attendees?: string[];
}): Meeting {
  const { name, summary_file, processed_at, attendees, ...rest } = overrides;
  const fileName = summary_file ?? `${(name ?? 'untitled').toLowerCase().replace(/\s+/g, '_')}.json`;
  return {
    session_info: {
      name: name ?? 'Untitled Note',
      summary_file: fileName,
      processed_at: processed_at ?? '2026-08-01T10:00:00Z',
    },
    summary: '',
    attendees: attendees ?? [],
    ...rest,
  };
}

describe('normalizePersonKey', () => {
  test('trims, collapses whitespace, and lowercases', () => {
    expect(normalizePersonKey('  Alice   Smith  ')).toBe('alice smith');
    expect(normalizePersonKey('BOB JONES')).toBe('bob jones');
  });

  test('handles zh-Hant and CJK names properly', () => {
    expect(normalizePersonKey('唐鳳')).toBe('唐鳳');
    expect(normalizePersonKey('  唐 鳳  ')).toBe('唐 鳳');
    expect(normalizePersonKey('黃 欽 勇')).toBe('黃 欽 勇');
  });
});

describe('buildPeopleIndex', () => {
  test('returns empty array for empty, undefined, or null input', () => {
    expect(buildPeopleIndex([])).toEqual([]);
    expect(buildPeopleIndex(undefined)).toEqual([]);
    expect(buildPeopleIndex(null)).toEqual([]);
  });

  test('indexes per-person counts across multiple notes', () => {
    const meetings = [
      makeMeeting({
        name: 'M1',
        summary_file: 'm1.json',
        processed_at: '2026-08-01T10:00:00Z',
        attendees: ['Alice Smith', 'Bob Jones'],
      }),
      makeMeeting({
        name: 'M2',
        summary_file: 'm2.json',
        processed_at: '2026-08-02T10:00:00Z',
        attendees: ['Alice Smith', 'Charlie Brown'],
      }),
      makeMeeting({
        name: 'M3',
        summary_file: 'm3.json',
        processed_at: '2026-08-03T10:00:00Z',
        attendees: ['Alice Smith'],
      }),
    ];

    const index = buildPeopleIndex(meetings);
    expect(index).toHaveLength(3);

    // Alice attended 3 notes
    expect(index[0].name).toBe('Alice Smith');
    expect(index[0].noteCount).toBe(3);
    expect(index[0].summaryFiles).toEqual(['m1.json', 'm2.json', 'm3.json']);
    expect(index[0].lastDate).toBe('2026-08-03T10:00:00Z');

    // Bob and Charlie attended 1 note each; Charlie is more recent (Aug 2 vs Aug 1)
    expect(index[1].name).toBe('Charlie Brown');
    expect(index[1].noteCount).toBe(1);
    expect(index[1].lastDate).toBe('2026-08-02T10:00:00Z');

    expect(index[2].name).toBe('Bob Jones');
    expect(index[2].noteCount).toBe(1);
    expect(index[2].lastDate).toBe('2026-08-01T10:00:00Z');
  });

  test('counts an attendee only once per note even if duplicated in array', () => {
    const meetings = [
      makeMeeting({
        name: 'M1',
        summary_file: 'm1.json',
        attendees: ['Alice Smith', 'alice smith', '  Alice   Smith  '],
      }),
    ];

    const index = buildPeopleIndex(meetings);
    expect(index).toHaveLength(1);
    expect(index[0].name).toBe('Alice Smith');
    expect(index[0].noteCount).toBe(1);
    expect(index[0].summaryFiles).toEqual(['m1.json']);
  });

  test('preserves best-looking title case display name', () => {
    const meetings = [
      makeMeeting({
        name: 'M1',
        summary_file: 'm1.json',
        attendees: ['alice smith'],
      }),
      makeMeeting({
        name: 'M2',
        summary_file: 'm2.json',
        attendees: ['Alice Smith'],
      }),
    ];

    const index = buildPeopleIndex(meetings);
    expect(index).toHaveLength(1);
    expect(index[0].name).toBe('Alice Smith');
    expect(index[0].noteCount).toBe(2);
  });

  test('handles zh-Hant names correctly', () => {
    const meetings = [
      makeMeeting({
        name: 'M1',
        summary_file: 'm1.json',
        processed_at: '2026-08-10T10:00:00Z',
        attendees: ['唐鳳', '黃欽勇'],
      }),
      makeMeeting({
        name: 'M2',
        summary_file: 'm2.json',
        processed_at: '2026-08-12T10:00:00Z',
        attendees: ['唐鳳', '李開復'],
      }),
    ];

    const index = buildPeopleIndex(meetings);
    expect(index).toHaveLength(3);
    expect(index[0].name).toBe('唐鳳');
    expect(index[0].noteCount).toBe(2);
    expect(index[0].summaryFiles).toEqual(['m1.json', 'm2.json']);
    expect(index[0].lastDate).toBe('2026-08-12T10:00:00Z');
  });

  test('safely skips notes with no attendees or malformed entries', () => {
    const meetings = [
      makeMeeting({
        name: 'Solo 1',
        summary_file: 'solo1.json',
        attendees: [],
      }),
      makeMeeting({
        name: 'Solo 2',
        summary_file: 'solo2.json',
        attendees: undefined,
      }),
      makeMeeting({
        name: 'With Attendees',
        summary_file: 'with.json',
        attendees: ['Dana Scully', '', '   '],
      }),
    ];

    const index = buildPeopleIndex(meetings);
    expect(index).toHaveLength(1);
    expect(index[0].name).toBe('Dana Scully');
    expect(index[0].noteCount).toBe(1);
  });

  test('deterministic ordering: count DESC, then date DESC, then name ASC', () => {
    const meetings = [
      makeMeeting({
        name: 'M1',
        summary_file: 'm1.json',
        processed_at: '2026-08-01T10:00:00Z',
        attendees: ['Zachary Adams', 'Aaron Paul', 'Beta User'],
      }),
      makeMeeting({
        name: 'M2',
        summary_file: 'm2.json',
        processed_at: '2026-08-05T10:00:00Z',
        attendees: ['Beta User', 'Aaron Paul'],
      }),
      makeMeeting({
        name: 'M3',
        summary_file: 'm3.json',
        processed_at: '2026-08-10T10:00:00Z',
        attendees: ['Beta User'],
      }),
    ];

    const index = buildPeopleIndex(meetings);
    // Beta User: count 3
    // Aaron Paul: count 2 (date Aug 5)
    // Zachary Adams: count 1 (date Aug 1)
    expect(index.map((p) => p.name)).toEqual(['Beta User', 'Aaron Paul', 'Zachary Adams']);

    // When counts and dates are identical, alphabetical by name
    const tiedMeetings = [
      makeMeeting({
        name: 'Tied',
        summary_file: 'tied.json',
        processed_at: '2026-08-01T10:00:00Z',
        attendees: ['Zoe', 'Alice', 'Charlie'],
      }),
    ];
    const tiedIndex = buildPeopleIndex(tiedMeetings);
    expect(tiedIndex.map((p) => p.name)).toEqual(['Alice', 'Charlie', 'Zoe']);
  });

  test('stays fast and single-pass on a large list of meetings', () => {
    const largeList: Meeting[] = [];
    for (let i = 0; i < 500; i++) {
      largeList.push(
        makeMeeting({
          name: `Meeting ${i}`,
          summary_file: `m_${i}.json`,
          processed_at: new Date(1700000000000 + i * 3600000).toISOString(),
          attendees: [`Person ${i % 20}`, `Person ${(i + 1) % 20}`, `Person ${(i + 2) % 20}`],
        }),
      );
    }

    const start = performance.now();
    const index = buildPeopleIndex(largeList);
    const elapsed = performance.now() - start;

    expect(index).toHaveLength(20);
    expect(elapsed).toBeLessThan(50); // < 50ms for 500 meetings
  });
});
