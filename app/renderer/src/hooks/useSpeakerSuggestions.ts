import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ipc } from '@/lib/ipc';
import { unwrap } from '@/lib/result';
import { meetingsKeys } from './meetingKeys';

/** `session_info.summary_file` is an ABSOLUTE PATH in production
 * (`str(summary_path)`, simple_recorder.py) -> the bare meeting stem the
 * speaker-suggestion CLI/IPC surface keys everything by (matches
 * src._enumerate_meeting_stems' dedup-by-stem convention). Split on both
 * slash styles (cross-platform: macOS/Windows) rather than using Node's
 * `path` module, which isn't available in the renderer (contextIsolation). */
export function meetingStemFromSummaryFile(summaryFile: string | null | undefined): string | null {
  if (!summaryFile) return null;
  const basename = summaryFile.split(/[/\\]/).pop() ?? summaryFile;
  return basename.replace(/_summary\.(json|md)$/, '');
}

export const speakersKeys = {
  all: ['speakers'] as const,
  profiles: () => [...speakersKeys.all, 'profiles'] as const,
  suggestions: (meetingStem: string | null | undefined) =>
    [...speakersKeys.all, 'suggestions', meetingStem ?? null] as const,
};

export function usePersonProfiles(enabled = true) {
  return useQuery({
    queryKey: speakersKeys.profiles(),
    queryFn: async () => unwrap(await ipc().speakers.listProfiles()).person_profiles,
    enabled,
  });
}

export function useSpeakerSuggestions(
  meetingStem: string | null | undefined,
  enabled = true,
) {
  return useQuery({
    queryKey: speakersKeys.suggestions(meetingStem),
    queryFn: async () => unwrap(await ipc().speakers.suggestForMeeting(meetingStem as string)),
    enabled: Boolean(meetingStem) && enabled,
  });
}

interface ConfirmSpeakerArgs {
  meetingStem: string;
  channel: string;
  diarizationSpeakerId: string;
  expectedRunId: string;
  personId?: string;
  newPersonName?: string;
  /** The meeting's summaryFile, so a successful relabel invalidates the
   * transcript this meeting's detail view reads -- without this the panel
   * would show the confirmation but the transcript bubbles would keep
   * showing the old placeholder label until an unrelated refetch. */
  summaryFile?: string | null;
}

export function useConfirmSpeaker() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (args: ConfirmSpeakerArgs) =>
      unwrap(
        await ipc().speakers.confirm({
          meetingStem: args.meetingStem,
          channel: args.channel,
          diarizationSpeakerId: args.diarizationSpeakerId,
          expectedRunId: args.expectedRunId,
          personId: args.personId,
          newPersonName: args.newPersonName,
        }),
      ),
    // AWAITS the refetches (invalidateQueries' returned promise resolves
    // once actively-observed queries have refetched) -- without this, the
    // mutation (and any per-call onSuccess, e.g. the panel's confirmation
    // feedback) resolves the instant confirm-speaker itself returns, while
    // the suggestions refetch is still in flight in the background. On a
    // large real meeting (1000+ turns) that refetch can take a visible
    // moment, producing exactly the contradiction a real user hit: "✓
    // Confirmed as X" appearing while the row still says "Unidentified
    // speaker" from the stale pre-confirm data.
    onSuccess: async (_data, args) => {
      await Promise.all([
        qc.invalidateQueries({ queryKey: speakersKeys.suggestions(args.meetingStem) }),
        qc.invalidateQueries({ queryKey: speakersKeys.profiles() }),
        args.summaryFile
          ? qc.invalidateQueries({ queryKey: meetingsKeys.detail(args.summaryFile) })
          : Promise.resolve(),
      ]);
    },
  });
}

export function useCreatePersonProfile() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (displayName: string) => unwrap(await ipc().speakers.createProfile(displayName)),
    onSuccess: () => qc.invalidateQueries({ queryKey: speakersKeys.profiles() }),
  });
}

export function useRenamePersonProfile() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (args: { id: string; displayName: string }) =>
      unwrap(await ipc().speakers.renameProfile(args.id, args.displayName)),
    // Invalidates the WHOLE speakers.* tree (profiles AND every cached
    // per-meeting suggestions query), not just profiles -- a rename changes
    // the display_name a currently-open meeting's confirmed_by_user/
    // suggested_name would show, so a narrower invalidation would leave a
    // stale old name on screen until some unrelated refetch happened to fire.
    onSuccess: () => qc.invalidateQueries({ queryKey: speakersKeys.all }),
  });
}

