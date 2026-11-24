import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ipc, type ConnectSettings, type ConnectSettingsPatch } from '@/lib/ipc';
import { unwrap } from '@/lib/result';

export const connectKeys = {
  all: ['connect'] as const,
  info: () => [...connectKeys.all, 'info'] as const,
  settings: () => [...connectKeys.all, 'settings'] as const,
};

/** Install snippets + which assistants already have Steno configured. */
export function useConnectInfo() {
  return useQuery({
    queryKey: connectKeys.info(),
    queryFn: async () => unwrap(await ipc().connect.getInfo()),
    // Re-check after the user installs in another app and comes back.
    refetchOnWindowFocus: true,
  });
}

/** What the Steno MCP server lets assistants read (enforced server-side). */
export function useConnectSettings() {
  return useQuery({
    queryKey: connectKeys.settings(),
    queryFn: async () => unwrap(await ipc().connect.getSettings()),
  });
}

export function useSetConnectSettings() {
  const qc = useQueryClient();
  const key = connectKeys.settings();
  return useMutation({
    mutationFn: async (patch: ConnectSettingsPatch) =>
      unwrap(await ipc().connect.setSettings(patch)),
    onMutate: async (patch) => {
      await qc.cancelQueries({ queryKey: key });
      const previous = qc.getQueryData<ConnectSettings>(key);
      if (previous) qc.setQueryData<ConnectSettings>(key, { ...previous, ...patch });
      return { previous };
    },
    onError: (_err, _patch, ctx) => qc.setQueryData(key, ctx?.previous),
    onSuccess: (saved) => qc.setQueryData<ConnectSettings>(key, saved),
  });
}
