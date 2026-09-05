import { test, expect } from '../fixtures/electron';
import { realUserDataDir, fileSig } from '../fixtures/real-user-data';
import {
  enableSpeakerIdentification,
  fixtureDiarizationRunId,
  writeSpeakersSidecar,
  writeTranscriptFile,
  writeMeetingMarkdown,
} from '../fixtures/user-config';
import { readFileSync, existsSync, writeFileSync } from 'fs';
import path from 'path';

/**
 * T2 — the "this cluster holds more than one person" marking, the multi-excerpt
 * review samples, and what a delete costs. Model-free: seeds a
 * `<stem>_speakers.json` sidecar in the exact shape
 * src.speaker_suggestions.write_speakers_sidecar produces, plus a saved
 * transcript with `[MM:SS] [Speaker N]` lines at the sidecar's own segment
 * timestamps. No diarizer, no audio, no model — everything asserted here is
 * real backend state on disk or a real Python CLI's answer through the bridge.
 *
 * What makes these worth having as e2e rather than unit tests: the marking's
 * whole purpose is to stop a blended two-voice centroid from being enrolled as
 * a person, and the enrollment happens in a Python subprocess writing
 * config.json. A unit test can prove the guard function returns "none"; only
 * this can prove no prototype reaches config.json.
 */

type StenoWindow = Window & {
  stenoai: {
    speakers: {
      markCluster: (params: {
        meetingStem: string;
        channel: string;
        diarizationSpeakerId: string;
        expectedRunId: string;
        containsMultipleSpeakers: boolean;
      }) => Promise<{
        success: boolean;
        error?: string;
        contains_multiple_speakers?: boolean;
        cleared_confirmation_from?: string[];
        minimum_speaker_count?: number;
      }>;
      confirm: (params: {
        meetingStem: string;
        channel: string;
        diarizationSpeakerId: string;
        expectedRunId: string;
        newPersonName?: string;
        personId?: string;
      }) => Promise<{ success: boolean; error?: string }>;
      setClusterReviewState: (params: {
        meetingStem: string;
        channel: string;
        diarizationSpeakerId: string;
        expectedRunId: string;
        generic: boolean;
      }) => Promise<{
      success: boolean;
      diarization_run_id?: string;
        error?: string;
        resolved_diarization_speaker_id?: string;
        fragment_ids?: string[];
        review_state?: string | null;
      }>;
      suggestForMeeting: (meetingStem: string) => Promise<{
        success: boolean;
        minimum_speaker_count?: number;
        channels: Record<
          string,
          Record<
            string,
            {
              status: string;
              suggested_name: string | null;
              candidates: unknown[];
              contains_multiple_speakers?: boolean;
              review_state?: string | null;
              sample_text?: string | null;
              samples?: Array<{ start: number; end: number; text: string | null }>;
            }
          >
        >;
      }>;
      namingStatus: (meetingStem: string) => Promise<{
        success: boolean;
        has_sidecar?: boolean;
        total_clusters?: number;
        named_clusters?: number;
        unnamed_clusters?: number;
      }>;
    };
    meetings: {
      delete: (meeting: unknown) => Promise<{ success: boolean; id?: string; error?: string }>;
      commitDelete: (id: string) => Promise<{ success: boolean }>;
    };
  };
};

const readJson = (file: string) => JSON.parse(readFileSync(file, 'utf8'));

/** Two clusters that differ only in which one gets marked, plus a transcript
 * whose lines sit at the sidecar's segment timestamps so the samples have
 * real text to quote. SPEAKER_0's segments are deliberately of different
 * lengths and out of chronological order in the file, so the samples list
 * proves it sorts rather than echoing input order. */
