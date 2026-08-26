import * as React from 'react';
// Serialises the report markdown to an HTML string for the branded PDF, using
// the same react-markdown renderer the detail view renders on screen.
import { renderToStaticMarkup } from 'react-dom/server';
import ReactMarkdown from 'react-markdown';
import {
  Calendar as CalendarIcon,
  Check,
  ChevronDown,
  ChevronLeft,
  Clock,
  CloudOff,
  Copy,
  Download,
  FileDown,
  FileText,
  Folder as FolderIcon,
  Globe,
  MoreHorizontal,
  Mic,
  PencilLine,
  RefreshCw,
  Search,
  Trash2,
  UserRoundCheck,
  Users,
} from 'lucide-react';
import { Popover, PopoverAnchor, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { useQueryClient } from '@tanstack/react-query';
import * as SelectPrimitive from '@radix-ui/react-select';
import { MeetingsShell } from '@/components/MeetingsShell';
import { SpeakerReviewPanel } from '@/components/SpeakerReviewPanel';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectSeparator,
} from '@/components/ui/select';
import {
  useMeeting,
  useReprocessMeeting,
  useRetranscribeMeeting,
  useRecordingAvailable,
  useDeleteMeeting,
  useGenerateReport,
  useSetActiveReport,
  useDeleteReport,
  useUpdateUserNotes,
  meetingsKeys,
} from '@/hooks/useMeetings';
import { useTemplates } from '@/hooks/useTemplates';
import {
  useOrgSession,
  useShareToOrg,
  useOrgBackupState,
  useUnshareFromOrgBySummary,
} from '@/hooks/useOrg';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
  DialogClose,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import { Tooltip, TooltipTrigger, TooltipContent } from '@/components/ui/tooltip';
import {
  useFolders,
  useAddMeetingToFolder,
  useRemoveMeetingFromFolder,
  useCreateFolder,
} from '@/hooks/useFolders';
import { useActiveMeeting, useAskBar } from '@/lib/askBarContext';
import {
  findCitationsBatch,
  preprocessTranscript,
  type CitationMatch,
} from '@/lib/transcriptCitations';
import { ipc, type Meeting, type Report, type Template } from '@/lib/ipc';
import { buildTranscriptBundle, defaultExportFilename } from '@/lib/transcriptBundle';
import { buildNotesCopyText, type StructuredNoteSections } from '@/lib/notesCopy';
import { buildNotesHtml, hasNotesContent } from '@/lib/notesPdf';
import { unwrap } from '@/lib/result';
import { cn } from '@/lib/utils';
import { navigate } from '@/lib/router';
import { stripReasoning } from '@/lib/markdown';
import { pendingTitleRegens, streamCache, type StreamPhase } from '@/lib/meetingDetailState';
import { useReprocessBridge } from '@/hooks/reprocessBridgeStore';
import { useRecording } from '@/hooks/useRecording';
import { useAutoSummarizeSetting } from '@/hooks/useSettings';

const LAST_OPENED_KEY = 'steno-last-opened-meeting';

// Cross-process sentinel: the export-transcript handler returns this exact error
// when the user dismisses the save dialog, which we treat as a silent no-op
// rather than a failure. Must match the producers' value (app/ipc-sentinels.js,
// mirrored in the mock IPC) and app/docs/ipc-contract.md — the renderer is bundled
// separately and can't require that CJS module, so the contract doc is the source
// of truth that keeps them aligned.
const EXPORT_CANCELED_ERROR = 'canceled';

interface MeetingDetailProps {
  summaryFile: string;
}

export function MeetingDetail({ summaryFile }: MeetingDetailProps) {
  const meeting = useMeeting(summaryFile);
  useActiveMeeting(summaryFile, meeting.data?.session_info.name ?? null);

  React.useEffect(() => {
    if (meeting.data) {
      localStorage.setItem(LAST_OPENED_KEY, summaryFile);
    }
  }, [meeting.data, summaryFile]);

  return (
    <MeetingsShell activeSummaryFile={summaryFile}>
      {meeting.isLoading || (meeting.isFetching && !meeting.data) ? (
        <div className="flex min-h-[40vh] items-center justify-center text-[color:var(--fg-2)]">
          Loading meeting…
        </div>
      ) : meeting.isError ? (
        <div className="space-y-4 text-center">
          <h1 className="mv-title">Couldn't load note.</h1>
          <p className="text-[17px] leading-[1.55]" style={{ color: 'var(--fg-2)' }}>
            {(meeting.error as Error)?.message ?? 'An error occurred loading this note.'}
          </p>
          <button type="button" className="mv-chip" onClick={() => navigate('/meetings')}>
            Back to meetings
          </button>
        </div>
      ) : !meeting.data ? (
        <div className="space-y-4 text-center">
          <h1 className="mv-title">Note not found.</h1>
          <p className="text-[17px] leading-[1.55]" style={{ color: 'var(--fg-2)' }}>
            This recording may have been deleted. Pick another from the sidebar.
          </p>
          <button type="button" className="mv-chip" onClick={() => navigate('/meetings')}>
            Back to meetings
          </button>
        </div>
      ) : (
        <DetailContent key={summaryFile} meeting={meeting.data} routeSummaryFile={summaryFile} />
      )}
    </MeetingsShell>
  );
}

