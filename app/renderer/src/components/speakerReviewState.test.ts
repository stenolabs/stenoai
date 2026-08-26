import { describe, expect, it } from 'vitest';

import {
  channelClusterCapacity,
  isKeptGeneric,
  showsKeepGenericButton,
  showsNamingActions,
  shouldShowSpeakerReview,
  staleAssignmentNotice,
} from './SpeakerReviewPanel';

const suggestion = (over: Record<string, unknown> = {}) =>
  ({
    status: 'none',
    suggested_person_id: null,
    suggested_name: null,
    merged_from: [],
    candidates: [],
    reasons: [],
    speech_duration_seconds: 60,
    segment_count: 10,
    first_timestamp: '00:12',
    sample_text: null,
    samples: [],
    contains_multiple_speakers: false,
    is_likely_artifact: false,
    confirmed_by_user: null,
    ...over,
  }) as never;

describe('shouldShowSpeakerReview', () => {
  it('opens a non-diarised transcript only when its sidecar has multiple clusters', () => {
    expect(shouldShowSpeakerReview('meeting', false, true, 2)).toBe(true);
    expect(shouldShowSpeakerReview('meeting', false, true, 1)).toBe(false);
    expect(shouldShowSpeakerReview('meeting', false, true, 0)).toBe(false);
  });

  it('preserves a one-cluster panel for a diarised transcript', () => {
    expect(shouldShowSpeakerReview('meeting', true, true, 1)).toBe(true);
  });

  it('hides a diarised transcript when no speaker rows exist', () => {
    expect(shouldShowSpeakerReview('meeting', true, true, 0)).toBe(false);
  });

  it('waits for a meeting stem and a completed suggestion response', () => {
    expect(shouldShowSpeakerReview(null, true, true, 2)).toBe(false);
    expect(shouldShowSpeakerReview('meeting', true, false, 2)).toBe(false);
  });
});

describe('channelClusterCapacity', () => {
  it('uses the largest channel rather than summing possible duplicate voices', () => {
    expect(channelClusterCapacity({
      system: { one: suggestion(), two: suggestion() },
      mic: { one: suggestion() },
    })).toBe(2);
  });

  it('uses the same channel that establishes the highest speaker minimum', () => {
    expect(channelClusterCapacity({
      mic: {
        one: suggestion(),
        two: suggestion(),
        three: suggestion(),
      },
      system: {
        one: suggestion({ contains_multiple_speakers: true }),
        two: suggestion({ contains_multiple_speakers: true }),
      },
    })).toBe(2);
  });
});

describe('isKeptGeneric', () => {
  it('reads the marking out of the query payload, not component state', () => {
    // The whole point of persisting it: this derivation has no memory of
    // its own, so a remount cannot lose the decision.
    expect(isKeptGeneric(suggestion({ review_state: 'generic' }))).toBe(true);
  });

  it('treats an absent marking as not reviewed', () => {
    expect(isKeptGeneric(suggestion())).toBe(false);
  });

  it('ignores a value it does not know', () => {
    // Forward compatibility in the safe direction: a newer build writing a
    // state this one has never heard of must not read as "kept generic",
    // because that hides the row's remaining actions behind an undo for a
    // decision nobody made here.
    expect(isKeptGeneric(suggestion({ review_state: 'something-newer' }))).toBe(false);
  });
});

describe('showsKeepGenericButton', () => {
  it('offers the button on an ordinary unreviewed row', () => {
    expect(showsKeepGenericButton(suggestion())).toBe(true);
  });

  it('hides it once the row is confirmed', () => {
    // A named row is decided. Offering "keep generic" there invites a click
    // that would say two contradictory things about the same cluster.
    expect(showsKeepGenericButton(suggestion({ confirmed_by_user: 'Max' }))).toBe(false);
  });

  it('hides it on a row marked as holding several people', () => {
    expect(showsKeepGenericButton(suggestion({ contains_multiple_speakers: true }))).toBe(false);
  });

  it('keeps offering it on a row that is already kept generic', () => {
    // That is the undo, and it is the only way back.
    expect(showsKeepGenericButton(suggestion({ review_state: 'generic' }))).toBe(true);
  });
});

describe('showsNamingActions', () => {
  it('offers naming on an ordinary row', () => {
    expect(showsNamingActions(suggestion())).toBe(true);
  });

  it('withholds it on a row marked as several people', () => {
    expect(showsNamingActions(suggestion({ contains_multiple_speakers: true }))).toBe(false);
  });

  it('withholds it on a row kept generic', () => {
    // Otherwise the row says "Kept generic - you decided not to name this
    // speaker" while Approve, Change and New person sit beside it, and the
    // button offers to "Reopen" something that was never closed. Parking a
    // row has to mean the same thing here as marking one does.
    expect(showsNamingActions(suggestion({ review_state: 'generic' }))).toBe(false);
  });

  it('comes back the moment the row is reopened', () => {
    expect(showsNamingActions(suggestion({ review_state: null }))).toBe(true);
  });
});

describe('staleAssignmentNotice', () => {
  it('says nothing when nothing was orphaned', () => {
    expect(staleAssignmentNotice([])).toBeNull();
    expect(staleAssignmentNotice(undefined)).toBeNull();
  });

  it('names the people whose assignment no longer points anywhere', () => {
    const notice = staleAssignmentNotice([
      { person_id: 'p1', display_name: 'Max' },
      { person_id: 'p2', display_name: 'Sarah' },
    ]);
    expect(notice).toContain('Max');
    expect(notice).toContain('Sarah');
  });

  it('does not join a single name with "and", and agrees with the verb', () => {
    const one = staleAssignmentNotice([{ person_id: 'p1', display_name: 'Max' }]);
    expect(one).toContain('Max is no longer');
    expect(one).not.toContain(' and ');

    const two = staleAssignmentNotice([
      { person_id: 'p1', display_name: 'Max' },
      { person_id: 'p2', display_name: 'Sarah' },
    ]);
    expect(two).toContain('Max and Sarah are no longer');
  });
});