function seedMeeting(userDataDir: string, stem: string) {
  enableSpeakerIdentification(userDataDir);
  writeSpeakersSidecar(userDataDir, stem, {
    system: {
      recording_type: 'remote',
      clusters: {
        SPEAKER_0: {
          embedding: [1.0, 0.0],
          speech_duration_seconds: 60.0,
          segment_count: 3,
          segments: [
            { start: 120.0, end: 128.0 },
            { start: 10.0, end: 30.0 },
            { start: 60.0, end: 62.0 },
          ],
        },
        SPEAKER_1: {
          embedding: [0.0, 1.0],
          speech_duration_seconds: 40.0,
          segment_count: 1,
          segments: [{ start: 200.0, end: 210.0 }],
        },
      },
    },
  }, [
    // One entry per diarised transcript line, in order -- exact recorded
    // provenance. Three of the four lines belong to SPEAKER_0, and they
    // are the lines labeled "You": on the mic channel those are the
    // owner's own turns, and an earlier version skipped every "You" line,
    // which left the owner's cluster quoting somebody else.
    { start: 10.0, channel: 'system', diarization_speaker_id: 'SPEAKER_0' },
    { start: 60.0, channel: 'system', diarization_speaker_id: 'SPEAKER_0' },
    { start: 120.0, channel: 'system', diarization_speaker_id: 'SPEAKER_0' },
    { start: 200.0, channel: 'system', diarization_speaker_id: 'SPEAKER_1' },
  ]);
  writeTranscriptFile(
    userDataDir,
    stem,
    [
      '[00:10] [You] the longest turn in the meeting',
      '',
      '[01:00] [You] a short interjection',
      '',
      '[02:00] [You] the middle length turn',
      '',
      '[03:20] [Speaker 3] someone else entirely',
    ].join('\n'),
  );
}

/** The same meeting WITHOUT a turn manifest -- the shape every sidecar
 * written by backfill-speaker-embeddings has. Excerpt text is withheld
 * entirely for these, because the transcript's timestamps came from a
 * different diarization run than these segments. */
function seedMeetingWithoutManifest(userDataDir: string, stem: string) {
  seedMeeting(userDataDir, stem);
  const sidecarPath = path.join(userDataDir, 'output', `${stem}_speakers.json`);
  const sidecar = readJson(sidecarPath);
  delete sidecar.transcript_lines;
  writeFileSync(sidecarPath, JSON.stringify(sidecar, null, 2));
}

