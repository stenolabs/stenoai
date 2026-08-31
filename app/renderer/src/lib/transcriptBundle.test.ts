import { describe, expect, test } from 'vitest';
import type { Meeting } from '@/lib/ipc';
import { buildTranscriptBundle } from '@/lib/transcriptBundle';

function meeting(overrides: Partial<Meeting> & { diarised_text?: string }): Meeting {
  return {
    session_info: {
      name: 'Project sync',
      duration_seconds: 45,
      processed_at: '2026-01-15T12:00:00.000Z',
    },
    summary: '',
    is_diarised: true,
    transcript: '',
    ...overrides,
  } as Meeting;
}

describe('buildTranscriptBundle conversation view', () => {
  test('non-diarised transcripts stay a single Transcript section', () => {
    const bundle = buildTranscriptBundle(
      meeting({
        is_diarised: false,
        diarised_text: '',
        transcript: 'Alice: we ship Friday.\nBob: I will prep the release notes.',
        participants: ['Alice', 'Bob'],
      }),
    );
    expect(bundle).toContain('# Project sync');
    expect(bundle).toContain('Participants: Alice, Bob');
    expect(bundle).toContain(
      '## Transcript\nAlice: we ship Friday.\nBob: I will prep the release notes.',
    );
    expect(bundle).not.toContain('## Timestamped transcript');
  });

  test('You becomes Me; adjacent fragments merge; a pause stays two turns', () => {
    const adjacent = buildTranscriptBundle(
      meeting({
        diarised_text: '[00:00] [You] This fragment\n[00:02] [You] continues.',
      }),
    );
    expect(adjacent).toContain('## Transcript\nMe: This fragment continues.');
    expect(adjacent).toContain('## Timestamped transcript');
    expect(adjacent).toContain('[00:00] [You] This fragment');
    expect(adjacent).toContain('[00:02] [You] continues.');

    const chain = buildTranscriptBundle(
      meeting({
        diarised_text:
          '[00:00] [You] One.\n[00:02] [You] Two.\n[00:04] [You] Three.',
      }),
    );
    expect(chain).toContain('Me: One. Two. Three.');

    const paused = buildTranscriptBundle(
      meeting({
        diarised_text: '[00:00] [You] First thought.\n[00:15] [You] Later thought.',
      }),
    );
    expect(paused).toContain('Me: First thought.\n\nMe: Later thought.');
  });

  test('accepts a timed speaker marker whose text starts on the next line', () => {
    const body = '[00:00] [You]\nWe should ship Friday.';
    const bundle = buildTranscriptBundle(meeting({ diarised_text: body }));

    expect(bundle).toContain('## Transcript\nMe: We should ship Friday.');
    expect(bundle).toContain(`## Timestamped transcript\n${body}`);
  });

  test('alternating channels keep honest labels and all source timestamps', () => {
    const body = [
      '[00:03] [You] Local opening.',
      '[00:07] [Others] Remote response.',
      '[00:10] [You] Local follow-up.',
      '[00:14] [Others] Remote follow-up.',
      '[00:18] [You] Final local remark.',
    ].join('\n');
    const bundle = buildTranscriptBundle(meeting({ diarised_text: body }));
    expect(bundle).not.toContain('Participants:');
    expect(bundle).toContain('Me: Local opening.');
    expect(bundle).toContain('Others: Remote response.');
    expect(bundle).toContain('## Timestamped transcript');
    expect(bundle).toContain('[00:03] [You] Local opening.');
    expect(bundle).toContain('[00:18] [You] Final local remark.');
  });

  test('does not merge across a resumed timestamp reset', () => {
    const bundle = buildTranscriptBundle(
      meeting({
        diarised_text:
          '[00:10] [You] Before pause.\n[00:01] [You] After resume.\n[00:02] [You] Continues.',
      }),
    );

    expect(bundle).toContain(
      '## Transcript\nMe: Before pause.\n\nMe: After resume. Continues.',
    );
  });

  test('falls back to the original transcript when timestamps are missing', () => {
    const body = '[You] Older first fragment.\n[You] Older second fragment.';
    const bundle = buildTranscriptBundle(meeting({ diarised_text: body }));

    expect(bundle).toContain(`## Transcript\n${body}`);
    expect(bundle).not.toContain('## Timestamped transcript');
    expect(bundle).not.toContain('Me: Older first fragment.');
  });

  test.each([
    '[00:60] [You] Invalid seconds.',
    '[1:02:60] [You] Invalid seconds in a long timestamp.',
    '[1:60:00] [You] Invalid minutes in a long timestamp.',
    'Imported preface that cannot be attributed.\n[00:00] [You] Actual turn.',
    '[Intro: imported context]\n[00:00] [You] Actual turn.',
    '[00:00] [You]\n[00:01] [Others] Actual turn after an empty marker.',
  ])(
    'falls back to the original transcript when a diarised source is not fully parseable',
    (body) => {
      const bundle = buildTranscriptBundle(meeting({ diarised_text: body }));

      expect(bundle).toContain(`## Transcript\n${body}`);
      expect(bundle).not.toContain('## Timestamped transcript');
      expect(bundle).not.toContain('Me:');
    },
  );

  test('enforces the exact gap and combined-span boundaries', () => {
    const atGap = buildTranscriptBundle(
      meeting({ diarised_text: '[00:00.0] [You] One.\n[00:02.5] [You] Two.' }),
    );
    expect(atGap).toContain('## Transcript\nMe: One. Two.');

    const pastGap = buildTranscriptBundle(
      meeting({ diarised_text: '[00:00.0] [You] One.\n[00:02.6] [You] Two.' }),
    );
    expect(pastGap).toContain('## Transcript\nMe: One.\n\nMe: Two.');

    const atSpanTimes = [
      '00:00.0',
      '00:02.5',
      '00:05.0',
      '00:07.5',
      '00:10.0',
      '00:12.5',
      '00:15.0',
      '00:17.5',
      '00:20.0',
    ];
    const atSpan = buildTranscriptBundle(
      meeting({
        diarised_text: atSpanTimes.map((ts, index) => `[${ts}] [You] ${index}.`).join('\n'),
      }),
    );
    expect(atSpan).toContain('## Transcript\nMe: 0. 1. 2. 3. 4. 5. 6. 7. 8.');

    const pastSpan = buildTranscriptBundle(
      meeting({
        diarised_text: [...atSpanTimes, '00:22.5']
          .map((ts, index) => `[${ts}] [You] ${index}.`)
          .join('\n'),
      }),
    );
    expect(pastSpan).toContain(
      '## Transcript\nMe: 0. 1. 2. 3. 4. 5. 6. 7. 8.\n\nMe: 9.',
    );
  });

  test('counts normalized text at the exact 400-character boundary', () => {
    const atLimitTail = 'b'.repeat(398);
    const atLimit = buildTranscriptBundle(
      meeting({ diarised_text: `[00:00] [You] a\n[00:01] [You] ${atLimitTail}` }),
    );
    expect(atLimit).toContain(`## Transcript\nMe: a ${atLimitTail}`);

    const pastLimitTail = 'b'.repeat(399);
    const pastLimit = buildTranscriptBundle(
      meeting({ diarised_text: `[00:00] [You] a\n[00:01] [You] ${pastLimitTail}` }),
    );
    expect(pastLimit).toContain(`## Transcript\nMe: a\n\nMe: ${pastLimitTail}`);

    const whitespaceHeavyTail = `${'c'.repeat(390)}\n     ${'d'.repeat(5)}`;
    const normalized = buildTranscriptBundle(
      meeting({ diarised_text: `[00:00] [You] a\n[00:01] [You] ${whitespaceHeavyTail}` }),
    );
    expect(normalized).toContain(
      `## Transcript\nMe: a ${'c'.repeat(390)} ${'d'.repeat(5)}`,
    );
  });
});
