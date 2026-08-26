import { mkdirSync, writeFileSync, readFileSync, existsSync } from 'fs';
import path from 'path';

/**
 * Shared T2 setup helpers for the core-loop specs. Everything writes into the
 * per-test STENOAI_USER_DATA_DIR temp dir (the isolation keystone) BEFORE launch,
 * mirroring how config-corruption.t2 pre-seeds config.json.
 */

/** Read <userDataDir>/config.json (returns {} if absent/unreadable). */
export function readUserConfig(userDataDir: string): Record<string, unknown> {
  const cfgPath = path.join(userDataDir, 'config.json');
  if (!existsSync(cfgPath)) return {};
  try {
    return JSON.parse(readFileSync(cfgPath, 'utf8')) as Record<string, unknown>;
  } catch {
    return {};
  }
}

/**
 * Merge a partial config into <userDataDir>/config.json, creating it if absent.
 *
 * `privacy_notice_seen` is seeded true because a config.json that exists but
 * lacks the key is treated as an upgrading install (src/config.py
 * `_migrate_privacy_notice_seen`), which pops the one-time privacy modal over
 * the app and intercepts pointer events — a spec that clicks anything then
 * races the dialog. A spec that wants the modal can pass the key as false.
 */
export function writeUserConfig(
  userDataDir: string,
  partial: Record<string, unknown>,
): void {
  const cfgPath = path.join(userDataDir, 'config.json');
  let cfg: Record<string, unknown> = {};
  if (existsSync(cfgPath)) {
    try {
      cfg = JSON.parse(readFileSync(cfgPath, 'utf8')) as Record<string, unknown>;
    } catch {
      cfg = {};
    }
  }
  writeFileSync(
    cfgPath,
    JSON.stringify({ privacy_notice_seen: true, ...cfg, ...partial }, null, 2),
  );
}

/** Explicitly opt a test user into local biometric speaker identification. */
export function enableSpeakerIdentification(userDataDir: string): void {
  writeUserConfig(userDataDir, {
    identity_matching_enabled: true,
    identity_matching_privacy_default_version: 1,
  });
}

/**
 * Configure the app for the renderer-driven capture path (system audio ON) with
 * the Whisper engine, so no Parakeet live-transcribe sidecar spawns. The
 * renderer-driven path is the only recording path now; this sets the recording
 * state machine without loading any model — see app/main.js `start-recording-ui`
 * + `loadTranscriptionEngine`. This is what makes the lifecycle deterministic on
 * a headless CI runner. It still requires `isSystemAudioSupported()` to be true on
 * the host (macOS >= 14.4 / Windows >= 10); the spec guards on that and skips
 * loudly otherwise rather than spawning a real recorder.
 */
export function enableDeterministicRecording(userDataDir: string): void {
  writeUserConfig(userDataDir, {
    system_audio_enabled: true,
    transcription_engine: 'whisper',
  });
}

export interface FixtureMeeting {
  name: string;
  summary?: string;
  participants?: string[];
  key_points?: string[];
  action_items?: string[];
  transcript?: string;
  folders?: string[];
}

/**
 * Write a deterministic `<stem>_summary.json` into <userDataDir>/output so the
 * real backend's `list-meetings` (which globs get_data_dirs()['output']) finds
 * it. Returns the absolute path of the written summary file. Model-free — no
 * transcription/summarisation involved, just a known-good summary document.
 */
export function writeMeetingSummary(
  userDataDir: string,
  stem: string,
  meeting: FixtureMeeting,
): string {
  const outputDir = path.join(userDataDir, 'output');
  mkdirSync(outputDir, { recursive: true });
  const summaryFile = path.join(outputDir, `${stem}_summary.json`);
  const now = new Date().toISOString();
  const data = {
    session_info: {
      name: meeting.name,
      summary_file: summaryFile,
      processed_at: now,
      duration_seconds: 0,
    },
    summary: meeting.summary ?? `Summary for ${meeting.name}`,
    participants: meeting.participants ?? [],
    key_points: meeting.key_points ?? [],
    action_items: meeting.action_items ?? [],
    transcript: meeting.transcript ?? '',
    // Folder membership lives at the TOP level of the summary doc — that's where
    // src/folders.py add_meeting_to_folder writes it and list-meetings reads it.
    folders: meeting.folders ?? [],
  };
  writeFileSync(summaryFile, JSON.stringify(data, null, 2));
  return summaryFile;
}

export interface FixtureMeetingMarkdown {
  name: string;
  summaryMarkdown: string;
  transcript: string;
  notes?: string;
  /**
   * Extra frontmatter keys appended verbatim (e.g. `{ notes_stale: true }`,
   * `{ processing: true }`). Lets a spec seed the optional markers the detail
   * parser must surface into `session_info` without a real record/append run.
   */
  frontmatter?: Record<string, string | number | boolean>;
}