test('a marked cluster is withheld from naming, refused by confirm, and raises the minimum speaker count', async ({
  launchApp,
  userDataDir,
}) => {
  const realDirBefore = fileSig(realUserDataDir());
  const stem = 'e2e-multi-marking';
  seedMeeting(userDataDir, stem);

  const { page } = await launchApp();

  // Baseline: unmarked, both clusters are ordinary review rows.
  const before = await page.evaluate(
    (s) => (window as StenoWindow).stenoai.speakers.suggestForMeeting(s), stem,
  );
  expect(before.success).toBe(true);
  expect(before.channels.system.SPEAKER_0.contains_multiple_speakers).toBe(false);
  expect(before.minimum_speaker_count).toBe(2);

  const marked = await page.evaluate(
    (params) => (window as StenoWindow).stenoai.speakers.markCluster(params),
    { meetingStem: stem, channel: 'system', diarizationSpeakerId: 'SPEAKER_0', expectedRunId: fixtureDiarizationRunId(stem), containsMultipleSpeakers: true },
  );
  expect(marked.success).toBe(true);
  expect(marked.contains_multiple_speakers).toBe(true);
  // Two clusters, one of them known to hold at least two people.
  expect(marked.minimum_speaker_count).toBe(3);

  // It landed in the sidecar itself, not somewhere parallel that a
  // re-read could miss.
  const sidecarPath = path.join(userDataDir, 'output', `${stem}_speakers.json`);
  await expect.poll(() =>
    readJson(sidecarPath).channels.system.clusters.SPEAKER_0.contains_multiple_speakers,
  ).toBe(true);
  // And the embeddings the sidecar exists to carry survived the rewrite --
  // once the audio is gone they cannot be recomputed.
  expect(readJson(sidecarPath).channels.system.clusters.SPEAKER_0.embedding).toEqual([1.0, 0.0]);

  const after = await page.evaluate(
    (s) => (window as StenoWindow).stenoai.speakers.suggestForMeeting(s), stem,
  );
  const row = after.channels.system.SPEAKER_0;
  expect(row.contains_multiple_speakers).toBe(true);
  expect(row.status).toBe('none');
  // No candidates either: a ranking from a blended centroid is a confident
  // guess about a voice that does not exist, and offering it in a picker
  // would invite the exact confirmation this marking prevents.
  expect(row.candidates).toEqual([]);
  expect(after.minimum_speaker_count).toBe(3);

  // THE POINT: the backend refuses to enroll it, so no blended voiceprint
  // can reach config.json to degrade suggestions in unrelated meetings.
  const refused = await page.evaluate(
    (params) => (window as StenoWindow).stenoai.speakers.confirm(params),
    { meetingStem: stem, channel: 'system', diarizationSpeakerId: 'SPEAKER_0', expectedRunId: fixtureDiarizationRunId(stem), newPersonName: 'Person Alpha' },
  );
  expect(refused.success).toBe(false);
  expect(refused.error).toContain('more than one person');

  const configPath = path.join(userDataDir, 'config.json');
  const profiles = (readJson(configPath).person_profiles ?? []) as Array<{ display_name: string }>;
  expect(profiles.find((p) => p.display_name === 'Person Alpha')).toBeUndefined();

  // The unmarked neighbour is unaffected -- marking one row must not cost
  // the others their naming.
  const accepted = await page.evaluate(
    (params) => (window as StenoWindow).stenoai.speakers.confirm(params),
    { meetingStem: stem, channel: 'system', diarizationSpeakerId: 'SPEAKER_1', expectedRunId: fixtureDiarizationRunId(stem), newPersonName: 'Person Gamma' },
  );
  expect(accepted.success).toBe(true);

  // Undo restores an ordinary row (a misclick must be recoverable, and the
  // marked row stays visible in the panel precisely so this is reachable).
  const unmarked = await page.evaluate(
    (params) => (window as StenoWindow).stenoai.speakers.markCluster(params),
    { meetingStem: stem, channel: 'system', diarizationSpeakerId: 'SPEAKER_0', expectedRunId: fixtureDiarizationRunId(stem), containsMultipleSpeakers: false },
  );
  expect(unmarked.success).toBe(true);
  expect(unmarked.minimum_speaker_count).toBe(2);
  await expect.poll(() =>
    'contains_multiple_speakers' in readJson(sidecarPath).channels.system.clusters.SPEAKER_0,
  ).toBe(false);

  expect(fileSig(realUserDataDir())).toEqual(realDirBefore);
});