function DetailContent({
  meeting,
  routeSummaryFile,
}: {
  meeting: Meeting;
  /** The summaryFile as it appears in the route — the same identity
   *  useActiveMeeting registers as activeSummaryFile. Can differ from
   *  info.summary_file when the storage path crosses a symlink (macOS
   *  /var → /private/var, custom storage dirs): the backend realpaths,
   *  the route doesn't. Anything compared against activeSummaryFile
   *  (the reprocess bridge) must use THIS identity; anything talking to
   *  the backend keeps info.summary_file. */
  routeSummaryFile: string;
}) {
  const info = meeting.session_info;
  const summaryFile = info.summary_file;
  const date = formatDetailDate(info);
  const duration = formatDuration(info.duration_seconds);
  const [copied, setCopied] = React.useState(false);
  // Surfaces a refused delete (e.g. main's busy-guard while the note is
  // recording/processing). Without the old confirm dialog there is no other
  // place for that failure to show, so it must not stay silent.
  const [deleteError, setDeleteError] = React.useState<string | null>(null);
  const deleteMeeting = useDeleteMeeting();
  const reprocess = useReprocessMeeting();
  const retranscribe = useRetranscribeMeeting();
  // Re-transcribe (#266) is only offered when the source recording still exists
  // on disk (keep-recordings was on) — otherwise re-running ASR is impossible.
  const recordingAvailable = useRecordingAvailable(summaryFile);
  // Whether this processing note will get notes generated after transcription.
  // Defaults to true (config default) while the setting loads, so the copy
  // doesn't flash the transcript-only wording for the common auto-on case.
  const willGenerateNotes = useAutoSummarizeSetting().data ?? true;
  const [retranscribeOpen, setRetranscribeOpen] = React.useState(false);
  const generateReport = useGenerateReport();
  const setActiveReport = useSetActiveReport();
  const deleteReport = useDeleteReport();
  const { templates } = useTemplates();
  const orgSession = useOrgSession();
  const shareToOrg = useShareToOrg();
  const backupState = useOrgBackupState(orgSession.data?.signedIn ? summaryFile : null);
  const unshareFromOrg = useUnshareFromOrgBySummary();
  const [unshareOpen, setUnshareOpen] = React.useState(false);
  const [shareError, setShareError] = React.useState<string | null>(null);

  const isShared = backupState.data?.shared ?? false;
  const isSharing = shareToOrg.isPending;
  const isUnsharing = unshareFromOrg.isPending;
  // A persisted upload failure on a note that never landed — surfaced as a
  // "Backup failed · Retry" affordance so an auto-backup that silently failed
  // (e.g. behind a corporate proxy) is visible and one-click retryable.
  const backupFailed = !isShared && Boolean(backupState.data?.failed_at);
  const backupError = backupState.data?.error ?? null;

  const onShareToOrg = async () => {
    setShareError(null);
    const title = meeting.session_info.name || 'Untitled note';
    // Body = structured summary markdown (same as local detail page).
    // Transcript ships as a separate S3 artifact so the org viewer can
    // toggle it via the side panel rather than rendering it inline below
    // the summary. Diarised text (with [You]/[Others] tags) is preferred
    // when available so the org viewer gets the speaker-attributed view.
    const body = composeShareBody(meeting);
    const transcript = pickTranscriptForShare(meeting);
    try {
      await shareToOrg.mutateAsync({ title, body, transcript, visibility: 'org', summaryFile });
      // Successful share — useShareToOrg invalidates the backup-state
      // query, so the button flips to "Unshare" on the next render.
    } catch (e) {
      setShareError(e instanceof Error ? e.message : String(e));
    }
  };

  const onUnshareFromOrg = async () => {
    setShareError(null);
    try {
      await unshareFromOrg.mutateAsync(summaryFile);
      setUnshareOpen(false);
    } catch (e) {
      setShareError(e instanceof Error ? e.message : String(e));
    }
  };
  const [titleRegening, setTitleRegening] = React.useState(() =>
    pendingTitleRegens.has(summaryFile)
  );
  const [prevSummaryFile, setPrevSummaryFile] = React.useState(summaryFile);
  if (summaryFile !== prevSummaryFile) {
    setPrevSummaryFile(summaryFile);
    setTitleRegening(pendingTitleRegens.has(summaryFile));
  }

  const [isEditingTitle, setIsEditingTitle] = React.useState(false);
  const [titleError, setTitleError] = React.useState<string | null>(null);
  const titleEditRef = React.useRef<HTMLSpanElement>(null);

  React.useEffect(() => {
    const pending = pendingTitleRegens.get(summaryFile);
    if (!pending) return;
    let cancelled = false;
    pending.finally(() => {
      if (!cancelled) setTitleRegening(false);
    });
    return () => {
      cancelled = true;
    };
  }, [summaryFile]);

  React.useEffect(() => {
    if (isEditingTitle && titleEditRef.current) {
      const el = titleEditRef.current;
      el.focus();
      const range = document.createRange();
      range.selectNodeContents(el);
      range.collapse(false);
      const sel = window.getSelection();
      sel?.removeAllRanges();
      sel?.addRange(range);
    }
  }, [isEditingTitle]);

  const [titleKey, setTitleKey] = React.useState(0);
  const prevNameRef = React.useRef(info.name);
  React.useEffect(() => {
    if (info.name !== prevNameRef.current) {
      prevNameRef.current = info.name;
      setTitleKey((k) => k + 1);
      setTitleRegening(false);
      setTitleError(null);
    }
  }, [info.name]);

  const cached = streamCache.get(summaryFile);
  const [streamText, setStreamText] = React.useState(cached?.text ?? '');
  const [streamPhase, setStreamPhase] = React.useState<StreamPhase>(cached?.phase ?? 'idle');
  const [chunkProgress, setChunkProgress] = React.useState<{ step: number; total: number } | null>(
    null
  );
  const [reprocessFailed, setReprocessFailed] = React.useState(false);
  const qc = useQueryClient();

  // Report switch: null = the structured Standard summary, otherwise the id of
  // a generated report in meeting.reports. Seeded from the meeting's persisted
  // active_report so reopening a note lands on whatever was last viewed.
  const reports = meeting.reports ?? [];
  const [activeReportId, setActiveReportId] = React.useState<string | null>(
    meeting.active_report ?? null
  );
  const [prevMeetingReport, setPrevMeetingReport] = React.useState<string | null>(
    meeting.active_report ?? null
  );
  if ((meeting.active_report ?? null) !== prevMeetingReport) {
    setPrevMeetingReport(meeting.active_report ?? null);
    setActiveReportId(meeting.active_report ?? null);
  }
  const activeReport = activeReportId
    ? (reports.find((r) => r.id === activeReportId) ?? null)
    : null;
  // When a report generation finishes, summaryComplete fires for THIS meeting
  // and we want to land on the freshly-created report. The IPC stream doesn't
  // carry the new report id, so we flag "the active stream is a report" and,
  // on complete, refetch + adopt the meeting's refreshed active_report.
  const generatingReportRef = React.useRef(false);

  React.useEffect(() => {
    streamCache.set(summaryFile, { text: streamText, phase: streamPhase });
  }, [summaryFile, streamText, streamPhase]);

  React.useEffect(() => {
    const sessionName = info.name;
    const offChunk = ipc().on.summaryChunk((e) => {
      if (e.summaryFile !== summaryFile) return;
      // Promote from idle too (not just analyzing): an instant-stop note's
      // first-ever summary streams in with no prior reprocess to seed
      // 'analyzing', so without idle→generating the StreamingView (gated on
      // phase !== 'idle') would never render and the summary would silently
      // pop in only at completion. Chunks are summaryFile-filtered, so this
      // can't fire for the wrong note; auto-off sends no chunks, so it no-ops.
      setStreamPhase((prev) => (prev === 'analyzing' || prev === 'idle' ? 'generating' : prev));
      setStreamText((prev) => prev + e.chunk);
    });
    const offComplete = ipc().on.summaryComplete((e) => {
      if (e.summaryFile !== summaryFile) return;
      if (!e.success) {
        setStreamPhase('idle');
        setChunkProgress(null);
        if (e.report) {
          // A failed report generation is not a reprocess/model-memory failure.
          // Keyed on the event's `report` flag (not the local ref) so it's
          // correct regardless of summary-complete vs processing-complete order.
          generatingReportRef.current = false;
          setStreamText('');
          streamCache.delete(summaryFile);
        } else {
          setReprocessFailed(true);
        }
        return;
      }
      setStreamPhase('done');
      // Report generation reuses the summary stream. On success, refetch this
      // meeting so reports[]/active_report refresh, then land on the new report
      // (the backend marks it active) once the fresh detail payload arrives.
      if (generatingReportRef.current) {
        generatingReportRef.current = false;
        void qc.invalidateQueries({ queryKey: meetingsKeys.detail(summaryFile) }).then(() => {
          const fresh = qc.getQueryData<Meeting>(meetingsKeys.detail(summaryFile));
          if (fresh?.active_report) setActiveReportId(fresh.active_report);
        });
        setChunkProgress(null);
        setTimeout(() => {
          setStreamText('');
          setStreamPhase('idle');
          streamCache.delete(summaryFile);
        }, 400);
      }
    });
    const offProcessing = ipc().on.processingComplete((e) => {
      // Scope on summaryFile (unique) when the event carries one — the display
      // name is shareable, so two same-named notes would otherwise clear each
      // other's stream state mid-run (re-transcribe lengthens the job, widening
      // the race). Fall back to the sessionName match only when the event has no
      // summaryFile (the plain recording pipeline may emit none). Mirrors how the
      // chunk/progress handlers above guard on summaryFile.
      if (e.summaryFile) {
        if (e.summaryFile !== summaryFile) return;
      } else if (e.sessionName !== sessionName) {
        return;
      }
      setChunkProgress(null);
      if (!e.success) {
        setStreamPhase('idle');
        if (e.report) {
          // Terminal event of a failed report generation (e.g. non-zero exit
          // with no STREAM_ERROR). Roll back without the reprocess banner.
          generatingReportRef.current = false;
          setStreamText('');
          streamCache.delete(summaryFile);
        } else {
          setReprocessFailed(true);
        }
        return;
      }
      void qc.invalidateQueries({ queryKey: meetingsKeys.all });
      setTimeout(() => {
        setStreamText('');
        setStreamPhase('idle');
        streamCache.delete(summaryFile);
      }, 400);
    });
    const offProgress = ipc().on.processingProgress((e) => {
      // Ignore progress from a different meeting's concurrent reprocess — without
      // this scope check this view would render another meeting's map/reduce step.
      // Scoped on summaryFile (unique) rather than the display name (shareable).
      if (e.summaryFile !== summaryFile) return;
      const mapMatch = e.line.match(/^PROGRESS:summarize:(\d+)\/(\d+)$/);
      if (mapMatch) {
        setChunkProgress({ step: parseInt(mapMatch[1]), total: parseInt(mapMatch[2]) });
      } else if (e.line === 'PROGRESS:summarize:reducing') {
        setChunkProgress(null);
      }
    });
    return () => {
      offChunk();
      offComplete();
      offProcessing();
      offProgress();
    };
  }, [info.name, summaryFile, qc]);

  // Non-Standard templates only — the locked `standard` template drives the
  // structured summary, not an on-demand report.
  const reportTemplates = templates.filter((t) => !t.locked);

  const onGenerateReport = (templateId: string) => {
    setStreamText('');
    setStreamPhase('analyzing');
    setChunkProgress(null);
    setReprocessFailed(false);
    generatingReportRef.current = true;
    streamCache.set(summaryFile, { text: '', phase: 'analyzing' });
    generateReport.mutate(
      { summaryFile, templateId },
      {
        // Failures before the first stream event (e.g. the backend never starts
        // streaming) won't emit summary-complete, so roll the UI back here instead
        // of stranding it in the analyzing state.
        onError: () => {
          generatingReportRef.current = false;
          setStreamPhase('idle');
          setStreamText('');
          setChunkProgress(null);
          streamCache.delete(summaryFile);
        },
      }
    );
  };

  const startReprocess = () => {
    // Synchronous re-entrancy guard (#313 review): the floating dock button's
    // disabled state arrives one commit late (published via effect to the
    // reprocess bridge), so a fast double-click there could fire two
    // overlapping `reprocess` jobs for the same file — main.js deliberately
    // allows concurrent jobs across files and has no same-file dedupe.
    // streamCache is a module-level Map written synchronously below, so it
    // can't lag the way state/props can.
    const cached = streamCache.get(summaryFile);
    if (
      reprocess.isPending ||
      streamPhase !== 'idle' ||
      cached?.phase === 'analyzing' ||
      cached?.phase === 'generating'
    ) {
      return;
    }
    setStreamText('');
    setStreamPhase('analyzing');
    setChunkProgress(null);
    setReprocessFailed(false);
    streamCache.set(summaryFile, { text: '', phase: 'analyzing' });
    reprocess.mutate(
      { summaryFile, regenTitle: false, name: info.name },
      {
        // A rejection here means the IPC call itself failed (e.g. the backend
        // never spawned) BEFORE any processing-complete/summary-complete event
        // could fire to roll the UI back — without this the analyzing/streaming
        // state would be stuck forever with no way to retry (mirrors
        // onGenerateReport's onError below).
        onError: () => {
          setStreamPhase('idle');
          setStreamText('');
          setChunkProgress(null);
          streamCache.delete(summaryFile);
          setReprocessFailed(true);
        },
      }
    );
  };

  // Re-transcribe (#266): re-run ASR on the source recording with the current
  // settings, then re-summarise. Reuses the SAME streaming UI as reprocess —
  // the backend drives summary-chunk/-complete keyed by summaryFile — so we only
  // swap which mutation fires. Transcription is silent (no CHUNK), so the view
  // stays in "analyzing" until summarisation streams, matching reprocess's
  // pre-first-chunk state. Mirrors startReprocess's re-entrancy guard + onError.
  const startRetranscribe = () => {
    const cached = streamCache.get(summaryFile);
    if (
      retranscribe.isPending ||
      reprocess.isPending ||
      streamPhase !== 'idle' ||
      cached?.phase === 'analyzing' ||
      cached?.phase === 'generating'
    ) {
      return;
    }
    setStreamText('');
    setStreamPhase('analyzing');
    setChunkProgress(null);
    setReprocessFailed(false);
    streamCache.set(summaryFile, { text: '', phase: 'analyzing' });
    retranscribe.mutate(
      { summaryFile, name: info.name },
      {
        // A rejection means the IPC/backend failed (e.g. RETRANSCRIBE_NO_AUDIO,
        // or ASR crashed) BEFORE a summary-complete could roll the UI back —
        // surface the shared reprocess failure affordance. Same as startReprocess.
        onError: () => {
          setStreamPhase('idle');
          setStreamText('');
          setChunkProgress(null);
          streamCache.delete(summaryFile);
          setReprocessFailed(true);
        },
      }
    );
  };

  // Persist the choice so it survives navigation (B1 review: active_report not
  // persisted). `null` selects the structured Standard summary → 'standard'.
  const onSelectReport = (id: string | null) => {
    setActiveReportId(id);
    setActiveReport.mutate({ summaryFile, reportId: id ?? 'standard' });
  };

  const onDeleteReport = (reportId: string) => {
    if (activeReportId === reportId) setActiveReportId(null);
    deleteReport.mutate({ summaryFile, reportId });
  };

  const [copiedTranscript, setCopiedTranscript] = React.useState(false);
  const [exportError, setExportError] = React.useState<string | null>(null);
  // Built once per meeting — the transcript can be large, and it's read on every
  // render for the buttons' disabled state as well as in both handlers.
  const transcriptBundle = React.useMemo(() => buildTranscriptBundle(meeting), [meeting]);

  // Await the write and only flip to "Copied" once it actually succeeds — a
  // rejected clipboard (permission denied, no focus) must not show a false
  // success. The transcript bundle is large and the only thing a user pastes
  // into an LLM, so a silent miscopy is worse here than for the small notes copy.
  const copyTranscriptForAi = async () => {
    if (!transcriptBundle) return;
    setExportError(null);
    try {
      await navigator.clipboard.writeText(transcriptBundle);
      setCopiedTranscript(true);
      setTimeout(() => setCopiedTranscript(false), 1500);
    } catch (error) {
      setExportError(`Couldn't copy transcript: ${getErrorMessage(error)}`);
    }
  };

  // Save writes a file, which can genuinely fail — so unlike the copy paths we
  // surface a real failure. A user-cancelled dialog is not an error (the handler
  // returns error: EXPORT_CANCELED_ERROR) and stays silent.
  const saveTranscript = async () => {
    if (!transcriptBundle) return;
    setExportError(null);
    try {
      const res = await ipc().meetings.exportTranscript(
        defaultExportFilename(meeting),
        transcriptBundle
      );
      if (!res.success && res.error !== EXPORT_CANCELED_ERROR) {
        setExportError(`Couldn't save transcript: ${res.error || 'unknown error'}`);
      }
    } catch (error) {
      setExportError(`Couldn't save transcript: ${getErrorMessage(error)}`);
    }
  };

  // The Standard structured note, decomposed once into the shape both note
  // exports consume — Copy notes (clipboard) and Save notes as PDF. Reasoning
  // blocks are stripped like the rendered views, so neither export carries
  // <think> content the screen hides. One memo so the two can't drift.
  const noteSections = React.useMemo<StructuredNoteSections>(() => {
    const meta = [formatDetailDate(info), formatDuration(info.duration_seconds)]
      .filter(Boolean)
      .join(' · ');
    return {
      name: info.name,
      meta: meta || undefined,
      summary: meeting.summary ? stripReasoning(meeting.summary) : undefined,
      discussionAreas: asDiscussionAreas(meeting.discussion_areas),
      keyPoints: meeting.key_points ?? [],
      actionItems: asStringArray(meeting.action_items),
      participants: asStringArray(meeting.participants),
    };
  }, [info, meeting]);

  // Whether there is anything worth exporting to PDF — the disabled state only
  // needs this boolean, so the ~45KB branded HTML (base64 font included) is
  // built lazily on click in saveNotesPdf, not on every render. An open report
  // counts on its own: a transcript-only note (auto-summarise off) has no
  // structured sections but can still have a generated report on screen.
  const canExportNotesPdf = activeReport
    ? Boolean(stripReasoning(activeReport.content).trim())
    : hasNotesContent(noteSections);

  // Branded-PDF export of whichever note is on screen — the open template
  // report when one is selected, otherwise the Standard structured note. The
  // report's markdown is serialised with the SAME renderer the view above uses
  // (react-markdown), so the PDF can't drift from what the user is looking at.
  // Hands finished HTML to the export-note-pdf IPC, which rasterises + writes it.
  const saveNotesPdf = async () => {
    if (!canExportNotesPdf) return;
    setExportError(null);
    try {
      const reportForPdf = activeReport
        ? {
            templateName: activeReport.template_name,
            contentHtml: renderToStaticMarkup(
              <ReactMarkdown>{stripReasoning(activeReport.content)}</ReactMarkdown>,
            ),
          }
        : null;
      const res = await ipc().meetings.exportNotePdf(
        defaultExportFilename(meeting, 'pdf'),
        buildNotesHtml(noteSections, reportForPdf)
      );
      if (!res.success && res.error !== EXPORT_CANCELED_ERROR) {
        setExportError(`Couldn't save notes: ${res.error || 'unknown error'}`);
      }
    } catch (error) {
      setExportError(`Couldn't save notes: ${getErrorMessage(error)}`);
    }
  };

  // Copies whichever note is on screen: the open template report when one is
  // selected, otherwise the Standard structured note.
  const copyNotes = () => {
    const text = buildNotesCopyText(
      noteSections,
      activeReport ? { content: stripReasoning(activeReport.content) } : null
    );
    void navigator.clipboard.writeText(text);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  const summary = meeting.summary?.trim();
  const participants = asStringArray(meeting.participants);
  const attendees = asStringArray(meeting.attendees);
  const keyPoints = meeting.key_points ?? [];
  const actionItems = asStringArray(meeting.action_items);
  const discussionAreas = asDiscussionAreas(meeting.discussion_areas);
  const transcriptionFailed = Boolean(meeting.session_info.transcription_failed);
  const transcriptionError = meeting.session_info.error?.trim();
  // The real signal for "auto-summarize was off" (#258) — NOT `!summary`, which
  // also matches an older/imported meeting whose ## Summary section is empty or
  // unparsable for unrelated reasons and would otherwise be misclassified as
  // transcript-only.
  const notesNotGenerated = meeting.session_info.notes_generated === false;
  // Instant-stop placeholder: written from the live transcript at stop while
  // the batch transcribe/summarise upgrades it in the background. Show a quiet
  // "finishing up" affordance and suppress the Generate-notes CTA until the
  // pipeline completes (or clears the flag on failure).
  const isProcessing = meeting.session_info.processing === true;
  // While a recording is live on THIS note (resume/continue), the transcript
  // is still growing — offering "Generate notes" mid-recording would summarise
  // a moving target and strand the CTA once it finishes. Suppress it until the
  // recording is stopped. Matched by summary-file IDENTITY (not display name,
  // which collides for two default-"Note" notes); a recording on a *different*
  // note leaves this note's CTA untouched.
  const recording = useRecording();
  const isRecordingThisNote =
    recording.status !== 'idle' &&
    recording.status !== 'processing' &&
    recording.recordingSummaryFile != null &&
    recording.recordingSummaryFile === info.summary_file;

  // Publish this note's reprocess trigger + streaming state so the floating
  // GenerateNotesBar (mounted at App level, above the Ask bar) drives THIS
  // detail's `startReprocess` and shares its disabled state — one source of
  // truth, no double-fire. Only while showing a transcript-only note.
  const publishReprocess = useReprocessBridge((s) => s.publish);
  const clearReprocess = useReprocessBridge((s) => s.clear);
  // Mirrors the render ternary below: a transcription-failed note shows its
  // failure notice and hides its own reprocess controls, so the floating
  // trigger must not offer "Generate notes" for it either (#313 review —
  // reprocess on a failed note exits non-zero and strands the UI).
  const summaryPending =
    notesNotGenerated &&
    !transcriptionFailed &&
    !isProcessing &&
    !isRecordingThisNote &&
    Boolean(meeting.transcript);
  // A continued note (continue-recording appended a segment after notes were
  // generated): the summary no longer covers the transcript — offer the same
  // floating "Generate notes" CTA. reprocess clears the flag on rewrite.
  const summaryStale =
    meeting.session_info.notes_stale === true &&
    !transcriptionFailed &&
    !isProcessing &&
    !isRecordingThisNote &&
    Boolean(meeting.transcript);
  const reprocessStreaming = reprocess.isPending || streamPhase !== 'idle';
  const startReprocessRef = React.useRef(startReprocess);
  startReprocessRef.current = startReprocess;
  const stableStartReprocess = React.useCallback(() => startReprocessRef.current(), []);
  React.useEffect(() => {
    // Publish under the ROUTE identity (routeSummaryFile): the bar compares
    // against activeSummaryFile, which useActiveMeeting registered from the
    // route. info.summary_file can be a realpath'd variant of the same file
    // (symlinked storage path) and would never match.
    // When reprocess has FAILED, the inline retry card (data-testid=
    // "reprocess-retry") owns the CTA — don't also publish the floating dock
    // button, or the user sees two identical "Generate notes" buttons at once
    // (the failure path doesn't invalidate the query, so notes_stale /
    // notes_generated stay true here). The floating CTA returns on the next
    // startReprocess, which resets reprocessFailed.
    if ((summaryPending || summaryStale) && !reprocessFailed) {
      publishReprocess({
        summaryFile: routeSummaryFile,
        streaming: reprocessStreaming,
        // Always "Generate notes" — no separate Regenerate wording. Every
        // record/continue → stop leaves this one CTA.
        label: 'Generate notes',
        start: stableStartReprocess,
      });
    } else {
      clearReprocess(routeSummaryFile);
    }
    return () => clearReprocess(routeSummaryFile);
  }, [
    summaryPending,
    summaryStale,
    reprocessFailed,
    reprocessStreaming,
    routeSummaryFile,
    stableStartReprocess,
    publishReprocess,
    clearReprocess,
  ]);

  // My notes tab: an always-available editable notes layer, independent of
  // the summary. Persists to the `## User Notes` section (autosave). Local
  // state resets per meeting because DetailContent is keyed by summaryFile.
  const [tab, setTab] = React.useState<'summary' | 'notes'>('summary');
  const hasUserNotes = Boolean((meeting.user_notes ?? '').trim());
  const { setTranscriptOpen } = useAskBar();

  const rawTranscript =
    (meeting.is_diarised && meeting.diarised_text ? meeting.diarised_text : meeting.transcript) ??
    '';

  const processedTranscript = React.useMemo(() => {
    if (!rawTranscript.trim()) return null;
    return preprocessTranscript(rawTranscript);
  }, [rawTranscript]);

  const summaryParagraphs = React.useMemo(() => {
    if (!summary) return [];
    return stripReasoning(summary)
      .split(/\n{2,}/)
      .map((p) => p.trim())
      .filter(Boolean);
  }, [summary]);

  const summaryCitations = React.useMemo(() => {
    if (!processedTranscript || summaryParagraphs.length === 0) return [];
    return findCitationsBatch(summaryParagraphs, processedTranscript);
  }, [summaryParagraphs, processedTranscript]);

  const keyPointsCitations = React.useMemo(() => {
    if (!processedTranscript || keyPoints.length === 0) return [];
    return findCitationsBatch(keyPoints, processedTranscript);
  }, [keyPoints, processedTranscript]);

  const actionItemsCitations = React.useMemo(() => {
    if (!processedTranscript || actionItems.length === 0) return [];
    return findCitationsBatch(actionItems, processedTranscript);
  }, [actionItems, processedTranscript]);

  const jumpToCitation = React.useCallback(
    (match: CitationMatch) => {
      setTranscriptOpen(true);
      const targetIndex = match.lineIndex;

      const highlightAndScroll = (attemptsLeft: number) => {
        const transcriptBar = document.querySelector('[data-transcript-bar]');
        if (!transcriptBar) {
          if (attemptsLeft > 0) {
            requestAnimationFrame(() => highlightAndScroll(attemptsLeft - 1));
          }
          return;
        }

        const scrollContainer = transcriptBar.querySelector('.overflow-auto') as HTMLElement | null;
        const rowEl = transcriptBar.querySelector(
          `[data-index="${targetIndex}"]`,
        ) as HTMLElement | null;

        if (rowEl) {
          rowEl.scrollIntoView({ behavior: 'smooth', block: 'center' });
          applyCitationHighlight(rowEl);
        } else if (scrollContainer) {
          scrollContainer.scrollTo({
            top: Math.max(0, targetIndex * 80 - 100),
            behavior: 'smooth',
          });
          if (attemptsLeft > 0) {
            setTimeout(() => highlightAndScroll(attemptsLeft - 1), 60);
          }
        }
      };

      requestAnimationFrame(() => highlightAndScroll(10));
    },
    [setTranscriptOpen],
  );

  return (
    <article data-testid="meeting-detail" className="space-y-9">
      <header
        className="flex flex-col gap-4 pb-6"
        style={{ borderBottom: '1px solid var(--border-subtle)' }}
      >
        <div className="flex items-center justify-between gap-3">
          <button
            type="button"
            onClick={() => navigate('/')}
            aria-label="Back to home"
            className="inline-flex items-center gap-1 rounded-md px-2 py-1 text-[12.5px] transition-colors hover:bg-[color:var(--surface-hover)] hover:text-[color:var(--fg-1)]"
            style={{ color: 'var(--fg-2)' }}
          >
            <ChevronLeft className="size-[15px]" />
            Home
          </button>
          <div className="flex items-center gap-1">
            <Tooltip>
              <TooltipTrigger asChild>
                {/* Disabled while a summary/report stream is on screen — the
                    clipboard would otherwise get the old note while the body
                    shows the in-flux streamed text. */}
                <ActionIconButton
                  label={copied ? 'Copied' : 'Copy notes'}
                  onClick={copyNotes}
                  disabled={streamPhase !== 'idle'}
                >
                  {copied ? <Check className="size-[13px]" /> : <Copy className="size-[13px]" />}
                </ActionIconButton>
              </TooltipTrigger>
              <TooltipContent side="bottom">{copied ? 'Copied!' : 'Copy notes'}</TooltipContent>
            </Tooltip>
            <Tooltip>
              <TooltipTrigger asChild>
                <ActionIconButton
                  label={copiedTranscript ? 'Copied' : 'Copy transcript'}
                  onClick={() => void copyTranscriptForAi()}
                  disabled={!transcriptBundle}
                >
                  {copiedTranscript ? (
                    <Check className="size-[13px]" />
                  ) : (
                    <FileText className="size-[13px]" />
                  )}
                </ActionIconButton>
              </TooltipTrigger>
              <TooltipContent side="bottom">
                {copiedTranscript ? 'Copied!' : 'Copy transcript'}
              </TooltipContent>
            </Tooltip>
            {/* Re-runs summarisation on the existing transcript. A
                transcription-failure note has no transcript, so reprocess
                would exit non-zero and strand the UI on a spinner — hide it
                until a real re-transcribe-from-audio retry ships. */}
            {!info.transcription_failed && (
              <Tooltip>
                <TooltipTrigger asChild>
                  <ActionIconButton
                    label="Generate notes"
                    onClick={startReprocess}
                    // Disable while a recording is live on THIS note — same
                    // reason the floating CTA hides: don't summarise a
                    // still-growing transcript out from under the recording.
                    disabled={reprocess.isPending || streamPhase !== 'idle' || isRecordingThisNote}
                  >
                    <RefreshCw
                      className={cn(
                        'size-[13px]',
                        (reprocess.isPending ||
                          streamPhase === 'analyzing' ||
                          streamPhase === 'generating') &&
                          'animate-spin'
                      )}
                    />
                  </ActionIconButton>
                </TooltipTrigger>
                <TooltipContent side="bottom">Generate notes</TooltipContent>
              </Tooltip>
            )}
            <Popover>
              <PopoverTrigger asChild>
                <button
                  type="button"
                  aria-label="More options"
                  title="More options"
                  className="inline-flex size-7 items-center justify-center rounded-md transition-colors hover:bg-[color:var(--surface-hover)] hover:text-[color:var(--fg-1)]"
                  style={{ color: 'var(--fg-2)' }}
                >
                  <MoreHorizontal className="size-[14px]" />
                </button>
              </PopoverTrigger>
              <PopoverContent align="end" className="w-56 p-1">
                <button
                  type="button"
                  className="flex w-full items-center gap-2.5 rounded-md px-3 py-2 text-left text-sm transition-colors hover:bg-[color:var(--surface-hover)]"
                  style={{ color: 'var(--fg-1)' }}
                  onClick={() => {
                    const file = info.summary_file || info.transcript_file || info.audio_file;
                    if (file) ipc().meetings.revealFolder(file);
                  }}
                >
                  <FolderIcon className="size-[13px] shrink-0" style={{ color: 'var(--fg-2)' }} />
                  View containing folder
                </button>
                <button
                  type="button"
                  className="flex w-full items-center gap-2.5 rounded-md px-3 py-2 text-left text-sm transition-colors hover:bg-[color:var(--surface-hover)] disabled:opacity-50"
                  style={{ color: 'var(--fg-1)' }}
                  onClick={() => void saveTranscript()}
                  disabled={!transcriptBundle}
                >
                  <Download className="size-[13px] shrink-0" style={{ color: 'var(--fg-2)' }} />
                  Save transcript as .md…
                </button>
                <button
                  type="button"
                  className="flex w-full items-center gap-2.5 rounded-md px-3 py-2 text-left text-sm transition-colors hover:bg-[color:var(--surface-hover)] disabled:opacity-50"
                  style={{ color: 'var(--fg-1)' }}
                  onClick={() => void saveNotesPdf()}
                  disabled={!canExportNotesPdf}
                >
                  <FileDown className="size-[13px] shrink-0" style={{ color: 'var(--fg-2)' }} />
                  Save notes as PDF…
                </button>
                {/* Re-transcribe (#266): only when the source recording still
                    exists (keep-recordings was on). Disabled while a stream is on
                    screen or a recording is live on this note. */}
                {recordingAvailable.data === true && (
                  <button
                    type="button"
                    className="flex w-full items-center gap-2.5 rounded-md px-3 py-2 text-left text-sm transition-colors hover:bg-[color:var(--surface-hover)] disabled:opacity-50"
                    style={{ color: 'var(--fg-1)' }}
                    data-testid="retranscribe-action"
                    onClick={() => setRetranscribeOpen(true)}
                    disabled={
                      reprocess.isPending ||
                      retranscribe.isPending ||
                      streamPhase !== 'idle' ||
                      isRecordingThisNote
                    }
                  >
                    <Mic className="size-[13px] shrink-0" style={{ color: 'var(--fg-2)' }} />
                    Re-transcribe recording
                  </button>
                )}
                {orgSession.data?.signedIn &&
                  (isShared ? (
                    <button
                      type="button"
                      className="flex w-full items-center gap-2.5 rounded-md px-3 py-2 text-left text-sm transition-colors hover:bg-[color:var(--surface-hover)] disabled:opacity-50"
                      style={{ color: 'var(--fg-1)' }}
                      onClick={() => setUnshareOpen(true)}
                      disabled={isUnsharing}
                      title={`Unshare from ${orgSession.data.orgId}`}
                    >
                      <Globe className="size-[13px] shrink-0" style={{ color: 'var(--fg-2)' }} />
                      {`Unshare from ${orgSession.data.orgId}`}
                    </button>
                  ) : (
                    <button
                      type="button"
                      className="flex w-full items-center gap-2.5 rounded-md px-3 py-2 text-left text-sm transition-colors hover:bg-[color:var(--surface-hover)] disabled:opacity-50"
                      style={{ color: 'var(--fg-1)' }}
                      onClick={() => void onShareToOrg()}
                      // Disable while the persistent share state is still
                      // loading — otherwise a fast click during initial
                      // mount would treat the note as "not shared" and
                      // upload a duplicate against an already-shared note.
                      disabled={isSharing || backupState.isLoading}
                      title={`Share with ${orgSession.data.orgId}`}
                    >
                      <Globe className="size-[13px] shrink-0" style={{ color: 'var(--fg-2)' }} />
                      {isSharing
                        ? 'Sharing…'
                        : shareError
                          ? `Share failed: ${shareError}`
                          : `Share with ${orgSession.data.orgId}`}
                    </button>
                  ))}
                {/* Deletes straight away, no confirm step: the delete is a
                    soft-delete and the Undo toast (#234) is the safety net.
                    Asking first *and* offering undo made the flow feel heavy
                    (maintainer feedback) — one or the other, not both. */}
                <button
                  type="button"
                  className="flex w-full items-center gap-2.5 rounded-md px-3 py-2 text-left text-sm transition-colors hover:bg-[color:var(--surface-hover)] disabled:opacity-50"
                  style={{ color: 'var(--danger)' }}
                  disabled={deleteMeeting.isPending}
                  onClick={async () => {
                    setDeleteError(null);
                    try {
                      await deleteMeeting.mutateAsync(meeting);
                    } catch (err) {
                      setDeleteError(
                        `Delete failed: ${err instanceof Error ? err.message : String(err)}`,
                      );
                      return;
                    }
                    navigate('/');
                  }}
                >
                  <Trash2 className="size-[13px] shrink-0" />
                  Delete note
                </button>
              </PopoverContent>
            </Popover>
          </div>
        </div>

        {exportError && (
          <p role="alert" className="text-[12.5px]" style={{ color: 'var(--danger)' }}>
            {exportError}
          </p>
        )}

        {deleteError && (
          <p role="alert" className="text-[12.5px]" style={{ color: 'var(--danger)' }}>
            {deleteError}
          </p>
        )}

        <h1
          data-testid="meeting-detail-title"
          key={titleKey}
          className={cn('mv-title group', titleKey > 0 && 'animate-title-in')}
        >
          <button
            type="button"
            onClick={async () => {
              if (pendingTitleRegens.has(summaryFile)) return;
              setTitleError(null);
              setTitleRegening(true);
              const task = (async () => {
                try {
                  unwrap(await ipc().meetings.regenTitle(summaryFile, info.name));
                  await qc.invalidateQueries({ queryKey: meetingsKeys.all });
                } finally {
                  pendingTitleRegens.delete(summaryFile);
                }
              })();
              pendingTitleRegens.set(summaryFile, task);
              try {
                await task;
              } catch (error) {
                setTitleError(getErrorMessage(error));
              } finally {
                setTitleRegening(false);
              }
            }}
            disabled={
              titleRegening || reprocess.isPending || streamPhase !== 'idle' || isEditingTitle
            }
            aria-label="Regenerate title"
            title="Regenerate title"
            className={cn(
              'inline-flex items-center justify-center opacity-0 transition-opacity group-hover:opacity-100 disabled:pointer-events-none',
              titleRegening && 'opacity-100'
            )}
            style={{
              verticalAlign: 'middle',
              color: 'var(--fg-1)',
              width: '1em',
              height: '1em',
              marginRight: '0.15em',
              marginLeft: '-1.15em',
            }}
          >
            <RefreshCw className={cn('size-[0.45em]', titleRegening && 'animate-spin')} />
          </button>
          {isEditingTitle ? (
            <span
              ref={titleEditRef}
              contentEditable
              suppressContentEditableWarning
              onBlur={(e) => {
                const next = (e.currentTarget.textContent ?? '').trim();
                setIsEditingTitle(false);
                if (!next || next === info.name) return;
                void ipc()
                  .meetings.update(summaryFile, { name: next })
                  .then(() => qc.invalidateQueries({ queryKey: meetingsKeys.all }));
              }}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  e.preventDefault();
                  (e.currentTarget as HTMLSpanElement).blur();
                } else if (e.key === 'Escape') {
                  e.preventDefault();
                  if (titleEditRef.current) titleEditRef.current.textContent = info.name;
                  setIsEditingTitle(false);
                }
              }}
              className="outline-none"
            >
              {info.name}
            </span>
          ) : (
            <span className="cursor-text" onClick={() => setIsEditingTitle(true)}>
              {info.name}
            </span>
          )}
        </h1>

        <div className="flex flex-wrap gap-1.5">
          {date && <ChipV2 icon={<CalendarIcon className="size-[11px]" />}>{date}</ChipV2>}
          {duration && <ChipV2 icon={<Clock className="size-[11px]" />}>{duration}</ChipV2>}
          <FolderPicker
            summaryFile={summaryFile}
            assignedFolderIds={meeting.folders ?? meeting.session_info.folders ?? []}
          />
          {attendees.length > 0 && <AttendeesChip attendees={attendees} />}
          {participants.length > 0 && (
            // "speaker", not "person": this count comes from the audio, and on a
            // note that also has calendar attendees the two chips otherwise read
            // as one fact with two different numbers. The Participants section
            // below names these same rows Speaker 1..N.
            <ChipV2 icon={<Users className="size-[11px]" />}>
              {participants.length} {participants.length === 1 ? 'speaker' : 'speakers'}
            </ChipV2>
          )}
          {/* Quiet, non-alarming backup status for org users — a calm
              metadata chip (not a red alert) that a user can click to retry.
              The failure is also written to the diagnostic log for support. */}
          {orgSession.data?.signedIn && backupFailed && (
            <ChipV2
              icon={<CloudOff className="size-[11px]" />}
              onClick={() => void onShareToOrg()}
              title={
                backupError
                  ? `Last backup failed: ${backupError}. Click to retry.`
                  : 'This note has not been backed up. Click to retry.'
              }
            >
              {isSharing ? 'Backing up…' : 'Not backed up'}
            </ChipV2>
          )}
        </div>

        {titleError && (
          <p className="text-sm" style={{ color: 'var(--danger)' }}>
            {titleError}
          </p>
        )}
      </header>

      <NoteViewToggle
        tab={tab}
        onTab={setTab}
        hasNotes={hasUserNotes}
        activeReportId={activeReportId}
        reports={reports}
        templates={reportTemplates}
        onSelectReport={onSelectReport}
        onDeleteReport={onDeleteReport}
        onGenerate={onGenerateReport}
        generating={generateReport.isPending}
      />

      {tab === 'summary' && (
        <>
          {reprocessFailed && (
            <section
              className="flex flex-col items-start gap-2 rounded-lg p-4"
              style={{
                background: 'var(--surface-raised)',
                border: '1px solid var(--border-subtle, var(--surface-raised))',
              }}
              data-testid="reprocess-retry"
            >
              <div className="text-[15px] font-medium" style={{ color: 'var(--fg-1)' }}>
                Notes weren’t generated
              </div>
              <p
                className="text-[14px] leading-[1.6]"
                style={{ color: 'var(--fg-2)', maxWidth: '64ch' }}
              >
                That didn’t work this time — give it another go. If it keeps failing on a long
                meeting, switch to a smaller model in Settings.
              </p>
              <Button
                className="mt-1"
                onClick={startReprocess}
                disabled={reprocess.isPending || streamPhase !== 'idle'}
              >
                Generate notes
              </Button>
            </section>
          )}
          {streamPhase !== 'idle' ? (
            <StreamingView text={streamText} phase={streamPhase} chunkProgress={chunkProgress} />
          ) : activeReport ? (
            <section
              className="stream-markdown"
              data-testid="report-content"
              style={{ color: 'var(--fg-1)', maxWidth: '72ch' }}
            >
              <ReactMarkdown>{stripReasoning(activeReport.content)}</ReactMarkdown>
            </section>
          ) : (
            <div className="flex flex-col gap-9">
              {transcriptionFailed ? (
                <section
                  className="flex flex-col gap-2 rounded-lg p-4"
                  style={{
                    background: 'var(--surface-raised)',
                    border: '1px solid var(--border-subtle, var(--surface-raised))',
                  }}
                  data-testid="transcription-failed-notice"
                >
                  <div className="text-[15px] font-medium" style={{ color: 'var(--fg-1)' }}>
                    Transcription failed
                  </div>
                  <p
                    className="text-[14px] leading-[1.6]"
                    style={{ color: 'var(--fg-2)', maxWidth: '64ch' }}
                  >
                    No notes could be generated for this recording. Your audio was preserved (not
                    deleted), so nothing was lost.
                  </p>
                  {transcriptionError && (
                    <p
                      className="text-[12.5px] leading-[1.5]"
                      style={{ color: 'var(--fg-2)', opacity: 0.8 }}
                    >
                      Details: {transcriptionError}
                    </p>
                  )}
                </section>
              ) : isProcessing ? (
                <section
                  className="flex flex-col gap-2 rounded-lg p-4"
                  style={{
                    background: 'var(--surface-raised)',
                    border: '1px solid var(--border-subtle, var(--surface-raised))',
                  }}
                  data-testid="note-processing"
                >
                  <div
                    className="flex items-center gap-1.5 text-[15px] font-medium"
                    style={{ color: 'var(--fg-1)' }}
                  >
                    Finishing up
                    <span className="thinking-dot" />
                    <span className="thinking-dot" />
                    <span className="thinking-dot" />
                  </div>
                  <p
                    className="text-[14px] leading-[1.6]"
                    style={{ color: 'var(--fg-2)', maxWidth: '64ch' }}
                  >
                    {willGenerateNotes ? (
                      <>
                        Finishing your transcript in the background, then generating notes. You can
                        read and edit <strong>My notes</strong> now.
                      </>
                    ) : (
                      <>
                        Finishing your transcript in the background. You can read and edit{' '}
                        <strong>My notes</strong> now, and generate notes when it's done.
                      </>
                    )}
                  </p>
                </section>
              ) : summary ? (
                <section className="flex flex-col gap-3">
                  <SectionTitle>Summary</SectionTitle>
                  <div data-testid="tab-summary-content">
                    {summaryParagraphs.map((para, i) => {
                      const citation = summaryCitations[i];
                      return (
                        <p
                          key={i}
                          className="text-[15.5px] leading-[1.65]"
                          style={{ color: 'var(--fg-1)', maxWidth: '64ch' }}
                        >
                          <span>{para}</span>
                          {citation && (
                            <CitationButton
                              testId={`citation-summary-${i}`}
                              onJump={() => jumpToCitation(citation)}
                            />
                          )}
                        </p>
                      );
                    })}
                  </div>
                </section>
              ) : notesNotGenerated && meeting.transcript ? (
                <section
                  className="flex flex-col items-start gap-2 rounded-lg p-4"
                  style={{
                    background: 'var(--surface-raised)',
                    border: '1px solid var(--border-subtle, var(--surface-raised))',
                  }}
                  data-testid="no-notes-yet"
                >
                  <div className="text-[15px] font-medium" style={{ color: 'var(--fg-1)' }}>
                    No notes yet
                  </div>
                  <p
                    className="text-[14px] leading-[1.6]"
                    style={{ color: 'var(--fg-2)', maxWidth: '64ch' }}
                  >
                    This recording was transcribed but notes were not generated automatically. Use
                    the <strong>Generate notes</strong> button below to create them, or copy or save
                    the transcript from the actions above.
                  </p>
                </section>
              ) : (
                <p className="py-2 text-sm" style={{ color: 'var(--fg-2)' }}>
                  No summary available for this meeting.
                </p>
              )}

              {discussionAreas.length > 0 && (
                <section className="flex flex-col gap-3">
                  <SectionTitle>Key topics</SectionTitle>
                  <div className="mv-topics">
                    {discussionAreas.map((area, i) => (
                      <div key={i} className="flex flex-col gap-1">
                        <div className="mv-topic-title">{area.title}</div>
                        {area.analysis && <div className="mv-topic-body">{area.analysis}</div>}
                      </div>
                    ))}
                  </div>
                </section>
              )}

              {keyPoints.length > 0 && (
                <section className="flex flex-col gap-3">
                  <SectionTitle>Key points</SectionTitle>
                  <ul className="mv-bullets">
                    {keyPoints.map((p, i) => {
                      const citation = keyPointsCitations[i];
                      return (
                        <li key={i}>
                          <span>{p}</span>
                          {citation && (
                            <CitationButton
                              testId={`citation-key-points-${i}`}
                              onJump={() => jumpToCitation(citation)}
                            />
                          )}
                        </li>
                      );
                    })}
                  </ul>
                </section>
              )}

              {actionItems.length > 0 && (
                <section className="flex flex-col gap-3">
                  <SectionTitle>Action items</SectionTitle>
                  <ul className="mv-bullets">
                    {actionItems.map((a, i) => {
                      const citation = actionItemsCitations[i];
                      return (
                        <li key={i}>
                          <span>{a}</span>
                          {citation && (
                            <CitationButton
                              testId={`citation-action-items-${i}`}
                              onJump={() => jumpToCitation(citation)}
                            />
                          )}
                        </li>
                      );
                    })}
                  </ul>
                </section>
              )}

              {participants.length > 0 && (
                <section className="flex flex-col gap-3">
                  <SectionTitle>Participants</SectionTitle>
                  <div className="flex flex-wrap gap-1.5">
                    {participants.map((p, i) => (
                      <ChipV2 key={i}>{p}</ChipV2>
                    ))}
                  </div>
                </section>
              )}

              <SpeakerReviewPanel
                summaryFile={summaryFile}
                isDiarised={Boolean(meeting.is_diarised)}
                hasSpeakerSidecar={Boolean(meeting.has_speaker_sidecar)}
              />
            </div>
          )}
        </>
      )}

      {tab === 'notes' && (
        <MyNotesEditor summaryFile={routeSummaryFile} initialNotes={meeting.user_notes ?? ''} />
      )}

      <Dialog open={unshareOpen} onOpenChange={setUnshareOpen}>
        <DialogContent className="max-w-sm">
          <DialogHeader>
            <DialogTitle>
              Unshare from {orgSession.data?.signedIn ? orgSession.data.orgId : 'your org'}?
            </DialogTitle>
            <DialogDescription>
              The shared copy will be removed from your organisation. Your local note stays on this
              device. You can re-share at any time.
            </DialogDescription>
          </DialogHeader>
          {shareError && (
            <p className="text-sm" style={{ color: 'var(--danger)' }}>
              {shareError}
            </p>
          )}
          <DialogFooter>
            <DialogClose asChild>
              <Button variant="ghost">Cancel</Button>
            </DialogClose>
            <Button
              variant="destructive"
              disabled={isUnsharing}
              onClick={() => void onUnshareFromOrg()}
            >
              {isUnsharing ? 'Unsharing…' : 'Unshare'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <ConfirmDialog
        open={retranscribeOpen}
        onOpenChange={setRetranscribeOpen}
        title="Re-transcribe this recording?"
        description="This re-runs transcription with your current transcription settings, replacing the transcript and regenerating the summary."
        confirmLabel="Re-transcribe"
        isPending={retranscribe.isPending}
        onConfirm={() => {
          setRetranscribeOpen(false);
          startRetranscribe();
        }}
      />
    </article>
  );
}

