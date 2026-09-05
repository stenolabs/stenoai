import * as React from 'react';
import { useMutation, useQuery } from '@tanstack/react-query';
import { ipc } from '@/lib/ipc';
import { unwrap } from '@/lib/result';

export const setupKeys = {
  all: ['setup'] as const,
  check: () => [...setupKeys.all, 'check'] as const,
};

export function useSetupCheck() {
  return useQuery({
    queryKey: setupKeys.check(),
    queryFn: async () => unwrap(await ipc().setup.check()),
  });
}

export function useSetupStep(name: 'ollamaAndModel' | 'parakeet' | 'speakerModels' | 'test') {
  return useMutation({
    mutationFn: async () => {
      const res = await ipc().setup[name]();
      if (!res.success) throw new Error(res.error);
      return res;
    },
  });
}

export function useCheckMicPermission() {
  return useMutation({
    mutationFn: async () => unwrap(await ipc().perm.checkMicrophone()).status,
  });
}

export function useRequestMicPermission() {
  return useMutation({
    mutationFn: async () => unwrap(await ipc().perm.requestMicrophone()).granted,
  });
}

export function useDebugLog() {
  const [lines, setLines] = React.useState<string[]>([]);
  React.useEffect(() => {
    return ipc().on.debugLog((line) => {
      setLines((prev) => {
        const next = [...prev, line];
        return next.length > 500 ? next.slice(-500) : next;
      });
    });
  }, []);
  const clear = React.useCallback(() => setLines([]), []);
  return { lines, clear };
}
