import * as React from 'react';

import { useTheme } from '@/hooks/useTheme';
import { Sandbox } from '@/routes/Sandbox';
import { Settings } from '@/routes/Settings';
import { Setup } from '@/routes/Setup';
import { Chat } from '@/routes/Chat';
import { ChatConversation } from '@/routes/ChatConversation';
import { People } from '@/routes/People';
import { StreamingProvider } from '@/hooks/useStreamingQuery';
import { Home } from '@/routes/Home';
import { MeetingDetail } from '@/routes/MeetingDetail';
import { FolderDetail } from '@/routes/FolderDetail';
import { OrgShared, OrgSharedDetail } from '@/routes/OrgShared';
import { useOrgSession, useSharedNotesGate } from '@/hooks/useOrg';
import { Recording } from '@/routes/Recording';
import { Processing, ProcessingDock } from '@/routes/Processing';
import { TranscriptBar } from '@/components/AskBar';
import { GenerateNotesBar } from '@/components/GenerateNotesBar';
import { BottomDockSlot } from '@/components/BottomDockSlot';
import { PrimaryDock } from '@/components/PrimaryDock';
import { useLiveTranscriptOpen } from '@/hooks/liveTranscriptOpenStore';
import { QuitDialog } from '@/components/QuitDialog';
import { PrivacyConsentModal } from '@/components/PrivacyConsentModal';
import { usePrivacyNoticeSeen } from '@/hooks/useSettings';
import { ImportDropZone } from '@/components/ImportDropZone';
import { CommandPaletteProvider, useCommandPalette } from '@/components/CommandPalette';
import { AskBarProvider } from '@/lib/askBarContext';
import {
  useRecording,
  useRecordingEvents,
  useRecordingProcessingEffects,
} from '@/hooks/useRecording';
import { useSystemAudioCapture } from '@/hooks/useSystemAudioCapture';
import { useCalendarEvents, useCalendarAuthBus } from '@/hooks/useCalendarEvents';
import { navigate, useRoute, rememberNonSettingsRoute } from '@/lib/router';
import { ipc } from '@/lib/ipc';
import { primeDebugLogs } from '@/lib/debugLogs';

