import * as React from 'react';
import { Check, ExternalLink, Loader2, X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { ipc } from '@/lib/ipc';
import { useAppVersion } from '@/hooks/useSettings';
import { COMPACT_BTN, SettingRow } from './primitives';
import { useTranslation } from '@/i18n';
/** Plain external-link text (matches TemplatesTab's "learn more" link) for
 *  rows that just navigate out, rather than a bordered Button — keeps the
 *  bordered-button treatment reserved for in-page actions (Check for
 *  Updates, Restart to Update). */
function ExternalLinkAction({ label, onClick }: { label: string; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="inline-flex items-center gap-1 text-[13px] underline underline-offset-2 hover:no-underline"
      style={{ color: 'var(--fg-1)' }}
    >
      {label}
      <ExternalLink className="size-3" />
    </button>
  );
}

// docs.stenoai.co/changelog (not github.com), so these go through the
// generic shell.openExternal channel rather than updates.openReleasePage,
// which is locked to the github.com origin (see main.js's open-release-page
// handler) for the contextual "View release" button below.
const CHANGELOG_URL = 'https://docs.stenoai.co/changelog';
const DISCORD_URL = 'https://discord.gg/DZ6vcQnxxu';
const GITHUB_URL = 'https://github.com/stenolabs/stenoai';
const TERMS_URL = 'https://stenoai.co/terms.html';
const PRIVACY_URL = 'https://stenoai.co/privacy.html';

type CheckState =
  | { kind: 'idle' }
  | { kind: 'checking' }
  | { kind: 'error'; message: string }
  | { kind: 'up-to-date' }
  | { kind: 'update-available'; version: string; releaseUrl: string }
  // An update exists on GitHub but this Mac is below the 14.4 launch floor, so
  // it can't be installed here (#432). We explain it rather than offer a broken
  // "View release" download nudge.
  | { kind: 'update-blocked-os'; version: string };

export function AboutTab() {
  const { t } = useTranslation();
  const version = useAppVersion();
  const [checkState, setCheckState] = React.useState<CheckState>({ kind: 'idle' });
  const [downloadPercent, setDownloadPercent] = React.useState<number | null>(null);
  const [downloadedVersion, setDownloadedVersion] = React.useState<string | null>(null);
  const [downloadError, setDownloadError] = React.useState<string | null>(null);
  // Guards against a stale getStatus() response (below) re-opening the
  // progress bar after the download has already reached a terminal state.
  // Both the live 'update-downloaded'/'update-error' events and getStatus()
  // set this — whichever observes completion first wins, and once true a
  // later-arriving percent-only snapshot is ignored rather than merged.
  const settledRef = React.useRef(false);
  // Separate from settledRef, which is about the progress bar. Every
  // authoritative write to the banner bumps this: the live update-error and
  // update-error-cleared events, and the re-read after a manual check. The
  // mount-time getStatus() below captures it before its request and drops its
  // own reply if anything has written since — main answers with the state as of
  // the REQUEST, so a newer write has to win regardless of which reply lands
  // last. Without it, a stale reply's `e ?? persisted` merge sees the cleared
  // null and puts the settled failure straight back on screen.
  const errorSeqRef = React.useRef(0);

  React.useEffect(() => {
    const offAvailable = ipc().on.updateAvailable(() => {
      // Confirms the real background updater has started fetching this
      // version — the progress bar below is about to start moving.
      //
      // Deliberately does NOT clear the banner: main keeps a sticky failure
      // through this event, because finding a version proves the feed was
      // readable and nothing else. Clearing here would hide a failure main
      // still holds, and a remount would bring it straight back.
      settledRef.current = false;
      setDownloadPercent((p) => p ?? 0);
    });
    const offProgress = ipc().on.updateDownloadProgress((evt) => {
      // Bytes are actually arriving — that is what disproves a full disk or a
      // permission problem, so this is where main clears both kinds and where
      // the banner goes with them.
      errorSeqRef.current += 1;
      setDownloadError(null);
      setDownloadPercent(evt.percent);
    });
    const offDownloaded = ipc().on.updateDownloaded((evt) => {
      settledRef.current = true;
      // Main clears the failure here too (both kinds — the bytes are on disk).
      // Usually download-progress got there first, but a resumed or cached
      // transfer can make this the first event this tab sees, and then the
      // banner would sit next to "Restart to Update".
      errorSeqRef.current += 1;
      setDownloadError(null);
      setDownloadPercent(null);
      setDownloadedVersion(evt.version);
    });
    const offError = ipc().on.updateError((evt) => {
      settledRef.current = true;
      errorSeqRef.current += 1;
      setDownloadPercent(null);
      setDownloadError(evt.message);
    });
    // Main settled an earlier failure (a cycle came back clean). Nothing else
    // fires on that path, so without this the banner would stay on a tab that
    // happens to be open.
    const offErrorCleared = ipc().on.updateErrorCleared(() => {
      errorSeqRef.current += 1;
      setDownloadError(null);
    });
    return () => {
      offAvailable();
      offProgress();
      offDownloaded();
      offError();
      offErrorCleared();
    };
  }, []);

  // The events above only reach a listener mounted at the exact moment they
  // fire — Settings tabs unmount on switch, so returning to About after a
  // download finished (or while one is still actively running) would
  // otherwise show nothing until the next event happens to land. Re-seed
  // from main's persisted state on every mount: a finished download restores
  // "Restart to Update", an in-flight one restores the progress bar instead
  // of hiding it until completion. Merge rather than overwrite: if a live
  // event above already settled this (completed or errored) while this
  // request was in flight, a stale percent-only snapshot must not reopen
  // the progress bar alongside it.
  React.useEffect(() => {
    let cancelled = false;
    // Captured before the request: anything that writes the banner while this
    // is in flight makes the reply stale, whichever order they land in.
    const seqAtRequest = errorSeqRef.current;
    void ipc()
      .updates.getStatus()
      .then((result) => {
        if (cancelled || !result.success) return;
        if (result.downloadedVersion) {
          settledRef.current = true;
          setDownloadedVersion((v) => v ?? result.downloadedVersion);
        } else if (result.downloadError && errorSeqRef.current === seqAtRequest) {
          // A failed background update persists in main; restore it so
          // returning to About still shows the failure. Terminal for this
          // cycle (like a completed download), so mark settled — a stale
          // percent-only snapshot must not reopen the progress bar over it.
          settledRef.current = true;
          setDownloadError((e) => e ?? result.downloadError);
        } else if (result.downloadPercent !== null && !settledRef.current) {
          setDownloadPercent((p) => p ?? result.downloadPercent);
        }
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const onCheck = async () => {
    setCheckState({ kind: 'checking' });
    try {
      const result = await ipc().updates.check();
      if (!result.success) {
        setCheckState({ kind: 'error', message: result.error });
        return;
      }
      if (result.updateAvailable && result.osUpdateEligible === false) {
        // Update exists but this macOS is below the launch floor (#432) — don't
        // point the user at a DMG that won't run.
        setCheckState({ kind: 'update-blocked-os', version: result.latestVersion });
      } else if (result.updateAvailable) {
        setCheckState({
          kind: 'update-available',
          version: result.latestVersion,
          releaseUrl: result.releaseUrl,
        });
      } else {
        setCheckState({ kind: 'up-to-date' });
        // A check that just succeeded settles an earlier failed one, so a stale
        // banner doesn't sit under a fresh "You're on the latest version" as two
        // contradictory answers to the same question. Main owns that decision —
        // it knows whether the failure was disproved by this check or is still
        // true (a full disk, a permission problem) — so re-read rather than
        // clearing locally, and stay in sync with what a remount would show.
        // Same staleness rule as the mount effect, in the other direction: if a
        // live update-error lands while this read is in flight, that error is
        // newer than the state main answered with, and overwriting it would
        // wipe a failure that just happened.
        const seqAtRequest = errorSeqRef.current;
        const status = await ipc().updates.getStatus();
        if (status.success && errorSeqRef.current === seqAtRequest) {
          errorSeqRef.current += 1;
          setDownloadError(status.downloadError);
        }
      }
    } catch (e) {
      setCheckState({
        kind: 'error',
        message: e instanceof Error ? e.message : 'Check failed',
      });
    }
  };

  // The button itself narrates checking -> confirmed/failed, so a terminal,
  // non-actionable result (up-to-date/error) reverts to the plain "Check for
  // Updates" state after a few seconds rather than announcing a stale check
  // forever. update-available is left alone — it's still actionable via
  // "View release" and should persist until the user updates.
  React.useEffect(() => {
    if (checkState.kind !== 'up-to-date' && checkState.kind !== 'error') return;
    const timer = setTimeout(() => setCheckState({ kind: 'idle' }), 4000);
    return () => clearTimeout(timer);
  }, [checkState]);

  // Leads with the installed version (always known); the check outcome lives
  // on the button itself (Checking for Updates -> You're on the latest
  // version / Check failed), so the description only needs to add the
  // persistent, actionable update-available case.
  const versionLabel = `Version ${version.data?.version ?? '—'}`;
  const checkDescription =
    checkState.kind === 'update-available'
      ? `${versionLabel} — Update available (v${checkState.version})`
      : checkState.kind === 'update-blocked-os'
        ? `${versionLabel} — v${checkState.version} requires a newer version of macOS`
        : versionLabel;

  return (
    <section data-settings-tab="about">
      <SettingRow label="Steno" description={checkDescription}>
        <div className="flex items-center gap-2">
          {checkState.kind === 'update-available' && (
            <Button
              variant="ghost"
              size="sm"
              className={COMPACT_BTN}
              onClick={() => void ipc().updates.openReleasePage(checkState.releaseUrl)}
            >
              View release
            </Button>
          )}
          <Button
            variant="outline"
            size="sm"
            className={COMPACT_BTN}
            onClick={() => void onCheck()}
            disabled={checkState.kind === 'checking'}
            title={checkState.kind === 'error' ? checkState.message : undefined}
          >
            {checkState.kind === 'checking' ? (
              <>
                <Loader2 className="mr-1.5 size-3 animate-spin" />
                {t('settings.about.checkingUpdates')}
              </>
            ) : checkState.kind === 'up-to-date' ? (
              <>
                <Check className="mr-1.5 size-3" />
                {t('settings.about.upToDate')}
              </>
            ) : checkState.kind === 'error' ? (
              <>
                <X className="mr-1.5 size-3" />
                {t('common.error')}
              </>
            ) : (
              t('settings.about.checkForUpdates')
            )}
          </Button>
        </div>
      </SettingRow>

      {downloadPercent !== null && (
        <div className="py-3">
          <div
            className="mb-1.5 flex items-center justify-between text-[12px]"
            style={{ color: 'var(--fg-2)' }}
          >
            <span>Downloading update…</span>
            <span className="tabular-nums">{downloadPercent}%</span>
          </div>
          <div
            className="h-1.5 overflow-hidden rounded-full"
            style={{ background: 'var(--surface-sunken)' }}
          >
            <div
              className="h-full rounded-full"
              style={{ width: `${downloadPercent}%`, background: 'var(--fg-1)' }}
            />
          </div>
        </div>
      )}

      {/* main.js sends a finished sentence that already names what failed
          (check vs download) — see update-error-copy.js. Rendering it verbatim
          is deliberate: the old "Update download failed: {raw}" prefix claimed
          a download even when the check never got that far, and pasted
          net:: codes and bundle paths into the UI. */}
      {downloadError && (
        <div className="py-3 text-[12px]" style={{ color: 'var(--danger)' }}>
          {downloadError}
        </div>
      )}

      {downloadedVersion && (
        <div className="py-3">
          <Button className="w-full" onClick={() => ipc().updates.install()}>
            {t('settings.about.restartToUpdate')} (v{downloadedVersion})
          </Button>
        </div>
      )}

      <SettingRow label={t('settings.about.viewReleaseNotes')} description={t('settings.about.whatsNew')}>
        <ExternalLinkAction
          label="View"
          onClick={() => void ipc().shell.openExternal(CHANGELOG_URL)}
        />
      </SettingRow>

      <SettingRow label="Discord" description="Join the community, ask questions, share feedback">
        <ExternalLinkAction
          label="Join"
          onClick={() => void ipc().shell.openExternal(DISCORD_URL)}
        />
      </SettingRow>

      <SettingRow
        label="GitHub"
        description="Steno is open source — browse the code, file issues"
        noBorder
      >
        <ExternalLinkAction
          label="View"
          onClick={() => void ipc().shell.openExternal(GITHUB_URL)}
        />
      </SettingRow>

      {/* Legal footer — small, out of the settings-row rhythm above since
          these aren't actions on Steno itself. */}
      <div
        className="mt-8 flex items-center gap-3 text-[12px]"
        style={{ color: 'var(--fg-muted)' }}
      >
        <button
          type="button"
          onClick={() => void ipc().shell.openExternal(TERMS_URL)}
          className="hover:underline"
        >
          {t('settings.about.termsOfService')}
        </button>
        <span aria-hidden="true">·</span>
        <button
          type="button"
          onClick={() => void ipc().shell.openExternal(PRIVACY_URL)}
          className="hover:underline"
        >
          {t('settings.about.privacyPolicy')}
        </button>
      </div>
    </section>
  );
}
