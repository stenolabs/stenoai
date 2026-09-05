import * as React from 'react';
import {
  Check, ChevronDown, ChevronRight, Loader2, Play, Square, Undo2, Users, UserPlus, X,
} from 'lucide-react';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter, DialogClose } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import {
  useSpeakerSuggestions,
  usePersonProfiles,
  useConfirmSpeaker,
  useGetSpeakerSampleAudio,
  useMarkSpeakerCluster,
  useSetClusterReviewState,
  meetingStemFromSummaryFile,
} from '@/hooks/useSpeakerSuggestions';
import { useBlobAudioPlayback } from '@/hooks/useBlobAudioPlayback';
import type { SpeakerSuggestion, StaleAssignment } from '@/lib/ipc';

interface SpeakerReviewPanelProps {
  summaryFile: string;
  isDiarised: boolean;
  hasSpeakerSidecar: boolean;
}

interface Row {
  channel: string;
  diarizationSpeakerId: string;
  suggestion: SpeakerSuggestion;
}

function rowKey(row: Pick<Row, 'channel' | 'diarizationSpeakerId'>): string {
  return `${row.channel}:${row.diarizationSpeakerId}`;
}

/** confirmed_by_user (a real SpeakerPrototype match) always wins over the
 * distance-based status/suggested_name -- otherwise a row can show "Might
 * be X" or even "Unidentified speaker" right next to a *separate*
 * "confirmed" line for the same X, which reads as a flat contradiction. A
 * human already confirmed who this is; the ranking that produced the
 * original suggestion is no longer the interesting fact about this row. */
function suggestionLabel(suggestion: SpeakerSuggestion): string {
  // Ahead of confirmed_by_user, because a marked cluster cannot BE
  // confirmed (confirm-speaker refuses it) -- if both were ever somehow
  // set, the marking is the newer and more specific fact.
  if (suggestion.contains_multiple_speakers) {
    return 'More than one person';
  }
  if (suggestion.confirmed_by_user) {
    return `✓ Confirmed as ${suggestion.confirmed_by_user}`;
  }
  if (suggestion.status === 'confirmed' && suggestion.suggested_name) {
    return `Likely ${suggestion.suggested_name}`;
  }
  const topCandidate = suggestion.candidates[0];
  if (suggestion.status === 'possible' && topCandidate) {
    return `Might be ${topCandidate.display_name}`;
  }
  return 'Unidentified speaker';
}

// Mirrors Config._person_name_taken's case/whitespace-insensitive
// comparison (src/config.py) -- lets the "New person" dialog warn BEFORE
// a round trip to the backend, which enforces the same rule as the real
// source of truth (defense against a stale/racy profiles list here).
function foldPersonName(value: string): string {
  return value
    .trim()
    .normalize('NFKC')
    .replace(/\s+/gu, ' ')
    .toLowerCase()
    .replaceAll('ß', 'ss')
    .replaceAll('ς', 'σ');
}

export function namesCollide(a: string, b: string): boolean {
  return foldPersonName(a) === foldPersonName(b);
}

const STALE_DIARIZATION_ERROR_CODE = 'stale_diarization_run';
const STALE_DIARIZATION_FEEDBACK =
  'The speaker analysis changed while you were reviewing. Refreshing the list. Check the row before trying again.';

function isStaleDiarizationError(error: unknown): boolean {
  return Boolean(
    error
    && typeof error === 'object'
    && 'code' in error
    && error.code === STALE_DIARIZATION_ERROR_CODE,
  );
}

/** People already assigned somewhere in this meeting first, the rest after,
 *  each group alphabetical. The picker is the only route to "this cluster is
 *  someone I already named here", and that answer gets commoner the more the
 *  diarizer splits a voice -- burying it in a global list of everyone ever
 *  named is what pushes a hurried reviewer towards "New person" instead. */
export function orderProfilesForRow<T extends { display_name: string; person_id: string }>(
  profiles: T[],
  alreadyInMeeting: Set<string>,
): T[] {
  return [...profiles].sort((a, b) => {
    const aHere = alreadyInMeeting.has(a.person_id);
    const bHere = alreadyInMeeting.has(b.person_id);
    if (aHere !== bHere) return aHere ? -1 : 1;
    return a.display_name.localeCompare(b.display_name);
  });
}

/** Above this many people the picker grows a search box.
 *
 *  The list is ordered "already in this meeting" first, which carries a small
 *  library on its own -- a search box under a handful of names is a control to
 *  tab past, not a help. It stops carrying one as soon as the answer is not on
 *  screen, which is what this threshold marks. */
export const PERSON_SEARCH_THRESHOLD = 8;

/** Substring match on the display name, case- and diacritic-insensitive.
 *
 *  Order is preserved, so the "already in this meeting" people stay on top of
 *  a filtered list too. An empty or whitespace-only query matches everything
 *  rather than nothing -- the box starts empty on every open, and a query of
 *  spaces is someone mid-typing, not someone asking for no results.
 *
 *  NFD + combining-mark strip so a library written with umlauts stays
 *  reachable from an ASCII keyboard: typing "Mullen" has to find "Müllen",
 *  because the alternative for a user who cannot produce the character is no
 *  path to that person at all. */
function foldForSearch(value: string): string {
  return value.normalize('NFD').replace(/\p{M}+/gu, '').toLowerCase();
}

