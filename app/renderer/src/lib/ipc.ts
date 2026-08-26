/**
 * Typed wrapper over `window.stenoai` — the contextBridge surface defined in
 * `app/preload.js`. All hooks/components talk to this module; no direct
 * `ipcRenderer` usage in renderer code.
 *
 * The source of truth for the shape is `app/preload.js`; keep this typed
 * mirror in sync with it. The channel contract across preload, main.js, this
 * file and the e2e mock is enforced by `app/ipc-contract.test.js`.
 */

// ---------- shared result envelope ----------
export type Result<T> = ({ success: true } & T) | {
  success: false;
  error: string;
  error_code?: string;
};

// ---------- domain types ----------
export interface SessionInfo {
  name: string;
  summary_file: string;
  transcript_file?: string;
  audio_file?: string;
  processed_at?: string;
  updated_at?: string;
  duration_seconds?: number;
  folders?: string[];
  /** Set when transcription crashed (e.g. an OOM): the recording was
   *  preserved instead of deleted and no real summary exists. The detail
   *  view renders an honest failure state instead of an empty note. */
  transcription_failed?: boolean;
  reprocessable?: boolean;
  error?: string;
  /** Set to false when the meeting has a transcript but notes were not
   *  generated automatically (auto-summarize off, #258). The detail view
   *  offers a "Generate notes" CTA instead of a blank/"no summary" state. */
  notes_generated?: boolean;
  /** Set when a continue-recording segment was appended to this note after
   *  its notes were generated: the summary no longer covers the full
   *  transcript. The UI offers the "Generate notes" CTA; reprocess clears it. */
  notes_stale?: boolean;
  /** Instant-stop placeholder: the note was written from the live transcript
   *  at stop and the batch transcribe/summarise is still upgrading it in the
   *  background. The detail view shows a quiet "finishing up" affordance; the
   *  pipeline clears it (on success by rewriting fresh; on failure/startup via
   *  a sweep). */
  processing?: boolean;
  /** Set when the batch transcription came back empty and the note's transcript
   *  was rescued from the live capture instead (#207). Both parsers surface it;
   *  the UI can note that no batch transcript exists. */
  is_live_transcript?: boolean;
}

export interface Meeting {
  session_info: SessionInfo;
  summary: string;
  participants?: unknown[];
  discussion_areas?: unknown[];
  key_points?: string[];
  action_items?: unknown[];
  transcript?: string;
  is_diarised?: boolean;
  /** Whether a per-meeting speaker sidecar exists. The detail view uses this
   *  to avoid spawning two speaker backend reads for ordinary notes. */
  has_speaker_sidecar?: boolean;
  diarised_text?: string | null;
  folders?: string[];
  /** Whether the ORIGINAL recording is still on disk (list-meetings only —
   *  derived from one directory listing, extension-agnostic). keep_recordings
   *  defaults off, so this is false for most notes, and everything that needs
   *  the audio (re-transcribe, speaker samples, any future re-diarization) is
   *  quietly unavailable without it. */
  has_audio?: boolean;
  /** User notes as persisted + returned by the backend (`_parse_meeting_markdown` -> `user_notes`). */
  user_notes?: string | null;
  /** Renderer-side notes for the in-progress / draft recording (live + processing views). */
  notes?: string;
  reports?: Report[];
  active_report?: string;
  /** Synthetic flag set by the renderer for the in-progress recording. Never sent by backend. */
  is_recording?: boolean;
  /** Synthetic flag set by the renderer when a recording is in the processing pipeline (post-stop, pre-summary). */
  is_processing?: boolean;
}

export interface Folder {
  id: string;
  name: string;
  color: string;
  order: number;
  icon?: string;
}

export interface ListedModel {
  name: string;
  displayName?: string;
  size_gb?: number;
  installed: boolean;
  current?: boolean;
  deprecated?: boolean;
  description?: string;
  speed?: string;
  quality?: string;
  mlxTag?: string;
  mlxInstalled?: boolean;
  mlxSizeGb?: number;
  ggufInstalled?: boolean;
}

export interface CalendarEvent {
  id: string;
  title: string;
  start: string;
  end: string;
  attendees?: Array<{ email: string; name?: string }>;
  location?: string;
  meeting_url?: string;
  description?: string;
  is_all_day?: boolean;
  response_status?: 'accepted' | 'declined' | 'tentative' | 'needsAction' | 'organizer' | 'unknown';
  color?: string;
}

export interface UpdateMeetingPatch {
  name?: string;
  summary?: string;
  participants?: unknown[];
  key_points?: string[];
  action_items?: unknown[];
  /** The user's own notes (My notes tab). Upserts the `## User Notes` body
   *  section of the .md (or the `user_notes` field of a legacy .json); an
   *  empty string removes the section. */
  user_notes?: string;
}

export interface ChatSessionsBlob {
  sessions: Array<{
    id: string;
    name: string;
    summaryFile?: string;
    messages: Array<{ role: 'user' | 'assistant'; content: string; ts: number }>;
    createdAt: number;
    updatedAt: number;
  }>;
}

// ---------- Org adapter types ----------
export interface OrgUser {
  email: string;
  name: string;
  orgId: string;
}

export interface OrgStatusResponse {
  signedIn: boolean;
  adapterUrl?: string;
  email?: string;
  name?: string;
  orgId?: string;
  /** True if the user has *ever* successfully signed in to an org (on this
   *  install). Persists across sign-outs. Used by the sidebar to decide
   *  whether to surface the "Sign in to org" CTA — personal users who've
   *  never connected to an org don't see clutter; enterprise users get a
   *  one-click recovery path after their first connection. */
  everSignedIn?: boolean;
  /** JWT exp claim (Unix seconds). When signedIn, the renderer schedules a
   *  setTimeout to invalidate this query the instant the token expires —
   *  no polling, no stale UI. Absent on signed-out / malformed responses. */
  exp?: number;
}

export type OrgLoginResponse = Result<{
  signedIn: true;
  adapterUrl: string;
  email: string;
  name: string;
  orgId: string;
}>;

export interface OrgMeetingSummary {
  id: string;
  title: string;
  owner_email: string;
  org_id: string;
  visibility: 'private' | 'org';
  created_at: number;
  has_artifact: boolean;
  /** True when the shared note also has a transcript artifact in S3. Lets
   *  the list view show a "has transcript" affordance without GETting each
   *  meeting individually. */
  has_transcript: boolean;
}

export interface OrgMeeting extends OrgMeetingSummary {
  body: string;
  /** Inlined transcript content. Only present when the meeting was shared
   *  with a transcript (post-v0.3.0 adapter). Missing for older notes. */
  transcript_body?: string;
  download_url?: string;
}

export type OrgListMeetingsResponse = Result<{ meetings: OrgMeetingSummary[] }>;
export type OrgGetMeetingResponse = Result<{ meeting: OrgMeeting }>;

export interface OrgCreateMeetingPayload {
  title: string;
  body?: string;
  visibility?: 'private' | 'org';
  s3_key?: string | null;
}

export interface OrgShareMeetingPayload {
  title: string;
  body: string;
  /** Optional transcript content uploaded as a separate S3 object. Diarised
   *  text (with [You]/[Others] tags) is preferred when available; the
   *  desktop side decides which to send. Empty string skips the second
   *  upload entirely. */
  transcript?: string;
  visibility?: 'private' | 'org';
  /** When present, main records this summary as "backup attempted" so the
   *  auto-backup trigger won't push a duplicate copy on a later reprocess. */
  summaryFile?: string;
}

export type OrgShareMeetingResponse = Result<{ meeting: OrgMeeting; s3_key: string }>;

export interface OrgTryAutoBackupPayload {
  summaryFile: string;
  title: string;
  body: string;
  /** Optional transcript — same semantics as OrgShareMeetingPayload.transcript. */
  transcript?: string;
  visibility?: 'private' | 'org';
}