// ---------------------------------------------------------------------------
// Subcomponents
// ---------------------------------------------------------------------------

/**
 * Summary / My notes tab switcher. My notes is always present (the note's own
 * notes layer survives regardless of summary state); a dot marks when notes
 * exist so the tab reads as non-empty without opening it.
 */
/**
 * Split toggle (Granola-style): one pill split into "My notes" (left) and a
 * template picker (right). The left switches to the notes editor; the right
 * shows the active summary/report view and drops a menu of Summary + generated
 * reports + "Generate from template". Replaces the old Summary/My-notes tabs +
 * the separate report switcher — one control for every view of the note.
 */
function NoteViewToggle({
  tab,
  onTab,
  hasNotes,
  activeReportId,
  reports,
  templates,
  onSelectReport,
  onDeleteReport,
  onGenerate,
  generating,
}: {
  tab: 'summary' | 'notes';
  onTab: (t: 'summary' | 'notes') => void;
  hasNotes: boolean;
  activeReportId: string | null;
  reports: Report[];
  templates: Template[];
  onSelectReport: (id: string | null) => void;
  onDeleteReport: (reportId: string) => void;
  onGenerate: (templateId: string) => void;
  generating: boolean;
}) {
  const [menuOpen, setMenuOpen] = React.useState(false);
  const [deleteTarget, setDeleteTarget] = React.useState<Report | null>(null);
  const notesActive = tab === 'notes';
  const summaryActive = tab === 'summary';
  const activeLabel =
    activeReportId === null
      ? 'Summary'
      : (reports.find((r) => r.id === activeReportId)?.template_name ?? 'Summary');

  const selectView = (id: string | null) => {
    setMenuOpen(false);
    onSelectReport(id);
    onTab('summary');
  };
  const generateView = (templateId: string) => {
    setMenuOpen(false);
    onGenerate(templateId);
    onTab('summary');
  };

  return (
    <div className="flex items-center" data-testid="note-view-toggle">
      <div
        role="tablist"
        aria-label="Note view"
        className="inline-flex items-stretch overflow-hidden rounded-full"
        style={{ border: '1px solid var(--border-subtle)' }}
      >
        {/* Left — My notes */}
        <button
          type="button"
          role="tab"
          aria-selected={notesActive}
          data-testid="tab-notes"
          onClick={() => onTab('notes')}
          className="inline-flex items-center gap-1.5 px-3 py-1 text-[13px] font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
          style={{
            background: notesActive ? 'var(--surface-active)' : 'transparent',
            color: notesActive ? 'var(--fg-1)' : 'var(--fg-2)',
          }}
        >
          <PencilLine className="size-[13px]" />
          My notes
          {hasNotes && !notesActive && (
            <span
              aria-hidden="true"
              className="size-1.5 rounded-full"
              style={{ background: 'var(--accent-primary)' }}
            />
          )}
        </button>
        <span aria-hidden="true" style={{ width: 1, background: 'var(--border-subtle)' }} />
        {/* Right — a split button: the label switches to the active summary/
            report view directly; only the chevron opens the template menu. */}
        <Popover open={menuOpen} onOpenChange={setMenuOpen}>
          {/* Anchor the menu to the WHOLE right segment (label + chevron) so it
              drops straight down from the Summary box, not off the tiny
              chevron. */}
          <PopoverAnchor asChild>
            <div
              className="inline-flex items-stretch"
              style={{ background: summaryActive ? 'var(--surface-active)' : 'transparent' }}
            >
              <button
                type="button"
                role="tab"
                aria-selected={summaryActive}
                data-testid="tab-summary"
                onClick={() => onTab('summary')}
                className="inline-flex items-center py-1 pl-3 pr-1.5 text-[13px] font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
                style={{ color: summaryActive ? 'var(--fg-1)' : 'var(--fg-2)' }}
              >
                {generating ? 'Generating…' : activeLabel}
              </button>
              <PopoverTrigger asChild>
                <button
                  type="button"
                  aria-label="Choose view or template"
                  data-testid="note-view-menu-trigger"
                  className="inline-flex items-center py-1 pl-0.5 pr-2.5 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring hover:text-[color:var(--fg-1)]"
                  style={{ color: 'var(--fg-2)' }}
                >
                  <ChevronDown className="size-[13px]" />
                </button>
              </PopoverTrigger>
            </div>
          </PopoverAnchor>
          <PopoverContent align="start" className="w-56 p-1" data-testid="note-view-menu">
            <ViewMenuItem
              selected={summaryActive && activeReportId === null}
              onClick={() => selectView(null)}
            >
              Summary
            </ViewMenuItem>
            {reports.map((r) => {
              const meta = [r.model, formatReportDate(r.created_at)].filter(Boolean).join(' · ');
              return (
                <div
                  key={r.id}
                  className="group flex items-center rounded-md transition-colors hover:bg-[color:var(--surface-hover)]"
                >
                  <button
                    type="button"
                    onClick={() => selectView(r.id)}
                    className="flex min-w-0 flex-1 flex-col items-start gap-0.5 px-3 py-2 text-left text-sm"
                    style={{ color: 'var(--fg-1)' }}
                    title={meta || undefined}
                  >
                    <span className="truncate">{r.template_name}</span>
                    {meta && (
                      <span className="text-[10.5px]" style={{ color: 'var(--fg-2)' }}>
                        {meta}
                      </span>
                    )}
                  </button>
                  <button
                    type="button"
                    aria-label={`Delete report ${r.template_name}`}
                    onClick={(e) => {
                      e.stopPropagation();
                      setDeleteTarget(r);
                    }}
                    className="mr-1.5 rounded-full p-1 opacity-0 transition-opacity hover:bg-[color:var(--danger-bg)] hover:text-[color:var(--danger)] group-hover:opacity-100"
                    style={{ color: 'var(--fg-2)' }}
                  >
                    <Trash2 className="size-[11px]" />
                  </button>
                </div>
              );
            })}
            {templates.length > 0 && (
              <>
                <div className="my-1 border-t" style={{ borderColor: 'var(--border-subtle)' }} />
                <div
                  className="px-3 pb-1 pt-1.5 text-[11px] font-medium"
                  style={{ color: 'var(--fg-muted)' }}
                >
                  Generate from template
                </div>
                {templates.map((t) => (
                  <button
                    key={t.id}
                    type="button"
                    disabled={generating}
                    onClick={() => generateView(t.id)}
                    data-testid="note-view-generate"
                    className="flex w-full items-center gap-2.5 rounded-md px-3 py-2 text-left text-sm transition-colors hover:bg-[color:var(--surface-hover)] disabled:opacity-50"
                    style={{ color: 'var(--fg-1)' }}
                  >
                    <FileText className="size-[13px] shrink-0" style={{ color: 'var(--fg-2)' }} />
                    <span className="truncate">{t.name}</span>
                  </button>
                ))}
              </>
            )}
          </PopoverContent>
        </Popover>
      </div>

      <ConfirmDialog
        open={!!deleteTarget}
        onOpenChange={(o) => !o && setDeleteTarget(null)}
        title={deleteTarget ? `Delete report "${deleteTarget.template_name}"?` : ''}
        description="This permanently deletes this generated report. The transcript and other reports are not affected."
        confirmLabel="Delete"
        destructive
        onConfirm={() => {
          if (!deleteTarget) return;
          onDeleteReport(deleteTarget.id);
          setDeleteTarget(null);
        }}
      />
    </div>
  );
}

