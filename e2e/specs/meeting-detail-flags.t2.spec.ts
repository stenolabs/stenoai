import { test, expect } from '../fixtures/electron';
import { writeMeetingMarkdown, writeTranscriptFile } from '../fixtures/user-config';

/**
 * T2 — the meeting-DETAIL parser (get-meeting) must surface the optional
 * session_info markers, not just the LIST parser.
 *
 * Regression: the detail page routes through main.js `parseMeetingMarkdown`
 * (a JS reimplementation of the Python `_parse_meeting_markdown` used by
 * list-meetings). It surfaced `transcription_failed` / `notes_generated` but
 * DROPPED `notes_stale`, `processing`, and `is_live_transcript` — so a
 * continued (stale) note showed no "Generate notes" CTA on its detail page
 * even though the flag was correctly written to disk. The T1 CTA specs seed
 * `session_info.notes_stale` through mock IPC, so they bypassed this parser
 * and never caught it. This drives the REAL get-meeting bridge.
 *
 * Model-free: pure markdown parse, no ASR / Ollama.
 */

type SessionInfo = {
  summary_file: string;
  notes_stale?: boolean;
  processing?: boolean;
  is_live_transcript?: boolean;
  notes_generated?: boolean;
  [key: string]: unknown;
};
type Meeting = {
  session_info: SessionInfo;
  summary?: string;
  participants?: string[];
  discussion_areas?: Array<{ title: string; analysis: string }>;
  key_points?: string[];
  action_items?: string[];
  is_diarised?: boolean;
  user_notes?: string | null;
  folders?: string[];
  transcript?: string;
  diarised_text?: string | null;
};
type GetResult = { success: boolean; meeting?: Meeting; error?: string };
type ListResult = { success: boolean; meetings: Meeting[] };

type StenoWindow = Window & {
  stenoai: {
    meetings: {
      get: (summaryFile: string) => Promise<GetResult>;
      list: () => Promise<ListResult>;
    };
  };
};

const getMeeting = (page: import('@playwright/test').Page, file: string) =>
  page.evaluate((f) => (window as StenoWindow).stenoai.meetings.get(f), file);

const listMeetings = (page: import('@playwright/test').Page) =>
  page.evaluate(() => (window as StenoWindow).stenoai.meetings.list());

test('get-meeting surfaces notes_stale (continued note → Generate-notes CTA)', async ({
  launchApp,
  userDataDir,
}) => {
  // A summarised note that a continue-recording append marked stale.
  const file = writeMeetingMarkdown(userDataDir, 'stale', {
    name: 'Stale Note',
    summaryMarkdown: '## Summary\nOutlook was confirmed working.',
    transcript: 'Is Outlook working? I think so.\n\n--- Resumed 09:20 ---\n\nResuming the chat.',
    frontmatter: { notes_stale: true },
  });

  const { page } = await launchApp();

  const res = await getMeeting(page, file);
  expect(res.success, res.error).toBe(true);
  // The detail parser must thread the flag through — this is exactly what the
  // floating "Generate notes" CTA gates on (summaryStale).
  expect(res.meeting!.session_info.notes_stale).toBe(true);
  // And the transcript must still be present (the CTA also requires it).
  expect(res.meeting!.transcript).toContain('Resuming the chat');
});

test('get-meeting surfaces is_live_transcript (live-sourced note)', async ({
  launchApp,
  userDataDir,
}) => {
  // NB: we do NOT assert `processing` here — the startup sweep
  // (sweepStuckProcessingFlags) legitimately clears `processing: true` on any
  // note with no active queue job, so a seeded placeholder is cleaned before
  // get-meeting reads it. The live @pipeline / instant-stop.t2 specs cover the
  // processing state with a real in-flight job. is_live_transcript is
  // sweep-independent, so it's the parser-mirror we can assert statically.
  const file = writeMeetingMarkdown(userDataDir, 'live', {
    name: 'Live Note',
    summaryMarkdown: '## Summary\nRescued from the live capture.',
    transcript: 'Live transcript captured during recording.',
    frontmatter: { is_live_transcript: true },
  });

  const { page } = await launchApp();

  const res = await getMeeting(page, file);
  expect(res.success, res.error).toBe(true);
  expect(res.meeting!.session_info.is_live_transcript).toBe(true);
});

test('get-meeting leaves the markers unset for a normal summarised note', async ({
  launchApp,
  userDataDir,
}) => {
  const file = writeMeetingMarkdown(userDataDir, 'normal', {
    name: 'Normal Note',
    summaryMarkdown: '## Summary\nA complete, current summary.',
    transcript: 'Full transcript here.',
  });

  const { page } = await launchApp();

  const res = await getMeeting(page, file);
  expect(res.success, res.error).toBe(true);
  // No stale/processing markers → the note reads as done (no CTA).
  expect(res.meeting!.session_info.notes_stale).toBeFalsy();
  expect(res.meeting!.session_info.processing).toBeFalsy();
  expect(res.meeting!.session_info.is_live_transcript).toBeFalsy();
});

test('get-meeting keeps a manually redacted diarised summary transcript authoritative', async ({
  launchApp,
  userDataDir,
}) => {
  const file = writeMeetingMarkdown(userDataDir, 'redacted-speakers', {
    name: 'Redacted speakers',
    summaryMarkdown: '## Summary\nSensitive wording was removed.',
    transcript: '[00:05] [Speaker 2] [redacted]',
    frontmatter: { is_diarised: true },
  });
  writeTranscriptFile(
    userDataDir,
    'redacted-speakers',
    '[00:05] [Person Alpha] sensitive wording that must stay hidden',
  );

  const { page } = await launchApp();

  const res = await getMeeting(page, file);
  expect(res.success, res.error).toBe(true);
  expect(res.meeting!.diarised_text).toBe('[00:05] [Speaker 2] [redacted]');
  expect(res.meeting!.diarised_text).not.toContain('sensitive wording that must stay hidden');
});