test('marking a cluster that was already confirmed withdraws the name and its voiceprint', async ({
  launchApp,
  userDataDir,
}) => {
  const realDirBefore = fileSig(realUserDataDir());
  const stem = 'e2e-multi-withdraw';
  seedMeeting(userDataDir, stem);

  const { page } = await launchApp();
  const configPath = path.join(userDataDir, 'config.json');

  // The realistic order: confirm first, then hear the second voice in a
  // later excerpt and realise the cluster is mixed.
  const confirmed = await page.evaluate(
    (params) => (window as StenoWindow).stenoai.speakers.confirm(params),
    { meetingStem: stem, channel: 'system', diarizationSpeakerId: 'SPEAKER_0', expectedRunId: fixtureDiarizationRunId(stem), newPersonName: 'Person Alpha' },
  );
  expect(confirmed.success).toBe(true);
  await expect.poll(() => {
    const profiles = (readJson(configPath).person_profiles ?? []) as Array<{
      display_name: string; prototypes: unknown[];
    }>;
    return profiles.find((p) => p.display_name === 'Person Alpha')?.prototypes.length;
  }).toBe(1);

  const marked = await page.evaluate(
    (params) => (window as StenoWindow).stenoai.speakers.markCluster(params),
    { meetingStem: stem, channel: 'system', diarizationSpeakerId: 'SPEAKER_0', expectedRunId: fixtureDiarizationRunId(stem), containsMultipleSpeakers: true },
  );
  expect(marked.success).toBe(true);
  expect(marked.cleared_confirmation_from).toEqual(['Person Alpha']);

  // If marking only blocked FUTURE confirms, this blended two-voice
  // embedding would stay enrolled as Person Alpha -- the exact state the marking
  // exists to prevent, and still reachable from enroll-self-from-person
  // and from every future suggestion scored against his profile.
  await expect.poll(() => {
    const profiles = (readJson(configPath).person_profiles ?? []) as Array<{
      display_name: string; prototypes: unknown[];
    }>;
    return profiles.find((p) => p.display_name === 'Person Alpha')?.prototypes.length;
  }).toBe(0);

  // Confirming the neighbour afterwards must not pick up negative evidence
  // derived from that mixed cluster.
  const neighbour = await page.evaluate(
    (params) => (window as StenoWindow).stenoai.speakers.confirm(params),
    { meetingStem: stem, channel: 'system', diarizationSpeakerId: 'SPEAKER_1', expectedRunId: fixtureDiarizationRunId(stem), newPersonName: 'Person Gamma' },
  );
  expect(neighbour.success).toBe(true);
  const profiles = (readJson(configPath).person_profiles ?? []) as Array<{
    display_name: string; hard_negatives?: unknown[];
  }>;
  for (const person of profiles) {
    expect(person.hard_negatives ?? []).toEqual([]);
  }

  expect(fileSig(realUserDataDir())).toEqual(realDirBefore);
});

test('a cluster offers several chronological excerpts, and each index plays its own clip', async ({
  launchApp,
  userDataDir,
}) => {
  const realDirBefore = fileSig(realUserDataDir());
  const stem = 'e2e-multi-samples';
  seedMeeting(userDataDir, stem);

  const { page } = await launchApp();

  const result = await page.evaluate(
    (s) => (window as StenoWindow).stenoai.speakers.suggestForMeeting(s), stem,
  );
  const samples = result.channels.system.SPEAKER_0.samples ?? [];
  expect(samples).toHaveLength(3);

  // Chronological, NOT by duration: the longest turn (20s at 00:10) comes
  // first here because it happens first, and the 8s turn at 02:00 comes
  // last. Ordering is a contract -- an index into this list is what
  // getSampleAudio(..., i) plays, so a duration-ordered list would make
  // every play button play a different moment than the text beside it.
  expect(samples.map((s) => s.start)).toEqual([10.0, 60.0, 120.0]);
  // The lines are labeled "You" on purpose. Those are the device owner's
  // own turns, and an earlier version skipped every "You" line, which left
  // the owner's own cluster quoting a DIFFERENT participant -- found on a
  // real three-person call.
  expect(samples.map((s) => s.text)).toEqual([
    'the longest turn in the meeting',
    'a short interjection',
    'the middle length turn',
  ]);

  expect(fileSig(realUserDataDir())).toEqual(realDirBefore);
});

