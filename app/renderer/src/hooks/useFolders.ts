import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ipc, type Folder, type Meeting } from '@/lib/ipc';
import { unwrap } from '@/lib/result';
import { meetingsKeys } from './useMeetings';

export const foldersKeys = {
  all: ['folders'] as const,
  list: () => [...foldersKeys.all, 'list'] as const,
};

export function useFolders() {
  return useQuery({
    queryKey: foldersKeys.list(),
    queryFn: async () => unwrap(await ipc().folders.list()).folders,
  });
}

export function useCreateFolder() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (args: { name: string; color?: string }) =>
      unwrap(await ipc().folders.create(args.name, args.color)),
    onSuccess: () => qc.invalidateQueries({ queryKey: foldersKeys.all }),
  });
}

export function useRenameFolder() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (args: { id: string; name: string }) =>
      unwrap(await ipc().folders.rename(args.id, args.name)),
    onSuccess: () => qc.invalidateQueries({ queryKey: foldersKeys.all }),
  });
}

export function useUpdateFolderIcon() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (args: { id: string; icon: string }) =>
      unwrap(await ipc().folders.updateIcon(args.id, args.icon)),
    onMutate: async ({ id, icon }) => {
      // Cancel in-flight folder fetches so a refetch landing during the
      // optimistic write doesn't overwrite our prediction.
      await qc.cancelQueries({ queryKey: foldersKeys.list() });
      const previous = qc.getQueryData<Folder[]>(foldersKeys.list());
      qc.setQueryData(
        foldersKeys.list(),
        (old: Folder[] | undefined) =>
          old?.map((f) => (f.id === id ? { ...f, icon } : f)),
      );
      return { previous };
    },
    onError: (_err, _args, ctx) => {
      // Restore the cache so the UI doesn't silently keep an icon that
      // never made it to disk.
      if (ctx?.previous !== undefined) {
        qc.setQueryData(foldersKeys.list(), ctx.previous);
      }
    },
    onSettled: () => qc.invalidateQueries({ queryKey: foldersKeys.all }),
  });
}

export function useDeleteFolder() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (id: string) => unwrap(await ipc().folders.delete(id)),
    onSuccess: () => qc.invalidateQueries({ queryKey: foldersKeys.all }),
  });
}

export function useReorderFolders() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (ids: string[]) => unwrap(await ipc().folders.reorder(ids)),
    onSuccess: () => qc.invalidateQueries({ queryKey: foldersKeys.all }),
  });
}

function patchMeetingFolders(
  qc: ReturnType<typeof useQueryClient>,
  summaryFile: string,
  update: (folders: string[]) => string[],
) {
  qc.setQueryData(meetingsKeys.list(), (old: Meeting[] | undefined) => {
    if (!old) return old;
    return old.map((m) =>
      m.session_info.summary_file === summaryFile
        ? { ...m, folders: update(m.folders ?? []) }
        : m,
    );
  });
}

function restoreMeetingsSnapshot(
  qc: ReturnType<typeof useQueryClient>,
  previous: Meeting[] | undefined,
) {
  qc.setQueryData(meetingsKeys.list(), previous);
}

export function useAddMeetingToFolder() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (args: { summaryFile: string; folderId: string }) =>
      unwrap(await ipc().folders.addMeeting(args.summaryFile, args.folderId)),
    onMutate: ({ summaryFile, folderId }) => {
      const previous = qc.getQueryData<Meeting[]>(meetingsKeys.list());
      patchMeetingFolders(qc, summaryFile, (f) => [...new Set([...f, folderId])]);
      return { previous };
    },
    onError: (_error, _args, ctx) => {
      restoreMeetingsSnapshot(qc, ctx?.previous);
    },
    onSettled: () => {
      qc.invalidateQueries({ queryKey: foldersKeys.all });
      qc.invalidateQueries({ queryKey: meetingsKeys.all });
    },
  });
}

export function useRemoveMeetingFromFolder() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (args: { summaryFile: string; folderId: string }) =>
      unwrap(await ipc().folders.removeMeeting(args.summaryFile, args.folderId)),
    onMutate: ({ summaryFile, folderId }) => {
      const previous = qc.getQueryData<Meeting[]>(meetingsKeys.list());
      patchMeetingFolders(qc, summaryFile, (f) => f.filter((id) => id !== folderId));
      return { previous };
    },
    onError: (_error, _args, ctx) => {
      restoreMeetingsSnapshot(qc, ctx?.previous);
    },
    onSettled: () => {
      qc.invalidateQueries({ queryKey: foldersKeys.all });
      qc.invalidateQueries({ queryKey: meetingsKeys.all });
    },
  });
}

export function useSetFolderTemplate() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (args: { folderId: string; templateId?: string | null }) =>
      unwrap(await ipc().folders.setTemplate(args.folderId, args.templateId)),
    onMutate: async ({ folderId, templateId }) => {
      await qc.cancelQueries({ queryKey: foldersKeys.list() });
      const previous = qc.getQueryData<Folder[]>(foldersKeys.list());
      qc.setQueryData(foldersKeys.list(), (old: Folder[] | undefined) =>
        old?.map((f) => (f.id === folderId ? { ...f, template_id: templateId ?? null } : f)),
      );
      return { previous };
    },
    onError: (_err, _args, ctx) => {
      if (ctx?.previous !== undefined) {
        qc.setQueryData(foldersKeys.list(), ctx.previous);
      }
    },
    onSettled: () => qc.invalidateQueries({ queryKey: foldersKeys.all }),
  });
}

export function useSetFolderRecurring() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (args: { folderId: string; titles: string[] }) =>
      unwrap(await ipc().folders.setRecurring(args.folderId, args.titles)),
    onMutate: async ({ folderId, titles }) => {
      await qc.cancelQueries({ queryKey: foldersKeys.list() });
      const previous = qc.getQueryData<Folder[]>(foldersKeys.list());
      qc.setQueryData(foldersKeys.list(), (old: Folder[] | undefined) =>
        old?.map((f) => (f.id === folderId ? { ...f, recurring_titles: titles } : f)),
      );
      return { previous };
    },
    onError: (_err, _args, ctx) => {
      if (ctx?.previous !== undefined) {
        qc.setQueryData(foldersKeys.list(), ctx.previous);
      }
    },
    onSettled: () => qc.invalidateQueries({ queryKey: foldersKeys.all }),
  });
}

