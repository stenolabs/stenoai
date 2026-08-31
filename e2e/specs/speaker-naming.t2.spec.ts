import { test, expect } from '../fixtures/electron';
import { realUserDataDir, fileSig } from '../fixtures/real-user-data';
import {
  enableSpeakerIdentification,
  fixtureDiarizationRunId,
  readUserConfig,
  writeMeetingMarkdown,
  writeSpeakersSidecar,
  writeTranscriptFile,
} from '../fixtures/user-config';
import { makeWav } from '../fixtures/make-wav';
import { readFileSync, mkdirSync, writeFileSync } from 'fs';
import path from 'path';

/**
 * T2 — speaker naming (SpeakerReviewPanel's Approve/Change/New-person flow,
 * driven directly through the IPC bridge). Model-free: seeds a
 * `<stem>_speakers.json` sidecar (the exact shape written by
 * src.speaker_suggestions.write_speakers_sidecar / backfill-speaker-embeddings)
 * and a saved transcript with placeholder `[MM:SS] [Speaker N]` lines at the
 * same timestamps as the sidecar's segments -- no real diarizer, no real
 * audio, no model. Proves the full chain end-to-end through IPC: the real
 * Python `confirm-speaker --relabel-transcript` command persists a
 * PersonProfile in config.json AND rewrites the matching transcript lines by
 * timestamp overlap (see src.speaker_suggestions.relabel_transcript_speaker
 * and the speaker_identification plan doc's Phase 4).
 */

type ConfirmSpeakerResult = {
  success: boolean;
  error?: string;
  person_id?: string;
  display_name?: string;
  relabeled_lines?: number;
  reassigned_from?: string[];
};

type StenoWindow = Window & {
  stenoai: {
    meetings: {
      get: (summaryFile: string) => Promise<{
        success: boolean;
        error?: string;
        meeting?: { diarised_text?: string | null };
      }>;
    };
    speakers: {
      confirm: (params: {
        meetingStem: string;
        channel: string;
        diarizationSpeakerId: string;
        expectedRunId: string;
        personId?: string;
        newPersonName?: string;
      }) => Promise<ConfirmSpeakerResult>;
      suggestForMeeting: (meetingStem: string) => Promise<{
      success: boolean;
      diarization_run_id?: string;
        recording_available?: boolean;
        minimum_speaker_count?: number;
        channels: Record<
          string,
          Record<
            string,
            {
              status: string;
              suggested_name: string | null;
              first_timestamp: string | null;
              sample_text?: string | null;
              is_likely_artifact?: boolean;
              confirmed_by_user?: string | null;
            }
          >
        >;
      }>;
      getSampleAudio: (
        meetingStem: string,
        channel: string,
        diarizationSpeakerId: string,
        expectedRunId: string,
      ) => Promise<{ success: boolean; error?: string; audio_base64?: string }>;
      listProfiles: () => Promise<{
        success: boolean;
        person_profiles?: Array<{ person_id: string; display_name: string }>;
      }>;
      deleteProfile: (id: string) => Promise<{ success: boolean }>;
    };
  };
};

const readJson = (file: string) => JSON.parse(readFileSync(file, 'utf8'));

test('a meeting without a speaker sidecar returns an empty result without backend failure', async ({
  launchApp,
}) => {
  const realDirBefore = fileSig(realUserDataDir());
  const { page } = await launchApp();

  const suggestions = await page.evaluate(() =>
    (window as StenoWindow).stenoai.speakers.suggestForMeeting('e2e-no-speaker-sidecar'),
  );

  expect(suggestions).toMatchObject({
    success: true,
    recording_available: false,
    minimum_speaker_count: 0,
    channels: {},
  });
  expect(fileSig(realUserDataDir())).toBe(realDirBefore);
});