/** Result of the auto-backup gateway. `attempted` is true only if we
 *  actually performed an upload; otherwise `reason` tells the caller why
 *  we skipped (most are silent — only 'error' / 'upload-failed' surface
 *  in the UI). */
export type OrgTryAutoBackupResponse =
  | { attempted: true; meeting: OrgMeeting; s3_key: string }
  | {
      attempted: false;
      reason:
        | 'not-signed-in'
        | 'disabled'
        | 'already-attempted'
        | 'missing-summary-file'
        | 'missing-title'
        | 'missing-body'
        | 'upload-failed'
        | 'error';
      error?: string;
    };

export type GetOrgAutoBackupResponse = Result<{ org_auto_backup_enabled: boolean }>;
export type SetOrgAutoBackupResponse = Result<{ org_auto_backup_enabled: boolean }>;

/** Enterprise policy published by the adapter (GET /policy). The desktop
 *  honors these in the UI; the adapter also enforces shared_notes_enabled
 *  server-side (a disabled feature collapses /meetings to owner-only). */
export interface OrgPolicy {
  /** Initial on-state for the auto-backup toggle, seeded on first sign-in. */
  auto_share_default: boolean;
  /** When false, hide the Shared notes tab + cross-folder chat. */
  shared_notes_enabled: boolean;
}

export type GetOrgPolicyResponse = Result<{ policy: OrgPolicy }>;

export type OrgGetBackupStateResponse = Result<{
  shared: boolean;
  meeting_id: string | null;
  attempted_at: string | null;
  /** ISO timestamp of the last upload failure for this note, or null. Set
   *  independently of `shared` so a never-shared note can still report a
   *  failed backup attempt; cleared once a share/backup actually lands. */
  failed_at: string | null;
  /** Truncated error message from the last failed backup, or null. */
  error: string | null;
}>;

/** Outcome from `org.unshareBySummary`. `adapter_status` tells you which
 *  branch ran so the renderer can word the toast — `deleted` is the happy
 *  path, `already-gone` means the org-side meeting was 404 (someone else
 *  deleted it; we still clear the local flag), `no-meeting-id` means the
 *  local flag was orphaned with no `meeting_id` to delete. */
export type OrgUnshareBySummaryResponse = Result<{
  meeting_id: string | null;
  adapter_status: 'deleted' | 'already-gone' | 'no-meeting-id';
}>;

export interface OrgChatPayload {
  messages: Array<{ role: 'user' | 'assistant'; content: string }>;
  system?: string;
  model?: string;
  max_tokens?: number;
}

export type OrgChatResponse = Result<{
  reply: string;
  model: string;
  input_tokens: number;
  output_tokens: number;
}>;

export type MicPermissionStatus =
  | 'granted'
  | 'denied'
  | 'restricted'
  | 'not-determined'
  | 'unknown';

export type AiProvider = 'local' | 'remote' | 'cloud' | 'adapter';
export type CloudProvider = 'openai' | 'anthropic' | 'bedrock' | 'custom';

// ---------- response envelopes ----------
export type AppVersionResponse = Result<{ version: string; name: string }>;
export type StatusResponse = Result<{ status: string; details?: unknown }>;
export type SetupCheckStatus = 'pass' | 'fail' | 'warn';
export interface SetupCheckItem {
  /** Bare check name, e.g. "Python", "ffmpeg", "recordings/". */
  name: string;
  /** true unless the check failed; warnings are still ok. */
  ok: boolean;
  status: SetupCheckStatus;
  /** Human-readable detail, e.g. "3.11.5" or "not found - run: brew install ffmpeg". */
  detail: string;
}
export type SetupCheckResponse = Result<{
  allGood: boolean;
  checks: SetupCheckItem[];
}>;
export type SpeakerModelStatusResponse = Result<{
  ready: boolean;
  cache_directory: string;
  required_models: string[];
  missing_models: string[];
}>;

export type MicPermissionResponse = Result<{ status: MicPermissionStatus }>;
export type MicPermissionGrantResponse = Result<{ granted: boolean }>;

/** Mirrors RECORDING_TRIGGERS in main.js -- what UI action started the
 *  recording, so PostHog can tell whether the meeting-detected nudge
 *  actually moves the needle. */
export type RecordingTrigger = 'manual' | 'notification_click' | 'hotkey' | 'tray' | 'url_scheme';

/** Mirrors TELEMETRY_TOGGLE_SOURCES in main.js -- which UI surface the
 *  telemetry toggle was flipped from. 'setup' names the Setup.tsx screen,
 *  not a lifecycle stage: it's also reachable later via "run setup wizard"
 *  from Settings, so this does not mean "first run". */
export type TelemetryToggleSource = 'setup' | 'settings' | 'consent';

export type StartRecordingResponse = Result<{ message: string; sessionName?: string }>;
export type StopRecordingResponse = Result<{
  message: string;
  sessionName?: string;
  /** Instant stop: the note written from the live transcript at stop (or the
   *  continued note). The renderer navigates straight to it; absent for
   *  Whisper/import, which use the processing dock. */
  summaryFile?: string | null;
}>;
export type PauseRecordingResponse = Result<{ message: string }>;
export type ResumeRecordingResponse = Result<{ message: string }>;

export interface QueueStatus {
  success: true;
  isProcessing: boolean;
  queueSize: number;
  currentJob: string | null;
  /** Side-channel tracking for in-flight `reprocess-meeting` invocations,
   *  which don't go through `processingQueue` / `currentJob`. Populated
   *  by the reprocess IPC for the lifetime of each spawned Python
   *  subprocess and cleared in its finally block. Keyed by summaryFile
   *  in main so overlapping reprocesses coexist (e.g. user reprocesses A,
   *  navigates to B, reprocesses B before A finishes). Renderer consumers
   *  use this to flag the matching existing meeting rows as in-progress
   *  on Home. Empty array (not undefined) when no reprocess is active. */
  currentReprocesses: Array<{ summaryFile: string; sessionName: string | null }>;
  hasRecording: boolean;
  isPaused: boolean;
  elapsedSeconds: number;
  sessionName: string | null;
  /** The note (summary-file realpath) an active continue/resume is recording
   *  INTO — lets a detail view tell "recording this note" from "recording a
   *  different one" by identity rather than the collidable display name. Null
   *  for a fresh new-note recording or when idle. */
  recordingSummaryFile?: string | null;
  /** The real note file the current recording/processing session produces (the
   *  instant-stop placeholder, then rewritten by the pipeline). Deterministic
   *  from the audio stem and stable across record→process, so useMeetings can
   *  dedupe the synthetic "__live__/…" row against the real note once it exists
   *  (one recording, one row — #bug4). Only the Parakeet instant-stop path
   *  writes that placeholder, so dedup only bites there; Whisper/import have no
   *  placeholder (dedup is a no-op even when this is set), and it's null idle. */
  liveSummaryFile?: string | null;
}

export type PickAudioFileResponse = Result<{ filePath: string }>;
export type RecordingsDirResponse = Result<{ path: string }>;

export type ListMeetingsResponse = Result<{ meetings: Meeting[] }>;
export type GetMeetingResponse = Result<{ meeting: Meeting }>;
export type UpdateMeetingResponse = Result<{ message: string; updatedData: Meeting }>;
// Soft-delete (#234): main hides only the summary and returns an `id` + a
// MAIN-owned `deadline` (epoch ms) so the renderer can offer Undo. `message` is
// set instead when there was nothing to delete (no summary / already gone).
export type DeleteMeetingResponse = Result<{ message?: string; id?: string; deadline?: number }>;

/** A note with an in-flight soft-delete window (#234), from list-pending-deletes. */
export interface PendingDelete {
  id: string;
  /** The exact `summary_file` string the note is listed under. */
  summaryFile: string;
  /** MAIN-owned deadline (epoch ms) — the countdown is display-only. */
  deadline: number;
  meeting: Meeting;
}
export type ListPendingDeletesResponse = Result<{ pending: PendingDelete[] }>;
export type SaveMeetingNotesResponse = Result<{ path: string }>;