/**
 * Write a deterministic `<stem>_summary.md` into <userDataDir>/output so the
 * real backend's `list-meetings` (which globs get_data_dirs()['output']) finds
 * it.  The format mirrors `simple_recorder._render_frontmatter` + the section
 * layout produced by `process_recording_streaming`:
 *
 *   ---
 *   title: "…"
 *   date: "…"
 *   duration_seconds: 0
 *   language: "en"
 *   is_diarised: false
 *   ---
 *
 *   <summaryMarkdown>
 *
 *   ## Transcript
 *
 *   <transcript>
 *
 *   ## User Notes        ← only when `notes` is provided
 *
 *   <notes>
 *
 * Returns the absolute path of the written summary file.
 */
export function writeMeetingMarkdown(
  userDataDir: string,
  stem: string,
  meeting: FixtureMeetingMarkdown,
): string {
  const outputDir = path.join(userDataDir, 'output');
  mkdirSync(outputDir, { recursive: true });
  const summaryFile = path.join(outputDir, `${stem}_summary.md`);
  const now = new Date().toISOString();

  const escapeYaml = (s: string) => s.replace(/\\/g, '\\\\').replace(/"/g, '\\"');

  const lines: string[] = [
    '---',
    `title: "${escapeYaml(meeting.name)}"`,
    `date: "${now}"`,
    `duration_seconds: 0`,
    `language: "en"`,
    `is_diarised: false`,
    ...Object.entries(meeting.frontmatter ?? {}).map(([k, v]) =>
      typeof v === 'string' ? `${k}: "${escapeYaml(v)}"` : `${k}: ${v}`,
    ),
    '---',
    '',
    meeting.summaryMarkdown,
    '',
    '## Transcript',
    '',
    meeting.transcript,
  ];

  if (meeting.notes) {
    lines.push('', '## User Notes', '', meeting.notes);
  }

  writeFileSync(summaryFile, lines.join('\n'));
  return summaryFile;
}

export interface FixtureSpeakerCluster {
  embedding: number[];
  speech_duration_seconds: number;
  segment_count: number;
  segments: Array<{ start: number; end: number }>;
}

/**
 * Write a deterministic `<stem>_speakers.json` sidecar into
 * <userDataDir>/output, mirroring src.speaker_suggestions.write_speakers_sidecar's
 * JSON shape exactly: `{meeting_id, created_at, diarization_run, channels: {mic|system: {recording_type,
 * clusters: {sid: {embedding, speech_duration_seconds, segment_count, segments}}}}}`.
 * Model-free -- no real diarizer/embedding extraction involved, just a
 * known-good sidecar so suggest-speakers/confirm-speaker have real data to
 * read. Returns the absolute path of the written sidecar.
 */
export interface FixtureTurnManifestEntry {
  start: number;
  channel: string;
  diarization_speaker_id: string;
}

export function fixtureDiarizationRunId(stem: string): string {
  return `${stem}-fixture-run`;
}

export function writeSpeakersSidecar(
  userDataDir: string,
  stem: string,
  channels: Record<string, { recording_type: string; clusters: Record<string, FixtureSpeakerCluster> }>,
  turnManifest?: FixtureTurnManifestEntry[],
): string {
  const outputDir = path.join(userDataDir, 'output');
  mkdirSync(outputDir, { recursive: true });
  const sidecarFile = path.join(outputDir, `${stem}_speakers.json`);
  const data: Record<string, unknown> = {
    meeting_id: stem,
    created_at: Date.now() / 1000,
    diarization_run: {
      run_id: fixtureDiarizationRunId(stem),
      created_at: Date.now() / 1000,
    },
    channels,
  };
  // Omitted (not written empty) when absent, exactly like the real writer --
  // and the distinction MATTERS: without a manifest the backend attributes
  // no excerpt text at all, because a backfilled sidecar's segments come
  // from a different diarization run than the transcript's timestamps.
  if (turnManifest && turnManifest.length > 0) data.transcript_lines = turnManifest;
  writeFileSync(sidecarFile, JSON.stringify(data, null, 2));
  return sidecarFile;
}

/**
 * Write a deterministic `<stem>_transcript.txt` into <userDataDir>/transcripts,
 * mirroring simple_recorder.py's `_write_transcript_file` body shape closely
 * enough for relabel_transcript_speaker's `[MM:SS] [Label] text` line parser
 * (the header lines above the "====" separator are never parsed, only
 * skipped). `body` should already contain the diarised `[MM:SS] [Label] text`
 * lines, blank-line-separated, matching `_tag_channel_segments`'s output.
 * Returns the absolute path of the written transcript file.
 */
export function writeTranscriptFile(userDataDir: string, stem: string, body: string): string {
  const transcriptsDir = path.join(userDataDir, 'transcripts');
  mkdirSync(transcriptsDir, { recursive: true });
  const transcriptFile = path.join(transcriptsDir, `${stem}_transcript.txt`);
  const content = `Session: ${stem}\nFile: ${stem}.webm\nDate: 2026-01-01 00:00:00\n\n${'='.repeat(60)}\n\n${body}\n`;
  writeFileSync(transcriptFile, content);
  return transcriptFile;
}