test('without a turn manifest the moments stay playable but carry no attributed text', async ({
  launchApp,
  userDataDir,
}) => {
  const realDirBefore = fileSig(realUserDataDir());
  const stem = 'e2e-multi-nomanifest';
  seedMeetingWithoutManifest(userDataDir, stem);

  const { page } = await launchApp();

  const result = await page.evaluate(
    (s) => (window as StenoWindow).stenoai.speakers.suggestForMeeting(s), stem,
  );
  const row = result.channels.system.SPEAKER_0;
  const samples = row.samples ?? [];

  // Still three moments to listen to -- the timestamps and the audio come
  // from the same run as the segments, so those stay trustworthy.
  expect(samples).toHaveLength(3);
  expect(samples.map((s) => s.start)).toEqual([10.0, 60.0, 120.0]);

  // But no text is attributed. This is the shape every sidecar written by
  // backfill-speaker-embeddings has, and for those the transcript's
  // timestamps came from a different diarization run than these segments.
  // Measured on a real call, matching across the two put another
  // participant's sentences under the owner's own cluster -- so nothing is
  // shown rather than something possibly wrong.
  expect(samples.map((s) => s.text)).toEqual([null, null, null]);
  expect(row.sample_text ?? null).toBeNull();

  expect(fileSig(realUserDataDir())).toEqual(realDirBefore);
});

test('deleting a meeting reports its unnamed speakers and removes its voice-embedding sidecar', async ({
  launchApp,
  userDataDir,
}) => {
  const realDirBefore = fileSig(realUserDataDir());
  const stem = 'e2e-multi-delete';
  seedMeeting(userDataDir, stem);
  const summaryFile = writeMeetingMarkdown(userDataDir, stem, {
    name: 'Deletable meeting',
    summaryMarkdown: '## Summary\n\nA meeting seeded for the delete path.',
    transcript: '[00:10] [Speaker 2] the longest turn in the meeting',
    frontmatter: { is_diarised: true },
  });

  const { page } = await launchApp();

  // Two clusters, neither named yet.
  const status = await page.evaluate(
    (s) => (window as StenoWindow).stenoai.speakers.namingStatus(s), stem,
  );
  expect(status.success).toBe(true);
  expect(status.has_sidecar).toBe(true);
  expect(status.unnamed_clusters).toBe(2);

  // Naming one moves it out of the count. This is the whole distinction the
  // delete warning rests on: a CONFIRMED person outlives the meeting (their
  // prototype is bound to the person in config.json), an unnamed cluster
  // does not and can never be recovered, because naming a voice requires
  // hearing it and the delete takes the audio.
  await page.evaluate(
    (params) => (window as StenoWindow).stenoai.speakers.confirm(params),
    { meetingStem: stem, channel: 'system', diarizationSpeakerId: 'SPEAKER_1', expectedRunId: fixtureDiarizationRunId(stem), newPersonName: 'Person Gamma' },
  );
  await expect.poll(async () =>
    (await page.evaluate(
      (s) => (window as StenoWindow).stenoai.speakers.namingStatus(s), stem,
    )).unnamed_clusters,
  ).toBe(1);

  // The sidecar holds this meeting's raw voice embeddings. It used to be
  // left behind by delete-meeting (same class of miss as the reports
  // sidecar), so a deleted meeting kept its voiceprints on disk.
  const sidecarPath = path.join(userDataDir, 'output', `${stem}_speakers.json`);
  expect(existsSync(sidecarPath)).toBe(true);

  const deleted = await page.evaluate(
    (meeting) => (window as StenoWindow).stenoai.meetings.delete(meeting),
    { session_info: { name: 'Deletable meeting', summary_file: summaryFile } },
  );
  expect(deleted.success).toBe(true);

  // Soft-delete: the sidecar is still there DURING the undo window, which is
  // what lets the toast read the unnamed count while undo is still possible.
  expect(existsSync(sidecarPath)).toBe(true);

  await page.evaluate(
    (id) => (window as StenoWindow).stenoai.meetings.commitDelete(id), deleted.id as string,
  );
  await expect.poll(() => existsSync(sidecarPath)).toBe(false);

  // Person Gamma's voice profile deliberately SURVIVES: it is bound to the person,
  // not the meeting, and is what makes recognition work across recordings.
  const profiles = (readJson(path.join(userDataDir, 'config.json')).person_profiles ?? []) as Array<{
    display_name: string;
    prototypes: unknown[];
  }>;
  expect(profiles.find((p) => p.display_name === 'Person Gamma')?.prototypes).toHaveLength(1);

  expect(fileSig(realUserDataDir())).toEqual(realDirBefore);
});