function ViewMenuItem({
  selected,
  onClick,
  children,
}: {
  selected: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="flex w-full items-center justify-between gap-2 rounded-md px-3 py-2 text-left text-sm transition-colors hover:bg-[color:var(--surface-hover)]"
      style={{ color: 'var(--fg-1)', fontWeight: selected ? 600 : 400 }}
    >
      <span className="truncate">{children}</span>
      {selected && <Check className="size-[13px]" style={{ color: 'var(--fg-2)' }} />}
    </button>
  );
}

/**
 * My notes editor — an always-editable notes layer for the meeting, decoupled
 * from the AI summary (borrowed from meetily's separate meeting_notes store).
 * Autosaves the `## User Notes` section: debounced while typing and flushed on
 * blur/unmount. The textarea is the source of truth while focused, so a
 * background summary regenerate doesn't clobber in-progress typing.
 */
function MyNotesEditor({
  summaryFile,
  initialNotes,
}: {
  summaryFile: string;
  initialNotes: string;
}) {
  const [value, setValue] = React.useState(initialNotes);
  const save = useUpdateUserNotes();
  const timerRef = React.useRef<number | null>(null);
  const savedRef = React.useRef(initialNotes);
  const valueRef = React.useRef(value);
  valueRef.current = value;

  const flush = React.useCallback(() => {
    if (timerRef.current !== null) {
      window.clearTimeout(timerRef.current);
      timerRef.current = null;
    }
    if (valueRef.current === savedRef.current) return;
    savedRef.current = valueRef.current;
    save.mutate({ summaryFile, userNotes: valueRef.current });
  }, [save, summaryFile]);

  // Flush any pending edit on unmount (tab switch / navigation).
  React.useEffect(() => flush, [flush]);

  const onChange = (next: string) => {
    setValue(next);
    if (timerRef.current !== null) window.clearTimeout(timerRef.current);
    timerRef.current = window.setTimeout(flush, 800);
  };

  return (
    <section className="flex flex-col gap-2" data-testid="my-notes">
      <textarea
        value={value}
        onChange={(e) => onChange(e.target.value)}
        onBlur={flush}
        placeholder="Write notes…"
        spellCheck
        data-testid="my-notes-input"
        className="block w-full resize-none border-0 bg-transparent text-[15.5px] outline-none"
        style={{
          color: 'var(--fg-1)',
          fontFamily: 'var(--font-sans)',
          lineHeight: 1.65,
          minHeight: 360,
          maxWidth: '64ch',
        }}
      />
    </section>
  );
}