test('speaker identification stays unavailable until the user opts in', async ({
  launchApp,
  userDataDir,
}) => {
  const stem = 'e2e-speaker-opt-out';
  writeSpeakersSidecar(userDataDir, stem, {
    mic: {
      recording_type: 'in_person',
      clusters: {
        SPEAKER_0: {
          embedding: [1.0, 0.0], speech_duration_seconds: 30.0, segment_count: 5,
          segments: [{ start: 5.0, end: 7.0 }],
        },
      },
    },
  });

  const { page } = await launchApp();
  const suggestions = await page.evaluate(
    (meetingStem) => (window as StenoWindow).stenoai.speakers.suggestForMeeting(meetingStem),
    stem,
  );
  expect(suggestions).toMatchObject({ success: true, channels: {} });

  const confirm = await page.evaluate(
    (params) => (window as StenoWindow).stenoai.speakers.confirm(params),
    { meetingStem: stem, channel: 'mic', diarizationSpeakerId: 'SPEAKER_0', expectedRunId: fixtureDiarizationRunId(stem), newPersonName: 'Person Alpha' },
  );
  expect(confirm).toMatchObject({
    success: false,
    error: 'Speaker identification is disabled in settings.',
  });
  expect(readUserConfig(userDataDir).person_profiles ?? []).toEqual([]);
});

test('legacy sidecars without a run id can still be reviewed safely', async ({
  launchApp,
  userDataDir,
}) => {
  const stem = 'e2e-speaker-legacy-sidecar';
  const sidecarFile = writeSpeakersSidecar(userDataDir, stem, {
    mic: {
      recording_type: 'in_person',
      clusters: {
        SPEAKER_0: {
          embedding: [1.0, 0.0],
          speech_duration_seconds: 30.0,
          segment_count: 5,
          segments: [{ start: 5.0, end: 7.0 }],
        },
        SPEAKER_1: {
          embedding: [0.0, 1.0],
          speech_duration_seconds: 25.0,
          segment_count: 4,
          segments: [{ start: 9.0, end: 11.0 }],
        },
      },
    },
  });
  const legacySidecar = readJson(sidecarFile) as Record<string, unknown>;
  delete legacySidecar.diarization_run;
  const legacyChannels = legacySidecar.channels as Record<
    string,
    { clusters: Record<string, Record<string, unknown>> }
  >;
  legacyChannels.mic.clusters.SPEAKER_0.review_state = 'generic';
  writeFileSync(sidecarFile, JSON.stringify(legacySidecar, null, 2));
  enableSpeakerIdentification(userDataDir);

  const { page } = await launchApp();
  const suggestions = await page.evaluate(
    (meetingStem) => (window as StenoWindow).stenoai.speakers.suggestForMeeting(meetingStem),
    stem,
  );
  expect(suggestions.success).toBe(true);
  expect(suggestions.diarization_run_id).toMatch(/^legacy-[a-f0-9]{64}$/);

  const result = await page.evaluate(
    (params) => (window as StenoWindow).stenoai.speakers.confirm(params),
    {
      meetingStem: stem,
      channel: 'mic',
      diarizationSpeakerId: 'SPEAKER_0',
      expectedRunId: suggestions.diarization_run_id as string,
      newPersonName: 'Person Legacy',
    },
  );
  expect(result).toMatchObject({ success: true, display_name: 'Person Legacy' });

  const suggestionsAfterFirstConfirm = await page.evaluate(
    (meetingStem) => (window as StenoWindow).stenoai.speakers.suggestForMeeting(meetingStem),
    stem,
  );
  expect(suggestionsAfterFirstConfirm.diarization_run_id).toBe(
    suggestions.diarization_run_id,
  );
  const secondResult = await page.evaluate(
    (params) => (window as StenoWindow).stenoai.speakers.confirm(params),
    {
      meetingStem: stem,
      channel: 'mic',
      diarizationSpeakerId: 'SPEAKER_1',
      expectedRunId: suggestions.diarization_run_id as string,
      newPersonName: 'Person Legacy Two',
    },
  );
  expect(secondResult).toMatchObject({ success: true, display_name: 'Person Legacy Two' });
  expect(readUserConfig(userDataDir).person_profiles).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ display_name: 'Person Legacy' }),
      expect.objectContaining({ display_name: 'Person Legacy Two' }),
    ]),
  );
});