export function useDeletePersonProfile() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (id: string) => unwrap(await ipc().speakers.deleteProfile(id)),
    // Same reasoning as useRenamePersonProfile above: deleting a person
    // removes their prototypes, which changes confirmed_by_user/candidates
    // for every cluster that referenced them -- invalidate the whole tree,
    // not just the profiles list.
    onSuccess: () => qc.invalidateQueries({ queryKey: speakersKeys.all }),
  });
}

/** Fetch-on-demand, not cached: mirrors the reference project's play-on-click
 * behavior (pasrom/meeting-transcriber's SpeakerNamingView.swift) -- a
 * mutation, not a query, since there's nothing to keep fresh in the
 * background for an audio clip a human triggers explicitly. */
export function useGetSpeakerSampleAudio() {
  return useMutation({
    mutationFn: async (args: {
      meetingStem: string;
      channel: string;
      diarizationSpeakerId: string;
      expectedRunId: string;
      /** Index into the row's `samples`. Omitted plays the longest turn
       * (the collapsed row's single button); a number plays exactly that
       * excerpt, so the audio matches the text it sits next to. */
      segmentIndex?: number;
    }) =>
      unwrap(
        await ipc().speakers.getSampleAudio(
          args.meetingStem,
          args.channel,
          args.diarizationSpeakerId,
          args.expectedRunId,
          args.segmentIndex,
        ),
      ),
  });
}

/** Fetch one representative clip for a known person on demand.
 *
 * The backend resolves private meeting/cluster provenance at click time and
 * returns only audio bytes, so the renderer never caches local source details.
 */
export function useGetPersonSampleAudio() {
  return useMutation({
    mutationFn: async (personId: string) =>
      unwrap(await ipc().speakers.getPersonSampleAudio(personId)),
  });
}

/** Marking a cluster as holding more than one person. Invalidates the whole
 * speakers tree rather than just this meeting's suggestions: the marking
 * withdraws the cluster from meeting-wide person exclusivity, so ANOTHER
 * row's suggestion can change as a direct result of marking this one. */
export function useMarkSpeakerCluster() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (args: {
      meetingStem: string;
      channel: string;
      diarizationSpeakerId: string;
      expectedRunId: string;
      containsMultipleSpeakers: boolean;
      /** The meeting's summaryFile, carried for the same reason the confirm
       * mutation carries it: marking a CONFIRMED cluster withdraws that
       * person from the meeting's participants, and the open detail view
       * reads those from its own cached query. Without invalidating it, the
       * Participants line keeps showing the withdrawn name until an
       * unrelated refetch or a navigation. */
      summaryFile?: string | null;
    }) => {
      const { summaryFile: _ignored, ...call } = args;
      return unwrap(await ipc().speakers.markCluster(call));
    },
    onSuccess: async (_data, args) => {
      await qc.invalidateQueries({ queryKey: speakersKeys.all });
      if (args.summaryFile) {
        await qc.invalidateQueries({ queryKey: meetingsKeys.detail(args.summaryFile) });
      }
    },
  });
}

/** Recording that a human reviewed a cluster and left it unnamed.
 *
 * Invalidates only THIS meeting's suggestions, unlike the marking mutation
 * next door: keeping a row generic changes nothing about the person
 * profiles and nothing about any other meeting -- it is a note about this
 * review, so widening the invalidation would refetch every cached meeting
 * for no change. */
export function useSetClusterReviewState() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (args: {
      meetingStem: string;
      channel: string;
      diarizationSpeakerId: string;
      expectedRunId: string;
      generic: boolean;
    }) => unwrap(await ipc().speakers.setClusterReviewState(args)),
    onSuccess: async (_data, args) => {
      await qc.invalidateQueries({ queryKey: speakersKeys.suggestions(args.meetingStem) });
    },
  });
}

/** How many speaker clusters of a meeting are still unnamed -- read once,
 * right before a delete confirmation, to decide whether to add a sentence
 * saying the unnamed ones are about to become unnameable forever.
 *
 * Failures resolve to null rather than throwing: this decides whether ONE
 * extra sentence appears, and must never stand between someone and
 * deleting their own recording. `enabled` keeps it from firing at all
 * until a delete is actually being confirmed. */
export function useSpeakerNamingStatus(meetingStem: string | null | undefined, enabled: boolean) {
  return useQuery({
    queryKey: [...speakersKeys.all, 'naming-status', meetingStem ?? null] as const,
    queryFn: async () => {
      const res = await ipc().speakers.namingStatus(meetingStem as string);
      return res.success ? res : null;
    },
    enabled: enabled && Boolean(meetingStem),
    retry: false,
    staleTime: 0,
  });
}