test('keeping a speaker generic round-trips through the sidecar, and a confirm clears it', async ({
  launchApp,
  userDataDir,
}) => {
  // The standing-rule coverage for the persisted review state: the panel's
  // "Keep generic" used to change nothing outside React, so the only proof
  // that matters is that the marking is on disk and comes back out of a
  // real suggest-speakers. Legacy sidecars remain covered by the backend unit
  // tests; mutations in this E2E use the current run-aware IPC contract.
  const realDirBefore = fileSig(realUserDataDir());
  const stem = 'e2e-review-state';
  seedMeeting(userDataDir, stem);

  const { page } = await launchApp();
  const sidecarPath = path.join(userDataDir, 'output', `${stem}_speakers.json`);

  const before = await page.evaluate(
    (s) => (window as StenoWindow).stenoai.speakers.suggestForMeeting(s), stem,
  );
  expect(before.channels.system.SPEAKER_0.review_state ?? null).toBeNull();

  const marked = await page.evaluate(
    (params) => (window as StenoWindow).stenoai.speakers.setClusterReviewState(params),
    { meetingStem: stem, channel: 'system', diarizationSpeakerId: 'SPEAKER_0', expectedRunId: fixtureDiarizationRunId(stem), generic: true },
  );
  expect(marked.success).toBe(true);
  expect(marked.review_state).toBe('generic');

  // On disk, in the cluster entry itself -- and the embeddings the sidecar
  // exists to carry survived the rewrite.
  await expect
    .poll(() => readJson(sidecarPath).channels.system.clusters.SPEAKER_0.review_state)
    .toBe('generic');
  expect(readJson(sidecarPath).channels.system.clusters.SPEAKER_0.embedding).toEqual([1.0, 0.0]);
  // Written to exactly the cluster it was handed, not smeared across the channel.
  expect(readJson(sidecarPath).channels.system.clusters.SPEAKER_1.review_state).toBeUndefined();

  const after = await page.evaluate(
    (s) => (window as StenoWindow).stenoai.speakers.suggestForMeeting(s), stem,
  );
  expect(after.channels.system.SPEAKER_0.review_state).toBe('generic');

  // Naming the cluster is a stronger statement about it and supersedes the
  // marking -- otherwise the panel would report a confirmed row as parked.
  const confirmed = await page.evaluate(
    (params) => (window as StenoWindow).stenoai.speakers.confirm(params),
    { meetingStem: stem, channel: 'system', diarizationSpeakerId: 'SPEAKER_0', expectedRunId: fixtureDiarizationRunId(stem), newPersonName: 'Ida' },
  );
  expect(confirmed.success).toBe(true);
  await expect
    .poll(() => readJson(sidecarPath).channels.system.clusters.SPEAKER_0.review_state)
    .toBeUndefined();

  // And the explicit undo removes the key rather than storing a null.
  const reMarked = await page.evaluate(
    (params) => (window as StenoWindow).stenoai.speakers.setClusterReviewState(params),
    { meetingStem: stem, channel: 'system', diarizationSpeakerId: 'SPEAKER_1', expectedRunId: fixtureDiarizationRunId(stem), generic: true },
  );
  expect(reMarked.success).toBe(true);
  const cleared = await page.evaluate(
    (params) => (window as StenoWindow).stenoai.speakers.setClusterReviewState(params),
    { meetingStem: stem, channel: 'system', diarizationSpeakerId: 'SPEAKER_1', expectedRunId: fixtureDiarizationRunId(stem), generic: false },
  );
  expect(cleared.success).toBe(true);
  expect(cleared.review_state).toBeNull();
  await expect
    .poll(() => readJson(sidecarPath).channels.system.clusters.SPEAKER_1.review_state)
    .toBeUndefined();

  expect(fileSig(realUserDataDir())).toEqual(realDirBefore);
});
