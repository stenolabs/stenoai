import * as React from 'react';
import { Check, ChevronLeft, Loader2, Trash2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import { Input, Textarea } from '@/components/ui/input';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { cn } from '@/lib/utils';
import type { Template } from '@/lib/ipc';
import {
  useDeleteTemplate,
  useResetTemplate,
  useSaveTemplate,
  useSetDefaultTemplate,
  useTemplates,
} from '@/hooks/useTemplates';
import { COMPACT_BTN } from '@/routes/settings/primitives';
import { LANGUAGES_WHISPER, type LangOption } from '@/routes/settings/languages';
import { t } from '@/i18n';

// ---------------------------------------------------------------------------
// Cookbook editor — the full-page create/edit view the Cookbooks gallery opens.
// A cookbook is a note/report template underneath (data model and IPC keep the
// `template` name); this is the only place in the app that manages them:
// create, edit, reset a built-in, set as default, and delete. The backend
// owns merging built-ins with user edits, so this just routes each action
// back through the typed `templates` bridge.
// ---------------------------------------------------------------------------

// Language picker. Built from LANGUAGES_WHISPER so the codes line up with
// Config.SUPPORTED_LANGUAGES (the 11 curated codes) plus 'auto', and we reuse
// its human labels rather than hardcoding a second list. A cookbook's
// language pins the summary output language; 'auto' follows the transcript /
// global setting.
const TEMPLATE_LANGUAGES: LangOption[] = LANGUAGES_WHISPER;

/** Full-page editor for creating or editing a cookbook. Surfaces backend
 *  validation/save/delete errors inline rather than throwing. A locked
 *  built-in (Standard) opens read-only: it can be set as default but not
 *  changed or deleted. */
export function CookbookEditor({
  editing,
  onClose,
}: {
  editing: Partial<Template> | null;
  onClose: () => void;
}) {
  const save = useSaveTemplate();
  const reset = useResetTemplate();
  const del = useDeleteTemplate();
  const { defaultId } = useTemplates();
  const setDefault = useSetDefaultTemplate();
  const [confirmDelete, setConfirmDelete] = React.useState(false);
  // Surfaced inside the confirm dialog when a delete fails, so a rejected
  // mutation isn't a silent unhandled rejection (#308).
  const [deleteError, setDeleteError] = React.useState<string | null>(null);
  // Save and Reset both write this template and both close the editor on
  // success — letting them run concurrently (e.g. click Reset, then Save
  // before it settles) races two writes against each other, and whichever
  // response lands last silently wins over the other's intent. Mutual
  // exclusion: each of Save/Reset/Make Default is disabled while any of the
  // three is in flight.
  const busy = save.isPending || reset.isPending || setDefault.isPending || del.isPending;
  const isDefault = !!editing?.id && editing.id === defaultId;
  const deletable = !!editing?.id && !editing.builtin;
  const readOnly = !!editing?.locked;
  const [name, setName] = React.useState(editing?.name ?? '');
  const [prompt, setPrompt] = React.useState(editing?.prompt ?? '');
  const [language, setLanguage] = React.useState(editing?.language ?? 'auto');
  const [error, setError] = React.useState<string | null>(null);

  const onSave = () => {
    setError(null);
    save.mutate(
      { id: editing?.id, name, prompt, language },
      {
        onSuccess: () => onClose(),
        onError: (e) => setError(e instanceof Error ? e.message : t('cookbooks.editor.saveError')),
      },
    );
  };

  return (
    <div className="flex flex-col h-full flex-1 pt-2 animate-in fade-in zoom-in-95 duration-200">
      {/* Header Area */}
      <div
        className="flex items-center justify-between gap-3 mb-6 pb-4 border-b shrink-0"
        style={{ borderColor: 'var(--border-subtle)' }}
      >
        <div className="flex items-center gap-3">
          <button
            type="button"
            onClick={onClose}
            disabled={busy}
            aria-label={t('cookbooks.editor.backAria')}
            className="inline-flex size-8 shrink-0 items-center justify-center rounded-md transition-colors hover:bg-[color:var(--surface-hover)] hover:text-[color:var(--fg-1)] disabled:pointer-events-none disabled:opacity-50"
            style={{ color: 'var(--fg-2)' }}
          >
            <ChevronLeft className="size-[18px]" />
          </button>
          <div>
            <h2 className="text-[20px] font-medium" style={{ color: 'var(--fg-1)' }}>
              {readOnly
                ? t('cookbooks.editor.viewTitle')
                : editing?.id
                  ? t('cookbooks.editor.editTitle')
                  : t('cookbooks.editor.newTitle')}
            </h2>
            <p className="text-[13px] mt-1" style={{ color: 'var(--fg-muted)' }}>
              {readOnly ? t('cookbooks.editor.lockedHint') : t('cookbooks.editor.editorIntro')}
            </p>
          </div>
        </div>

        <div className="flex items-center gap-2">
          {isDefault && (
            <span
              className="inline-flex items-center gap-1 px-2 text-[12px] font-medium"
              style={{ color: 'var(--fg-2)' }}
              title={t('cookbooks.editor.defaultHint')}
            >
              <Check className="size-3.5" aria-hidden="true" />
              {t('cookbooks.editor.isDefault')}
            </span>
          )}
          {editing?.id && !isDefault && (
            <Button
              variant="outline"
              size="sm"
              className={COMPACT_BTN}
              disabled={busy}
              title={t('cookbooks.editor.defaultHint')}
              onClick={() => {
                if (editing.id) setDefault.mutate(editing.id);
              }}
            >
              {t('cookbooks.editor.makeDefault')}
            </Button>
          )}
          {deletable && (
            <Button
              variant="ghost"
              size="sm"
              className={cn(
                COMPACT_BTN,
                'text-[color:var(--fg-2)] hover:bg-[color:var(--danger-bg)] hover:text-[color:var(--danger)]',
              )}
              disabled={busy}
              aria-label={t('cookbooks.editor.deleteAria', { name: editing?.name ?? '' })}
              title={t('cookbooks.editor.deleteAria', { name: editing?.name ?? '' })}
              onClick={() => {
                setDeleteError(null);
                setConfirmDelete(true);
              }}
            >
              <Trash2 className="size-3.5" aria-hidden="true" />
            </Button>
          )}
          {editing?.id && editing.builtin && !editing.locked && (
            <Button
              variant="ghost"
              size="sm"
              className={COMPACT_BTN}
              disabled={busy}
              title={t('cookbooks.editor.resetHint')}
              onClick={() => {
                if (editing.id) reset.mutate(editing.id, { onSuccess: () => onClose() });
              }}
            >
              {t('cookbooks.editor.reset')}
            </Button>
          )}
          {!readOnly && (
          <Button
            size="sm"
            className={COMPACT_BTN}
            onClick={onSave}
            disabled={busy || !name.trim()}
          >
            {save.isPending ? (
              <>
                <Loader2 className="mr-1.5 size-3 animate-spin" />
                {t('cookbooks.editor.saving')}
              </>
            ) : (
              t('cookbooks.editor.save')
            )}
          </Button>
          )}
        </div>
      </div>

      {/* Settings Grid */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-6 mb-6 shrink-0">
        <div className="flex flex-col gap-2">
          <label className="text-[13px] font-medium" style={{ color: 'var(--fg-1)' }}>
            {t('cookbooks.editor.nameLabel')}
          </label>
          <Input
            value={name}
            onChange={(e) => setName(e.target.value)}
            disabled={readOnly}
            placeholder={t('cookbooks.editor.namePlaceholder')}
            className="text-[14px] bg-[color:var(--surface-raised)]"
          />
        </div>
        <div className="flex flex-col gap-2">
          <label className="text-[13px] font-medium" style={{ color: 'var(--fg-1)' }}>
            {t('cookbooks.editor.languageLabel')}
          </label>
          <Select value={language} onValueChange={setLanguage} disabled={readOnly}>
            <SelectTrigger className="text-[14px] bg-[color:var(--surface-raised)]">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {TEMPLATE_LANGUAGES.map((l) => (
                <SelectItem key={l.value} value={l.value}>
                  {l.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      </div>

      {/* Prompt Area */}
      <div
        className="flex flex-col flex-1 min-h-0 rounded-[8px] overflow-hidden"
        style={{
          border: '1px solid var(--border-subtle)',
          background: 'var(--surface-raised)'
        }}
      >
        <div
          className="px-4 py-3 flex items-center justify-between border-b shrink-0"
          style={{
            borderColor: 'var(--border-subtle)',
            background: 'var(--surface-raised)'
          }}
        >
          <span className="text-[13px] font-medium" style={{ color: 'var(--fg-1)' }}>
            {t('cookbooks.editor.promptLabel')}
          </span>
          <span className="text-[12px]" style={{ color: 'var(--fg-muted)' }}>
            {readOnly ? t('cookbooks.editor.structuredFormat') : t('cookbooks.editor.markdownSupported')}
          </span>
        </div>
        <Textarea
          value={prompt}
          onChange={(e) => setPrompt(e.target.value)}
          placeholder={
            readOnly ? t('cookbooks.editor.lockedPrompt') : t('cookbooks.editor.promptPlaceholder')
          }
          readOnly={readOnly}
          className="flex-1 w-full p-5 text-[14px] leading-relaxed border-0 focus-visible:ring-0 resize-none bg-[color:var(--surface-raised)] shadow-none"
          style={{ color: 'var(--fg-1)' }}
        />
      </div>

      {error && (
        <div
          className="mt-4 p-3 rounded-[8px] text-[13px] flex items-center shrink-0"
          style={{
            color: 'var(--accent-danger)',
            background: 'var(--danger-bg)',
            border: '1px solid var(--accent-danger)'
          }}
          role="alert"
        >
          {error}
        </div>
      )}

      <ConfirmDialog
        open={confirmDelete}
        onOpenChange={(o) => {
          if (!o) {
            setConfirmDelete(false);
            setDeleteError(null);
          }
        }}
        title={t('cookbooks.editor.deleteConfirm.title', { name: editing?.name ?? '' })}
        description={
          <>
            {t('cookbooks.editor.deleteConfirm.description')}
            {deleteError && (
              <span
                role="alert"
                style={{ display: 'block', marginTop: 8, color: 'var(--accent-danger)' }}
              >
                {deleteError}
              </span>
            )}
          </>
        }
        confirmLabel={t('cookbooks.editor.deleteConfirm.action')}
        destructive
        isPending={del.isPending}
        onConfirm={async () => {
          if (!editing?.id) return;
          setDeleteError(null);
          try {
            await del.mutateAsync(editing.id);
            setConfirmDelete(false);
            onClose();
          } catch (e) {
            // Keep the dialog open so the user can retry; surface why.
            setDeleteError(e instanceof Error ? e.message : t('cookbooks.editor.deleteError'));
          }
        }}
      />
    </div>
  );
}