export function filterProfilesByQuery<T extends { display_name: string }>(
  profiles: T[],
  query: string,
): T[] {
  const needle = foldForSearch(query.trim());
  if (!needle) return profiles;
  return profiles.filter((p) => foldForSearch(p.display_name).includes(needle));
}

export function shouldShowSpeakerReview(
  meetingStem: string | null,
  isDiarised: boolean,
  hasSuggestionData: boolean,
  rowCount: number,
): meetingStem is string {
  return Boolean(
    meetingStem
    && hasSuggestionData
    && rowCount > (isDiarised ? 0 : 1),
  );
}

/** Did a human look at this row and choose to leave it unnamed?
 *
 *  Read out of the query payload rather than component state, which is the
 *  whole reason the backend records it: held in the component, the decision
 *  died on the next remount and every row the reviewer had already dealt
 *  with came back.
 *
 *  Compares against the one value this build knows. A newer build writing a
 *  state this one has never heard of reads as "not reviewed" -- the safe
 *  direction, because the alternative is presenting an undo for a decision
 *  this build cannot describe. */
export function isKeptGeneric(suggestion: SpeakerSuggestion): boolean {
  return suggestion.review_state === 'generic';
}

/** Whether the "keep generic" button belongs on this row at all.
 *
 *  Not on a confirmed row and not on one marked as several people: both are
 *  decided, and parking a decided row would say two contradictory things
 *  about the same cluster. (Until this slice the button rendered on both,
 *  because it sat outside the conditional that hides the naming actions.)
 *  It stays on a row that is already kept generic -- that click is the undo,
 *  and it is the only way back. */
export function showsKeepGenericButton(suggestion: SpeakerSuggestion): boolean {
  return !suggestion.confirmed_by_user && !suggestion.contains_multiple_speakers;
}

/** Whether this row still offers Approve / Change / New person.
 *
 *  Withheld on a mixed row because the backend refuses to enroll it, and on
 *  a row kept generic because parking a row has to mean the same thing here
 *  as marking one does: the reviewer said they are done with it. Leaving the
 *  naming actions there produced a row that said "you decided not to name
 *  this speaker" with three ways to name it beside the sentence, and offered
 *  to "Reopen" something that was never closed. Reopening is one click, and
 *  it brings them all back. */
export function showsNamingActions(suggestion: SpeakerSuggestion): boolean {
  return !suggestion.contains_multiple_speakers && !isKeptGeneric(suggestion);
}

/** The one meeting-level sentence for confirmations a re-diarization
 *  orphaned, or null when there are none.
 *
 *  Deliberately says the assignments are gone rather than the people: their
 *  voice evidence is untouched and still scores candidates everywhere. And
 *  deliberately does not promise completeness -- someone whose cluster id
 *  the new run no longer produces cannot be listed here at all (see
 *  suggest-speakers, where this list is built). */