export function App() {
  useTheme();
  const route = useRoute();

  // One-time privacy disclosure for upgraders. Show it only when the marker is
  // explicitly false (existing install predating telemetry/launch-on-login) and
  // we're NOT on /setup — an upgrader who also lacks a model lands on onboarding,
  // which discloses the same toggles and marks the notice seen on exit
  // (Setup.finishOnboarding), so we don't double up. A config-but-no-model
  // upgrader can see the modal for a sub-second frame before the async /setup
  // redirect lands; accepted as cosmetic for that rare state (the redirect and
  // onboarding's mark-seen still make it correct).
  const privacyNotice = usePrivacyNoticeSeen();
  const showPrivacyModal = privacyNotice.data === false && route !== '/setup';

  React.useLayoutEffect(() => {
    if (typeof window !== 'undefined' && window.stenoai) {
      ipc().window.readyToShow();
      // Deterministic launch gate for e2e: the suite waits on [data-app-ready]
      // instead of a fixed timeout. Set alongside the existing readiness signal
      // so there is one readiness path with two observers (main + Playwright).
      document.documentElement.dataset.appReady = '1';
    }
  }, []);

  // Reflect the resolved privacy-gate value onto the root element so e2e can
  // deterministically wait for the query to settle (data-privacy-gate="true"
  // means the notice was already seen) before asserting the modal's absence,
  // instead of racing a not-yet-resolved query. Mirrors the data-app-ready
  // readiness signal; no effect on production behaviour.
  React.useEffect(() => {
    if (privacyNotice.data === undefined) return;
    document.documentElement.dataset.privacyGate = String(privacyNotice.data);
  }, [privacyNotice.data]);



  React.useEffect(() => {
    if (typeof window === 'undefined' || !window.stenoai) return;
    const off = [
      ipc().on.trayOpenSettings(() => navigate('/settings')),
      ipc().on.setupFlowTriggered(() => navigate('/setup')),
      // Capture backend debug-log lines from app start (not just when Settings
      // → Developer is open) so the console always has the full session.
      primeDebugLogs((cb) => ipc().on.debugLog(cb)),
    ];
    return () => off.forEach((fn) => fn());
  }, []);

  useRecordingEvents();
  useRecordingProcessingEffects();
  useSystemAudioCapture();
  // Mount the calendar query at the App level so its 2 min polling and
  // window-focus refetch keep ticking across route changes. Without this
  // the subscription unmounts whenever the user navigates away from Home
  // (or Settings, which is the other consumer), and the user comes back
  // to a cache that's only as fresh as the last visit. Home.tsx /
  // Settings.tsx still call useCalendarEvents() — React Query shares the
  // observer + cache, so this is one query, not three.
  useCalendarEvents();
  // Auth-change → cache-invalidate bus. Mounted ONCE here at App level
  // so we have one set of googleAuthChanged + outlookAuthChanged
  // subscribers, not one per useCalendarEvents() caller (App + Home +
  // Settings would otherwise each register their own pair and fire
  // invalidateQueries N times per auth event).
  useCalendarAuthBus();

  // Track the last non-settings route so the sidebar Settings toggle and the
  // Settings page's Back button can return the user to where they came from
  // (e.g. a meeting they were viewing) instead of dropping them on Home.
  React.useEffect(() => {
    rememberNonSettingsRoute(route);
  }, [route]);

  // Cold-reload mid-processing: if we restart the app while the backend is
  // still summarizing, drop the user on /meetings/processing so they don't
  // sit on Home wondering what happened. Only fires once on first render.
  const recording = useRecording();

  // Reset the inline transcript panel to closed on every new recording
  // session. Without this, a user who opened the panel in session A would
  // start session B with the panel already expanded — the store survives
  // session boundaries by design (zustand isn't React-tree-scoped), so we
  // explicitly reset it here at the App level when sessionName changes.
  const setLiveTranscriptOpen = useLiveTranscriptOpen((s) => s.setOpen);
  const lastSessionRef = React.useRef<string | null>(null);
  React.useEffect(() => {
    if (recording.sessionName !== lastSessionRef.current) {
      lastSessionRef.current = recording.sessionName ?? null;
      setLiveTranscriptOpen(false);
    }
  }, [recording.sessionName, setLiveTranscriptOpen]);

  const didAutoRouteRef = React.useRef(false);
  React.useEffect(() => {
    if (didAutoRouteRef.current) return;
    if (recording.isLoading) return;
    didAutoRouteRef.current = true;
    if (
      recording.status === 'processing' &&
      (route === '/' || route === '' || route === '/meetings')
    ) {
      navigate('/meetings/processing');
    }
    // No recording/paused branch: recording coexists with the app (the pill
    // docks next to the Ask bar wherever the user is), so a cold reload
    // mid-recording stays put instead of being yanked to a takeover route.
  }, [recording.isLoading, recording.status, route]);

  // First-run onboarding: auto-open the setup wizard when no transcription
  // model is installed yet (Parakeet or any Whisper). This was wired in the
  // pre-React renderer and dropped in the rewrite. parakeet-status /
  // whisper-list read on-disk state (no running service needed), so it's a
  // reliable "needs setup" signal. We only redirect from a neutral landing
  // route and never while recording/processing, so we don't yank the user out
  // of anything in flight. Runs once.
  const didSetupGateRef = React.useRef(false);
  React.useEffect(() => {
    if (didSetupGateRef.current) return;
    if (recording.isLoading) return;
    const onNeutralRoute = route === '/' || route === '' || route === '/meetings';
    const busy =
      recording.status === 'recording' ||
      recording.status === 'paused' ||
      recording.status === 'processing';
    if (!onNeutralRoute || busy) return;
    didSetupGateRef.current = true;
    (async () => {
      try {
        const [parakeet, whisper] = await Promise.all([
          ipc().parakeetModels.status(),
          ipc().whisperModels.list(),
        ]);
        const parakeetInstalled = parakeet.success && parakeet.installed === true;
        const anyWhisperInstalled =
          whisper.success &&
          Object.values(whisper.supported_models ?? {}).some(
            (m) => (m as { installed?: boolean }).installed === true,
          );
        if (!parakeetInstalled && !anyWhisperInstalled) {
          navigate('/setup');
        }
      } catch {
        // Best-effort onboarding gate; never block the app on it.
      }
    })();
  }, [recording.isLoading, recording.status, route]);

  const isProcessingRoute = route === '/meetings/processing';
  // The /chat page has its own large composer, so the floating AskBar dock
  // would just stack a second redundant input below the same page. The
  // sub-route /chat/<id> (conversation view) also owns its own composer.
  // Note: no /recording exclusion — recording coexists with the app, and
  // during it PrimaryDock renders the Ask bar disabled next to the pill.
  const isChatRoute = route === '/chat' || route.startsWith('/chat/');
  // App-chrome routes where a chat composer never belongs. When idle the
  // AskBar self-hides there anyway (no active meeting), but the disabled
  // recording shell renders even without one — without this exclusion it
  // would float over Settings/Setup and block clicks in that band; the
  // pill docks alone there instead.
  const isChromeRoute =
    route === '/settings' ||
    route.startsWith('/settings?') ||
    route === '/setup' ||
    route === '/dev' ||
    route.startsWith('/dev/');
  const showAskBar = !isProcessingRoute && !isChatRoute && !isChromeRoute;
  const recordingActive =
    recording.status === 'recording' || recording.status === 'paused';

  return (
    <CommandPaletteProvider>
      <CommandPaletteHotkey />
      <StreamingProvider>
      <AskBarProvider>
        <RouteView route={route} />
        <QuitDialog />
        <PrivacyConsentModal open={showPrivacyModal} />
        <ImportDropZone />

        {/* Bottom dock — shared anchor across recording → processing → meeting.
            Recording is status-driven, not route-driven: PrimaryDock docks the
            transcription pill next to a disabled Ask bar while a recording is
            active (or swaps in the expanded LiveTranscriptBar), and falls back
            to the plain Ask bar when idle. Processing owns the slot on its
            route — UNLESS a new recording is active (back-to-back notes: note
            A processing while note B records); the recording's pill + Stop
            must stay reachable everywhere, so recording wins the slot. */}
        <BottomDockSlot>
          {isProcessingRoute && !recordingActive ? (
            <ProcessingDock />
          ) : (
            <PrimaryDock showAskBar={showAskBar} />
          )}
        </BottomDockSlot>

        {/* Transcript — floats above the chat bar (only on real meeting routes).
            Coexistence invariant: both 72-band panels self-gate on a *saved*
            meeting (activeSummaryFile), and the note being recorded is unsaved
            — so during a recording they can only ever concern a saved meeting
            the user is viewing, never fight the live pill row below. */}
        {showAskBar && (
          <BottomDockSlot bottomOffset={72}>
            <TranscriptBar />
          </BottomDockSlot>
        )}

        {/* Generate-notes CTA — floats just above the chat bar for a
            transcript-only note (auto-summarise off). Self-hides when notes
            exist or the transcript panel is open. Shares the bottomOffset={72}
            band with TranscriptBar above; the two stay non-overlapping because
            they're mutually exclusive on `transcriptOpen` (TranscriptBar shows
            only when open, this hides when open) — keep that invariant if either
            gate changes. */}
        {showAskBar && (
          <BottomDockSlot bottomOffset={72}>
            <GenerateNotesBar />
          </BottomDockSlot>
        )}
      </AskBarProvider>
      </StreamingProvider>
    </CommandPaletteProvider>
  );
}