test('confirm-speaker --relabel-transcript persists a PersonProfile and relabels the saved transcript', async ({
  launchApp,
  userDataDir,
}) => {
  const realDirBefore = fileSig(realUserDataDir());
  const stem = 'e2e-speaker-mtg';

  writeSpeakersSidecar(userDataDir, stem, {
    system: {
      recording_type: 'remote',
      clusters: {
        SPEAKER_0: {
          embedding: [1.0, 0.0],
          speech_duration_seconds: 30.0,
          segment_count: 5,
          segments: [{ start: 5.0, end: 7.0 }],
        },
      },
    },
  });
  const transcriptFile = writeTranscriptFile(
    userDataDir,
    stem,
    '[00:05] [Speaker 2] hello there\n\n[00:20] [You] hi back',
  );
  const summaryFile = writeMeetingMarkdown(userDataDir, stem, {
    name: 'Speaker naming',
    summaryMarkdown: '## Summary\nTwo people discussed the plan.',
    transcript: '[00:05] [Speaker 2] hello there\n\n[00:20] [You] hi back',
    frontmatter: { is_diarised: true },
  });

  enableSpeakerIdentification(userDataDir);

  const { page } = await launchApp();

  const result = await page.evaluate(
    (params) => (window as StenoWindow).stenoai.speakers.confirm(params),
    { meetingStem: stem, channel: 'system', diarizationSpeakerId: 'SPEAKER_0', expectedRunId: fixtureDiarizationRunId(stem), newPersonName: 'Person Alpha' },
  );
  expect(result.success).toBe(true);
  expect(result.display_name).toBe('Person Alpha');
  expect(result.relabeled_lines).toBe(1);

  // The PersonProfile landed in config.json with one confirmed prototype.
  const configPath = path.join(userDataDir, 'config.json');
  await expect.poll(() => {
    const cfg = readJson(configPath);
    const profiles = (cfg.person_profiles ?? []) as Array<{ display_name: string; prototypes: unknown[] }>;
    return profiles.find((p) => p.display_name === 'Person Alpha')?.prototypes.length;
  }).toBe(1);

  // The saved transcript now shows the real name at the confirmed segment's
  // timestamp, and the untouched "You" line is unaffected.
  await expect.poll(() => readFileSync(transcriptFile, 'utf8')).toEqual(
    expect.stringContaining('[00:05] [Person Alpha] hello there'),
  );
  expect(readFileSync(transcriptFile, 'utf8')).toContain('[00:20] [You] hi back');
  const firstMeeting = await page.evaluate(
    (file) => (window as StenoWindow).stenoai.meetings.get(file),
    summaryFile,
  );
  expect(firstMeeting.success, firstMeeting.error).toBe(true);
  expect(firstMeeting.meeting!.diarised_text).toContain('[00:05] [Person Alpha] hello there');

  // A second confirm of the SAME cluster (the review UI's "Change"
  // correction) REASSIGNS it: the transcript re-labels idempotently rather
  // than duplicating lines, and Person Alpha's superseded prototype is removed
  // so the mis-confirm can't keep poisoning cross-meeting matching.
  const secondResult = await page.evaluate(
    (params) => (window as StenoWindow).stenoai.speakers.confirm(params),
    { meetingStem: stem, channel: 'system', diarizationSpeakerId: 'SPEAKER_0', expectedRunId: fixtureDiarizationRunId(stem), newPersonName: 'Person Gamma' },
  );
  expect(secondResult.success).toBe(true);
  expect(secondResult.reassigned_from).toEqual(['Person Alpha']);
  await expect.poll(() => readFileSync(transcriptFile, 'utf8')).toEqual(
    expect.stringContaining('[00:05] [Person Gamma] hello there'),
  );
  expect(readFileSync(transcriptFile, 'utf8')).not.toContain('[Person Alpha]');
  const correctedMeeting = await page.evaluate(
    (file) => (window as StenoWindow).stenoai.meetings.get(file),
    summaryFile,
  );
  expect(correctedMeeting.success, correctedMeeting.error).toBe(true);
  expect(correctedMeeting.meeting!.diarised_text).toContain('[00:05] [Person Gamma] hello there');
  expect(correctedMeeting.meeting!.diarised_text).not.toContain('[Person Alpha]');

  // On disk: Person Alpha keeps his (now evidence-less) profile, Person Gamma owns the
  // cluster with a prototype marked as a correction.
  await expect.poll(() => {
    const cfg = readJson(configPath);
    const profiles = (cfg.person_profiles ?? []) as Array<{
      display_name: string;
      prototypes: Array<{ created_from: string; channel?: string }>;
    }>;
    const personAlpha = profiles.find((p) => p.display_name === 'Person Alpha');
    const personGamma = profiles.find((p) => p.display_name === 'Person Gamma');
    return {
      alphaPrototypes: personAlpha?.prototypes.length,
      gammaCreatedFrom: personGamma?.prototypes[0]?.created_from,
      gammaChannel: personGamma?.prototypes[0]?.channel,
    };
  }).toEqual({ alphaPrototypes: 0, gammaCreatedFrom: 'user_corrected', gammaChannel: 'system' });

  // Re-running suggest-speakers reflects the corrected state. Status is
  // "possible", not "confirmed" -- SUGGESTION_MIN_CONFIRMED_MEETINGS (=2)
  // caps any person with evidence from only ONE meeting there, and Person Gamma
  // only has this single meeting confirmed so far. suggested_name is
  // still set at "possible" tier (see suggest_speaker). Person Alpha has no
  // prototypes left, so he can't out-rank Person Gamma the way his stale
  // same-cluster prototype used to before the reassignment fix.
  const suggestions = await page.evaluate(
    (meetingStem) => (window as StenoWindow).stenoai.speakers.suggestForMeeting(meetingStem),
    stem,
  );
  expect(suggestions.success).toBe(true);
  expect(suggestions.channels.system.SPEAKER_0.status).toBe('possible');
  expect(suggestions.channels.system.SPEAKER_0.suggested_name).toBe('Person Gamma');
  // The identification anchor (where to go listen) computed end-to-end by
  // the real backend from the sidecar's seeded segment ({start: 5.0}).
  expect(suggestions.channels.system.SPEAKER_0.first_timestamp).toBe('00:05');
  // confirmed_by_user is real, persisted evidence (a matching
  // SpeakerPrototype), not the transient panel-only feedback line -- it
  // survives a completely fresh process (this IS a fresh suggest-speakers
  // call, not a cached value). After the reassignment it names Person Gamma --
  // Person Alpha's superseded prototype no longer exists to be found.
  expect(suggestions.channels.system.SPEAKER_0.confirmed_by_user).toBe('Person Gamma');

  // Keystone: the real user-data dir is byte-for-byte untouched.
  expect(fileSig(realUserDataDir())).toBe(realDirBefore);
});

