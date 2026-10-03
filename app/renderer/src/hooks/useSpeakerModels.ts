import * as React from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ipc, type SpeakerModelsProgressEvent } from '@/lib/ipc';

const statusKey = ['speakerModels', 'status'] as const;

/** macOS speaker-separation models: whether they are on disk, and a download
 *  that streams progress. main.js shares one download between onboarding and
 *  Settings, so starting it twice is harmless. */
export function useSpeakerModels() {
  const queryClient = useQueryClient();
  const status = useQuery({
    queryKey: statusKey,
    queryFn: () => ipc().setup.speakerModelsStatus(),
    // Each check spawns the backend and the sidecar; the answer only changes
    // when a download finishes, which invalidates it below.
    staleTime: 5 * 60_000,
    refetchOnWindowFocus: false,
  });

  const [progress, setProgress] = React.useState<SpeakerModelsProgressEvent | null>(null);
  React.useEffect(() => ipc().on.speakerModelsProgress(setProgress), []);

  const download = useMutation({
    mutationFn: async () => {
      setProgress(null);
      const res = await ipc().setup.speakerModels();
      if (!res.success || !res.ready) throw new Error(res.success ? 'not ready' : res.error);
      return res;
    },
    onSettled: () => {
      setProgress(null);
      void queryClient.invalidateQueries({ queryKey: statusKey });
    },
  });

  return { status, progress, download };
}