/** Global ⌘K → open the command palette. Capture-phase so it fires even when
 *  focus is in a form control. */
function CommandPaletteHotkey() {
  const { open } = useCommandPalette();
  React.useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!(e.metaKey || e.ctrlKey) || e.key.toLowerCase() !== 'k') return;
      e.preventDefault();
      open();
    };
    document.addEventListener('keydown', onKey, true);
    return () => document.removeEventListener('keydown', onKey, true);
  }, [open]);
  return null;
}

function RouteView({ route }: { route: string }) {
  // Enterprise can hide the Shared notes feature. Gate the /org/shared
  // routes on it so a stale nav or deep-link can't reach the browse view
  // or its detail (the detail is what wires the cross-folder AskBar chat).
  const orgSession = useOrgSession();
  const sharedNotes = useSharedNotesGate(orgSession.data?.signedIn ?? false);

  // If we're sitting on a Shared notes route that policy has now resolved as
  // disabled, redirect to Home rather than rendering Home in place — keeps
  // the URL and content in agreement (and the sidebar active-state correct).
  // Gated on `resolved` so this only fires once we *know* it's disabled, not
  // during the initial load. Effect, never navigate() during render.
  const onOrgSharedRoute = route === '/org/shared' || route.startsWith('/org/shared/');
  React.useEffect(() => {
    if (onOrgSharedRoute && sharedNotes.resolved && !sharedNotes.enabled) {
      navigate('/');
    }
  }, [onOrgSharedRoute, sharedNotes.resolved, sharedNotes.enabled]);

  if (route === '/dev' || route.startsWith('/dev/')) return <Sandbox />;
  // Match deep-links like /settings?tab=organisation too — the Settings
  // component reads the tab param off the route on mount.
  if (route === '/settings' || route.startsWith('/settings?')) return <Settings />;
  if (route === '/setup') return <Setup />;
  if (route === '/recording') return <Recording />;
  if (route === '/chat') return <Chat />;
  if (route.startsWith('/chat/')) {
    const sessionId = safeDecode(route.slice('/chat/'.length));
    return <ChatConversation sessionId={sessionId} />;
  }
  if (route === '/people' || route.startsWith('/people/')) return <People />;
  if (route === '/meetings/processing') return <Processing />;
  if (route.startsWith('/meetings/')) {
    const summaryFile = safeDecode(route.slice('/meetings/'.length));
    return <MeetingDetail summaryFile={summaryFile} />;
  }
  if (route.startsWith('/folders/')) {
    const folderId = safeDecode(route.slice('/folders/'.length));
    return <FolderDetail folderId={folderId} />;
  }
  if (route === '/org/shared' || route.startsWith('/org/shared/')) {
    // Not yet known-enabled (still loading, or disabled): show Home. The
    // effect above redirects to '/' once the policy resolves to disabled.
    if (!sharedNotes.enabled) return <Home mode="home" />;
    if (route === '/org/shared') return <OrgShared />;
    const id = safeDecode(route.slice('/org/shared/'.length));
    return <OrgSharedDetail id={id} />;
  }
  if (route === '/meetings') return <Home mode="meetings" />;
  return <Home mode="home" />;
}

// Tolerate malformed % escapes — a bad route shouldn't crash the renderer.
function safeDecode(s: string): string {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
}
