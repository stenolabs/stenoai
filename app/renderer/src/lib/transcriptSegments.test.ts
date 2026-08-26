import { describe, test, expect } from 'vitest';
import { parseTranscript } from '@/lib/transcriptSegments';

/**
 * parseTranscript splits a diarised transcript into speaker segments, pulling
 * the optional leading `[MM:SS]` / `[H:MM:SS]` timestamp (written by
 * transcriber.py's _format_timestamp) into its own field. The load-bearing
 * edges: a timestamp must attach to its OWN segment (not trail the previous
 * one), and transcripts saved BEFORE timestamps (no `[MM:SS]`) must still parse.
 */
describe('parseTranscript — diarised', () => {
  test('extracts timestamp, speaker, and text per turn', () => {
    const segs = parseTranscript(
      '[00:01] [You] Hello there\n\n[00:15] [Others] Hi back',
      true,
    );
    expect(segs).toEqual([
      { speaker: 'You', text: 'Hello there', timestamp: '00:01' },
      { speaker: 'Others', text: 'Hi back', timestamp: '00:15' },
    ]);
  });

  test('handles the H:MM:SS form for long meetings', () => {
    const segs = parseTranscript('[1:02:03] [You] Still going', true);
    expect(segs[0].timestamp).toBe('1:02:03');
    expect(segs[0].text).toBe('Still going');
  });

  test('parses timestamp-less transcripts (saved before this feature)', () => {
    const segs = parseTranscript('[You] Hello\n\n[Others] Hi', true);
    expect(segs).toEqual([
      { speaker: 'You', text: 'Hello', timestamp: undefined },
      { speaker: 'Others', text: 'Hi', timestamp: undefined },
    ]);
  });

  test('multi-line segment text stays with its turn', () => {
    const segs = parseTranscript('[00:00] [You] line one\nline two\n\n[00:05] [Others] reply', true);
    expect(segs[0].text).toContain('line one');
    expect(segs[0].text).toContain('line two');
    expect(segs[1].timestamp).toBe('00:05');
  });

  test('parses acoustically-diarized "Speaker N" labels alongside You/Others', () => {
    const segs = parseTranscript(
      '[00:00] [You] Hello\n\n[00:05] [Speaker 2] Hi there\n\n[00:10] [Others] Welcome',
      true,
    );
    expect(segs).toEqual([
      { speaker: 'You', text: 'Hello', timestamp: '00:00' },
      { speaker: 'Speaker 2', text: 'Hi there', timestamp: '00:05' },
      { speaker: 'Others', text: 'Welcome', timestamp: '00:10' },
    ]);
  });
});

describe('parseTranscript — non-diarised', () => {
  test('splits into sentence segments with no speaker or timestamp', () => {
    const segs = parseTranscript('First sentence. Second sentence.', false);
    expect(segs.length).toBeGreaterThan(0);
    expect(segs.every((s) => s.speaker === null && s.timestamp === undefined)).toBe(true);
  });

  test('empty input yields no segments', () => {
    expect(parseTranscript('   ', false)).toEqual([]);
  });
});