export type QueryResponse = Result<{ answer: string }>;
export type LoadChatSessionsResponse = Result<{ data: ChatSessionsBlob | null }>;

export type ListFoldersResponse = Result<{ folders: Folder[] }>;
export type CreateFolderResponse = Result<{ folder: Folder }>;

export type CheckOllamaResponse = Result<{ installed: boolean; path?: string }>;
export type CheckModelInstalledResponse = Result<{ installed: boolean }>;
export interface Template {
  id: string;
  name: string;
  icon: string;
  prompt: string;
  language: string;
  format: 'structured' | 'markdown';
  builtin: boolean;
  locked: boolean;
}
export type ListTemplatesResponse = Result<{
  templates: Template[];
  default_template_id: string;
}>;
export type SaveTemplateResponse = Result<{ template: Template }>;

export interface PersonProfile {
  person_id: string;
  display_name: string;
  prototype_counts: Record<string, number>;
  hard_negative_counts: Record<string, number>;
  sample_available: boolean;
  updated_at: number;
}
export type ListPersonProfilesResponse = Result<{ person_profiles: PersonProfile[] }>;
export type CreatePersonProfileResponse = Result<{ person_id: string; display_name: string }>;

export interface SpeakerCandidate {
  person_id: string;
  display_name: string;
  distance: number;
  hard_negative_conflict: boolean;
  /** Distance to this person's nearest stored hard-negative, or null when
   *  they have none -- explains hard_negative_conflict (suppression is
   *  relative: negative evidence must rival the positive to suppress). */
  negative_distance: number | null;
}
export interface SpeakerSample {
  start: number;
  end: number;
  text: string | null;
}
export interface SpeakerSuggestion {
  status: 'confirmed' | 'possible' | 'none';
  suggested_person_id: string | null;
  suggested_name: string | null;
  merged_from: string[];
  candidates: SpeakerCandidate[];
  reasons: string[];
  // Identification anchors -- without these, "Unidentified speaker" gives a
  // human nothing to go on to figure out who it actually is.
  speech_duration_seconds: number;
  segment_count: number;
  /** "MM:SS" / "H:MM:SS" of this cluster's earliest segment, or null if the
   *  sidecar has no segment timestamps (a pre-this-feature sidecar). */
  first_timestamp: string | null;
  /** Quoted excerpt of what this cluster said, at its longest (most
   *  trustworthy) segment -- null if no saved transcript overlaps it. */
  sample_text: string | null;
  /** Several excerpts, chronological, each independently playable. Index i
   *  here is exactly what `getSampleAudio(..., i)` plays -- both sides
   *  derive the list from the shared `sample_segments`, so the clip always
   *  matches the text beside it. `text` is null for a segment no transcript
   *  line covers; the entry stays, because its audio is still playable and
   *  dropping it would shift every later index. */
  samples: SpeakerSample[];
  /** A human marked this cluster as holding more than one person. Never
   *  derived -- no measurable property of a blended centroid distinguishes
   *  one voice from two (0.8270 to the contaminating speaker in the real
   *  case this exists for). True takes the cluster out of naming entirely:
   *  no suggestion, no candidates, and confirm-speaker refuses it. */
  contains_multiple_speakers: boolean;
  /** True when duration/segment-count shape matches the real-data-validated
   *  echo/crosstalk artifact pattern (SUGGESTION_MIN_AVG_TURN_SECONDS) --
   *  a UI hint only, never excludes the cluster from confirm-speaker. */
  is_likely_artifact: boolean;
  /** Display name of the person this exact cluster was already confirmed
   *  as, from a real SpeakerPrototype in config.json -- null if never
   *  confirmed. Persists across navigation/reload unlike the panel's
   *  transient post-click feedback, which is plain component state. */
  confirmed_by_user: string | null;
  /** The same confirmation's person_id. Display names are not identity -- a
   *  rename can leave two profiles reading alike -- so anything deciding
   *  WHICH person a cluster went to compares this, not the name. Optional:
   *  a payload predating this field simply carries no id. */
  confirmed_person_id?: string | null;
  /** How far a human got reviewing this cluster. `"generic"` means they
   *  looked at it and chose to leave it unnamed -- the one review outcome
   *  that leaves no other trace, so it is read from here rather than from
   *  component state and survives a remount by construction. Absent on a
   *  payload predating the field, and on every unreviewed row. Never
   *  affects the suggestion: it records progress, not evidence. */
  review_state?: string | null;
}
export type SuggestSpeakersResponse = Result<{
  schema_version: 1;
  diarization_run_id: string | null;
  meeting_id: string;
  /** Whether the source recording still exists on disk (keep_recordings
   *  defaults off, so this is false for most older backfilled meetings) --
   *  checked once per meeting; gates whether a play button can render. */
  recording_available: boolean;
  /** Clusters, plus one extra for each cluster marked as holding more than
   *  one person. Surfaced because the ceiling is real and invisible in the
   *  output: Sortformer's four-slot architecture returns a five-person
   *  channel as four clusters with nothing indicating anything was lost.
   *  Nothing consumes this number today -- Sortformer takes no speaker-count
   *  hint, so there is no re-diarization call to feed it into. */
  minimum_speaker_count: number;
  /** People whose confirmation in this meeting was made against a
   *  diarization run that no longer describes the clusters below, because
   *  the meeting was re-diarized since. Their voice evidence is untouched
   *  and keeps scoring candidates everywhere; what is lost is the link to a
   *  cluster, and only re-confirming restores it. Absent or empty is the
   *  normal case, including on every library that was never re-diarized. */
  stale_assignments?: StaleAssignment[];
  channels: Record<string, Record<string, SpeakerSuggestion>>;
}>;

export interface StaleAssignment {
  person_id: string;
  display_name: string;
}

export interface MarkSpeakerClusterParams {
  meetingStem: string;
  channel: string;
  diarizationSpeakerId: string;
  expectedRunId: string;
  containsMultipleSpeakers: boolean;
}

export interface SetClusterReviewStateParams {
  meetingStem: string;
  channel: string;
  diarizationSpeakerId: string;
  expectedRunId: string;
  /** True records "a human reviewed this and left it unnamed"; false
   *  removes that marking, which is the undo. */
  generic: boolean;
}
export type SetClusterReviewStateResponse = Result<{
  resolved_diarization_speaker_id: string;
  /** Every raw cluster id the marked row covers. The panel shows merged
   *  rows, so one click can reach several ids. */
  fragment_ids: string[];
  review_state: string | null;
}>;
export type MarkSpeakerClusterResponse = Result<{
  resolved_diarization_speaker_id: string;
  contains_multiple_speakers: boolean;
  /** Display names whose confirmation of THIS cluster the marking withdrew.
   *  Marking implies the name was wrong, so the prototype (a blended
   *  two-voice embedding) and the hard negatives it created are removed
   *  rather than left enrolled. */
  cleared_confirmation_from: string[];
  minimum_speaker_count: number;
}>;

/** Feeds the one sentence shown before a delete. `has_sidecar: false` means
 *  this meeting was never diarized -- nothing is at risk, no warning. */
export type SpeakerNamingStatusResponse = Result<{
  meeting_id: string;
  has_sidecar: boolean;
  total_clusters: number;
  named_clusters: number;
  unnamed_clusters: number;
}>;

export interface ConfirmSpeakerParams {
  meetingStem: string;
  channel: string;
  diarizationSpeakerId: string;
  expectedRunId: string;
  personId?: string;
  newPersonName?: string;
}
export type ConfirmSpeakerResponse = Result<{
  person_id: string;
  display_name: string;
  prototype_id: string;
  resolved_diarization_speaker_id: string;
  merged_from: string[];
  hard_negatives_added_against: string[];
  /** Display names of people whose previous confirmation of this SAME
   *  cluster was superseded by this confirm (the "Change" flow) -- their
   *  stale prototype and derived hard negatives were removed. */
  reassigned_from: string[];
  relabeled_lines: number;
}>;

