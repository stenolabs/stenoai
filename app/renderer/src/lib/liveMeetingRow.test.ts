import { describe, expect, it } from 'vitest';
import { isLiveRowStatus, liveRowRedundant, shouldShowLiveRow } from './liveMeetingRow';

// Regression guard for the phantom "Recording" row.
//
// The bug: useMeetings built the synthetic live row from `sessionName` alone.
// main deliberately keeps that name after a capture start that failed in the
// renderer (no microphone connected, mic busy, permission revoked), reasoning
// that "a stale name while hasRecording is false is inert" — so with status
// back at 'idle' the list showed a pulsing "Recording" row that no poll and no
// reload ever cleared, and clicking it routed to /recording, which correctly
// saw no session and bounced straight back home.
//
// Note the e2e mock IPC could never have caught this: it nulls sessionName as
// soon as the recording goes inactive, which is a *more* correct contract than
// the real main process implements.

describe('shouldShowLiveRow', () => {
  it('shows a row while a session is genuinely running', () => {
    expect(shouldShowLiveRow('Note', 'recording')).toBe(true);
    expect(shouldShowLiveRow('Note', 'paused')).toBe(true);
    expect(shouldShowLiveRow('Note', 'processing')).toBe(true);
  });

  it('shows no row for a stale name left behind by a failed start', () => {
    expect(shouldShowLiveRow('Note', 'idle')).toBe(false);
  });

  it('shows no row without a session name, whatever the status claims', () => {
    expect(shouldShowLiveRow(null, 'recording')).toBe(false);
    expect(shouldShowLiveRow(undefined, 'recording')).toBe(false);
    expect(shouldShowLiveRow('', 'recording')).toBe(false);
  });

  it('treats an absent or unknown status as no session', () => {
    expect(shouldShowLiveRow('Note', null)).toBe(false);
    expect(shouldShowLiveRow('Note', undefined)).toBe(false);
    expect(shouldShowLiveRow('Note', 'something-new')).toBe(false);
  });
});

describe('isLiveRowStatus', () => {
  it('matches exactly the three statuses that mean a session exists', () => {
    for (const s of ['recording', 'paused', 'processing']) {
      expect(isLiveRowStatus(s)).toBe(true);
    }
    for (const s of ['idle', '', null, undefined, 'RECORDING']) {
      expect(isLiveRowStatus(s)).toBe(false);
    }
  });
});

describe('liveRowRedundant', () => {
  it('is redundant once the session real note file is in the list', () => {
    const base = [{ session_info: { summary_file: '/out/a_summary.md' } }];
    expect(liveRowRedundant(base, '/out/a_summary.md')).toBe(true);
  });

  it('is not redundant without a live summary file, or when it is absent', () => {
    const base = [{ session_info: { summary_file: '/out/a_summary.md' } }];
    expect(liveRowRedundant(base, null)).toBe(false);
    expect(liveRowRedundant(base, '/out/b_summary.md')).toBe(false);
  });
});
