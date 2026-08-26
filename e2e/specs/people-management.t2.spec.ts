import { test, expect } from '../fixtures/electron';
import { realUserDataDir, fileSig } from '../fixtures/real-user-data';
import { makeWav } from '../fixtures/make-wav';
import {
  enableSpeakerIdentification,
  fixtureDiarizationRunId,
  writeSpeakersSidecar,
} from '../fixtures/user-config';
import { readFileSync, mkdirSync } from 'fs';
import path from 'path';

type ProfileMutationResult = {
  success: boolean;
  person_id?: string;
  display_name?: string;
  error?: string;
};

type StenoWindow = Window & {
  stenoai: {
    speakers: {
      createProfile: (displayName: string) => Promise<ProfileMutationResult>;
      confirm: (params: {
        meetingStem: string;
        channel: string;
        diarizationSpeakerId: string;
        expectedRunId: string;
        newPersonName: string;
      }) => Promise<ProfileMutationResult>;
      listProfiles: () => Promise<{
        success: boolean;
        person_profiles?: Array<{
          person_id: string;
          display_name: string;
          sample_available: boolean;
        }>;
      }>;
      getPersonSampleAudio: (
        personId: string,
      ) => Promise<{ success: boolean; error?: string; audio_base64?: string }>;
    };
  };
};

function storedProfileNames(configPath: string): string[] {
  try {
    const config = JSON.parse(readFileSync(configPath, 'utf8')) as {
      person_profiles?: Array<{ display_name: string }>;
    };
    return (config.person_profiles ?? []).map((profile) => profile.display_name).sort();
  } catch {
    return [];
  }
}

test('People settings sorts profiles and deletes one through the real backend', async ({
  launchApp,
  userDataDir,
}) => {
  const realDirBefore = fileSig(realUserDataDir());
  const configPath = path.join(userDataDir, 'config.json');
  const { page } = await launchApp();

  const zora = await page.evaluate(() =>
    (window as StenoWindow).stenoai.speakers.createProfile('Zora Quinn'),
  );
  const ada = await page.evaluate(() =>
    (window as StenoWindow).stenoai.speakers.createProfile('Ada Lovelace'),
  );
  expect(zora.success).toBe(true);
  expect(ada.success).toBe(true);

  await page.evaluate(() => {
    window.location.hash = '#/settings?tab=people';
  });

  const people = page.getByTestId('people-tab');
  await expect(people).toBeVisible();
  await expect(
    page.getByText(
      'Deleting a profile stops future matching but does not delete recordings or transcripts.',
    ),
  ).toBeVisible();

  const rows = people.locator(':scope > div');
  await expect(rows).toHaveCount(2);
  await expect(rows.nth(0)).toContainText('Ada Lovelace');
  await expect(rows.nth(1)).toContainText('Zora Quinn');
  await expect(
    people.getByText('No voice samples yet - Steno cannot recognise them automatically.'),
  ).toHaveCount(2);

  await page.getByTestId(`people-delete-${ada.person_id}`).click();
  const confirmDialog = page.locator('[data-confirm-dialog]');
  await expect(confirmDialog).toContainText('Delete Ada Lovelace?');
  await expect(confirmDialog).toContainText("This removes them from every meeting's speaker suggestions");
  await expect(confirmDialog).toContainText("This can't be undone.");
  await confirmDialog.getByRole('button', { name: 'Delete' }).click();
  await expect(confirmDialog).toHaveCount(0);

  await expect.poll(() => storedProfileNames(configPath)).toEqual(['Zora Quinn']);
  await expect(people).not.toContainText('Ada Lovelace');
  await expect(people).toContainText('Zora Quinn');

  expect(fileSig(realUserDataDir())).toBe(realDirBefore);
});

test('People sample playback extracts a current confirmed voice through the bundled backend', async ({
  launchApp,
  userDataDir,
}) => {
  const realDirBefore = fileSig(realUserDataDir());
  const stem = 'e2e-person-sample';
  const recordingsDir = path.join(userDataDir, 'recordings');
  mkdirSync(recordingsDir, { recursive: true });
  makeWav(path.join(recordingsDir, `${stem}.wav`), { seconds: 3, channels: 2 });

  const sidecarPath = writeSpeakersSidecar(userDataDir, stem, {
    mic: {
      recording_type: 'in_person',
      clusters: {
        SPEAKER_0: {
          embedding: [1.0, 0.0],
          speech_duration_seconds: 2.0,
          segment_count: 1,
          segments: [{ start: 0.5, end: 2.5 }],
        },
      },
    },
  });
  enableSpeakerIdentification(userDataDir);

  const { page } = await launchApp();
  const confirmed = await page.evaluate(
    (params) => (window as StenoWindow).stenoai.speakers.confirm(params),
    {
      meetingStem: stem,
      channel: 'mic',
      diarizationSpeakerId: 'SPEAKER_0',
      expectedRunId: fixtureDiarizationRunId(stem),
      newPersonName: 'Sample Person',
    },
  );
  expect(confirmed.success).toBe(true);

  const profiles = await page.evaluate(() =>
    (window as StenoWindow).stenoai.speakers.listProfiles(),
  );
  expect(profiles.success).toBe(true);
  const profile = profiles.person_profiles?.find((entry) => entry.person_id === confirmed.person_id);
  expect(profile).toMatchObject({
    display_name: 'Sample Person',
    sample_available: true,
  });
  expect(profile).not.toHaveProperty('meeting_id');
  expect(profile).not.toHaveProperty('channel');
  expect(profile).not.toHaveProperty('diarization_speaker_id');
  expect(profile).not.toHaveProperty('recording_path');
  expect(profile).not.toHaveProperty('prototypes');
  expect(profile).not.toHaveProperty('embedding');

  const sample = await page.evaluate(
    (personId) => (window as StenoWindow).stenoai.speakers.getPersonSampleAudio(personId),
    confirmed.person_id as string,
  );
  expect(sample.success).toBe(true);
  const bytes = Buffer.from(sample.audio_base64 as string, 'base64');
  expect(bytes.subarray(0, 4).toString('ascii')).toBe('RIFF');
  expect(bytes.subarray(8, 12).toString('ascii')).toBe('WAVE');
  expect(bytes.length).toBeGreaterThan(44);

  expect(fileSig(realUserDataDir())).toBe(realDirBefore);
});