// audio_base64 (a WAV clip), not a filesystem path: the renderer's CSP
// (media-src 'self' blob:) has no file: allowance, so a raw path could
// never actually play -- the renderer builds a blob: URL from these bytes.
export type GetSpeakerSampleAudioResponse = Result<{ audio_base64: string }>;

export interface Report {
  id: string;
  template_id: string;
  template_name: string;
  model: string;
  content: string;
  created_at: string;
}

export interface RawSupportedModel {
  name?: string;
  size?: string;
  params?: string;
  description?: string;
  speed?: string;
  quality?: string;
  deprecated?: boolean;
  installed?: boolean;
  // Distinct from `installed`, which is also true when only the NVFP4
  // sibling is present (see mlx_installed) -- this is specifically whether
  // the GGUF id itself was pulled, needed by anything that must not act on
  // a tag that was never actually downloaded (e.g. deleting it).
  gguf_installed?: boolean;
  mlx_tag?: string;
  mlx_installed?: boolean;
  // The NVFP4 blob's own size -- a different (often larger) download than
  // this entry's `size`, which describes the GGUF variant only.
  mlx_size?: string;
}

export type ListModelsResponse = Result<{
  supported_models: Record<string, RawSupportedModel>;
  current_model: string;
  provider: string;
  // Machine RAM in GB (main.js attaches os.totalmem()); used to flag local
  // models that may exceed available memory. Absent -> never warn.
  total_ram_gb?: number;
}>;
export type GetCurrentModelResponse = Result<{ model: string }>;

// Deliberately NOT wrapped in Result<T>: Result<T> is `({ success: true } & T)`,
// and these responses already have their own `success` field, so wrapping would
// collapse both `success` fields into one (`true & boolean` narrows to `true`)
// and silently hide the real success/failure the caller needs to branch on.
// main.js's verify-model/delete-model handlers (Task 8) return the Python CLI's
// `{ success, error }` JSON verbatim, with no additional wrapping.
export type VerifyModelResponse = { success: boolean; error: string | null };
export type DeleteModelResponse = { success: boolean; error: string | null };
// model -> either its still-running progress string, or (done: true) its
// terminal outcome if it finished while nothing was around to consume the
// live model-pull-complete event (e.g. Settings was unmounted). Flat for the
// same reason as the two types above: main.js returns its in-memory maps
// verbatim, no Result<T> wrapping.
export type GetActivePullsResponse = Record<
  string,
  { progress?: string; done: boolean; success?: boolean; error?: string; cancelled?: boolean }
>;
export type CancelPullResponse = { success: boolean; error: string | null };

export type ListWhisperModelsResponse = Result<{
  supported_models: Record<string, RawSupportedModel>;
  current_model: string;
  provider: string;
}>;

export type ListParakeetModelsResponse = Result<{
  supported_models: Record<string, RawSupportedModel>;
  current_model: string;
  provider: string;
}>;

export type ParakeetStatusResponse = Result<{
  model: string;
  installed: boolean;
}>;

export type TranscriptionEngine = 'parakeet' | 'whisper';

export type GetTranscriptionEngineResponse = Result<{
  engine: TranscriptionEngine;
  valid_engines: TranscriptionEngine[];
}>;

export type GetNotificationsResponse = Result<{ notifications_enabled: boolean }>;
// `enabled` is the persisted preference; `registered` is the live global-
// shortcut registration state (false when enabled but another app owns the
// accelerator). The setter returns the same two fields.
export type GetRecordHotkeyResponse = Result<{ enabled: boolean; registered: boolean }>;
export type SetRecordHotkeyResponse = Result<{ enabled: boolean; registered: boolean }>;
export type GetTelemetryResponse = Result<{
  telemetry_enabled: boolean;
  anonymous_id?: string;
}>;
export type GetPrivacyNoticeSeenResponse = Result<{ privacy_notice_seen: boolean }>;
export type GetDockIconResponse = Result<{ hide_dock_icon: boolean }>;
export type GetMenuBarIconResponse = Result<{ show_menu_bar_icon: boolean }>;
export type GetSystemAudioResponse = Result<{ system_audio_enabled: boolean }>;
export type GetAutoDetectMeetingsResponse = Result<{ auto_detect_meetings_enabled: boolean }>;
export type GetPremeetingNotificationsResponse = Result<{
  premeeting_notifications_enabled: boolean;
}>;
export type GetLaunchOnLoginResponse = Result<{ launch_on_login: boolean }>;
export type GetWhisperModelResponse = Result<{ whisper_model: string; supported_models: string[] }>;
export type GetKeepRecordingsResponse = Result<{ keep_recordings: boolean }>;

export type GetAutoSummarizeResponse = Result<{ auto_summarize_enabled: boolean }>;

export type GetAutoInstallWhenIdleResponse = Result<{ auto_install_when_idle: boolean }>;

export type GetIdentityMatchingEnabledResponse = Result<{ identity_matching_enabled: boolean }>;

export type GetSilenceAutoStopResponse = Result<{
  silence_auto_stop_enabled: boolean;
  silence_auto_stop_minutes: number;
  supported_minutes: number[];
}>;

export type SetSilenceAutoStopEnabledResponse = Result<{ silence_auto_stop_enabled: boolean }>;
export type SetSilenceAutoStopMinutesResponse = Result<{ silence_auto_stop_minutes: number }>;
export type GetLanguageResponse = Result<{ language: string }>;
export type GetMicrophoneResponse = Result<{
  device_id: string | null;
  label: string | null;
}>;
export type GetUserNameResponse = Result<{ user_name: string }>;
export type StoragePathResponse = Result<{
  storage_path: string | null;
  custom_path: string | null;
  default_path: string;
}>;
export type PickStorageFolderResponse = Result<{ folderPath: string }>;
export type GetObsidianSyncResponse = Result<{ obsidian_sync_enabled: boolean }>;
export type GetObsidianVaultPathResponse = Result<{ obsidian_vault_path: string }>;
export type ObsidianConflict = { vaultRelPath: string; detectedAt: string; reason: string };
export type GetObsidianConflictsResponse = Result<{ conflicts: Record<string, ObsidianConflict> }>;
export type GetAiPromptsResponse = Result<{ summarization: string }>;

export type GetAiProviderResponse = Result<{
  ai_provider: AiProvider;
  remote_ollama_url: string;
  cloud_api_url: string;
  cloud_provider: CloudProvider;
  cloud_model: string;
  /** The local/remote Ollama summarisation model (config.model). */
  model: string;
  cloud_api_key_set: boolean;
  /** AWS region used as the Bedrock endpoint host (defaults to us-east-1). */
  bedrock_region: string;
  /** Optional cross-region inference profile id. Empty when unset. */
  bedrock_inference_profile: string;
  /** Curated list of Claude-on-Bedrock model ids surfaced as the dropdown. */
  bedrock_supported_models: string[];
}>;

export type AuthStatusResponse = Result<{ connected: boolean; email?: string | null }>;
export type GetCalendarEventsResponse =
  | { success: true; events: CalendarEvent[] }
  | { success: false; needsAuth: true }
  | { success: false; error: string };

export type CheckForUpdatesResponse = Result<{
  updateAvailable: boolean;
  currentVersion: string;
  latestVersion: string;
  releaseUrl: string;
  releaseName: string;
  downloadUrl: string | null;
  // macOS only: false when this OS is below the app's launch floor (14.4), so
  // an available update can't be auto-installed and the About tab explains that
  // instead of offering a broken Restart (#432). Absent/true elsewhere.
  osUpdateEligible?: boolean;
}>;

