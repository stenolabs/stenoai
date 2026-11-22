import * as React from 'react';
import { ChevronDown, ChevronRight, Loader2 } from 'lucide-react';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import { OpenAiIcon } from '@/components/ui/openai-icon';
import { GoogleIcon } from '@/components/ui/google-icon';
import { MetaIcon } from '@/components/ui/meta-icon';
import { QwenIcon } from '@/components/ui/qwen-icon';
import { t } from '@/i18n';
import {
  useCurrentModel,
  useDeleteModel,
  useModels,
  usePullModel,
  useSetCurrentModel,
  useSwitchToFasterBuild,
} from '@/hooks/useModels';
import { ModelCard, formatModelSize, isDefaultModel } from '../model-card';
import { modelMayExceedMemory } from '../model-memory';

// Attribution icon for the local Ollama model list -- matched by prefix
// against the model id (e.g. "gemma4:e2b-it-qat"), not the display name,
// since ids are the stable identifier. Remote-provider models can be
// anything a user's Ollama server has pulled, so unmatched ids just render
// without an icon rather than guessing.
function getOllamaModelIcon(modelId: string): React.ReactNode | undefined {
  if (modelId.startsWith('gemma')) return <GoogleIcon size={12} />;
  if (modelId.startsWith('llama')) return <MetaIcon size={12} />;
  if (modelId.startsWith('qwen')) return <QwenIcon size={12} />;
  if (modelId.startsWith('gpt-oss') || modelId.startsWith('gpt')) return <OpenAiIcon size={12} />;
  return undefined;
}