test('identification aids: sample_text/is_likely_artifact/recording_available and a real audio sample extraction', async ({
  launchApp,
  userDataDir,
}) => {
  const realDirBefore = fileSig(realUserDataDir());
  const stem = 'e2e-speaker-mtg-audio';

  // A short real WAV (mirrors audio-import.t2's pattern) so
  // get-speaker-sample-audio has genuine source audio to slice with ffmpeg
  // -- proving the extraction, not just that it gracefully no-ops.
  const recordingsDir = path.join(userDataDir, 'recordings');
  mkdirSync(recordingsDir, { recursive: true });
  makeWav(path.join(recordingsDir, `${stem}.wav`), { seconds: 3, channels: 2 });

  writeSpeakersSidecar(userDataDir, stem, {
    mic: {
      recording_type: 'in_person',
      clusters: {
        // A real, substantial turn -- sample_text should be extracted,
        // is_likely_artifact should be false (avg turn well above the gate).
        SPEAKER_0: {
          embedding: [1.0, 0.0], speech_duration_seconds: 2.0, segment_count: 1,
          segments: [{ start: 0.5, end: 2.5 }],
        },
        // The real-library echo-artifact shape: many short scattered turns.
        SPEAKER_1: {
          embedding: [0.0, 1.0], speech_duration_seconds: 5.0, segment_count: 10,
          segments: [{ start: 0.1, end: 0.3 }],
        },
      },
    },
  }, [
    // The turn manifest is what makes sample_text attributable at all: one
    // entry per diarised transcript line, in order, naming the exact
    // cluster that produced it. Without it the backend returns no text
    // rather than matching by timestamp -- a backfilled sidecar's segments
    // come from a different diarization run than the transcript's [MM:SS]
    // markers, and matching across the two put a different participant's
    // words under the owner's own cluster on a real recording.
    { start: 1.0, channel: 'mic', diarization_speaker_id: 'SPEAKER_0' },
  ]);
  // Timestamp must land inside the segment's [start, end] +/- the 0.5s
  // sample tolerance -- SPEAKER_0's segment is [0.5, 2.5], so [00:01] (1s)
  // is safely within range (unlike 0s, which would be just outside).
  writeTranscriptFile(userDataDir, stem, '[00:01] [Speaker 2] this is a real substantial turn');

  enableSpeakerIdentification(userDataDir);

  const { page } = await launchApp();

  const suggestions = await page.evaluate(
    (meetingStem) => (window as StenoWindow).stenoai.speakers.suggestForMeeting(meetingStem),
    stem,
  );
  expect(suggestions.success).toBe(true);
  expect(suggestions.recording_available).toBe(true);
  expect(suggestions.channels.mic.SPEAKER_0.sample_text).toBe('this is a real substantial turn');
  expect(suggestions.channels.mic.SPEAKER_0.is_likely_artifact).toBe(false);
  expect(suggestions.channels.mic.SPEAKER_1.is_likely_artifact).toBe(true);
  // Never confirmed -- no matching SpeakerPrototype exists yet.
  expect(suggestions.channels.mic.SPEAKER_0.confirmed_by_user).toBeNull();

  const sample = await page.evaluate(
    (args) => (window as StenoWindow).stenoai.speakers.getSampleAudio(args.stem, 'mic', args.sid, args.runId),
    { stem, sid: 'SPEAKER_0', runId: fixtureDiarizationRunId(stem) },
  );
  expect(sample.success).toBe(true);
  const bytes = Buffer.from(sample.audio_base64 as string, 'base64');
  // A real WAV file starts with the RIFF magic bytes -- proves ffmpeg
  // actually extracted real audio, not a stub/placeholder.
  expect(bytes.subarray(0, 4).toString('ascii')).toBe('RIFF');
  expect(bytes.length).toBeGreaterThan(44); // more than just a bare header

  // Keystone: the real user-data dir is byte-for-byte untouched.
  expect(fileSig(realUserDataDir())).toBe(realDirBefore);
});

