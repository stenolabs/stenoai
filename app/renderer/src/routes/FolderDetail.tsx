import * as React from 'react';
import { MeetingsShell } from '@/components/MeetingsShell';
import { PreviousRow } from '@/components/home/PreviousRow';
import { useMeetings } from '@/hooks/useMeetings';
import { useFolders, useUpdateFolderIcon } from '@/hooks/useFolders';
import { LucideIcon, IconPicker } from '@/components/IconPicker';
import { navigate } from '@/lib/router';
import { useTranslation } from '@/i18n';
interface FolderDetailProps {
  folderId: string;
}

export function FolderDetail({ folderId }: FolderDetailProps) {
  const { t } = useTranslation();
  const meetings = useMeetings();
  const folders = useFolders();
  const updateIcon = useUpdateFolderIcon();
  const [iconPickerAnchor, setIconPickerAnchor] = React.useState<DOMRect | null>(null);

  const folder = folders.data?.find((f) => f.id === folderId);
  const filtered = (meetings.data ?? []).filter((m) =>
    (m.folders ?? m.session_info.folders ?? []).includes(folderId),
  );

  const isLoading = meetings.isLoading || folders.isLoading;

  return (
    <MeetingsShell activeSummaryFile={null}>
      {isLoading ? (
        <div className="flex min-h-[40vh] items-center justify-center text-[color:var(--fg-2)]">
          {t('home.loadingFolder')}
        </div>
      ) : !folder ? (
        <div className="space-y-4 text-center">
          <h1 className="home-hello">{t('home.folderNotFound')}</h1>
          <p className="text-sm" style={{ color: 'var(--fg-2)' }}>
            {t('home.folderDeletedHint')}{' '}
            <button
              type="button"
              className="underline"
              onClick={() => navigate('/')}
              style={{ color: 'var(--fg-1)' }}
            >
              {t('home.backToHome')}
            </button>
            .
          </p>
        </div>
      ) : (
        <>
          <div className="mb-10">
            <div className="mb-1.5 flex items-end justify-between gap-6">
              <h1 className="home-hello flex items-center gap-3.5">
                <button
                  type="button"
                  aria-label={t('home.changeFolderIcon')}
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
                {t('home.folderMeetingCount', { count: filtered.length, plural: filtered.length === 1 ? 'meeting' : 'meetings' })}
              </div>
            </div>
          </div>

          <section>
            <div className="mb-3.5 flex items-baseline justify-between pb-2.5">
              <div className="flex items-baseline gap-2.5">
                <h2
                  className="text-sm font-medium tracking-[-0.005em]"
                  style={{ color: 'var(--fg-1)', fontFamily: 'var(--font-sans)' }}
                >
                  {t('home.notesSectionTitle')}
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
                  {t('home.emptyFolderTitle')}
                </div>
                <div
                  className="mx-auto max-w-[40ch] text-[13.5px] leading-[1.55]"
                  style={{ color: 'var(--fg-2)' }}
                >
                  {t('home.emptyFolderSubtitle')}
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
        </>
      )}
    </MeetingsShell>
  );
}