// downloadedVersion is null until a download finishes (or after one already
// installed). downloadPercent is non-null only while a download is actively
// in flight — cleared once it lands in downloadedVersion. Lets a freshly-
// mounted About tab recover either state instead of only reacting to
// whichever one-shot 'update-available'/'update-download-progress'/
// 'update-downloaded' IPC event fires while it happens to be mounted.
export type GetUpdateStatusResponse = Result<{
  downloadedVersion: string | null;
  downloadPercent: number | null;
  // The last surfaced auto-updater error, so a freshly-mounted About tab can
  // rehydrate a failed background update instead of only reacting to the
  // one-shot 'update-error' event. Null when the last cycle didn't fail.
  downloadError: string | null;
}>;

// ---------- event payloads ----------
export interface ProcessingProgressEvent {
  line: string;
  // The meeting's summary file — its unique key — so a detail view can ignore
  // progress from a different meeting's concurrent reprocess. Uses the file path
  // (not the display name, which two meetings can share) for an exact match.
  summaryFile?: string;
}
export interface SummaryChunkEvent {
  chunk: string;
  sessionName: string;
  summaryFile?: string;
}
export interface SummaryTitleEvent {
  title: string;
  sessionName: string;
}
export interface SummaryCompleteEvent {
  success: boolean;
  sessionName: string;
  summaryFile?: string;
  /** True when this completion belongs to a template report generation rather
   *  than a reprocess. Lets the renderer suppress the reprocess/model-memory
   *  failure banner for report failures, independent of event ordering. */
  report?: boolean;
}
export interface ProcessingCompleteEvent {
  success: boolean;
  sessionName: string;
  message: string;
  meetingData?: Meeting;
  /** Populated by the reprocess flow (which doesn't carry a freshly-
   *  generated Meeting payload like the recording flow does). Lets the
   *  app-level cleanup find the matching streamCache entry to clear
   *  even when MeetingDetail unmounted mid-reprocess. */
  summaryFile?: string;
  /** Preserved source-audio path on a HARD processing crash (success: false).
   *  No note/summaryFile is written on that path, so this is the only handle
   *  the Processing screen's "Try again" has to re-queue the recording via
   *  `recording.processFile`. Absent on success and on the graceful
   *  transcription-failure path (which writes a reprocessable note instead). */
  audioFile?: string;
  /** Set when the backend gracefully marked a transcription crash: the
   *  audio was preserved and a reprocessable meeting was saved, so the
   *  flow still succeeds (success: true) but the renderer should surface
   *  the failure honestly rather than treat it as a normal note. */
  transcriptionFailed?: boolean;
  transcriptionError?: string;
  /** True when this is the terminal event of a template report generation
   *  (not a reprocess). The renderer rolls the stream back without the
   *  reprocess banner regardless of whether STREAM_ERROR or a non-zero exit
   *  ended it. */
  report?: boolean;
  /** True when summarization actually ran (STREAM_COMPLETE), i.e. the note has
   *  generated notes. False/absent on the transcript-only path (auto_summarize
   *  off → SUMMARY_SKIPPED). Drives whether the renderer fires "Note ready" vs
   *  the "Transcript ready — generate notes?" prompt (#bug2/#bug3). */
  notesGenerated?: boolean;
}
export interface QueryChunkEvent {
  queryId: string;
  chunk: string;
}
export interface QueryDoneEvent {
  queryId: string;
  success: boolean;
  error?: string;
}
export interface ModelPullProgressEvent {
  model: string;
  progress: string;
}
export interface ModelPullCompleteEvent {
  model: string;
  success: boolean;
  error?: string;
  cancelled?: boolean;
}
export interface WhisperPullProgressEvent {
  model: string;
  progress: string;
}
export interface WhisperPullCompleteEvent {
  model: string;
  success: boolean;
  error?: string;
}
export interface ParakeetPullProgressEvent {
  /** Present on pull-parakeet-model invocations; omitted on
   *  setup-parakeet (which downloads the default model with no id arg). */
  model?: string | null;
  stage: 'downloading' | 'loading' | string;
}
export interface ParakeetPullCompleteEvent {
  model?: string | null;
  success: boolean;
  error?: string;
}
/** Byte-level progress from the onboarding wizard's local summarization-model
 *  download (main.js 'setup-ollama-and-model'). Dedicated to the Setup flow -
 *  distinct from the Settings model-pull events, whose payload is a
 *  { model, progress: string } string. Ollama streams per-blob progress, so
 *  `pct` can step back toward 0 as each new layer starts; the label carries the
 *  current phase alongside the bar. */
export interface SetupOllamaProgressEvent {
  status: string;
  pct: number;
  completed: number;
  total: number;
}

// ---------- live transcript ----------
export interface LiveSegment {
  text: string;
  start: number;
  end: number;
  /** True once Parakeet has frozen this sentence — subsequent pushes will
   *  start a new partial. False means the segment is the trailing partial
   *  and may be replaced by the next event. */
  isFinal: boolean;
  /** Speaker attribution set by the Python sidecar from which physical
   *  channel (mic vs system loopback) produced this segment — a
   *  structural fact, not a heuristic. Undefined on a mic-only recording
   *  before the first LIVE_SEG arrives; the UI treats undefined as 'You'. */
  speaker?: 'You' | 'Others';
}

export type LiveTranscriptStateResponse = Result<{
  sessionName: string | null;
  segments: LiveSegment[];
  /** Finalised segments carried over from the previous recording into this
   *  same note on a resume/continue. Display-only — rendered before the live
   *  tail so the bar shows earlier speech instead of starting blank. Static
   *  for the session's lifetime; empty on a fresh (non-continued) recording. */
  priorSegments?: LiveSegment[];
  /** True once the Python side has loaded the Parakeet model. Before this
   *  flips, the UI should show a model-loading state instead of an empty
   *  "no speech yet" panel — the difference matters for first-launch UX. */
  ready: boolean;
  /** Last failure reported by the consumer thread, if any. Null on success. */
  error: { stage: string; error?: string; message?: string } | null;
}>;

export interface LiveTranscriptReadyEvent {
  sessionName: string;
}

export interface LiveTranscriptChunkEvent {
  sessionName: string;
  segment: LiveSegment;
}

export interface LiveTranscriptErrorEvent {
  sessionName: string;
  stage: string;
  error?: string;
  message?: string;
}
export interface UpdateAvailableEvent {
  version: string;
}
export interface UpdateProgressEvent {
  percent: number;
}
export interface UpdateDownloadedEvent {
  version: string;
}
export interface UpdateErrorEvent {
  message: string;
}
export interface ShortcutStartRecordingEvent {
  sessionName: string | null;
}

// ---------- bridge shape ----------
type RequestFn<Args extends unknown[], Res> = (...args: Args) => Promise<Res>;
type SendFn<Args extends unknown[]> = (...args: Args) => void;
type Subscribe<P = void> = (cb: (payload: P) => void) => () => void;

export interface StenoaiBridge {
  version: number;

  app: {
    platform: 'darwin' | 'linux' | 'win32';
    getVersion: RequestFn<[], AppVersionResponse>;
  };

  window: { focus: SendFn<[]>; readyToShow: SendFn<[]> };

  shell: {
    openExternal: RequestFn<[string], Result<Record<string, never>>>;
  };

  analytics: {
    /** Fire-and-forget. Main whitelists event names and sanitizes properties;
     *  see RENDERER_TRACK_EVENTS in main.js. */
    track: SendFn<[name: string, props?: Record<string, string | number | boolean>]>;
  };

  system: {
    getStatus: RequestFn<[], StatusResponse>;
    test: RequestFn<[], Result<Record<string, never>>>;
    clearState: RequestFn<[], Result<Record<string, never>>>;
  };

