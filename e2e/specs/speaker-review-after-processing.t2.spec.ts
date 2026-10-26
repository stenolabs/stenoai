import { test, expect } from '../fixtures/electron';
import { existsSync, readdirSync, statSync, writeFileSync } from 'fs';
import path from 'path';
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

test('a live note becomes a processing placeholder, then shows its completed speaker review', async ({
  launchApp,
  userDataDir,
}) => {
  test.setTimeout(60_000);
  enableSpeakerIdentification(userDataDir);
  writeUserConfig(userDataDir, {
    privacy_notice_seen: true,
    transcription_engine: 'parakeet',
    system_audio_enabled: true,
    auto_summarize_enabled: false,
  });
  const readyFile = path.join(userDataDir, 'fake-processing-ready');
  const finishFile = path.join(userDataDir, 'finish-fake-processing');
  const { app, page } = await launchApp({ fakeAudio: true, releaseHighlightsSeen: true });

  // The real capture state machine writes the instant-stop placeholder. Only
  // its ASR and batch subprocesses are replaced with deterministic producers:
  // no model, service, real microphone, or existing user data participates.
  await app.evaluate((_electron, files: { readyFile: string; finishFile: string; userDataDir: string }) => {
    const { ChildProcess } = process.getBuiltinModule('child_process');
    const nodePath = process.getBuiltinModule('path');
    const original = ChildProcess.prototype.spawn;
    ChildProcess.prototype.spawn = function (options: any) {
      if (options.args?.includes('transcribe-stream')) {
        (global as any).__emitSpeakerLiveTurn = () => {
          this.stdout.emit('data', Buffer.from('LIVE_SEG:' + JSON.stringify({
            text: 'Synthetic first speaker turn', start: 0, end: 3,
            is_final: true, speaker: 'Others',
          }) + '\n'));
        };
        options.file = process.execPath;
        options.args = [process.execPath, '-e',
          "console.log('LIVE_READY:ok'); process.stdin.resume(); process.stdin.on('end',()=>process.exit(0));"];
        options.envPairs = options.envPairs.filter((p: string) => !p.startsWith('ELECTRON_RUN_AS_NODE='));
        options.envPairs.push('ELECTRON_RUN_AS_NODE=1');
      } else if (options.args?.includes('process-streaming')) {
        const audioFile = options.args[1] as string;
        const stem = nodePath.basename(audioFile, nodePath.extname(audioFile));
        const summaryFile = nodePath.join(files.userDataDir, 'output', `${stem}_summary.md`);
        const script = `const fs=require('fs'), path=require('path');
          const [ready,finish,summary]=process.argv.slice(1);
          const watcher=fs.watch(path.dirname(finish),(_event,name)=>{
            if (name !== path.basename(finish) || !fs.existsSync(finish)) return;
            watcher.close();
            console.log('SAVED:'+summary);
            console.log('STREAM_COMPLETE');
            process.exit(0);
          });
          fs.writeFileSync(ready,'ready');
        `;
        options.file = process.execPath;
        options.args = [process.execPath, '-e', script, files.readyFile, files.finishFile, summaryFile];
        options.envPairs = options.envPairs.filter((p: string) => !p.startsWith('ELECTRON_RUN_AS_NODE='));
        options.envPairs.push('ELECTRON_RUN_AS_NODE=1');
      }
      return original.call(this, options);
    };
  }, { readyFile, finishFile, userDataDir });

  const start = await page.evaluate(() => window.stenoai.recording.start('Synthetic Speakers'));
  expect(start.success).toBe(true);
  await expect.poll(async () => {
    const queue = await page.evaluate(() => window.stenoai.recording.getQueue());
    return queue.hasRecording;
  }).toBe(true);
  await app.evaluate(() => (global as any).__emitSpeakerLiveTurn());
  await expect.poll(async () => {
    const state = await page.evaluate(() => window.stenoai.liveTranscript.getState());
    return state.success && state.segments.some((segment) => segment.isFinal);
  }).toBe(true);
  await expect.poll(() => {
    const recordingsDir = path.join(userDataDir, 'recordings');
    if (!existsSync(recordingsDir)) return false;
    return readdirSync(recordingsDir).some((name) =>
      name.endsWith('.webm') && statSync(path.join(recordingsDir, name)).size > 0);
  }).toBe(true);

  await page.getByRole('button', { name: 'Stop recording' }).first().click();
  await expect.poll(() => existsSync(readyFile)).toBe(true);
  const queue = await page.evaluate(() => window.stenoai.recording.getQueue());
  expect(queue.isProcessing).toBe(true);
  const summaryFile = queue.liveSummaryFile;
  expect(summaryFile).toMatch(/_summary\.md$/);
  if (!summaryFile) throw new Error('instant-stop note path missing');
  await expect.poll(async () => {
    const res = await page.evaluate((file) => window.stenoai.meetings.get(file), summaryFile);
    return res.success && res.meeting?.session_info.processing === true && res.meeting.has_speaker_sidecar === false;
  }).toBe(true);
  await expect(page.getByTestId('meeting-detail-title')).toContainText('Synthetic Speakers');
  await expect(page.getByTestId('speaker-review-panel')).toHaveCount(0);
  const routeAtStop = await page.evaluate(() => window.location.hash);
  const stem = path.basename(summaryFile).replace(/_summary\.md$/, '');

  writeMeetingMarkdown(userDataDir, stem, {
    name: 'Synthetic Speakers', summaryMarkdown: '## Summary\n\nFinished synthetic note.',
    transcript: '[00:10] [Speaker 2] first turn\n\n[03:20] [Speaker 3] second turn',
    frontmatter: { is_diarised: true },
  });
  writeSpeakersSidecar(userDataDir, stem, {
    system: {
      recording_type: 'remote',
      clusters: {
        SPEAKER_0: { embedding: [1, 0], speech_duration_seconds: 60,
          segment_count: 1, segments: [{ start: 10, end: 30 }] },
        SPEAKER_1: { embedding: [0, 1], speech_duration_seconds: 40,
          segment_count: 1, segments: [{ start: 200, end: 210 }] },
      },
    },
  });
  writeFileSync(finishFile, 'complete');
  await expect(page.getByTestId('speaker-review-panel')).toBeVisible();
  await expect.poll(async () => {
    const status = await page.evaluate(() => window.stenoai.recording.getQueue());
    return status.isProcessing;
  }).toBe(false);
  await expect(page.getByTestId('speaker-review-panel')).toBeVisible();
  expect(await page.evaluate(() => window.location.hash)).toBe(routeAtStop);
  const detail = await page.evaluate((file) => window.stenoai.meetings.get(file), summaryFile);
  expect(detail.meeting?.has_speaker_sidecar).toBe(true);
  const suggestions = await page.evaluate((meetingStem) =>
    window.stenoai.speakers.suggestForMeeting(meetingStem), stem);
  expect(Object.keys(suggestions.channels.system)).toEqual(['SPEAKER_0', 'SPEAKER_1']);
});