export function ModelList() {
  const models = useModels();
  const current = useCurrentModel();
  const setCurrent = useSetCurrentModel();
  const pull = usePullModel();
  const [showDeprecated, setShowDeprecated] = React.useState(false);
  // Backs two distinct triggers that both end in "confirm, then delete one or
  // more tags": the automatic post-switch offer to remove the now-redundant
  // GGUF build, and the manual "delete this model to free up disk space"
  // action. Only one delete can be in flight/confirmed at a time in this UI,
  // so a single piece of state covers both.
  const [deleteCandidate, setDeleteCandidate] = React.useState<{ tags: string[]; description: string } | null>(
    null,
  );
  const deleteModel = useDeleteModel();
  const fasterBuild = useSwitchToFasterBuild((mlxTag) => {
    const match = models.data?.models.find((m) => m.mlxTag === mlxTag);
    if (match) {
      setDeleteCandidate({
        tags: [match.name],
        description: t('settings.ai.fasterBuildDelete.description', {
          name: match.name,
          size: formatModelSize(match.size_gb) ?? t('settings.ai.unknownSize'),
        }),
      });
    }
  });

  if (models.isLoading) {
    return (
      <div
        className="flex items-center gap-2 text-[13px]"
        style={{ color: 'var(--fg-2)' }}
      >
        <Loader2 className="size-3.5 animate-spin" />
        {t('settings.ai.model.loading')}
      </div>
    );
  }
  if (models.isError) {
    return (
      <div className="text-[13px]" style={{ color: 'var(--fg-2)' }}>
        {t('settings.ai.couldNotReach')}
      </div>
    );
  }
  if (!models.data?.models?.length) {
    return (
      <div className="text-[13px]" style={{ color: 'var(--fg-2)' }}>
        {t('settings.ai.noModelsAvailable')}
      </div>
    );
  }

  const isRemote = models.data.provider === 'remote';
  // The RAM-suitability badge only makes sense for the bundled local Ollama:
  // for remote-Ollama or any cloud provider the model runs off-machine, so
  // this Mac's memory is irrelevant. Gate strictly on 'local'.
  const isLocal = models.data.provider === 'local';
  const totalRamGb = models.data.totalRamGb;
  const sorted = [...models.data.models].sort(
    (a, b) => (a.deprecated ? 1 : 0) - (b.deprecated ? 1 : 0),
  );
  const active = sorted.filter((m) => !m.deprecated);
  const deprecated = sorted.filter((m) => m.deprecated);

  const renderCard = (m: (typeof sorted)[number]) => {
    const isCurrent = m.name === current.data;
    // On Apple Silicon, an uninstalled model is pulled straight to its NVFP4
    // sibling (matching what first-run setup's pull_target already does) --
    // config.json still ends up with the canonical GGUF id via models.set()
    // (see usePullModel's pendingSelect), but the actual download, and so
    // the IPC events this row's progress/cancel keys off of, are for the
    // NVFP4 tag. Off Apple Silicon (no mlxTag) this is just m.name, same as
    // before.
    const pullTarget = m.mlxTag ?? m.name;
    const isFasterBuildActive = fasterBuild.activeTag === m.mlxTag;
    // A "switch to faster build" pulls the SAME -nvfp4 tag a general "Select"
    // would, and usePullModel's progress listener is a global (unfiltered) IPC
    // subscription -- so it records that tag's progress too. Without this guard
    // pull.progress[pullTarget] lights up during a switch, and the card renders
    // a SECOND, duplicate progress bar (plus a duplicate Cancel) on top of the
    // faster-build one. While a switch is in flight the faster-build block owns
    // that UI, so suppress the general-download surface for this row.
    const isDownloading = Boolean(pull.progress[pullTarget]) && !isFasterBuildActive;
    const downloadProgress = isDownloading ? pull.progress[pullTarget] : undefined;
    const isDefault = !isRemote && isDefaultModel(m.description);

    let note: string | undefined;
    if (isRemote && m.description) {
      note = m.description;
    } else if (!isRemote) {
      const parts: string[] = [];
      if (m.speed) parts.push(t('settings.ai.speed', { speed: m.speed }));
      if (m.quality) parts.push(t('settings.ai.quality', { quality: m.quality }));
      note = parts.length ? parts.join(' · ') : undefined;
    }

    // The NVFP4 blob is a different (often larger) download than the GGUF
    // entry's own size -- show it instead whenever NVFP4 is what's actually
    // installed, or (nothing installed yet) what "Select" will actually
    // pull on Apple Silicon. Otherwise (GGUF installed, no NVFP4) the GGUF
    // size is what's really on disk.
    const showMlxSize = m.mlxTag && m.mlxSizeGb !== undefined && (m.mlxInstalled || !m.ggufInstalled);
    const sizeLabel = formatModelSize(showMlxSize ? m.mlxSizeGb : m.size_gb);
    const memoryWarning = isLocal && modelMayExceedMemory(m.size_gb, totalRamGb);
    const fasterBuildBlocked =
      Boolean(fasterBuild.activeTag) &&
      !isFasterBuildActive &&
      (fasterBuild.state === 'pulling' || fasterBuild.state === 'verifying' || fasterBuild.state === 'done');

    const onSelect = () => {
      if (m.installed) {
        setCurrent.mutate(m.name);
      } else {
        pull.mutate({ name: m.name, pullTarget });
      }
    };

    const onDeleteModel = () => {
      // Only tags actually present in Ollama -- a model pulled straight to
      // its NVFP4 tag (general "Select" on Apple Silicon) never has the
      // GGUF blob itself installed, and ollama.delete() on a tag that was
      // never pulled throws. Blindly including m.name here caused exactly
      // that: a stuck confirm dialog on a model with no GGUF blob.
      const tags: string[] = [];
      if (m.ggufInstalled) tags.push(m.name);
      if (m.mlxInstalled && m.mlxTag) tags.push(m.mlxTag);
      if (tags.length === 0) return;
      const label =
        tags.length > 1 ? t('settings.ai.deleteModel.multiLabel', { name: m.name }) : tags[0];
      setDeleteCandidate({
        tags,
        description:
          tags.length > 1
            ? t('settings.ai.deleteModel.description.other', {
                label,
                size: sizeLabel ?? t('settings.ai.unknownSize'),
              })
            : t('settings.ai.deleteModel.description.one', {
                label,
                size: sizeLabel ?? t('settings.ai.unknownSize'),
              }),
      });
    };

    return (
      <ModelCard
        key={m.name}
        icon={getOllamaModelIcon(m.name)}
        name={m.name}
        sizeLabel={sizeLabel}
        note={note}
        isCurrent={isCurrent}
        isDefault={isDefault}
        deprecated={Boolean(m.deprecated)}
        memoryWarning={memoryWarning}
        isDownloading={isDownloading}
        downloadProgress={downloadProgress}
        downloadBytesPerSecond={pull.bytesPerSecond[pullTarget]}
        onSelect={onSelect}
        onCancelDownload={() => pull.cancel(pullTarget)}
        isInstalled={Boolean(m.installed)}
        onDeleteModel={onDeleteModel}
        ggufInstalled={Boolean(m.ggufInstalled)}
        fasterBuildTag={m.installed ? m.mlxTag : undefined}
        fasterBuildInstalled={Boolean(m.mlxInstalled)}
        fasterBuildState={isFasterBuildActive ? fasterBuild.state : 'idle'}
        fasterBuildProgress={isFasterBuildActive ? fasterBuild.progress : undefined}
        fasterBuildBytesPerSecond={isFasterBuildActive ? fasterBuild.bytesPerSecond : undefined}
        fasterBuildBlocked={fasterBuildBlocked}
        onSwitchToFasterBuild={() => {
          if (!m.mlxTag || fasterBuildBlocked) return;
          fasterBuild.switchTo(m.mlxTag);
        }}
        onCancelFasterBuild={isFasterBuildActive ? fasterBuild.cancel : undefined}
      />
    );
  };

  return (
    <div>
      {active.map(renderCard)}

      {deprecated.length > 0 && (
        <>
          <button
            type="button"
            onClick={() => setShowDeprecated((d) => !d)}
            className="mt-4 flex cursor-pointer items-center gap-1.5 border-0 bg-transparent p-0 text-[13px]"
            style={{ color: 'var(--fg-muted)' }}
          >
            {showDeprecated ? (
              <ChevronDown size={12} />
            ) : (
              <ChevronRight size={12} />
            )}
            {showDeprecated ? t('settings.ai.deprecated.hide') : t('settings.ai.deprecated.show')}{' '}
            {t('settings.ai.deprecated.models')}
          </button>

          {showDeprecated && (
            <div className="mt-2">{deprecated.map(renderCard)}</div>
          )}
        </>
      )}

      {deleteCandidate && (
        <ConfirmDialog
          open={Boolean(deleteCandidate)}
          onOpenChange={(open) => {
            if (!open) {
              setDeleteCandidate(null);
              fasterBuild.reset();
            }
          }}
          title={t('settings.ai.deleteModel.title')}
          description={deleteCandidate.description}
          confirmLabel={t('settings.ai.deleteModel.action')}
          destructive
          onConfirm={async () => {
            // finally, not just a trailing statement: a delete call
            // rejecting (unexpected -- e.g. Ollama briefly unreachable)
            // must not leave this dialog stuck open with no way to close
            // it except Cancel (which, since some deletes may have already
            // succeeded, looked like "cancel deletes it anyway").
            // allSettled (not all): waits for every tag's attempt to finish
            // rather than returning as soon as the first one rejects, so the
            // dialog doesn't close while a sibling delete is still pending.
            try {
              const results = await Promise.allSettled(
                deleteCandidate.tags.map((tag) => deleteModel.mutateAsync(tag)),
              );
              const failed = results.filter((r): r is PromiseRejectedResult => r.status === 'rejected');
              if (failed.length > 0) {
                // eslint-disable-next-line no-console -- no toast/error-surface system exists yet; at least don't fail silently.
                console.error('Failed to delete some model tags:', failed.map((f) => f.reason));
              }
            } finally {
              setDeleteCandidate(null);
              fasterBuild.reset();
            }
          }}
        />
      )}
    </div>
  );
}