function SectionTitle({ children }: { children: React.ReactNode }) {
  return (
    <h2
      className="text-[13px] font-semibold tracking-[0.01em]"
      style={{
        color: 'var(--fg-2)',
        fontFamily: 'var(--font-sans)',
        margin: 0,
      }}
    >
      {children}
    </h2>
  );
}

interface ChipV2Props {
  icon?: React.ReactNode;
  children: React.ReactNode;
  onClick?: () => void;
  title?: string;
}

function ChipV2({ icon, children, onClick, title }: ChipV2Props) {
  return (
    <button
      type="button"
      className="mv-chip"
      onClick={onClick}
      title={title}
      style={onClick ? undefined : { cursor: 'default' }}
    >
      {icon}
      <span>{children}</span>
    </button>
  );
}

interface AttendeesChipProps {
  attendees: string[];
}

function AttendeesChip({ attendees }: AttendeesChipProps) {
  if (!attendees || attendees.length === 0) return null;

  const count = attendees.length;
  // "invited", not a bare count: the speaker-count chip sitting beside this one
  // also counts people, and two adjacent people-shaped counts with different
  // numbers (3 invited from the calendar, 1 speaker detected in the audio) read
  // as a contradiction rather than as two different facts.
  const label =
    count === 1
      ? attendees[0]
      : count === 2 && `${attendees[0]}, ${attendees[1]}`.length <= 32
        ? `${attendees[0]}, ${attendees[1]}`
        : `${count} invited`;

  const allNames = attendees.join(', ');

  return (
    <Popover>
      <PopoverTrigger asChild>
        <button
          type="button"
          className="mv-chip"
          data-testid="attendees-chip"
          title={allNames}
          aria-label={`Attendees: ${allNames}`}
        >
          <UserRoundCheck className="size-[11px]" />
          <span className="max-w-[200px] truncate">{label}</span>
        </button>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-64 p-2.5" data-testid="attendees-popover">
        <div
          className="pb-1.5 mb-1.5 text-[11.5px] font-medium tracking-[0.02em]"
          style={{
            color: 'var(--fg-muted)',
            borderBottom: '1px solid var(--border-subtle)',
          }}
        >
          Attendees ({count})
        </div>
        <ul className="max-h-56 overflow-y-auto space-y-1 text-[13px]" style={{ color: 'var(--fg-1)' }}>
          {attendees.map((name, i) => (
            <li key={i} className="truncate py-0.5" data-testid="attendee-item">
              {name}
            </li>
          ))}
        </ul>
      </PopoverContent>
    </Popover>
  );
}