export function staleAssignmentNotice(stale: StaleAssignment[] | undefined): string | null {
  if (!stale || stale.length === 0) return null;
  const names = stale.map((s) => s.display_name);
  const listed =
    names.length === 1
      ? names[0]
      : `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;
  return (
    `This meeting was analysed again, so the speakers were renumbered. `
    + `${listed} ${names.length === 1 ? 'is' : 'are'} no longer linked to any speaker below. `
    + `Nothing was deleted -- assign them again to restore the link.`
  );
}

// "mic" is always the device owner's own recording side (in-person audio);
// "system" is loopback capture of the other call participant(s) -- see
// determine_recording_type (src/speaker_suggestions.py) for the same
// mic->in_person / system->remote mapping this mirrors.
function channelLabel(channel: string): string {
  if (channel === 'mic') return 'your mic';
  if (channel === 'system') return 'the call';
  return channel;
}

/** Where in the recording to go listen, so a human reviewing an
 * "Unidentified speaker" row has something to act on -- without this
 * there's no way to know who a cluster with no suggestion actually is. */
function identificationHint(channel: string, suggestion: SpeakerSuggestion): string {
  const parts = [channelLabel(channel)];
  if (suggestion.first_timestamp) parts.push(`first at ${suggestion.first_timestamp}`);
  parts.push(
    `${Math.round(suggestion.speech_duration_seconds)}s across ${suggestion.segment_count} turn${suggestion.segment_count === 1 ? '' : 's'}`,
  );
  return parts.join(' · ');
}

/** Seconds -> "MM:SS" / "H:MM:SS", matching the [MM:SS] markers in the
 * saved transcript (src.transcriber._format_timestamp) so an excerpt's
 * timestamp can be found by eye in the transcript above. */
function formatOffset(seconds: number): string {
  const total = Math.max(0, Math.floor(seconds));
  const s = String(total % 60).padStart(2, '0');
  const m = Math.floor(total / 60) % 60;
  const h = Math.floor(total / 3600);
  return h > 0 ? `${h}:${String(m).padStart(2, '0')}:${s}` : `${String(m).padStart(2, '0')}:${s}`;
}

interface PlaySampleButtonProps {
  meetingStem: string;
  channel: string;
  diarizationSpeakerId: string;
  expectedRunId: string;
  /** Which of the row's `samples` to play. Omitted plays the cluster's
   * longest turn -- the collapsed row's single button. */
  segmentIndex?: number;
  disabled?: boolean;
  label?: string;
}

/** Play/stop toggle for a cluster's longest-segment audio sample -- mirrors
 * pasrom/meeting-transcriber's SpeakerNamingView.swift play button exactly
 * (fetch-on-click, toggle icon, auto-reset when playback ends). Fetched via
 * a mutation (not cached) since nothing needs to stay fresh in the
 * background for a clip a human explicitly triggers. */
function PlaySampleButton({
  meetingStem, channel, diarizationSpeakerId, expectedRunId, segmentIndex, disabled, label,
}: PlaySampleButtonProps) {
  const getSample = useGetSpeakerSampleAudio();
  const playbackKey = segmentIndex === undefined ? 'cluster' : `excerpt-${segmentIndex}`;
  const playback = useBlobAudioPlayback(async () => {
    const result = await getSample.mutateAsync({
      meetingStem, channel, diarizationSpeakerId, expectedRunId, segmentIndex,
    });
    return result.audio_base64;
  });
  const playing = playback.playingKey === playbackKey;

  const title = label ?? (playing ? 'Stop sample' : 'Play sample');
  // Distinct testid per excerpt: the whole point of the expanded list is
  // that each row plays a DIFFERENT moment, so a spec has to be able to
  // address them individually.
  const testId = segmentIndex === undefined
    ? `speaker-play-${channel}:${diarizationSpeakerId}`
    : `speaker-play-${channel}:${diarizationSpeakerId}-${segmentIndex}`;

  return (
    <span className="inline-flex items-center gap-2">
      <Button
        size="sm"
        variant="ghost"
        aria-label={playing ? 'Stop sample' : title}
        title={playing ? 'Stop sample' : title}
        disabled={disabled || playback.pendingKey !== null}
        onClick={() => void playback.toggle(playbackKey)}
        data-testid={testId}
      >
        {playback.pendingKey !== null ? (
          <Loader2 className="size-[13px] animate-spin" />
        ) : playing ? (
          <Square className="size-[13px]" />
        ) : (
          <Play className="size-[13px]" />
        )}
      </Button>
      {playback.errorKey === playbackKey && (
        <span role="alert" className="text-[12px]" style={{ color: 'var(--danger)' }}>
          Could not play this sample. Try again.
        </span>
      )}
    </span>
  );
}

export function channelClusterCapacity(
  channels: Record<string, Record<string, SpeakerSuggestion>>,
): number {
  let highestMinimum = 0;
  let matchingCapacity = 0;
  for (const clusters of Object.values(channels)) {
    const visibleClusters = Object.values(clusters);
    const capacity = visibleClusters.length;
    const minimum = capacity
      + visibleClusters.filter((cluster) => cluster.contains_multiple_speakers).length;
    if (
      minimum > highestMinimum
      || (minimum === highestMinimum && capacity > matchingCapacity)
    ) {
      highestMinimum = minimum;
      matchingCapacity = capacity;
    }
  }
  return matchingCapacity;
}

/**
 * Per-meeting review panel for diarized speaker clusters: shows a suggested
 * real name (if any) per cluster with Approve / Change / New person / Keep
 * generic actions. Lives inside MeetingDetail's content flow, gated on
 * `is_diarised` -- see the speaker_identification plan doc's Phase 4.
 *
 * Two kinds of row are hidden BY DEFAULT but stay reachable via the "Show N
 * filtered rows" toggle -- never silently dropped, since a human might
 * legitimately want to review either: rows with status "none" AND zero
 * candidates (nothing actionable at all -- in practice almost always the
 * device owner's own mic-channel cluster, and the shape a row takes on after
 * the person it pointed at is deleted), and rows flagged `is_likely_artifact`
 * (the real-data-validated echo/crosstalk pattern -- see
 * SUGGESTION_MIN_AVG_TURN_SECONDS).
 */
/** `action` names what the person actually clicked. Without it every
 * failure on this row read "Couldn't confirm", including a failed
 * more-than-one-person marking, which describes an operation the user did
 * not attempt. */
type ConfirmFeedback = { message: string; action?: 'confirm' | 'mark' | 'unmark' | 'review' };

export function SpeakerReviewPanel({
  summaryFile,
  isDiarised,
  hasSpeakerSidecar,
}: SpeakerReviewPanelProps) {
  const meetingStem = meetingStemFromSummaryFile(summaryFile);
  const suggestionsQuery = useSpeakerSuggestions(meetingStem, hasSpeakerSidecar);
  const profilesQuery = usePersonProfiles(hasSpeakerSidecar);
  const confirmSpeaker = useConfirmSpeaker();
  const markCluster = useMarkSpeakerCluster();
  const setReviewState = useSetClusterReviewState();

  const [expanded, setExpanded] = React.useState<Set<string>>(new Set());
  const [changeOpenFor, setChangeOpenFor] = React.useState<string | null>(null);
  // Search query of the open "Change" picker. One piece of state rather than
  // one per row: only a single picker can be open at a time (changeOpenFor),
  // and it is cleared on every open/close.
  const [personQuery, setPersonQuery] = React.useState('');
  const [newPersonRow, setNewPersonRow] = React.useState<Row | null>(null);
  const [newPersonName, setNewPersonName] = React.useState('');
  const [newPersonError, setNewPersonError] = React.useState<string | null>(null);
  const [showFiltered, setShowFiltered] = React.useState(false);
  // Error acknowledgment only -- a SUCCESSFUL confirm needs no separate
  // feedback state: useConfirmSpeaker's onSuccess awaits the suggestions
  // refetch before resolving, so by the time this fires the row's own
  // label already reads "✓ Confirmed as X" from the real confirmed_by_user
  // field. A parallel success flag here would just be a second, redundant
  // (and unmount-fragile) copy of the same fact. Cleared whenever a fresh
  // confirm attempt starts on that row.
  const [feedback, setFeedback] = React.useState<Map<string, ConfirmFeedback>>(new Map());

  const rows: Row[] = [];
  const channels = suggestionsQuery.data?.channels ?? {};
  for (const channel of Object.keys(channels)) {
    for (const [diarizationSpeakerId, suggestion] of Object.entries(channels[channel])) {
      rows.push({ channel, diarizationSpeakerId, suggestion });
    }
  }

  if (!shouldShowSpeakerReview(
    meetingStem,
    isDiarised,
    Boolean(suggestionsQuery.data),
    rows.length,
  )) return null;
  const diarizationRunId = suggestionsQuery.data?.diarization_run_id;
  if (!diarizationRunId) return null;
  // Most speaking time first. Reviewing is voluntary and can be abandoned at
  // any point, so the order decides how much of the transcript the first
  // couple of decisions actually cover -- and the more the diarizer splits a
  // recording, the further that diverges from channel/cluster-id order,
  // which is only an artifact of how the diarizer numbered its slots.
  // Number.isFinite, not `?? 0`: a non-numeric duration would make the
  // subtraction NaN, and `||` treats NaN as falsy, so a single bad value
  // would silently drop the whole list back to cluster-id order.
  const speechSeconds = (row: Row) =>
    Number.isFinite(row.suggestion.speech_duration_seconds)
      ? row.suggestion.speech_duration_seconds
      : 0;
  rows.sort(
    (a, b) =>
      speechSeconds(b) - speechSeconds(a)
      || a.channel.localeCompare(b.channel)
      || a.diarizationSpeakerId.localeCompare(b.diarizationSpeakerId),
  );
  // People this meeting has already been given a cluster for. Under an
  // over-segmenting diarizer one person owns several clusters, so this is
  // the set the reviewer reaches for most, not the long tail of everyone
  // they have ever named.
  // By person_id, never by display name: a rename can leave two profiles
  // reading alike, and marking the wrong one as present here would invite
  // exactly the misassignment this is meant to prevent.
  const alreadyInMeeting = new Set(
    rows.map((row) => row.suggestion.confirmed_person_id).filter((id): id is string => !!id),
  );
  // A row a human has explicitly marked stays in the main list even if its
  // turn shape also matches the artifact heuristic -- hiding it behind
  // "Show N filtered rows" would bury the undo for a deliberate action
  // behind a toggle the user has no reason to open. Same for a row kept
  // generic: the marking IS a deliberate action, and its undo lives on the
  // row itself.
  // "Nothing actionable at all" -- no suggestion, nobody to pick from. In
  // practice almost always the device owner's own mic-channel cluster, which
  // never matches a named person.
  //
  // Demoted into the filtered list rather than dropped outright. Deleting a
  // person puts a row into exactly this shape (the backend recomputes
  // candidates from the profiles, so the cluster that pointed at them is left
  // with none), and until now the only thing keeping such a row on screen was
  // a session-scoped `keepVisible` set the panel's own delete button filled.
  // With deletion moved to Settings there is no such moment to hook into, and
  // dropping the row would leave the cluster the user just detached from a
  // person unreachable -- no way to give it a new name, no way to even see it.
  // A reachable row behind the existing toggle survives a remount, which the
  // old set never did.
  const nothingActionable = (row: Row) =>
    row.suggestion.status === 'none' && row.suggestion.candidates.length === 0;
  // A row a human has explicitly marked or kept generic is never filtered:
  // marking is a statement about the recording, not a dismissal, and its undo
  // lives on the row itself -- burying that behind a toggle would hide the
  // only way back from a misclick.
  const isFiltered = (row: Row) =>
    (row.suggestion.is_likely_artifact || nothingActionable(row))
    && !row.suggestion.contains_multiple_speakers
    && !isKeptGeneric(row.suggestion);
  const filteredRows = rows.filter(isFiltered);
  const primaryRows = rows.filter((row) => !isFiltered(row));
  const visibleRows = showFiltered ? rows : primaryRows;
  const recordingAvailable = suggestionsQuery.data?.recording_available ?? false;
  const staleNotice = staleAssignmentNotice(suggestionsQuery.data?.stale_assignments);

  const duplicateProfile = newPersonName.trim()
    ? (profilesQuery.data ?? []).find((p) => namesCollide(p.display_name, newPersonName))
    : undefined;

  const reportMutationFailure = (
    key: string,
    error: unknown,
    action?: ConfirmFeedback['action'],
  ) => {
    const stale = isStaleDiarizationError(error);
    setFeedback((prev) => new Map(prev).set(key, {
      message: stale ? STALE_DIARIZATION_FEEDBACK : 'Try again.',
      action,
    }));
    if (stale) void suggestionsQuery.refetch();
  };

  const confirm = (row: Row, args: { personId?: string; newPersonName?: string }) => {
    const key = rowKey(row);
    setFeedback((prev) => {
      const next = new Map(prev);
      next.delete(key);
      return next;
    });
    confirmSpeaker.mutate(
      {
        meetingStem,
        channel: row.channel,
        diarizationSpeakerId: row.diarizationSpeakerId,
        expectedRunId: diarizationRunId,
        personId: args.personId,
        newPersonName: args.newPersonName,
        summaryFile,
      },
      {
        onError: (error) => reportMutationFailure(key, error),
      },
    );
  };

  const setMultiSpeaker = (row: Row, containsMultipleSpeakers: boolean) => {
    const key = rowKey(row);
    setFeedback((prev) => {
      const next = new Map(prev);
      next.delete(key);
      return next;
    });
    markCluster.mutate(
      {
        meetingStem,
        channel: row.channel,
        diarizationSpeakerId: row.diarizationSpeakerId,
        expectedRunId: diarizationRunId,
        containsMultipleSpeakers,
        summaryFile,
      },
      {
        onError: (error) => reportMutationFailure(
          key,
          error,
          containsMultipleSpeakers ? 'mark' : 'unmark',
        ),
      },
    );
  };

  const setGenericReview = (row: Row, generic: boolean) => {
    const key = rowKey(row);
    setFeedback((prev) => {
      const next = new Map(prev);
      next.delete(key);
      return next;
    });
    setReviewState.mutate(
      {
        meetingStem,
        channel: row.channel,
        diarizationSpeakerId: row.diarizationSpeakerId,
        expectedRunId: diarizationRunId,
        generic,
      },
      {
        onError: (error) => reportMutationFailure(key, error, 'review'),
      },
    );
  };

  const submitNewPerson = async () => {
    if (
      !newPersonRow
      || !newPersonName.trim()
      || duplicateProfile
      || confirmSpeaker.isPending
    ) return;
    setNewPersonError(null);
    try {
      await confirmSpeaker.mutateAsync({
        meetingStem,
        channel: newPersonRow.channel,
        diarizationSpeakerId: newPersonRow.diarizationSpeakerId,
        expectedRunId: diarizationRunId,
        newPersonName: newPersonName.trim(),
        summaryFile,
      });
      setNewPersonRow(null);
    } catch (error) {
      if (isStaleDiarizationError(error)) {
        // This dialog holds a row object from the run that just became
        // stale. Close it before refetching: keeping it open would combine
        // its old cluster id with the next run id on retry, and diarizer ids
        // are intentionally not stable across runs.
        const staleRow = newPersonRow;
        setNewPersonRow(null);
        setNewPersonName('');
        setNewPersonError(null);
        reportMutationFailure(rowKey(staleRow), error);
      } else {
        setNewPersonError('Could not create this person. The name may already exist. Try another name.');
      }
    }
  };

  const clusterCapacity = channelClusterCapacity(channels);
  const minimumSpeakers = suggestionsQuery.data?.minimum_speaker_count ?? 0;

  return (
    <section className="flex flex-col gap-3" data-testid="speaker-review-panel">
      <h2
        className="text-[13px] font-semibold tracking-[0.01em]"
        style={{ color: 'var(--fg-2)', fontFamily: 'var(--font-sans)', margin: 0 }}
      >
        Speakers
      </h2>
      {/* Above the rows and above the speaker-count note, because it
          explains why the rows below look unfamiliar: without it, a
          reviewer returning to a re-analysed meeting just finds the names
          they entered gone, with nothing saying why or that re-entering
          them is all it takes. */}
      {staleNotice && (
        <p
          className="text-[11.5px]"
          style={{ color: 'var(--fg-2)', margin: 0 }}
          data-testid="speaker-stale-assignments"
        >
          {staleNotice}
        </p>
      )}
      {minimumSpeakers > clusterCapacity && (
        <p
          className="text-[11.5px]"
          style={{ color: 'var(--fg-2)', margin: 0 }}
          data-testid="speaker-minimum-count"
        >
          {`At least ${minimumSpeakers} people spoke, but only ${clusterCapacity} could be told apart on one channel. `}
          {'Speech from a group marked as more than one person is left unassigned.'}
        </p>
      )}
      <div className="flex flex-col gap-1.5">
        {/* Every action below spawns a confirm-speaker subprocess that
            reads-then-atomically-rewrites this meeting's saved transcript.
            Two such calls overlapping (e.g. clicking a second row's action
            before the first row's confirm has resolved) is unsafe -- gate
            EVERY row's actions on ANY confirm being in flight, not just the
            specific row a per-row check would match. A prior version only
            disabled the matching row's buttons (via confirmSpeaker.variables
            matching this row), which left every OTHER row's buttons
            clickable while a confirm was still in progress. */}
        {visibleRows.map((row) => {
          const key = rowKey(row);
          // setReviewState belongs in this gate even though it writes only a
          // marker: it is a read-modify-write of the same sidecar a confirm
          // rewrites, and that pair is exactly the overlap the backend can
          // narrow but not close (see _freshest_channel). Serialising the
          // clicks is the half of it the UI can actually guarantee.
          const anyConfirmPending =
            confirmSpeaker.isPending || markCluster.isPending || setReviewState.isPending;
          const isMarked = row.suggestion.contains_multiple_speakers;
          const isKept = isKeptGeneric(row.suggestion);
          const samples = row.suggestion.samples ?? [];
          const isExpanded = expanded.has(key);
          // Expanding is only worth offering when there is more than the
          // one excerpt the collapsed row already shows.
          const canExpand = samples.length > 1;
          return (
            <div
              key={key}
              data-testid={`speaker-row-${key}`}
              className="flex flex-col gap-1.5 rounded-md px-2 py-1.5"
              style={{ background: 'var(--surface-raised)', border: '1px solid var(--border-subtle)' }}
            >
              <div className="flex items-center justify-between gap-2">
              <div className="flex min-w-0 flex-col gap-0.5">
                <span
                  className={`text-[13.5px] ${row.suggestion.confirmed_by_user || isMarked ? 'font-medium' : ''}`}
                  style={{ color: isMarked || isKept ? 'var(--fg-2)' : 'var(--fg-1)' }}
                >
                  {suggestionLabel(row.suggestion)}
                </span>
                <span className="text-[11.5px]" style={{ color: 'var(--fg-2)' }}>
                  {identificationHint(row.channel, row.suggestion)}
                </span>
                {isMarked ? (
                  <span className="text-[11.5px]" style={{ color: 'var(--fg-2)' }}>
                    Left out of naming and voice recognition.
                  </span>
                ) : isKept ? (
                  <span
                    className="text-[11.5px]"
                    style={{ color: 'var(--fg-2)' }}
                    data-testid={`speaker-kept-generic-${key}`}
                  >
                    Kept generic — you decided not to name this speaker.
                  </span>
                ) : (
                  row.suggestion.sample_text && (
                    <span
                      className="truncate text-[11.5px] italic"
                      style={{ color: 'var(--fg-2)' }}
                      title={row.suggestion.sample_text}
                    >
                      “{row.suggestion.sample_text}”
                    </span>
                  )
                )}
                {canExpand && (
                  <button
                    type="button"
                    onClick={() =>
                      setExpanded((prev) => {
                        const next = new Set(prev);
                        if (next.has(key)) next.delete(key);
                        else next.add(key);
                        return next;
                      })
                    }
                    className="flex items-center gap-0.5 self-start text-[11.5px] underline-offset-2 hover:underline"
                    style={{ color: 'var(--fg-2)' }}
                    data-testid={`speaker-expand-${key}`}
                    aria-expanded={isExpanded}
                  >
                    {isExpanded ? (
                      <ChevronDown className="size-[12px]" />
                    ) : (
                      <ChevronRight className="size-[12px]" />
                    )}
                    {isExpanded ? 'Fewer excerpts' : `${samples.length} excerpts`}
                  </button>
                )}
                {feedback.get(key) && (
                  <span
                    className="text-[11.5px] font-medium"
                    style={{ color: 'var(--danger)' }}
                    data-testid={`speaker-feedback-${key}`}
                  >
                    {`${
                      feedback.get(key)!.action === 'mark'
                        ? "Couldn't mark this as more than one person"
                        : feedback.get(key)!.action === 'unmark'
                          ? "Couldn't undo the marking"
                          : feedback.get(key)!.action === 'review'
                            ? "Couldn't update the review state"
                          : "Couldn't confirm"
                    }: ${feedback.get(key)!.message}`}
                  </span>
                )}
              </div>
              <div className="flex items-center gap-1.5">
                {recordingAvailable && (
                  <PlaySampleButton
                    meetingStem={meetingStem}
                    channel={row.channel}
                    diarizationSpeakerId={row.diarizationSpeakerId}
                    expectedRunId={diarizationRunId}
                    disabled={anyConfirmPending}
                  />
                )}
                {/* Every naming action disappears for a marked cluster --
                    not merely disabled. confirm-speaker refuses it outright,
                    so a greyed-out Approve would be a control that can never
                    become available, and a "Change" picker would be an
                    invitation to do the one thing this marking exists to
                    prevent. The undo below is what stays reachable. */}
                {showsNamingActions(row.suggestion) && (
                  <>
                {/* Hidden once confirmed_by_user is set -- re-approving an
                    already-confirmed cluster is a no-op that changes
                    nothing visible, which reads as broken. Change/New
                    person stay available to correct a wrong confirmation. */}
                {row.suggestion.status !== 'none' &&
                  row.suggestion.suggested_person_id &&
                  !row.suggestion.confirmed_by_user && (
                    <Button
                      size="sm"
                      variant="default"
                      disabled={anyConfirmPending}
                      onClick={() => confirm(row, { personId: row.suggestion.suggested_person_id as string })}
                      data-testid={`speaker-approve-${key}`}
                    >
                      <Check className="size-[13px]" />
                      Approve
                    </Button>
                  )}
                <Popover
                  open={changeOpenFor === key}
                  onOpenChange={(open) => {
                    setChangeOpenFor(open ? key : null);
                    // Each opening starts a fresh search. Carrying the last
                    // query over would silently hide most of the list on a
                    // picker the user just opened.
                    setPersonQuery('');
                  }}
                >
                  <PopoverTrigger asChild>
                    <Button
                      size="sm"
                      variant="outline"
                      disabled={anyConfirmPending}
                      data-testid={`speaker-change-${key}`}
                    >
                      Change
                      <ChevronDown className="size-[13px]" />
                    </Button>
                  </PopoverTrigger>
                  <PopoverContent align="end" className="w-[240px] p-1">
                    {(profilesQuery.data ?? []).length === 0 ? (
                      <div className="px-2 py-1.5 text-[12.5px]" style={{ color: 'var(--fg-2)' }}>
                        No known people yet
                      </div>
                    ) : (
                      (() => {
                        const ordered = orderProfilesForRow(
                          profilesQuery.data ?? [],
                          alreadyInMeeting,
                        );
                        const matches = filterProfilesByQuery(ordered, personQuery);
                        return (
                          <>
                            {/* Below the threshold the whole list is visible at
                                a glance and a search box is just a control to
                                skip past. The list itself scrolls regardless --
                                the cap is what keeps a large library from
                                growing a popover taller than the window. */}
                            {ordered.length >= PERSON_SEARCH_THRESHOLD && (
                              <div className="p-1">
                                <Input
                                  value={personQuery}
                                  onChange={(e) => setPersonQuery(e.target.value)}
                                  placeholder="Search people…"
                                  aria-label="Search people"
                                  className="h-[28px] text-[13px]"
                                  data-testid={`speaker-person-search-${key}`}
                                />
                              </div>
                            )}
                            <div className="max-h-[280px] overflow-y-auto">
                              {matches.length === 0 ? (
                                <div
                                  className="px-2 py-1.5 text-[12.5px]"
                                  style={{ color: 'var(--fg-2)' }}
                                  data-testid="speaker-person-no-match"
                                >
                                  No match
                                </div>
                              ) : (
                                matches.map((profile) => (
                                  <button
                                    key={profile.person_id}
                                    type="button"
                                    onClick={() => {
                                      setChangeOpenFor(null);
                                      confirm(row, { personId: profile.person_id });
                                    }}
                                    className="flex w-full min-w-0 items-center gap-1.5 truncate rounded-md px-2 py-1.5 text-left text-[13px] transition-colors hover:bg-[color:var(--surface-hover)]"
                                    style={{ color: 'var(--fg-1)' }}
                                    data-testid={`speaker-pick-person-${profile.person_id}`}
                                  >
                                    <span className="truncate">{profile.display_name}</span>
                                    {alreadyInMeeting.has(profile.person_id) && (
                                      // The diarizer splits one voice across
                                      // several clusters routinely, so "this is
                                      // the person I already named above" is a
                                      // frequent, correct answer -- and one that
                                      // has to be visibly available, because the
                                      // alternative a hurried user reaches for is
                                      // "New person", which records the same
                                      // voice as two people and makes them a hard
                                      // negative against themselves.
                                      <span
                                        className="shrink-0 text-[11px]"
                                        style={{ color: 'var(--fg-2)' }}
                                        title="Already assigned in this meeting"
                                      >
                                        here
                                      </span>
                                    )}
                                  </button>
                                ))
                              )}
                            </div>
                          </>
                        );
                      })()
                    )}
                  </PopoverContent>
                </Popover>
                <Button
                  size="sm"
                  variant="outline"
                  disabled={anyConfirmPending}
                  onClick={() => {
                    setNewPersonName('');
                    setNewPersonError(null);
                    setNewPersonRow(row);
                  }}
                  data-testid={`speaker-new-person-${key}`}
                >
                  <UserPlus className="size-[13px]" />
                  New person
                </Button>
                  </>
                )}
                {/* The one fact about a cluster that no measurement can
                    supply. Sitting beside "New person" on purpose: both are
                    answers to the same question a human is holding while
                    listening, and this one has to be as easy to give as
                    naming, or it will not be given at all. */}
                <Button
                  size="sm"
                  variant={isMarked ? 'outline' : 'ghost'}
                  aria-label={
                    isMarked
                      ? 'This is one person after all - reopens the row for naming, does not restore the earlier name'
                      : 'This is more than one person'
                  }
                  title={
                    isMarked
                      ? 'This is one person after all - reopens the row for naming, does not restore the earlier name'
                      : 'This is more than one person'
                  }
                  disabled={anyConfirmPending}
                  onClick={() => setMultiSpeaker(row, !isMarked)}
                  data-testid={`speaker-mark-multi-${key}`}
                >
                  {/* Not labelled "Undo": clearing the marking reopens the
                      row for naming, it does not put back a name that was
                      withdrawn when the cluster was marked. The prototype,
                      the participants entry and the transcript labels are
                      all gone by then, and calling that an undo would
                      promise a recovery the backend cannot perform. */}
                  {isMarked ? <Undo2 className="size-[13px]" /> : <Users className="size-[13px]" />}
                  {isMarked ? 'One person' : null}
                </Button>
                {/* The row stays put and reads as parked, rather than
                    vanishing. Hiding it was fine while the decision lived
                    for one session; now that it is written down, a hidden
                    row would put its undo somewhere nobody can reach --
                    and a reviewer coming back tomorrow would have no way to
                    tell "I decided to leave this" from "this never
                    appeared". */}
                {showsKeepGenericButton(row.suggestion) && (
                  <Button
                    size="sm"
                    variant={isKept ? 'outline' : 'ghost'}
                    aria-label={isKept ? 'Reopen this speaker for naming' : 'Keep generic label'}
                    title={isKept ? 'Reopen this speaker for naming' : 'Keep generic label'}
                    disabled={anyConfirmPending}
                    onClick={() => setGenericReview(row, !isKept)}
                    data-testid={`speaker-keep-generic-${key}`}
                  >
                    {isKept ? <Undo2 className="size-[13px]" /> : <X className="size-[13px]" />}
                    {isKept ? 'Reopen' : null}
                  </Button>
                )}
              </div>
              </div>

              {/* Several moments from the recording, chronological, each
                  played individually. One excerpt is a single roll of the
                  dice on whether the longest turn happens to contain
                  anything recognizable; several are what let someone place
                  a voice -- and hearing two different voices in one list is
                  how the "more than one person" case becomes visible at all. */}
              {isExpanded && (
                <div
                  className="flex flex-col gap-0.5 border-t pt-1.5"
                  style={{ borderColor: 'var(--border-subtle)' }}
                  data-testid={`speaker-samples-${key}`}
                >
                  {/* Said once, not repeated per row. A meeting whose
                      speakers sidecar was produced by the backfill has no
                      turn manifest, and its transcript timestamps come from
                      a different diarization run -- so no line can be
                      attributed to a cluster with confidence, and none is
                      shown. Listening still works, and is the reliable half
                      anyway: the clip is cut at this cluster's own segments. */}
                  {samples.length > 0 && !samples.some((s) => s.text) && (
                    <span
                      className="text-[11.5px]"
                      style={{ color: 'var(--fg-2)' }}
                      data-testid={`speaker-samples-textless-${key}`}
                    >
                      Transcript text can’t be matched to a speaker in this recording. Play to listen.
                    </span>
                  )}
                  {samples.map((sample, index) => (
                    <div
                      key={`${sample.start}-${index}`}
                      className="flex items-center gap-1.5"
                      data-testid={`speaker-sample-${key}-${index}`}
                    >
                      {/* A collapsed range is the backend saying it could
                          not place this turn in the audio, and
                          extract_speaker_sample_audio refuses to cut one --
                          padding it into a clip would play whoever WAS
                          speaking at that second under this name. The row
                          keeps its place (its text is still this speaker's,
                          and every later play button is addressed by index),
                          the button is shown inert rather than firing a
                          request that can only fail. */}
                      {recordingAvailable && (
                        <PlaySampleButton
                          meetingStem={meetingStem}
                          channel={row.channel}
                          diarizationSpeakerId={row.diarizationSpeakerId}
                          expectedRunId={diarizationRunId}
                          segmentIndex={index}
                          disabled={anyConfirmPending || sample.end <= sample.start}
                          label={
                            sample.end <= sample.start
                              ? 'No audio could be matched to this moment'
                              : `Play excerpt at ${formatOffset(sample.start)}`
                          }
                        />
                      )}
                      <span
                        className="shrink-0 text-[11px] tabular-nums"
                        style={{ color: 'var(--fg-2)' }}
                      >
                        {formatOffset(sample.start)}
                      </span>
                      <span
                        className="truncate text-[11.5px] italic"
                        style={{ color: 'var(--fg-2)' }}
                        title={sample.text ?? undefined}
                      >
                        {/* A moment with no attributable line still gets a
                            row: the clip is playable, and dropping it would
                            put every later excerpt's play button out of step
                            with its index. Left blank when the whole cluster
                            has no text -- the one explanation above already
                            says why, and repeating it per row reads as five
                            separate failures. */}
                        {sample.text
                          ? `“${sample.text}”`
                          : samples.some((s) => s.text)
                            ? 'No transcript for this moment'
                            : ''}
                      </span>
                    </div>
                  ))}
                </div>
              )}
            </div>
          );
        })}
      </div>

      {filteredRows.length > 0 && (
        <button
          type="button"
          onClick={() => setShowFiltered((prev) => !prev)}
          className="self-start text-[11.5px] underline-offset-2 hover:underline"
          style={{ color: 'var(--fg-2)' }}
          data-testid="speaker-toggle-filtered"
        >
          {showFiltered
            ? 'Hide filtered rows'
            : `Show ${filteredRows.length} filtered row${filteredRows.length === 1 ? '' : 's'}`}
        </button>
      )}

      <Dialog
        open={newPersonRow !== null}
        onOpenChange={(open) => {
          if (!open && !confirmSpeaker.isPending) {
            setNewPersonRow(null);
            setNewPersonError(null);
          }
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>New person</DialogTitle>
            <DialogDescription className="space-y-2">
              <span className="block">
                Steno creates a numerical biometric voice profile from confirmed excerpts to
                suggest this person in future meetings. It stays on this device and is never sent
                to Steno. Suggestions can be wrong and should be reviewed.
              </span>
              <span className="block">
                Delete the profile anytime in Settings &gt; People. Recordings and transcripts are
                stored separately and are not deleted with the profile.
              </span>
            </DialogDescription>
          </DialogHeader>
          <Input
            value={newPersonName}
            onChange={(e) => setNewPersonName(e.target.value)}
            disabled={confirmSpeaker.isPending}
            placeholder="e.g. Person Alpha"
            autoFocus
            onKeyDown={(e) => {
              if (
                e.key === 'Enter'
                && newPersonRow
                && newPersonName.trim()
                && !duplicateProfile
              ) {
                void submitNewPerson();
              }
            }}
            data-testid="speaker-new-person-input"
          />
          {duplicateProfile && (
            <p className="text-[12px]" style={{ color: 'var(--danger)' }} data-testid="speaker-new-person-duplicate">
              A person named "{duplicateProfile.display_name}" already exists -- use Change to pick them instead.
            </p>
          )}
          {newPersonError && (
            <p role="alert" className="text-[12px]" style={{ color: 'var(--danger)' }} data-testid="speaker-new-person-error">
              {newPersonError}
            </p>
          )}
          <DialogFooter>
            <DialogClose asChild>
              <Button variant="outline" disabled={confirmSpeaker.isPending}>Cancel</Button>
            </DialogClose>
            <Button
              disabled={
                !newPersonName.trim()
                || Boolean(duplicateProfile)
                || confirmSpeaker.isPending
              }
              onClick={() => void submitNewPerson()}
              data-testid="speaker-new-person-submit"
            >
              {confirmSpeaker.isPending ? 'Creating…' : 'Create'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

    </section>
  );
}