  setup: {
    check: RequestFn<[], SetupCheckResponse>;
    ollamaAndModel: RequestFn<[], Result<Record<string, unknown>>>;
    parakeet: RequestFn<[], Result<Record<string, unknown>>>;
    speakerModelsStatus: RequestFn<[], SpeakerModelStatusResponse>;
    speakerModels: RequestFn<[], SpeakerModelStatusResponse>;
    test: RequestFn<[], Result<Record<string, unknown>>>;
    triggerWizard: RequestFn<[], Result<Record<string, unknown>>>;
  };

  privacy: {
    getNoticeSeen: RequestFn<[], GetPrivacyNoticeSeenResponse>;
    markNoticeSeen: RequestFn<[], Result<{ privacy_notice_seen: boolean }>>;
  };

  perm: {
    checkMicrophone: RequestFn<[], MicPermissionResponse>;
    requestMicrophone: RequestFn<[], MicPermissionGrantResponse>;
  };

  recording: {
    /** trigger: analytics source (manual/hotkey/tray/…). appendTo: path of an
     *  existing note to append this recording's transcript to
     *  (continue-recording) instead of creating a new note. */
    start: RequestFn<
      [name?: string, trigger?: RecordingTrigger, appendTo?: string],
      StartRecordingResponse
    >;
    stop: RequestFn<[], StopRecordingResponse>;
    pause: RequestFn<[], PauseRecordingResponse>;
    resume: RequestFn<[], ResumeRecordingResponse>;
    reportSystemAudioState: SendFn<[active: boolean]>;
    /** Hint that a recording may be imminent so main can re-warm the Parakeet
     *  model. Throttled main-side. Fire-and-forget. */
    hintWarmup: SendFn<[]>;
    enableLoopbackAudio: RequestFn<[], void>;
    disableLoopbackAudio: RequestFn<[], void>;
    getSystemAudioSupport: RequestFn<
      [],
      Result<{
        supported: boolean;
        osVersion: string;
        experimental?: boolean;
        platform?: string;
      }>
    >;
    /** Open an on-disk WebM file for the renderer-driven recording. Chunks are
     *  appended as they arrive (see appendSystemAudioChunk) so a crash leaves a
     *  processable file instead of losing the whole recording. */
    openSystemAudioFile: RequestFn<[name: string], Result<{ filePath: string }>>;
    appendSystemAudioChunk: RequestFn<[bytes: Uint8Array], Result<Record<string, never>>>;
    closeSystemAudioFile: RequestFn<[], Result<{ filePath: string }>>;
    /** Report a renderer-side capture failure so main can surface a native
     *  notification (a failed start would otherwise be silent). Fire-and-forget. */
    reportCaptureError: SendFn<[message: string]>;
    processSystemAudio: RequestFn<[filePath: string, name: string], Result<{ message: string }>>;
    // Fire-and-forget: the handler copies the file into recordings/ and queues
    // it (addToProcessingQueue), then resolves immediately with no payload —
    // it does NOT wait for transcription. Progress shows as a processing row.
    processFile: RequestFn<[filePath: string, name: string], Result<Record<string, never>>>;
    pickAudioFile: RequestFn<[], PickAudioFileResponse>;
    /** Resolve a dropped File's absolute path (Electron 32+ removed File.path). Synchronous. */
    getPathForFile: (file: File) => string;
    getQueue: RequestFn<[], QueueStatus | { success: false; error: string }>;
    getDir: RequestFn<[], RecordingsDirResponse>;
  };

  liveTranscript: {
    getState: RequestFn<[], LiveTranscriptStateResponse>;
    pushChunk: SendFn<[bytes: ArrayBuffer | Uint8Array]>;
    stop: SendFn<[]>;
  };

  meetings: {
    list: RequestFn<[], ListMeetingsResponse>;
    get: RequestFn<[summaryFile: string], GetMeetingResponse>;
    update: RequestFn<[summaryFile: string, patch: UpdateMeetingPatch], UpdateMeetingResponse>;
    revealFolder: RequestFn<[filePath: string], Result<Record<string, never>>>;
    delete: RequestFn<[meeting: Meeting], DeleteMeetingResponse>;
    undoDelete: RequestFn<[id: string], Result<{ meeting: Meeting }>>;
    commitDelete: RequestFn<[id: string], Result<Record<string, never>>>;
    listPendingDeletes: RequestFn<[], ListPendingDeletesResponse>;
    reprocess: RequestFn<
      [summaryFile: string, regenTitle: boolean, name: string],
      Result<{ message: string }>
    >;
    /** Re-run transcription on the source recording (#266) with the current
     *  settings, then re-summarise. Only wired when `recordingAvailable` is true. */
    retranscribe: RequestFn<[summaryFile: string, name: string], Result<{ message: string }>>;
    /** Whether the source recording for a note still exists on disk, gating the
     *  re-transcribe action (available only when keep-recordings was on). */
    recordingAvailable: RequestFn<[summaryFile: string], Result<{ available: boolean }>>;
    saveNotes: RequestFn<[name: string, notes: string], SaveMeetingNotesResponse>;
    exportTranscript: RequestFn<
      [defaultFilename: string, content: string],
      Result<{ path: string }>
    >;
    exportNotePdf: RequestFn<
      [defaultFilename: string, html: string],
      Result<{ path: string }>
    >;
    regenTitle: RequestFn<[summaryFile: string, name: string], Result<Record<string, never>>>;
    generateReport: RequestFn<
      [summaryFile: string, templateId: string],
      Result<{ message: string }>
    >;
    setActiveReport: RequestFn<
      [summaryFile: string, reportId: string],
      Result<Record<string, never>>
    >;
    deleteReport: RequestFn<[summaryFile: string, reportId: string], Result<Record<string, never>>>;
  };

  query: {
    ask: RequestFn<[file: string, q: string], QueryResponse>;
    askStream: SendFn<[id: string, file: string, q: string]>;
    askLiveStream: SendFn<[id: string, sessionName: string, q: string]>;
    chatGlobalStream: SendFn<[id: string, q: string, folderId?: string | null]>;
    cancel: SendFn<[id: string]>;
  };

  chat: {
    save: RequestFn<[data: ChatSessionsBlob], Result<Record<string, never>>>;
    load: RequestFn<[], LoadChatSessionsResponse>;
  };

  folders: {
    list: RequestFn<[], ListFoldersResponse>;
    create: RequestFn<[name: string, color?: string], CreateFolderResponse>;
    rename: RequestFn<[id: string, name: string], Result<Record<string, never>>>;
    updateIcon: RequestFn<[id: string, icon: string], Result<Record<string, never>>>;
    delete: RequestFn<[id: string], Result<Record<string, never>>>;
    reorder: RequestFn<[ids: string[]], Result<Record<string, never>>>;
    addMeeting: RequestFn<[summaryFile: string, folderId: string], Result<Record<string, never>>>;
    removeMeeting: RequestFn<
      [summaryFile: string, folderId: string],
      Result<Record<string, never>>
    >;
  };

  templates: {
    list: RequestFn<[], ListTemplatesResponse>;
    save: RequestFn<[t: Partial<Template>], SaveTemplateResponse>;
    remove: RequestFn<[id: string], Result<Record<string, never>>>;
    setDefault: RequestFn<[id: string], Result<Record<string, never>>>;
    reset: RequestFn<[id: string], Result<Record<string, never>>>;
  };

  speakers: {
    listProfiles: RequestFn<[], ListPersonProfilesResponse>;
    suggestForMeeting: RequestFn<[meetingStem: string], SuggestSpeakersResponse>;
    confirm: RequestFn<[params: ConfirmSpeakerParams], ConfirmSpeakerResponse>;
    createProfile: RequestFn<[displayName: string], CreatePersonProfileResponse>;
    renameProfile: RequestFn<[id: string, displayName: string], Result<Record<string, never>>>;
    deleteProfile: RequestFn<[id: string], Result<Record<string, never>>>;
    getSampleAudio: RequestFn<
      [
        meetingStem: string,
        channel: string,
        diarizationSpeakerId: string,
        expectedRunId: string,
        segmentIndex?: number,
      ],
      GetSpeakerSampleAudioResponse
    >;
    getPersonSampleAudio: RequestFn<[id: string], GetSpeakerSampleAudioResponse>;
    markCluster: RequestFn<[params: MarkSpeakerClusterParams], MarkSpeakerClusterResponse>;
    setClusterReviewState: RequestFn<
      [params: SetClusterReviewStateParams],
      SetClusterReviewStateResponse
    >;
    namingStatus: RequestFn<[meetingStem: string], SpeakerNamingStatusResponse>;
  };

