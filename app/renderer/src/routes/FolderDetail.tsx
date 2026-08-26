import * as React from 'react';
import { Check, Lock, Plus, X } from 'lucide-react';
import { MeetingsShell } from '@/components/MeetingsShell';
import { PreviousRow } from '@/components/home/PreviousRow';
import { useMeetings } from '@/hooks/useMeetings';
import {
  useFolders,
  useUpdateFolderIcon,
  useSetFolderTemplate,
  useSetFolderRecurring,
} from '@/hooks/useFolders';
import { useTemplates } from '@/hooks/useTemplates';
import { LucideIcon, IconPicker } from '@/components/IconPicker';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { cn } from '@/lib/utils';
import { navigate } from '@/lib/router';

const COMPACT_BTN = 'h-[30px] px-3 text-[13px]';

interface FolderDetailProps {
  folderId: string;
}

export function FolderDetail({ folderId }: FolderDetailProps) {
  const meetings = useMeetings();
  const folders = useFolders();
  const updateIcon = useUpdateFolderIcon();
  const setFolderTemplate = useSetFolderTemplate();
  const setFolderRecurring = useSetFolderRecurring();
  const { templates, defaultId } = useTemplates();

  const [iconPickerAnchor, setIconPickerAnchor] = React.useState<DOMRect | null>(null);
  const [newRecurringTitle, setNewRecurringTitle] = React.useState('');
  const [recurringTitleError, setRecurringTitleError] = React.useState<string | null>(null);

  const folder = folders.data?.find((f) => f.id === folderId);
  const filtered = (meetings.data ?? []).filter((m) =>
    (m.folders ?? m.session_info.folders ?? []).includes(folderId),
  );

  const isLoading = meetings.isLoading || folders.isLoading;

  const recurringTitles = folder?.recurring_titles ?? [];
  const hasFolderTemplate = Boolean(folder?.template_id);
  const activeTemplate = templates.find(
    (t) => t.id === (folder?.template_id || defaultId),
  );
  const inheritedTemplate = templates.find((t) => t.id === defaultId);

  const handleAddRecurringTitle = (e?: React.FormEvent) => {
    e?.preventDefault();
    const trimmed = newRecurringTitle.trim();
    if (!trimmed) return;

    const isDuplicate = recurringTitles.some(
      (t) => t.trim().toLowerCase() === trimmed.toLowerCase(),
    );
    if (isDuplicate) {
      setRecurringTitleError('This title is already in the recurring list.');
      return;
    }

    setRecurringTitleError(null);
    const updated = [...recurringTitles, trimmed];
    setFolderRecurring.mutate({ folderId, titles: updated });
    setNewRecurringTitle('');
  };

  const handleRemoveRecurringTitle = (titleToRemove: string) => {
    const target = titleToRemove.trim().toLowerCase();
    const updated = recurringTitles.filter(
      (t) => t.trim().toLowerCase() !== target,
    );
    setFolderRecurring.mutate({ folderId, titles: updated });
  };

  return (
    <MeetingsShell activeSummaryFile={null}>
      {isLoading ? (
        <div className="flex min-h-[40vh] items-center justify-center text-[color:var(--fg-2)]">
          Loading folder…
        </div>
      ) : !folder ? (
        <div className="space-y-4 text-center">
          <h1 className="home-hello">Folder not found.</h1>
          <p className="text-sm" style={{ color: 'var(--fg-2)' }}>
            This folder may have been deleted.{' '}
            <button
              type="button"
              className="underline"
              onClick={() => navigate('/')}
              style={{ color: 'var(--fg-1)' }}
            >
              Back to Home
            </button>
            .
          </p>
        </div>
      ) : (
        <>
          <div className="mb-8">
            <div className="mb-1.5 flex items-end justify-between gap-6">
              <h1 className="home-hello flex items-center gap-3.5">
                <button
                  type="button"
                  aria-label="Change folder icon"
                  className="inline-flex h-10 w-10 items-center justify-center rounded-lg transition-colors hover:bg-[color:var(--surface-active)]"
                  style={{ background: 'var(--surface-hover)', color: 'var(--fg-1)', flexShrink: 0 }}
                  onClick={(e) => setIconPickerAnchor(e.currentTarget.getBoundingClientRect())}
                >
                  <LucideIcon name={folder.icon ?? 'folder'} size={20} />
                </button>
                {folder.name}
              </h1>
              {iconPickerAnchor && (
                <IconPicker
                  anchorRect={iconPickerAnchor}
                  onSelect={(icon) => updateIcon.mutate({ id: folderId, icon })}
                  onClose={() => setIconPickerAnchor(null)}
                />
              )}
              <div
                className="pb-2 text-[13px] tabular-nums"
                style={{ color: 'var(--fg-2)' }}
              >
                {filtered.length} {filtered.length === 1 ? 'meeting' : 'meetings'}
              </div>
            </div>
          </div>

          <Tabs defaultValue="notes" className="w-full">
            <div
              className="mb-6 flex items-center justify-between border-b pb-3"
              style={{ borderColor: 'var(--border-subtle)' }}
            >
              <TabsList>
                <TabsTrigger value="notes" data-testid="folder-tab-notes">
                  Notes ({filtered.length})
                </TabsTrigger>
                <TabsTrigger value="settings" data-testid="folder-tab-settings">
                  Settings
                </TabsTrigger>
              </TabsList>
            </div>

            <TabsContent value="notes" className="mt-0">
              <section>
                <div className="mb-3.5 flex items-baseline justify-between pb-2.5">
                  <div className="flex items-baseline gap-2.5">
                    <h2
                      className="text-sm font-medium tracking-[-0.005em]"
                      style={{ color: 'var(--fg-1)', fontFamily: 'var(--font-sans)' }}
                    >
                      Notes
                    </h2>
                    <span
                      className="text-[12.5px] tabular-nums"
                      style={{ color: 'var(--fg-muted)' }}
                    >
                      {filtered.length}
                    </span>
                  </div>
                </div>

                {filtered.length === 0 ? (
                  <div className="px-6 py-24 text-center" style={{ color: 'var(--fg-2)' }}>
                    <div
                      className="mb-1.5"
                      style={{
                        fontFamily: 'var(--font-serif)',
                        fontSize: 24,
                        color: 'var(--fg-1)',
                        letterSpacing: '-0.02em',
                      }}
                    >
                      Nothing here yet
                    </div>
                    <div
                      className="mx-auto max-w-[40ch] text-[13.5px] leading-[1.55]"
                      style={{ color: 'var(--fg-2)' }}
                    >
                      Notes you save to this folder will show up here.
                    </div>
                  </div>
                ) : (
                  <div>
                    {filtered.map((m) => (
                      <PreviousRow
                        key={m.session_info.summary_file}
                        meeting={m}
                      />
                    ))}
                  </div>
                )}
              </section>
            </TabsContent>

            <TabsContent
              value="settings"
              className="mt-0 space-y-10 max-w-3xl"
              data-testid="folder-tab-settings-content"
            >
              {/* Section 1: Default Template */}
              <section className="space-y-4">
                <div className="flex flex-col sm:flex-row sm:items-baseline justify-between gap-2">
                  <div>
                    <h2
                      className="text-[15px] font-semibold"
                      style={{ color: 'var(--fg-1)' }}
                    >
                      Default Template
                    </h2>
                    <p
                      className="text-[13px] leading-relaxed mt-0.5"
                      style={{ color: 'var(--fg-2)' }}
                      data-testid="folder-template-inheritance-desc"
                    >
                      {hasFolderTemplate ? (
                        <>
                          Meetings filed in this folder use{' '}
                          <strong style={{ color: 'var(--fg-1)' }}>
                            {activeTemplate?.name ?? folder.template_id}
                          </strong>
                          .
                        </>
                      ) : (
                        <>
                          Inheriting{' '}
                          <strong style={{ color: 'var(--fg-1)' }}>
                            {inheritedTemplate?.name ?? defaultId}
                          </strong>{' '}
                          from the global default.
                        </>
                      )}
                    </p>
                  </div>
                  {hasFolderTemplate && (
                    <Button
                      variant="ghost"
                      size="sm"
                      className={COMPACT_BTN}
                      disabled={setFolderTemplate.isPending}
                      onClick={() =>
                        setFolderTemplate.mutate({ folderId, templateId: null })
                      }
                      data-testid="folder-reset-template-btn"
                    >
                      Inherit global default
                    </Button>
                  )}
                </div>

                <div className="flex flex-col gap-2">
                  {templates.map((t) => {
                    const isFolderDefault = folder.template_id === t.id;
                    const isInherited = !folder.template_id && t.id === defaultId;
                    const isGlobalDefault = t.id === defaultId;

                    return (
                      <div
                        key={t.id}
                        className={cn(
                          'group flex items-center gap-4 rounded-[8px] px-4 py-3 transition-all duration-fast ease-steno',
                          (isFolderDefault || isInherited) && 'bg-[color:var(--surface-raised)]',
                        )}
                        style={{
                          border: isFolderDefault
                            ? '1px solid var(--fg-1)'
                            : '1px solid var(--border-subtle)',
                        }}
                        data-testid={`folder-template-card-${t.id}`}
                      >
                        <div className="min-w-0 flex-1">
                          <div className="flex flex-wrap items-center gap-2">
                            <span
                              className="truncate text-[13px] font-medium"
                              style={{ color: 'var(--fg-1)' }}
                            >
                              {t.name}
                            </span>
                            {isFolderDefault && (
                              <span
                                className="inline-flex shrink-0 items-center gap-1 text-[10px] uppercase tracking-wider font-semibold"
                                style={{ color: 'var(--fg-1)' }}
                                title="Used automatically for meetings in this folder"
                                data-testid={`badge-folder-default-${t.id}`}
                              >
                                <Check size={10} aria-hidden="true" />
                                Folder Default
                              </span>
                            )}
                            {isInherited && (
                              <span
                                className="inline-flex shrink-0 items-center gap-1 text-[10px] uppercase tracking-wider font-semibold"
                                style={{ color: 'var(--fg-muted)' }}
                                title="Inherited from the global default setting"
                                data-testid={`badge-inherited-default-${t.id}`}
                              >
                                <Check size={10} aria-hidden="true" />
                                Inherited Default
                              </span>
                            )}
                            {isGlobalDefault && !isInherited && (
                              <span
                                className="shrink-0 rounded-[3px] px-1.5 py-px text-[10px] uppercase tracking-wider"
                                style={{
                                  color: 'var(--fg-muted)',
                                  border: '1px solid var(--border-subtle)',
                                }}
                                title="Global default template"
                              >
                                Global Default
                              </span>
                            )}
                            {t.locked && (
                              <span
                                className="inline-flex shrink-0 items-center gap-1 text-[10px] uppercase tracking-wider"
                                style={{ color: 'var(--fg-muted)' }}
                                title="Built-in template — protected from editing"
                              >
                                <Lock size={10} aria-hidden="true" />
                                Locked
                              </span>
                            )}
                            {t.builtin && !t.locked && (
                              <span
                                className="shrink-0 rounded-[3px] px-1.5 py-px text-[10px] uppercase tracking-wider"
                                style={{
                                  color: 'var(--fg-muted)',
                                  border: '1px solid var(--border-subtle)',
                                }}
                              >
                                Built-in
                              </span>
                            )}
                          </div>

                          <div
                            className={cn(
                              'line-clamp-2 text-[12px] leading-relaxed mt-0.5',
                              !t.prompt && 'italic',
                            )}
                            style={{ color: 'var(--fg-muted)', opacity: t.prompt ? 1 : 0.6 }}
                            title={t.prompt}
                          >
                            {t.prompt ||
                              (t.builtin ? 'Uses structured format' : 'No prompt provided.')}
                          </div>
                        </div>

                        <div className="flex shrink-0 items-center gap-2">
                          {isFolderDefault ? (
                            <Button
                              variant="ghost"
                              size="sm"
                              className={COMPACT_BTN}
                              disabled={setFolderTemplate.isPending}
                              onClick={() =>
                                setFolderTemplate.mutate({ folderId, templateId: null })
                              }
                              data-testid={`clear-folder-template-${t.id}`}
                            >
                              Inherit global default
                            </Button>
                          ) : (
                            <Button
                              variant="ghost"
                              size="sm"
                              className={COMPACT_BTN}
                              disabled={setFolderTemplate.isPending}
                              onClick={() =>
                                setFolderTemplate.mutate({ folderId, templateId: t.id })
                              }
                              data-testid={`set-folder-template-${t.id}`}
                            >
                              Use for folder
                            </Button>
                          )}
                        </div>
                      </div>
                    );
                  })}
                </div>
              </section>

              {/* Section 2: Recurring Meetings */}
              <section
                className="space-y-4 pt-4 border-t"
                style={{ borderColor: 'var(--border-subtle)' }}
              >
                <div>
                  <h2
                    className="text-[15px] font-semibold"
                    style={{ color: 'var(--fg-1)' }}
                  >
                    Recurring Meetings
                  </h2>
                  <p
                    className="text-[13px] leading-relaxed mt-0.5"
                    style={{ color: 'var(--fg-2)' }}
                  >
                    A meeting whose title matches is filed here automatically.
                  </p>
                </div>

                {recurringTitles.length > 0 ? (
                  <div className="flex flex-wrap gap-2 pt-1" data-testid="recurring-titles-list">
                    {recurringTitles.map((title) => (
                      <span
                        key={title}
                        className="inline-flex items-center gap-1.5 rounded-[6px] px-2.5 py-1 text-[13px] font-medium"
                        style={{
                          background: 'var(--surface-raised)',
                          border: '1px solid var(--border-subtle)',
                          color: 'var(--fg-1)',
                        }}
                        data-testid={`recurring-title-chip-${title}`}
                      >
                        <span>{title}</span>
                        <button
                          type="button"
                          className="inline-flex size-4 items-center justify-center rounded-sm transition-colors hover:bg-[color:var(--surface-hover)] focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-[color:var(--focus-ring)]"
                          style={{ color: 'var(--fg-muted)' }}
                          onClick={() => handleRemoveRecurringTitle(title)}
                          aria-label={`Remove recurring title ${title}`}
                          data-testid={`remove-recurring-title-${title}`}
                        >
                          <X size={12} aria-hidden="true" />
                        </button>
                      </span>
                    ))}
                  </div>
                ) : (
                  <div
                    className="text-[13px] italic py-1"
                    style={{ color: 'var(--fg-muted)' }}
                    data-testid="no-recurring-titles"
                  >
                    No recurring titles configured for this folder.
                  </div>
                )}

                <form onSubmit={handleAddRecurringTitle} className="flex gap-2 max-w-md pt-1">
                  <div className="relative flex-1">
                    <Input
                      value={newRecurringTitle}
                      onChange={(e) => {
                        setNewRecurringTitle(e.target.value);
                        if (recurringTitleError) setRecurringTitleError(null);
                      }}
                      placeholder="e.g. Weekly Team Sync"
                      className="h-[32px] text-[13px]"
                      style={{
                        background: 'var(--surface-raised)',
                        borderColor: recurringTitleError
                          ? 'var(--danger, #ef4444)'
                          : 'var(--border-subtle)',
                      }}
                      aria-label="New recurring title"
                      data-testid="recurring-title-input"
                    />
                  </div>
                  <Button
                    type="submit"
                    variant="outline"
                    size="sm"
                    className="h-[32px] px-3 text-[13px]"
                    disabled={!newRecurringTitle.trim() || setFolderRecurring.isPending}
                    data-testid="add-recurring-title-btn"
                  >
                    <Plus size={14} className="mr-1" aria-hidden="true" />
                    Add
                  </Button>
                </form>
                {recurringTitleError && (
                  <p
                    className="text-[12px]"
                    style={{ color: 'var(--danger, #ef4444)' }}
                    data-testid="recurring-title-error"
                  >
                    {recurringTitleError}
                  </p>
                )}
              </section>
            </TabsContent>
          </Tabs>
        </>
      )}
    </MeetingsShell>
  );
}
