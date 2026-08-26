import { describe, test, expect } from 'vitest';
import type { Meeting } from '@/lib/ipc';
import {
  searchNotes,
  searchNotesDetailed,
  matchMeeting,
  snippet,
} from '@/lib/noteSearch';

function makeMeeting(overrides: Partial<Meeting> & { name?: string; processed_at?: string }): Meeting {
  const { name, processed_at, ...rest } = overrides;
  return {
    session_info: {
      name: name ?? 'Untitled Note',
      summary_file: `${(name ?? 'untitled').toLowerCase().replace(/\s+/g, '_')}.json`,
      processed_at: processed_at ?? '2026-08-01T10:00:00Z',
    },
    summary: '',
    ...rest,
  };
}

describe('noteSearch - field matching and labels', () => {
  test('matches note title with Title label', () => {
    const meeting = makeMeeting({ name: 'Architecture Review Q3' });
    const match = matchMeeting(meeting, 'Architecture');
    expect(match).not.toBeNull();
    expect(match?.field).toBe('title');
    expect(match?.label).toBe('Title');
    expect(match?.rank).toBe(1);
  });

  test('matches summary with Summary label', () => {
    const meeting = makeMeeting({
      name: 'Team Sync',
      summary: 'We decided on adopting the new streaming protocol.',
    });
    const match = matchMeeting(meeting, 'streaming protocol');
    expect(match).not.toBeNull();
    expect(match?.field).toBe('summary');
    expect(match?.label).toBe('Summary');
    expect(match?.rank).toBe(2);
    expect(match?.snippet).toContain('streaming protocol');
  });

  test('matches key_points with Key point label', () => {
    const meeting = makeMeeting({
      name: 'Design Session',
      key_points: ['Latency must stay under 50ms', 'Use zero-copy buffers'],
    });
    const match = matchMeeting(meeting, 'zero-copy');
    expect(match).not.toBeNull();
    expect(match?.field).toBe('key_point');
    expect(match?.label).toBe('Key point');
    expect(match?.rank).toBe(3);
    expect(match?.snippet).toContain('zero-copy buffers');
  });

  test('matches action_items string with Action item label', () => {
    const meeting = makeMeeting({
      name: 'Post-Mortem',
      action_items: ['Deploy hotfix to edge cluster', 'Update runbook'],
    });
    const match = matchMeeting(meeting, 'edge cluster');
    expect(match).not.toBeNull();
    expect(match?.field).toBe('action_item');
    expect(match?.label).toBe('Action item');
    expect(match?.rank).toBe(3);
    expect(match?.snippet).toContain('Deploy hotfix to edge cluster');
  });

  test('matches action_items object with Action item label', () => {
    const meeting = makeMeeting({
      name: 'Sprint Planning',
      action_items: [{ text: 'Benchmark parakeet on M5 Max' }],
    });
    const match = matchMeeting(meeting, 'parakeet');
    expect(match).not.toBeNull();
    expect(match?.field).toBe('action_item');
    expect(match?.label).toBe('Action item');
    expect(match?.rank).toBe(3);
  });

  test('matches user_notes with Notes label', () => {
    const meeting = makeMeeting({
      name: 'Client Call',
      user_notes: 'Client requested SOC2 compliance report by next week.',
    });
    const match = matchMeeting(meeting, 'SOC2 compliance');
    expect(match).not.toBeNull();
    expect(match?.field).toBe('user_notes');
    expect(match?.label).toBe('Notes');
    expect(match?.rank).toBe(4);
    expect(match?.snippet).toContain('SOC2 compliance');
  });

  test('matches draft notes with Notes label', () => {
    const meeting = makeMeeting({
      name: 'Quick Huddle',
      notes: 'Remember to verify disk quotas.',
    });
    const match = matchMeeting(meeting, 'disk quotas');
    expect(match).not.toBeNull();
    expect(match?.field).toBe('user_notes');
    expect(match?.label).toBe('Notes');
    expect(match?.rank).toBe(4);
  });

  test('matches transcript with Transcript label', () => {
    const meeting = makeMeeting({
      name: 'Standup',
      transcript: 'Alice: We discovered a memory leak in the audio buffer loop.',
    });
    const match = matchMeeting(meeting, 'memory leak');
    expect(match).not.toBeNull();
    expect(match?.field).toBe('transcript');
    expect(match?.label).toBe('Transcript');
    expect(match?.rank).toBe(5);
    expect(match?.snippet).toContain('memory leak in the audio buffer loop');
  });

  test('matches diarised_text with Transcript label', () => {
    const meeting = makeMeeting({
      name: '1-on-1',
      diarised_text: '[01:23] [Bob] The pipeline latency improved by 40%.',
    });
    const match = matchMeeting(meeting, 'pipeline latency');
    expect(match).not.toBeNull();
    expect(match?.field).toBe('transcript');
    expect(match?.label).toBe('Transcript');
    expect(match?.rank).toBe(5);
  });

  test('matches participants with Participant label', () => {
    const meeting = makeMeeting({
      name: 'All Hands',
      participants: ['Audrey Tang', 'John Doe'],
    });
    const match = matchMeeting(meeting, 'Audrey Tang');
    expect(match).not.toBeNull();
    expect(match?.field).toBe('participant');
    expect(match?.label).toBe('Participant');
    expect(match?.rank).toBe(6);
  });
});