  models: {
    checkOllama: RequestFn<[], CheckOllamaResponse>;
    list: RequestFn<[], ListModelsResponse>;
    getCurrent: RequestFn<[], GetCurrentModelResponse>;
    set: RequestFn<[name: string], Result<Record<string, never>>>;
    checkInstalled: RequestFn<[name: string], CheckModelInstalledResponse>;
    pull: RequestFn<[name: string], Result<Record<string, never>>>;
    cancelPull: RequestFn<[name: string], CancelPullResponse>;
    verify: RequestFn<[name: string], VerifyModelResponse>;
    delete: RequestFn<[name: string], DeleteModelResponse>;
    getActivePulls: RequestFn<[], GetActivePullsResponse>;
    ackPullComplete: SendFn<[name: string]>;
  };

  whisperModels: {
    list: RequestFn<[], ListWhisperModelsResponse>;
    set: RequestFn<[name: string], Result<Record<string, never>>>;
    pull: RequestFn<[name: string], Result<Record<string, never>>>;
  };

  parakeetModels: {
    list: RequestFn<[], ListParakeetModelsResponse>;
    pull: RequestFn<[id?: string | null], Result<{ model?: string; already_installed?: boolean }>>;
    status: RequestFn<[], ParakeetStatusResponse>;
  };

  transcriptionEngine: {
    get: RequestFn<[], GetTranscriptionEngineResponse>;
    set: RequestFn<[engine: TranscriptionEngine], Result<{ engine: TranscriptionEngine }>>;
  };

  settings: {
    getNotifications: RequestFn<[], GetNotificationsResponse>;
    setNotifications: RequestFn<[v: boolean], Result<Record<string, never>>>;
    getRecordHotkey: RequestFn<[], GetRecordHotkeyResponse>;
    setRecordHotkey: RequestFn<[v: boolean], SetRecordHotkeyResponse>;
    getTelemetry: RequestFn<[], GetTelemetryResponse>;
    setTelemetry: RequestFn<
      [v: boolean, source: TelemetryToggleSource],
      Result<Record<string, never>>
    >;
    getDockIcon: RequestFn<[], GetDockIconResponse>;
    setDockIcon: RequestFn<[v: boolean], Result<Record<string, never>>>;
    getMenuBarIcon: RequestFn<[], GetMenuBarIconResponse>;
    setMenuBarIcon: RequestFn<[v: boolean], Result<Record<string, never>>>;
    getSystemAudio: RequestFn<[], GetSystemAudioResponse>;
    setSystemAudio: RequestFn<[v: boolean], Result<Record<string, never>>>;
    getAutoDetectMeetings: RequestFn<[], GetAutoDetectMeetingsResponse>;
    setAutoDetectMeetings: RequestFn<[v: boolean], Result<Record<string, never>>>;
    getPremeetingNotifications: RequestFn<[], GetPremeetingNotificationsResponse>;
    setPremeetingNotifications: RequestFn<[v: boolean], Result<Record<string, never>>>;
    getLaunchOnLogin: RequestFn<[], GetLaunchOnLoginResponse>;
    setLaunchOnLogin: RequestFn<[v: boolean], Result<Record<string, never>>>;
    getWhisperModel: RequestFn<[], GetWhisperModelResponse>;
    setWhisperModel: RequestFn<[model: string], Result<Record<string, never>>>;
    getKeepRecordings: RequestFn<[], GetKeepRecordingsResponse>;
    setKeepRecordings: RequestFn<[v: boolean], Result<Record<string, never>>>;
    getAutoSummarize: RequestFn<[], GetAutoSummarizeResponse>;
    setAutoSummarize: RequestFn<[v: boolean], Result<Record<string, never>>>;
    getAutoInstallWhenIdle: RequestFn<[], GetAutoInstallWhenIdleResponse>;
    setAutoInstallWhenIdle: RequestFn<[v: boolean], Result<Record<string, never>>>;
    getIdentityMatchingEnabled: RequestFn<[], GetIdentityMatchingEnabledResponse>;
    setIdentityMatchingEnabled: RequestFn<[v: boolean], Result<Record<string, never>>>;
    getSilenceAutoStop: RequestFn<[], GetSilenceAutoStopResponse>;
    setSilenceAutoStopEnabled: RequestFn<[v: boolean], SetSilenceAutoStopEnabledResponse>;
    setSilenceAutoStopMinutes: RequestFn<[v: number], SetSilenceAutoStopMinutesResponse>;
    showSilenceAutoStopNotification: RequestFn<
      [payload: { minutes: number; sessionName: string | null }],
      Result<Record<string, never>>
    >;
    /** Fired when an enabled loopback acquisition genuinely fails; not fired
     *  for the toggle-off or OS-unsupported cases. */
    showSystemAudioMicOnlyNotification: RequestFn<[], Result<Record<string, never>>>;
    showNoteReadyNotification: RequestFn<
      [
        payload: {
          title: string;
          failed?: boolean;
          hardFailure?: boolean;
          summaryFile?: string | null;
        },
      ],
      Result<Record<string, never>>
    >;
    /** Transcript-only note finished transcription with no notes generated
     *  (auto_summarize off). Prompts "Generate notes?" — the action starts
     *  generation in the background, a body tap opens the note. Returns `shown`
     *  for the notifications_enabled gate. (#bug2/#bug3) */
    showTranscriptReadyNotification: RequestFn<
      [
        payload: {
          title?: string;
          summaryFile?: string | null;
          name?: string | null;
        },
      ],
      Result<{ shown?: boolean }>
    >;
    /** Design-for-test seam for the pre-meeting notification (production fire
     *  path is the main-side scheduler). Returns `shown` for the gate/suppression. */
    showPremeetingNotification: RequestFn<
      [payload: { event: { id: string; title?: string } }],
      Result<{ shown?: boolean }>
    >;
    getLanguage: RequestFn<[], GetLanguageResponse>;
    setLanguage: RequestFn<[code: string], Result<Record<string, never>>>;
    getMicrophone: RequestFn<[], GetMicrophoneResponse>;
    setMicrophone: RequestFn<[deviceId: string, label: string], GetMicrophoneResponse>;
    getUserName: RequestFn<[], GetUserNameResponse>;
    setUserName: RequestFn<[name: string], Result<Record<string, never>>>;
    getStoragePath: RequestFn<[], StoragePathResponse>;
    setStoragePath: RequestFn<[p: string], Result<Record<string, never>>>;
    pickStorageFolder: RequestFn<[], PickStorageFolderResponse>;
    getObsidianSync: RequestFn<[], GetObsidianSyncResponse>;
    setObsidianSync: RequestFn<[v: boolean], Result<Record<string, never>>>;
    getObsidianVaultPath: RequestFn<[], GetObsidianVaultPathResponse>;
    setObsidianVaultPath: RequestFn<[p: string], Result<Record<string, never>>>;
    pickObsidianVaultFolder: RequestFn<[], PickStorageFolderResponse>;
    getObsidianConflicts: RequestFn<[], GetObsidianConflictsResponse>;
    getAiPrompts: RequestFn<[], GetAiPromptsResponse>;
    saveDiagnostics: RequestFn<
      [defaultFilename: string, content: string],
      Result<{ path: string }>
    >;
  };

