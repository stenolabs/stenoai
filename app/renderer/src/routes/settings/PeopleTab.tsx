import * as React from 'react';
import { Loader2, Play, Square, Trash2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import {
  useDeletePersonProfile,
  useGetPersonSampleAudio,
  usePersonProfiles,
} from '@/hooks/useSpeakerSuggestions';
import type { PersonProfile } from '@/lib/ipc';
import { useBlobAudioPlayback } from '@/hooks/useBlobAudioPlayback';
import { SettingRow, COMPACT_BTN } from './primitives';
import { useTranslation } from '@/i18n';
// ---------------------------------------------------------------------------
// People - the one place a voice profile can be deleted.
//
// Deleting used to live inline in the speaker-review panel's "Change" picker,
// one icon away from the button that merely assigns a person to a cluster.
// That put a global, irreversible action (it removes the voice profile from
// EVERY meeting, and strips the derived hard-negative evidence out of everyone
// else's profile) inside a control whose entire job is a local, reversible
// choice about one cluster. Managing who Steno knows is a settings-level
// concern, so it lives at settings level.
// ---------------------------------------------------------------------------

/** Total stored voice samples across recording contexts.
 *
 *  `prototype_counts` is keyed by recording context (in-person/remote), not by
 *  meeting -- the profile DTO carries counts, not the prototypes themselves,
 *  so "how many meetings is this person in" is not answerable here without
 *  widening the backend payload. The sample count is the honest thing this
 *  screen can say: it is what recognition actually runs on. */
function sampleCount(profile: PersonProfile): number {
  return Object.values(profile.prototype_counts ?? {}).reduce(
    (sum, n) => sum + (Number.isFinite(n) ? n : 0),
    0,
  );
}

function describeSamples(profile: PersonProfile, t: (key: string, params?: Record<string, string | number>) => string): string {
  const n = sampleCount(profile);
  // A profile with no samples is a real state, not an error: "New person"
  // creates the profile before any voice has been attached to it, and every
  // enrollment path can leave one behind. Saying "0 voice samples" would
  // read as damage; naming it as not-yet-learned is what it is.
  if (n === 0) return t('speaker.noSamples');
  return t('speaker.samplesCount', { count: n, plural: n === 1 ? '' : 's' });
}

export function PeopleTab() {
  const { t } = useTranslation();
  const profilesQuery = usePersonProfiles();
  const deleteProfile = useDeletePersonProfile();
  const getPersonSample = useGetPersonSampleAudio();
  const [deleteTarget, setDeleteTarget] = React.useState<PersonProfile | null>(null);
  const [deleteError, setDeleteError] = React.useState(false);
  const playback = useBlobAudioPlayback(async (personId: string) => {
    const result = await getPersonSample.mutateAsync(personId);
    return result.audio_base64;
  });

  const profiles = React.useMemo(
    () =>
      [...(profilesQuery.data ?? [])].sort((a, b) =>
        a.display_name.localeCompare(b.display_name),
      ),
    [profilesQuery.data],
  );

  if (profilesQuery.isLoading) {
    return (
      <div className="flex items-center gap-2 py-6 text-[13px]" style={{ color: 'var(--fg-2)' }}>
        <Loader2 className="size-[14px] animate-spin" />
        {t('speaker.loadingPeople')}
      </div>
    );
  }

  if (profilesQuery.isError) {
    return (
      <div className="py-6 text-[13px]" style={{ color: 'var(--fg-2)' }} data-testid="people-error">
        {t('speaker.couldNotLoadPeople')}
      </div>
    );
  }

  return (
    <div data-testid="people-tab">
      {profiles.length === 0 ? (
        <div className="py-6 text-[13px]" style={{ color: 'var(--fg-2)' }} data-testid="people-empty">
          {t('speaker.noPeopleYet')}
        </div>
      ) : (
        profiles.map((profile, i) => (
          <SettingRow
            key={profile.person_id}
            label={profile.display_name}
            description={(
              <>
                <span>{describeSamples(profile, t)}</span>
                {playback.errorKey === profile.person_id && (
                  <span
                    role="alert"
                    className="mt-1 block"
                    data-testid={`people-play-error-${profile.person_id}`}
                  >
                    Could not play this voice sample. Try again.
                  </span>
                )}
              </>
            )}
            noBorder={i === profiles.length - 1}
          >
            <div className="flex items-center gap-2">
              {profile.sample_available && (
                <Button
                  variant="outline"
                  className={COMPACT_BTN}
                  disabled={playback.pendingKey !== null}
                  onClick={() => void playback.toggle(profile.person_id)}
                  aria-label={
                    playback.playingKey === profile.person_id
                      ? `Stop voice sample for ${profile.display_name}`
                      : `Play voice sample for ${profile.display_name}`
                  }
                  data-testid={`people-play-${profile.person_id}`}
                >
                  {playback.pendingKey === profile.person_id ? (
                    <Loader2 className="size-[13px] animate-spin" />
                  ) : playback.playingKey === profile.person_id ? (
                    <Square className="size-[13px]" />
                  ) : (
                    <Play className="size-[13px]" />
                  )}
                  {playback.playingKey === profile.person_id ? t('common.stop') : t('common.play')}
                </Button>
              )}
              <Button
                variant="outline"
                className={COMPACT_BTN}
                disabled={playback.pendingKey !== null}
                onClick={() => {
                  playback.stop();
                  setDeleteError(false);
                  setDeleteTarget(profile);
                }}
                aria-label={`Delete ${profile.display_name}`}
                data-testid={`people-delete-${profile.person_id}`}
              >
                <Trash2 className="size-[13px]" />
                {t('common.delete')}
              </Button>
            </div>
          </SettingRow>
        ))
      )}

      <ConfirmDialog
        open={deleteTarget !== null}
        onOpenChange={(open) => {
          if (!open) {
            setDeleteTarget(null);
            setDeleteError(false);
          }
        }}
        title={deleteTarget ? `Delete ${deleteTarget.display_name}?` : ''}
        // Wording carried over verbatim from the picker this replaced: the
        // reach of the action is the whole point of stating it, and it does
        // not get smaller for being triggered from settings.
        description={(
          <span>
            This removes them from every meeting&apos;s speaker suggestions and deletes their
            voice profile. This can&apos;t be undone.
            {deleteError && (
              <span
                role="alert"
                className="mt-2 block"
                data-testid="people-delete-error"
              >
                Could not delete this person. Try again.
              </span>
            )}
          </span>
        )}
        confirmLabel={t('common.delete')}
        destructive
        isPending={deleteProfile.isPending}
        onConfirm={async () => {
          if (!deleteTarget) return;
          setDeleteError(false);
          try {
            await deleteProfile.mutateAsync(deleteTarget.person_id);
            setDeleteTarget(null);
          } catch {
            setDeleteError(true);
          }
        }}
      />
    </div>
  );
}