test('duplicate person names are rejected, and delete-person-profile removes a person end-to-end', async ({
  launchApp,
  userDataDir,
}) => {
  const realDirBefore = fileSig(realUserDataDir());
  const stem = 'e2e-speaker-mtg-dedup';

  writeSpeakersSidecar(userDataDir, stem, {
    mic: {
      recording_type: 'in_person',
      clusters: {
        SPEAKER_0: {
          embedding: [1.0, 0.0], speech_duration_seconds: 30.0, segment_count: 5,
          segments: [{ start: 5.0, end: 7.0 }],
        },
        SPEAKER_1: {
          embedding: [0.0, 1.0], speech_duration_seconds: 30.0, segment_count: 5,
          segments: [{ start: 20.0, end: 22.0 }],
        },
      },
    },
  });

  enableSpeakerIdentification(userDataDir);

  const { page } = await launchApp();

  const first = await page.evaluate(
    (params) => (window as StenoWindow).stenoai.speakers.confirm(params),
    { meetingStem: stem, channel: 'mic', diarizationSpeakerId: 'SPEAKER_0', expectedRunId: fixtureDiarizationRunId(stem), newPersonName: 'Person Alpha' },
  );
  expect(first.success).toBe(true);

  // A second, entirely different cluster confirmed under the SAME name
  // (any case/whitespace variant) must be rejected -- real evidence for
  // one real person must not get split across two person_ids.
  const duplicate = await page.evaluate(
    (params) => (window as StenoWindow).stenoai.speakers.confirm(params),
    { meetingStem: stem, channel: 'mic', diarizationSpeakerId: 'SPEAKER_1', expectedRunId: fixtureDiarizationRunId(stem), newPersonName: '  person alpha ' },
  );
  expect(duplicate.success).toBe(false);
  expect(duplicate.error).toContain('already exists');

  const configPath = path.join(userDataDir, 'config.json');
  const profilesAfterDuplicate = JSON.parse(readFileSync(configPath, 'utf8')).person_profiles as Array<{
    display_name: string;
    prototypes: unknown[];
  }>;
  expect(profilesAfterDuplicate).toHaveLength(1);
  expect(profilesAfterDuplicate[0].prototypes).toHaveLength(1);

  // delete-person-profile removes them entirely.
  const listed = await page.evaluate(() => (window as StenoWindow).stenoai.speakers.listProfiles());
  expect(listed.success).toBe(true);
  const personAlpha = listed.person_profiles?.find((p) => p.display_name === 'Person Alpha');
  expect(personAlpha).toBeDefined();

  const deleted = await page.evaluate(
    (id) => (window as StenoWindow).stenoai.speakers.deleteProfile(id),
    personAlpha!.person_id,
  );
  expect(deleted.success).toBe(true);

  const listedAfterDelete = await page.evaluate(() => (window as StenoWindow).stenoai.speakers.listProfiles());
  expect(listedAfterDelete.person_profiles).toHaveLength(0);

  // Keystone: the real user-data dir is byte-for-byte untouched.
  expect(fileSig(realUserDataDir())).toBe(realDirBefore);
});