test('LIST (Python parser) and DETAIL (JS parser) agree on the session_info markers', async ({
  launchApp,
  userDataDir,
}) => {
  // The drift guard: list-meetings uses Python `_parse_meeting_markdown` and
  // get-meeting uses the JS `parseMeetingMarkdown` mirror in main.js. They must
  // surface the SAME markers or the detail page silently loses a flag (the very
  // bug this spec was born from). Seed one note carrying every statically-
  // assertable marker and assert both parsers agree.
  //   NB: `processing` is deliberately excluded — the startup sweep clears it
  //   before either read, so it isn't a stable parity signal here.
  const file = writeMeetingMarkdown(userDataDir, 'parity', {
    name: 'Parity Note',
    summaryMarkdown: '## Summary\nSeeded with markers.',
    transcript: 'A transcript rescued from the live capture.',
    frontmatter: { notes_stale: true, is_live_transcript: true, notes_generated: false },
  });

  const { page } = await launchApp();

  const detail = await getMeeting(page, file);
  expect(detail.success, detail.error).toBe(true);

  const listed = (await listMeetings(page)).meetings.find(
    (m) => m.session_info.summary_file === file,
  );
  expect(listed, 'seeded note present in list').toBeTruthy();

  const markers = (si: Meeting['session_info']) => ({
    notes_stale: si.notes_stale ?? false,
    is_live_transcript: si.is_live_transcript ?? false,
    notes_generated: si.notes_generated ?? true,
  });
  const detailMarkers = markers(detail.meeting!.session_info);
  // Both parsers must produce the seeded values...
  expect(detailMarkers).toEqual({
    notes_stale: true,
    is_live_transcript: true,
    notes_generated: false,
  });
  // ...and must agree with each other (drift guard).
  expect(detailMarkers).toEqual(markers(listed!.session_info));
});

test('LIST and DETAIL agree on the FULL parsed contract, incl. reasoning-tag normalization (#346)', async ({
  launchApp,
  userDataDir,
}) => {
  // The stronger drift guard. The marker-only test above missed Instance 2: the
  // Python parser normalizes an inline reasoning-close tag (`</think>## Summary`
  // on one line) onto its own line before section-splitting, the JS parser did
  // not — so the summary split in LIST but vanished in DETAIL. Seed a note whose
  // summary body starts with that inline tag and assert both parsers surface the
  // SAME contract (summary text + markers + every field both surface), not just
  // the three flags.
  const file = writeMeetingMarkdown(userDataDir, 'reasoning', {
    name: 'Reasoning Note',
    // Inline reasoning-close tag glued to the first header — the normalization
    // trigger. Without the JS port the `## Summary` header is not at line start,
    // so DETAIL drops the summary entirely while LIST keeps it.
    summaryMarkdown: [
      '</think>## Summary',
      'The team confirmed the reasoning-model path renders correctly.',
      '',
      '## Participants',
      'Alice, Bob',
      '',
      '## Key Points',
      '- Ship the parser parity fix',
      '- Keep both parsers in sync',
      '',
      '## Action Items',
      '- [ ] Land the JS normalization port',
    ].join('\n'),
    transcript: 'Full transcript of the reasoning-model discussion.',
    frontmatter: { notes_stale: true, is_live_transcript: true, notes_generated: false },
  });

  const { page } = await launchApp();

  const detail = await getMeeting(page, file);
  expect(detail.success, detail.error).toBe(true);

  const listed = (await listMeetings(page)).meetings.find(
    (m) => m.session_info.summary_file === file,
  );
  expect(listed, 'seeded note present in list').toBeTruthy();

  // Restrict to the fields both parsers surface. list-meetings strips the
  // transcript (fetched lazily by get-meeting) and adds has_transcript, and the
  // Python session_info carries configured_language/detected_language that the JS
  // side does not — those are out of scope here, so compare the intersection.
  const contract = (m: Meeting) => {
    const si = m.session_info;
    return {
      // Every session_info field the JS parser surfaces (the intersection).
      session_info: {
        name: si.name,
        processed_at: si.processed_at,
        duration_seconds: si.duration_seconds,
        // Compare by basename only: the two IPC surfaces legitimately attach the
        // path in different forms (get-meeting resolves the realpath, e.g.
        // /var -> /private/var on macOS or the 8.3-short vs long name on Windows;
        // list-meetings echoes the glob path). That path-plumbing difference is
        // not the #346 parse-contract drift, and it is not OS-portable to
        // normalize, so key identity on the filename the parsers surface.
        summary_file: String(si.summary_file).split(/[\\/]/).pop(),
        output_language: si.output_language ?? null,
        notes_stale: si.notes_stale ?? false,
        is_live_transcript: si.is_live_transcript ?? false,
        notes_generated: si.notes_generated ?? true,
      },
      summary: m.summary ?? '',
      participants: m.participants ?? [],
      discussion_areas: m.discussion_areas ?? [],
      key_points: m.key_points ?? [],
      action_items: m.action_items ?? [],
      is_diarised: m.is_diarised ?? false,
      user_notes: m.user_notes ?? null,
      folders: m.folders ?? [],
    };
  };

  const detailContract = contract(detail.meeting!);
  // Sanity: the normalization actually fired — the summary survived the inline tag.
  expect(detailContract.summary).toContain('renders correctly');
  // Full-contract parity: LIST (Python) and DETAIL (JS) must agree byte-for-byte.
  expect(detailContract).toEqual(contract(listed!));
});