  ai: {
    getProvider: RequestFn<[], GetAiProviderResponse>;
    setProvider: RequestFn<[p: AiProvider], Result<Record<string, never>>>;
    setRemoteOllamaUrl: RequestFn<[url: string], Result<Record<string, never>>>;
    testRemoteOllama: RequestFn<[url: string], Result<{ ok: boolean; message?: string }>>;
    setCloudApiUrl: RequestFn<[url: string], Result<Record<string, never>>>;
    setCloudApiKey: RequestFn<[key: string], Result<Record<string, never>>>;
    setCloudProvider: RequestFn<[p: CloudProvider], Result<Record<string, never>>>;
    setCloudModel: RequestFn<[m: string], Result<Record<string, never>>>;
    setBedrockRegion: RequestFn<[region: string], Result<Record<string, never>>>;
    setBedrockInferenceProfile: RequestFn<[profile: string], Result<Record<string, never>>>;
    testCloudApi: RequestFn<[], Result<{ models?: string[] }>>;
  };

  calendar: {
    google: {
      connect: RequestFn<[], Result<Record<string, never>>>;
      cancel: RequestFn<[], Result<{ cancelled: boolean }>>;
      status: RequestFn<[], AuthStatusResponse>;
      disconnect: RequestFn<[], Result<Record<string, never>>>;
    };
    outlook: {
      connect: RequestFn<[], Result<Record<string, never>>>;
      cancel: RequestFn<[], Result<{ cancelled: boolean }>>;
      status: RequestFn<[], AuthStatusResponse>;
      disconnect: RequestFn<[], Result<Record<string, never>>>;
    };
    getEvents: RequestFn<[], GetCalendarEventsResponse>;
  };

  updates: {
    check: RequestFn<[], CheckForUpdatesResponse>;
    getStatus: RequestFn<[], GetUpdateStatusResponse>;
    openReleasePage: RequestFn<[url: string], Result<Record<string, never>>>;
    install: SendFn<[]>;
  };

  shortcuts: {
    rendererReady: SendFn<[]>;
  };

  on: {
    debugLog: Subscribe<string>;
    setupFlowTriggered: Subscribe<unknown>;
    toggleRecordingHotkey: Subscribe<void>;
    summaryChunk: Subscribe<SummaryChunkEvent>;
    summaryTitle: Subscribe<SummaryTitleEvent>;
    summaryComplete: Subscribe<SummaryCompleteEvent>;
    processingComplete: Subscribe<ProcessingCompleteEvent>;
    processingProgress: Subscribe<ProcessingProgressEvent>;
    queryChunk: Subscribe<QueryChunkEvent>;
    queryDone: Subscribe<QueryDoneEvent>;
    modelPullProgress: Subscribe<ModelPullProgressEvent>;
    modelPullComplete: Subscribe<ModelPullCompleteEvent>;
    whisperPullProgress: Subscribe<WhisperPullProgressEvent>;
    whisperPullComplete: Subscribe<WhisperPullCompleteEvent>;
    parakeetPullProgress: Subscribe<ParakeetPullProgressEvent>;
    parakeetPullComplete: Subscribe<ParakeetPullCompleteEvent>;
    setupOllamaProgress: Subscribe<SetupOllamaProgressEvent>;
    liveTranscriptReady: Subscribe<LiveTranscriptReadyEvent>;
    liveTranscriptChunk: Subscribe<LiveTranscriptChunkEvent>;
    liveTranscriptError: Subscribe<LiveTranscriptErrorEvent>;
    updateAvailable: Subscribe<UpdateAvailableEvent>;
    updateDownloadProgress: Subscribe<UpdateProgressEvent>;
    updateDownloaded: Subscribe<UpdateDownloadedEvent>;
    updateError: Subscribe<UpdateErrorEvent>;
    updateErrorCleared: Subscribe<void>;
    googleAuthChanged: Subscribe<{ connected: boolean }>;
    outlookAuthChanged: Subscribe<{ connected: boolean }>;
    shortcutStartRecording: Subscribe<ShortcutStartRecordingEvent>;
    shortcutStopRecording: Subscribe<void>;
    trayStartRecording: Subscribe<void>;
    trayStopRecording: Subscribe<void>;
    autoRecordRequested: Subscribe<{ sessionName?: string; appName?: string }>;
    autoPauseRequested: Subscribe<void>;
    autoResumeRequested: Subscribe<void>;
    autoSummariseRequested: Subscribe<void>;
    /** Main asks the renderer to generate notes for a transcript-only note in
     *  the background (from the "Generate notes" action on the transcript-ready
     *  notification). Renderer runs the same reprocess path as GenerateNotesBar. */
    generateNotesRequested: Subscribe<{ summaryFile: string; name?: string | null }>;
    navigateToMeeting: Subscribe<{ summaryFile: string }>;
    trayOpenSettings: Subscribe<void>;
    showQuitDialog: Subscribe<{ type: 'recording' | 'processing'; jobCount?: number }>;
    showNotification: Subscribe<{
      id?: string;
      title: string;
      body?: string;
      time?: string;
      meeting_url?: string;
      attendees?: string;
      premeeting?: boolean;
      iconType?: 'app' | 'alert' | 'success' | 'recording';
      color?: string;
      actions?: { id: string; text: string; type?: 'primary' | 'secondary' }[];
    }>;
  };

  org: {
    status: RequestFn<[], OrgStatusResponse>;
    login: RequestFn<[adapterUrl: string, email: string, password: string], OrgLoginResponse>;
    ssoGoogleStart: RequestFn<[adapterUrl: string], OrgLoginResponse>;
    logout: RequestFn<[], Result<Record<string, never>>>;
    listMeetings: RequestFn<[], OrgListMeetingsResponse>;
    getMeeting: RequestFn<[id: string], OrgGetMeetingResponse>;
    createMeeting: RequestFn<[payload: OrgCreateMeetingPayload], OrgGetMeetingResponse>;
    deleteMeeting: RequestFn<[id: string], Result<{ id: string }>>;
    shareMeeting: RequestFn<[payload: OrgShareMeetingPayload], OrgShareMeetingResponse>;
    getBackupState: RequestFn<[summaryFile: string], OrgGetBackupStateResponse>;
    unshareBySummary: RequestFn<[summaryFile: string], OrgUnshareBySummaryResponse>;
    getAutoBackup: RequestFn<[], GetOrgAutoBackupResponse>;
    setAutoBackup: RequestFn<[enabled: boolean], SetOrgAutoBackupResponse>;
    getPolicy: RequestFn<[], GetOrgPolicyResponse>;
    tryAutoBackup: RequestFn<[payload: OrgTryAutoBackupPayload], OrgTryAutoBackupResponse>;
    aiChat: RequestFn<[payload: OrgChatPayload], OrgChatResponse>;
    chatStream: SendFn<[streamId: string, payload: OrgChatPayload]>;
  };

  dialog: {
    respondQuit: SendFn<[confirmed: boolean]>;
  };

  notification: {
    close: RequestFn<[], void>;
    actionClicked: SendFn<[actionId: string, notifId?: string]>;
    bodyClicked: SendFn<[notifId?: string]>;
  };

  subscribeQueryStream: (
    queryId: string,
    handlers: {
      onChunk?: (chunk: string) => void;
      onDone?: () => void;
      onError?: (err: Error) => void;
    }
  ) => () => void;
}

declare global {
  interface Window {
    stenoai: StenoaiBridge;
  }
}

/**
 * Accessor that asserts the bridge was actually installed. Throws a loud
 * error if the preload didn't run (e.g. someone forgot the contextIsolation
 * flag or loaded the renderer in a browser tab). Call this instead of
 * `window.stenoai.*` directly so bugs surface as messages, not
 * `Cannot read properties of undefined`.
 */
export function ipc(): StenoaiBridge {
  if (typeof window === 'undefined' || !window.stenoai) {
    throw new Error(
      '[ipc] window.stenoai is not defined — preload did not run. ' +
        'Check that main.js selected the new renderer webPreferences.'
    );
  }
  return window.stenoai;
}
