import { test, expect } from '../fixtures/electron';
import {
  enableSpeakerIdentification,
  writeUserConfig,
  writeMeetingMarkdown,
  writeSpeakersSidecar,
} from '../fixtures/user-config';

/**
 * T2 -- #585. The Speakers review section must appear in a note that is
 * already open when processing finishes, without leaving the note. The
 * speaker sidecar only exists once processing has written it, so the open
 * note's first detail fetch reports has_speaker_sidecar: false; the
 * processing-complete event is what has to bring the panel in.
 *
 * Model-free: the note and the sidecar are seeded on disk and the completion
 * event is sent the way main sends it, so the real get-meeting and
 * suggest-speakers backend paths decide what the panel shows.
 */

test('the Speakers section appears in the open note when processing completes', async ({
  launchApp,
  userDataDir,
}) => {
  const stem = 'e2e-speakers-after-processing';
  enableSpeakerIdentification(userDataDir);
  writeUserConfig(userDataDir, { privacy_notice_seen: true });
  const summaryFile = writeMeetingMarkdown(userDataDir, stem, {
    name: 'Speakers after processing',
    summaryMarkdown: '## Summary\n\nA meeting whose speakers arrive with processing.',
    transcript: '[00:10] [Speaker 2] the first turn\n\n[03:20] [Speaker 3] the second turn',
    frontmatter: { is_diarised: true },
  });

  const { app, page } = await launchApp({ releaseHighlightsSeen: true });
  await page.evaluate((f) => {
    window.location.hash = `#/meetings/${encodeURIComponent(f)}`;
  }, summaryFile);
  await expect(page.getByTestId('meeting-detail-title')).toContainText('Speakers after processing');
  await expect(page.getByTestId('speaker-review-panel')).toHaveCount(0);
  const before = await page.evaluate(async (file) =>
    (window as any).stenoai.meetings.get(file), summaryFile);
  expect(before.meeting.has_speaker_sidecar).toBe(false);

  // Processing writes the sidecar, then main reports completion.
  writeSpeakersSidecar(userDataDir, stem, {
    system: {
      recording_type: 'remote',
      clusters: {
        SPEAKER_0: {
          embedding: [1.0, 0.0],
          speech_duration_seconds: 60.0,
          segment_count: 1,
          segments: [{ start: 10.0, end: 30.0 }],
        },
        SPEAKER_1: {
          embedding: [0.0, 1.0],
          speech_duration_seconds: 40.0,
          segment_count: 1,
          segments: [{ start: 200.0, end: 210.0 }],
        },
      },
    },
  });
  // Main attaches the note as list-meetings returns it.
  const meetingData = await page.evaluate(async (file) => {
    const res = await (window as any).stenoai.meetings.list();
    const list = (res.meetings ?? res) as Array<{ session_info: { summary_file: string } }>;
    return list.find((m) => m.session_info.summary_file === file) ?? null;
  }, summaryFile);
  expect(meetingData).not.toBeNull();
  await app.evaluate(({ BrowserWindow }, { file, data }) => {
    const main = BrowserWindow.getAllWindows().find((w) => !w.webContents.getURL().includes('#/notification'));
    main!.webContents.send('processing-complete', {
      success: true,
      sessionName: 'Speakers after processing',
      summaryFile: file,
      meetingData: data,
      notesGenerated: true,
    });
  }, { file: summaryFile, data: meetingData });

  await expect(page.getByTestId('speaker-review-panel')).toBeVisible({ timeout: 10_000 });
  const after = await page.evaluate(async (file) =>
    (window as any).stenoai.meetings.get(file), summaryFile);
  expect(after.meeting.has_speaker_sidecar).toBe(true);
  const suggestions = await page.evaluate(async (meetingStem) =>
    (window as any).stenoai.speakers.suggestForMeeting(meetingStem), stem);
  expect(Object.keys(suggestions.channels.system)).toEqual(['SPEAKER_0', 'SPEAKER_1']);
});

test('processing completion refreshes cached speaker suggestions in the open note', async ({
  launchApp,
  userDataDir,
}) => {
  const stem = 'e2e-speakers-refreshed-analysis';
  enableSpeakerIdentification(userDataDir);
  writeUserConfig(userDataDir, { privacy_notice_seen: true });
  const summaryFile = writeMeetingMarkdown(userDataDir, stem, {
    name: 'Refreshed speaker analysis',
    summaryMarkdown: '## Summary\n\nThe speaker analysis is still being prepared.',
    transcript: '[00:10] [Speaker 2] first turn\n\n[03:20] [Speaker 3] second turn',
    frontmatter: { is_diarised: true },
  });
  writeSpeakersSidecar(userDataDir, stem, {
    system: {
      recording_type: 'remote',
      clusters: {
        SPEAKER_0: {
          embedding: [1, 0], speech_duration_seconds: 60,
          segment_count: 1, segments: [{ start: 10, end: 30 }],
        },
      },
    },
  });

  const { app, page } = await launchApp({ releaseHighlightsSeen: true });
  await page.evaluate((file) => {
    window.location.hash = `#/meetings/${encodeURIComponent(file)}`;
  }, summaryFile);
  await expect(page.getByTestId('meeting-detail-title')).toContainText('Refreshed speaker analysis');
  await expect(page.getByTestId('speaker-review-panel')).toBeVisible();
  await page.getByTestId('speaker-toggle-filtered').click();
  await expect(page.getByTestId('speaker-row-system:SPEAKER_0')).toBeVisible();
  await expect(page.getByTestId('speaker-row-system:SPEAKER_1')).toHaveCount(0);

  writeSpeakersSidecar(userDataDir, stem, {
    system: {
      recording_type: 'remote',
      clusters: {
        SPEAKER_0: {
          embedding: [1, 0], speech_duration_seconds: 60,
          segment_count: 1, segments: [{ start: 10, end: 30 }],
        },
        SPEAKER_1: {
          embedding: [0, 1], speech_duration_seconds: 40,
          segment_count: 1, segments: [{ start: 200, end: 210 }],
        },
      },
    },
  });
  const meetingData = await page.evaluate(async (file) => {
    const res = await (window as any).stenoai.meetings.list();
    const list = (res.meetings ?? res) as Array<{ session_info: { summary_file: string } }>;
    return list.find((meeting) => meeting.session_info.summary_file === file) ?? null;
  }, summaryFile);
  expect(meetingData).not.toBeNull();
  await app.evaluate(({ BrowserWindow }, { file, data }) => {
    const main = BrowserWindow.getAllWindows().find((w) => !w.webContents.getURL().includes('#/notification'));
    main!.webContents.send('processing-complete', {
      success: true, sessionName: 'Refreshed speaker analysis',
      summaryFile: file, meetingData: data, notesGenerated: true,
    });
  }, { file: summaryFile, data: meetingData });

  await expect(page.getByTestId('speaker-row-system:SPEAKER_1')).toBeVisible();
});