const ActionIconButton = React.forwardRef<
  HTMLButtonElement,
  React.ButtonHTMLAttributes<HTMLButtonElement> & { label: string }
>(function ActionIconButton({ label, children, ...rest }, ref) {
  return (
    <button
      ref={ref}
      type="button"
      aria-label={label}
      className="inline-flex size-7 items-center justify-center rounded-md transition-colors hover:bg-[color:var(--surface-hover)] hover:text-[color:var(--fg-1)] disabled:opacity-50"
      style={{ color: 'var(--fg-2)' }}
      {...rest}
    >
      {children}
    </button>
  );
});

// ---------------------------------------------------------------------------
// Streaming view (kept in this file because StreamingView's pinned-indicator
// reads #ask-bar-slot dimensions; staying close to MeetingDetail keeps the
// scroll/position math explicit).
// ---------------------------------------------------------------------------

interface MarkdownBlock {
  type: 'heading' | 'bullet' | 'paragraph';
  text: string;
}

function parseMarkdownBlocks(text: string): MarkdownBlock[] {
  const lines = text.split('\n');
  const blocks: MarkdownBlock[] = [];
  let bulletBuffer: string[] = [];

  const flushBullets = () => {
    if (bulletBuffer.length === 0) return;
    bulletBuffer.forEach((t) => blocks.push({ type: 'bullet', text: t }));
    bulletBuffer = [];
  };

  for (const raw of lines) {
    const line = raw.trimEnd();
    if (/^#{1,3}\s+/.test(line)) {
      flushBullets();
      blocks.push({ type: 'heading', text: line.replace(/^#{1,3}\s+/, '') });
    } else if (/^[-*]\s+/.test(line)) {
      bulletBuffer.push(line.replace(/^[-*]\s+/, ''));
    } else if (line.trim() === '') {
      flushBullets();
    } else {
      flushBullets();
      blocks.push({ type: 'paragraph', text: line });
    }
  }
  flushBullets();
  return blocks.filter((b) => b.text.trim());
}

const CHAR_TRANSITION = 'top 0.12s ease-out';
const ROW_TRANSITION = 'top 0.35s cubic-bezier(0.45, 0, 0.55, 1)';

function StreamingView({
  text,
  phase,
  chunkProgress,
}: {
  text: string;
  phase: StreamPhase;
  chunkProgress?: { step: number; total: number } | null;
}) {
  const blocks = parseMarkdownBlocks(stripReasoning(text));
  const isStreaming = phase === 'analyzing' || phase === 'generating';

  const [prevBlocksCount, setPrevBlocksCount] = React.useState(blocks.length);
  const [firstNewIdx, setFirstNewIdx] = React.useState(blocks.length);
  if (blocks.length !== prevBlocksCount) {
    setFirstNewIdx(prevBlocksCount);
    setPrevBlocksCount(blocks.length);
  }

  const blocksContainerRef = React.useRef<HTMLDivElement>(null);
  const indicatorRef = React.useRef<HTMLDivElement>(null);
  const rowCountRef = React.useRef(blocks.length);
  const rowTransitionTimerRef = React.useRef<ReturnType<typeof setTimeout> | null>(null);
  const currentTransitionRef = React.useRef(CHAR_TRANSITION);
  const naturalTopRef = React.useRef(0);
  const isPinnedRef = React.useRef(false);

  const repositionIndicator = React.useCallback(() => {
    const container = blocksContainerRef.current;
    const indicator = indicatorRef.current;
    if (!container || !indicator) return;

    const containerRect = container.getBoundingClientRect();
    const naturalViewportTop = containerRect.top + naturalTopRef.current;
    const indicatorH = 44;
    const askBar = document.getElementById('ask-bar-slot');
    const clearance = (askBar ? askBar.offsetHeight : 80) + 8;
    const pinnedViewportTop = window.innerHeight - indicatorH - clearance;

    if (naturalViewportTop <= pinnedViewportTop) {
      if (isPinnedRef.current) {
        isPinnedRef.current = false;
        indicator.style.transition = 'none';
        indicator.style.position = 'absolute';
        indicator.style.top = `${naturalTopRef.current}px`;
        indicator.style.left = '-12px';
        indicator.style.right = '-12px';
        indicator.style.width = '';
        requestAnimationFrame(() =>
          requestAnimationFrame(() => {
            if (indicatorRef.current)
              indicatorRef.current.style.transition = currentTransitionRef.current;
          })
        );
        return;
      }
      indicator.style.position = 'absolute';
      indicator.style.top = `${naturalTopRef.current}px`;
      indicator.style.left = '-12px';
      indicator.style.right = '-12px';
      indicator.style.width = '';
    } else {
      if (!isPinnedRef.current) {
        isPinnedRef.current = true;
        indicator.style.transition = 'none';
      }
      indicator.style.position = 'fixed';
      indicator.style.top = `${pinnedViewportTop}px`;
      indicator.style.left = `${containerRect.left - 12}px`;
      indicator.style.right = 'auto';
      indicator.style.width = `${container.offsetWidth + 24}px`;
    }
  }, []);

  React.useLayoutEffect(() => {
    const container = blocksContainerRef.current;
    const indicator = indicatorRef.current;
    if (!container || !indicator) return;

    const newTop = container.offsetHeight;
    const isNewRow = blocks.length !== rowCountRef.current;

    if (isNewRow) {
      rowCountRef.current = blocks.length;
      currentTransitionRef.current = ROW_TRANSITION;
      if (rowTransitionTimerRef.current) clearTimeout(rowTransitionTimerRef.current);
      rowTransitionTimerRef.current = setTimeout(() => {
        currentTransitionRef.current = CHAR_TRANSITION;
        if (indicatorRef.current && !isPinnedRef.current) {
          indicatorRef.current.style.transition = CHAR_TRANSITION;
        }
      }, 360);
    }

    naturalTopRef.current = newTop;
    if (!isPinnedRef.current) {
      indicator.style.transition = currentTransitionRef.current;
    }
    repositionIndicator();
  });

  React.useEffect(() => {
    if (!isStreaming) return;
    window.addEventListener('scroll', repositionIndicator, { passive: true });
    return () => window.removeEventListener('scroll', repositionIndicator);
  }, [isStreaming, repositionIndicator]);

  React.useEffect(
    () => () => {
      if (rowTransitionTimerRef.current) clearTimeout(rowTransitionTimerRef.current);
    },
    []
  );

  const indicatorLabel = chunkProgress
    ? `Summarising part ${chunkProgress.step}/${chunkProgress.total}`
    : phase === 'analyzing'
      ? 'Analysing transcript'
      : 'Generating notes';

  return (
    <div className="relative">
      <div ref={blocksContainerRef} className="space-y-4">
        {blocks.map((block, i) => {
          const animate = i >= firstNewIdx;
          if (block.type === 'heading') {
            return <SectionTitle key={i}>{block.text}</SectionTitle>;
          }
          if (block.type === 'bullet') {
            return (
              <div key={i} className={cn('flex gap-2', animate && 'animate-fade-in')}>
                <span className="mt-[0.45em] size-1 flex-shrink-0 rounded-full bg-[color:var(--fg-2)]" />
                <p className="text-sm leading-[1.65]" style={{ color: 'var(--fg-1)' }}>
                  {block.text}
                </p>
              </div>
            );
          }
          return (
            <p
              key={i}
              className={cn('text-[15px] leading-[1.7]', animate && 'animate-fade-in')}
              style={{ color: 'var(--fg-1)' }}
            >
              {block.text}
            </p>
          );
        })}
      </div>
      {isStreaming && (
        <div
          ref={indicatorRef}
          className="pointer-events-none absolute -left-3 -right-3 flex h-11 items-center gap-2 rounded-lg px-3"
          style={{
            top: 0,
            background: 'var(--surface-raised)',
            boxShadow: 'var(--shadow-md)',
          }}
        >
          <span
            className="inline-block size-3 animate-spin-fast rounded-full border-2 border-transparent"
            style={{ borderTopColor: 'var(--fg-2)' }}
          />
          <span className="text-xs" style={{ color: 'var(--fg-1)' }}>
            {indicatorLabel}
          </span>
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Folder picker (meeting → folder assignment via the chip dropdown)
// ---------------------------------------------------------------------------

const FOLDER_NONE = '__none__';
const FOLDER_NEW = '__new__';

function FolderPicker({
  summaryFile,
  assignedFolderIds,
}: {
  summaryFile: string;
  assignedFolderIds: string[];
}) {
  const folders = useFolders();
  const addMeeting = useAddMeetingToFolder();
  const removeMeeting = useRemoveMeetingFromFolder();
  const createFolder = useCreateFolder();
  const [newFolderName, setNewFolderName] = React.useState('');
  const [creatingFolder, setCreatingFolder] = React.useState(false);
  const [folderError, setFolderError] = React.useState<string | null>(null);
  const newFolderInputRef = React.useRef<HTMLInputElement>(null);

  const allFolders = folders.data ?? [];
  const serverFolderId = assignedFolderIds[0] ?? null;
  const [localFolderId, setLocalFolderId] = React.useState<string | null>(serverFolderId);
  const [prevServerFolderId, setPrevServerFolderId] = React.useState<string | null>(serverFolderId);
  if (serverFolderId !== prevServerFolderId) {
    setPrevServerFolderId(serverFolderId);
    setLocalFolderId(serverFolderId);
  }

  const currentFolder = allFolders.find((f) => f.id === localFolderId) ?? null;

  const assignFolder = async (nextFolderId: string | null) => {
    const previousFolderId = localFolderId;
    if (previousFolderId === nextFolderId) return;

    setFolderError(null);
    setLocalFolderId(nextFolderId);

    try {
      if (previousFolderId && nextFolderId) {
        await addMeeting.mutateAsync({ summaryFile, folderId: nextFolderId });
        try {
          await removeMeeting.mutateAsync({ summaryFile, folderId: previousFolderId });
        } catch (error) {
          await removeMeeting.mutateAsync({ summaryFile, folderId: nextFolderId }).catch(() => {
            // Query invalidation from the mutation hooks will restore server state.
          });
          throw error;
        }
        return;
      }

      if (previousFolderId) {
        await removeMeeting.mutateAsync({ summaryFile, folderId: previousFolderId });
      }
      if (nextFolderId) {
        await addMeeting.mutateAsync({ summaryFile, folderId: nextFolderId });
      }
    } catch (error) {
      setLocalFolderId(previousFolderId);
      setFolderError(getErrorMessage(error));
    }
  };

  const handleValueChange = (value: string) => {
    if (value === FOLDER_NEW) {
      setFolderError(null);
      setCreatingFolder(true);
      setTimeout(() => newFolderInputRef.current?.focus(), 50);
      return;
    }
    void assignFolder(value === FOLDER_NONE ? null : value);
  };

  const submitNewFolder = async () => {
    const name = newFolderName.trim();
    if (!name) {
      setCreatingFolder(false);
      setFolderError(null);
      return;
    }
    setFolderError(null);

    try {
      const result = await createFolder.mutateAsync({ name });
      setNewFolderName('');
      setCreatingFolder(false);
      await assignFolder(result.folder.id);
    } catch (error) {
      setFolderError(getErrorMessage(error));
    }
  };

  if (creatingFolder) {
    return (
      <div className="space-y-1">
        <div className="inline-flex h-9 items-center gap-1 rounded-md border border-border px-3 text-sm">
          <input
            ref={newFolderInputRef}
            value={newFolderName}
            onChange={(e) => setNewFolderName(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault();
                void submitNewFolder();
              }
              if (e.key === 'Escape') {
                setNewFolderName('');
                setFolderError(null);
                setCreatingFolder(false);
              }
            }}
            onBlur={() => void submitNewFolder()}
            placeholder="Folder name..."
            className="w-28 bg-transparent outline-none placeholder:text-muted-foreground"
          />
        </div>
        {folderError && <p className="text-xs text-destructive">{folderError}</p>}
      </div>
    );
  }

  const currentFolderLabel = currentFolder?.name ?? 'Add to folder';

  return (
    <div className="space-y-1">
      <Select value={localFolderId ?? FOLDER_NONE} onValueChange={handleValueChange}>
        <SelectPrimitive.Trigger asChild>
          <button type="button" className="mv-chip">
            {currentFolderLabel}
          </button>
        </SelectPrimitive.Trigger>
        <SelectContent align="start">
          <SelectItem value={FOLDER_NONE}>No folder</SelectItem>
          <SelectSeparator />
          {allFolders.map((f) => (
            <SelectItem key={f.id} value={f.id}>
              {f.name}
            </SelectItem>
          ))}
          <SelectSeparator />
          <SelectItem value={FOLDER_NEW}>New folder...</SelectItem>
        </SelectContent>
      </Select>
      {folderError && <p className="text-xs text-destructive">{folderError}</p>}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Pure formatting / parsing helpers
// ---------------------------------------------------------------------------

function formatDetailDate(info: {
  processed_at?: string;
  updated_at?: string;
}): string | undefined {
  const raw = info.processed_at ?? info.updated_at;
  if (!raw) return undefined;
  const d = new Date(raw);
  if (Number.isNaN(d.getTime())) return undefined;
  return d.toLocaleString(undefined, {
    weekday: 'short',
    month: 'short',
    day: 'numeric',
    year: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  });
}

// Compact date for the report-pill secondary line (e.g. "Jun 23"). Kept
// terser than formatDetailDate so the pill stays small.
function formatReportDate(raw?: string): string | undefined {
  if (!raw) return undefined;
  const d = new Date(raw);
  if (Number.isNaN(d.getTime())) return undefined;
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

function formatDuration(seconds?: number): string | undefined {
  if (!seconds || seconds <= 0) return undefined;
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = seconds % 60;
  if (h > 0) return `${h}h ${m}m`;
  if (m > 0) return `${m}m`;
  return `${s}s`;
}

function asStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((v) => {
      if (typeof v === 'string') return v;
      if (typeof v !== 'object' || v === null) return '';
      const obj = v as Record<string, unknown>;
      const desc = typeof obj.description === 'string' ? obj.description : '';
      const owner = typeof obj.owner === 'string' ? obj.owner : '';
      if (desc) return owner ? `${owner}: ${desc}` : desc;
      if (typeof obj.text === 'string') return obj.text;
      if (typeof obj.name === 'string') return obj.name;
      return '';
    })
    .filter(Boolean);
}

interface DiscussionArea {
  title: string;
  analysis?: string;
}

function asDiscussionAreas(value: unknown): DiscussionArea[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((v): DiscussionArea | null => {
      if (typeof v === 'string') return { title: v };
      if (typeof v !== 'object' || v === null) return null;
      const obj = v as Record<string, unknown>;
      const title = typeof obj.title === 'string' ? obj.title : '';
      const analysis = typeof obj.analysis === 'string' ? obj.analysis : undefined;
      if (!title && !analysis) return null;
      return { title: title || 'Discussion topic', analysis };
    })
    .filter((v): v is DiscussionArea => v !== null);
}

function getErrorMessage(error: unknown): string {
  if (error instanceof Error && error.message) return error.message;
  if (typeof error === 'string' && error.trim()) return error;
  return 'Something went wrong.';
}

/** Pick which transcript flavour to ship to org. Diarised text (with
 *  [You]/[Others] tags) preferred when available so org viewers get the
 *  speaker-attributed view; falls back to the plain transcript. Returns
 *  an empty string for meetings with no transcript at all, which the
 *  upload path treats as "skip the second presign+PUT". Kept here next
 *  to composeShareBody so manual-share (MeetingDetail) and auto-backup
 *  (useRecording) can't drift out of sync. */
export function pickTranscriptForShare(meeting: Meeting): string {
  if (meeting.is_diarised && meeting.diarised_text) return meeting.diarised_text;
  return meeting.transcript ?? '';
}

/** Compose the markdown body that will be uploaded to S3 when sharing
 *  a local note. Mirrors what the local note view renders (minus the raw
 *  transcript) so colleagues see the same structured summary. */
export function composeShareBody(meeting: Meeting): string {
  const sections: string[] = [];

  const summary = meeting.summary ? stripReasoning(meeting.summary).trim() : undefined;
  if (summary) {
    sections.push(`## Summary\n\n${summary}`);
  }

  const topics = asDiscussionAreas(meeting.discussion_areas);
  if (topics.length) {
    const block = topics
      .map((t) => {
        const title = (t.title || '').trim();
        const analysis = (t.analysis || '').trim();
        if (title && analysis) return `### ${title}\n\n${analysis}`;
        return `### ${title || analysis}`;
      })
      .join('\n\n');
    sections.push(`## Key topics\n\n${block}`);
  }

  const keyPoints = (meeting.key_points ?? []).filter(Boolean);
  if (keyPoints.length) {
    sections.push(`## Key points\n\n${keyPoints.map((kp) => `- ${kp}`).join('\n')}`);
  }

  const actionItems = asStringArray(meeting.action_items);
  if (actionItems.length) {
    sections.push(`## Action items\n\n${actionItems.map((ai) => `- ${ai}`).join('\n')}`);
  }

  // Deliberately do NOT fall back to meeting.transcript here: the raw
  // transcript is excluded from shared notes by design (limits blast radius
  // if the bucket is ever leaked, and matches what local meeting views
  // already show in the body — summary, not transcript). If every structured
  // field is empty, return empty rather than secretly upload the transcript.
  return sections.join('\n\n');
}

function applyCitationHighlight(el: HTMLElement) {
  el.setAttribute('data-citation-highlight', 'true');
  const bubble = (el.querySelector('.rounded-2xl') as HTMLElement) || el;
  const prevOutline = bubble.style.outline;
  const prevBg = bubble.style.backgroundColor;
  const prevTransition = bubble.style.transition;

  bubble.style.transition = 'all 0.2s ease';
  bubble.style.outline = '2px solid var(--fg-1, #1B1B19)';
  bubble.style.backgroundColor = 'var(--surface-active, #EFEBE1)';

  setTimeout(() => {
    bubble.style.transition = 'all 0.8s ease';
    bubble.style.outline = prevOutline;
    bubble.style.backgroundColor = prevBg;
    el.removeAttribute('data-citation-highlight');
    setTimeout(() => {
      bubble.style.transition = prevTransition;
    }, 800);
  }, 2000);
}

function CitationButton({
  testId,
  onJump,
}: {
  testId: string;
  onJump: () => void;
}) {
  return (
    <button
      type="button"
      data-testid={testId}
      onClick={(e) => {
        e.stopPropagation();
        onJump();
      }}
      // Not "Show transcript…": that is the accessible name of the Ask-bar and
      // pill transcript toggles, and an unscoped by-role lookup would match
      // both this and them.
      aria-label="Jump to transcript evidence"
      title="Jump to transcript evidence"
      className="inline-flex items-center justify-center size-5 ml-1.5 align-middle rounded text-[color:var(--fg-muted)] hover:text-[color:var(--fg-1)] hover:bg-[color:var(--surface-hover)] focus-visible:ring-1 focus-visible:ring-[color:var(--focus-ring)] transition-colors cursor-pointer"
    >
      <Search className="size-3" aria-hidden="true" />
    </button>
  );
}