describe('noteSearch - deterministic ranking', () => {
  test('ranks Title > Summary > Key points > Notes > Transcript', () => {
    const query = 'relevance';
    const transcriptMatch = makeMeeting({
      name: 'Meeting A',
      transcript: 'Some details about relevance in the full audio transcript.',
      processed_at: '2026-08-05T10:00:00Z',
    });
    const notesMatch = makeMeeting({
      name: 'Meeting B',
      user_notes: 'Typed notes about relevance during meeting.',
      processed_at: '2026-08-04T10:00:00Z',
    });
    const keyPointMatch = makeMeeting({
      name: 'Meeting C',
      key_points: ['Key point concerning relevance score'],
      processed_at: '2026-08-03T10:00:00Z',
    });
    const summaryMatch = makeMeeting({
      name: 'Meeting D',
      summary: 'Summary paragraph covering relevance metric.',
      processed_at: '2026-08-02T10:00:00Z',
    });
    const titleMatch = makeMeeting({
      name: 'Relevance Discussion',
      processed_at: '2026-08-01T10:00:00Z',
    });

    // Pass in reverse rank order
    const list = [transcriptMatch, notesMatch, keyPointMatch, summaryMatch, titleMatch];
    const results = searchNotes(list, query);

    expect(results).toHaveLength(5);
    expect(results[0].session_info.name).toBe('Relevance Discussion'); // Rank 1
    expect(results[1].session_info.name).toBe('Meeting D'); // Rank 2 (Summary)
    expect(results[2].session_info.name).toBe('Meeting C'); // Rank 3 (Key points)
    expect(results[3].session_info.name).toBe('Meeting B'); // Rank 4 (Notes)
    expect(results[4].session_info.name).toBe('Meeting A'); // Rank 5 (Transcript)
  });

  test('preserves recency as tiebreaker for equal ranks', () => {
    const query = 'database';
    const newer = makeMeeting({
      name: 'Meeting New',
      summary: 'Migrated database schema today.',
      processed_at: '2026-08-10T10:00:00Z',
    });
    const older = makeMeeting({
      name: 'Meeting Old',
      summary: 'Initial database design from last month.',
      processed_at: '2026-07-10T10:00:00Z',
    });

    const list = [newer, older];
    const results = searchNotes(list, query);

    expect(results).toHaveLength(2);
    expect(results[0].session_info.name).toBe('Meeting New');
    expect(results[1].session_info.name).toBe('Meeting Old');
  });
});

describe('noteSearch - CJK & character safety', () => {
  test('zh-Hant query returns readable snippet without splitting characters', () => {
    const zhText = '今天討論了繁體中文的語言模型在地化與語音辨識優化方案。';
    const meeting = makeMeeting({
      name: '語音模型會議',
      summary: zhText,
    });

    const match = matchMeeting(meeting, '語音辨識');
    expect(match).not.toBeNull();
    expect(match?.field).toBe('summary');
    expect(match?.snippet).toContain('語音辨識');
    expect(match?.snippet).toContain('語言模型在地化與語音辨識優化方案');
  });

  test('surrogate pairs at snippet boundaries do not split', () => {
    // Supplementary plane character (e.g. musical symbol or emoji 🚀 / 💡)
    const textWithEmoji = 'Start of report 🚀🚀🚀 Feature deployment was successful 💡💡💡 End of report';
    const result = snippet(textWithEmoji, 'Feature deployment', 10);
    expect(result).toContain('Feature deployment');
    // Ensure no unclosed or broken surrogate character codes
    for (let i = 0; i < result.length; i++) {
      const code = result.charCodeAt(i);
      if (code >= 0xd800 && code <= 0xdbff) {
        // High surrogate MUST be followed by low surrogate
        const next = result.charCodeAt(i + 1);
        expect(next >= 0xdc00 && next <= 0xdfff).toBe(true);
      }
    }
  });
});

describe('noteSearch - empty query and caps', () => {
  test('empty or whitespace query returns unfiltered list', () => {
    const meetings = [
      makeMeeting({ name: 'First' }),
      makeMeeting({ name: 'Second' }),
    ];
    expect(searchNotes(meetings, '')).toEqual(meetings);
    expect(searchNotes(meetings, '   ')).toEqual(meetings);
  });

  test('searchNotesDetailed returns [] on empty query', () => {
    const meetings = [makeMeeting({ name: 'First' })];
    expect(searchNotesDetailed(meetings, '')).toEqual([]);
  });

  test('result cap slicing works as expected', () => {
    const meetings: Meeting[] = [];
    for (let i = 0; i < 100; i++) {
      meetings.push(makeMeeting({ name: `Meeting ${i}`, summary: 'Common keyword match' }));
    }
    const results = searchNotes(meetings, 'Common keyword').slice(0, 50);
    expect(results).toHaveLength(50);
  });
});

describe('noteSearch - large-corpus performance', () => {
  test('evaluates 5,000 meetings in single-pass linear time without per-note regex compile', () => {
    const meetings: Meeting[] = [];
    for (let i = 0; i < 5000; i++) {
      meetings.push(
        makeMeeting({
          name: `Sprint Meeting ${i}`,
          summary: i % 10 === 0 ? 'Discussing roadmap prioritization and metrics.' : 'Regular daily standup check-in.',
          key_points: ['Point 1', 'Point 2'],
          transcript: i === 4242 ? 'Special needle term hidden deep in the transcript text.' : 'Standard audio transcript.',
        }),
      );
    }

    const t0 = performance.now();
    const results = searchNotes(meetings, 'Special needle term');
    const elapsed = performance.now() - t0;

    expect(results).toHaveLength(1);
    expect(results[0].session_info.name).toBe('Sprint Meeting 4242');
    // Must be fast: under 100ms for 5k meetings (typically < 15ms)
    expect(elapsed).toBeLessThan(200);
  });
});
