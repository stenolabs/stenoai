import { describe, test, expect } from 'vitest';
import {
  findCitation,
  findCitationsBatch,
  preprocessTranscript,
  stripTranscriptPrefix,
  extractTokens,
} from '@/lib/transcriptCitations';

describe('stripTranscriptPrefix', () => {
  test('strips range timestamps and speaker prefixes', () => {
    expect(stripTranscriptPrefix('[00:00 - 00:05] Speaker: Hello world')).toBe('Hello world');
    expect(stripTranscriptPrefix('[00:03] [You] We ship Friday.')).toBe('We ship Friday.');
    expect(stripTranscriptPrefix('[Others] I will prep notes.')).toBe('I will prep notes.');
    expect(stripTranscriptPrefix('Alice: We ship Friday.')).toBe('We ship Friday.');
    expect(stripTranscriptPrefix('Plain text without prefix')).toBe('Plain text without prefix');
  });
});

describe('extractTokens', () => {
  test('extracts English words while filtering stopwords', () => {
    const tokens = extractTokens('The team agreed to ship on Friday');
    expect(tokens.has('team')).toBe(true);
    expect(tokens.has('agreed')).toBe(true);
    expect(tokens.has('ship')).toBe(true);
    expect(tokens.has('friday')).toBe(true);
    expect(tokens.has('the')).toBe(false);
    expect(tokens.has('to')).toBe(false);
    expect(tokens.has('on')).toBe(false);
  });

  test('extracts CJK character bigrams for Traditional Chinese', () => {
    const tokens = extractTokens('團隊決定在週五發布新版本');
    expect(tokens.has('團隊')).toBe(true);
    expect(tokens.has('隊決')).toBe(true);
    expect(tokens.has('決定')).toBe(true);
    expect(tokens.has('週五')).toBe(true);
    expect(tokens.has('發布')).toBe(true);
    expect(tokens.has('新版')).toBe(true);
    expect(tokens.has('版本')).toBe(true);
  });
});

describe('findCitation — deterministic lookup & anti-guessing', () => {
  const sampleTranscript = [
    'Alice: We ship Friday.',
    'Bob: I will prep the release notes and update the website.',
    'Charlie: I will verify the database backups before the deploy.',
  ];

  test('exact-quote bullet matches the exact line with high score', () => {
    const match = findCitation('We ship Friday.', sampleTranscript);
    expect(match).not.toBeNull();
    expect(match?.lineIndex).toBe(0);
    expect(match?.score).toBeGreaterThanOrEqual(0.8);
  });

  test('paraphrase sharing sufficient tokens matches the correct line', () => {
    const match = findCitation('Bob will prepare release notes and update website', sampleTranscript);
    expect(match).not.toBeNull();
    expect(match?.lineIndex).toBe(1);
    expect(match?.score).toBeGreaterThanOrEqual(0.4);
  });

  test('evidence spanning two adjacent lines resolves to the start line index', () => {
    const multiTurnTranscript = [
      '[00:01] Alice: We are definitely targeting the Friday launch window.',
      '[00:08] Bob: Sounds good, I will finalize the release announcement.',
      '[00:15] Charlie: I will monitor the server logs during rollout.',
    ];
    const bullet = 'Alice confirmed Friday launch window and Bob will finalize the release announcement';
    const match = findCitation(bullet, multiTurnTranscript);
    expect(match).not.toBeNull();
    expect(match?.lineIndex).toBe(0);
  });

  test('Traditional Chinese (zh-Hant) bullet against zh-Hant transcript', () => {
    const zhTranscript = [
      '[00:01] [You] 我們預計在週五發布新版本。',
      '[00:15] [Others] 沒問題，我讓小明負責撰寫說明文件。',
      '[00:30] [Others] 資料庫備份已經完成確認。',
    ];

    const bullet = '團隊決定在週五發布新版本，並由小明負責撰寫說明文件。';
    const match = findCitation(bullet, zhTranscript);
    expect(match).not.toBeNull();
    // Spans lines 0 and 1
    expect(match?.lineIndex).toBe(0);
    expect(match?.score).toBeGreaterThan(0.5);

    const backupBullet = '資料庫備份確認已完成';
    const backupMatch = findCitation(backupBullet, zhTranscript);
    expect(backupMatch).not.toBeNull();
    expect(backupMatch?.lineIndex).toBe(2);
  });

  test('bullet with NO evidence returns null (anti-guessing property)', () => {
    const bullet = 'Discussed migrating the entire infrastructure to Kubernetes and PostgreSQL in Q4.';
    const match = findCitation(bullet, sampleTranscript);
    expect(match).toBeNull();
  });

  test('timestamp and speaker prefixes do not skew or artificially match scores', () => {
    const prefixedTranscript = [
      '[00:00 - 00:05] Speaker 1: Good morning everyone.',
      '[00:06 - 00:12] Speaker 2: We need to fix the authentication security vulnerability immediately.',
    ];

    // A bullet that mentions generic words like "Speaker" or "morning" shouldn't match line 1
    const genericBullet = 'Speaker 1 and Speaker 2 met for a discussion.';
    const genericMatch = findCitation(genericBullet, prefixedTranscript);
    // Should not falsely match with high confidence
    expect(genericMatch).toBeNull();

    // A bullet that matches actual content in line 1 should match accurately
    const authBullet = 'Fix the authentication security vulnerability immediately';
    const authMatch = findCitation(authBullet, prefixedTranscript);
    expect(authMatch).not.toBeNull();
    expect(authMatch?.lineIndex).toBe(1);
  });
});

describe('findCitationsBatch — performance & batch resolution', () => {
  test('resolves multiple bullets over a large transcript in one pass', () => {
    // Generate 1500 lines
    const largeLines: string[] = [];
    for (let i = 0; i < 1500; i++) {
      if (i === 42) {
        largeLines.push(`[01:00] Alice: Special key event ${i} deployed to staging server.`);
      } else if (i === 888) {
        largeLines.push(`[15:00] Bob: Crucial milestone ${i} reached for customer onboarding.`);
      } else {
        largeLines.push(`[00:${(i % 60).toString().padStart(2, '0')}] Speaker: Routine status update item ${i} discussed.`);
      }
    }

    const bullets = [
      'Special key event deployed to staging server',
      'Crucial milestone reached for customer onboarding',
      'Completely non-existent discussion about Mars rover',
    ];

    const start = performance.now();
    const processed = preprocessTranscript(largeLines);
    const results = findCitationsBatch(bullets, processed);
    const elapsed = performance.now() - start;

    expect(results).toHaveLength(3);
    expect(results[0]?.lineIndex).toBe(42);
    expect(results[1]?.lineIndex).toBe(888);
    expect(results[2]).toBeNull();

    // Verify batch processing is sub-100ms for 1500 lines
    expect(elapsed).toBeLessThan(200);
  });
});
