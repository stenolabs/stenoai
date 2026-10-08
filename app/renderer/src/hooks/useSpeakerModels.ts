import { useQuery } from '@tanstack/react-query';
import { ipc } from '@/lib/ipc';

/** Prefix of every speaker-models status query: this hook's (the saved
 *  engine's) and Settings' per-engine ones (diarizationEngineKeys.models), so
 *  one invalidation refreshes them all. */
export const speakerModelsStatusKey = ['speakerModels', 'status'] as const;

/** Whether the saved engine's macOS speaker models are on disk (onboarding). */
export function useSpeakerModelsStatus() {
  return useQuery({
    queryKey: speakerModelsStatusKey,
    queryFn: () => ipc().setup.speakerModelsStatus(),
    // Each check spawns the backend and the sidecar; the answer only changes
    // when a download finishes, which invalidates it.
    staleTime: 5 * 60_000,
    refetchOnWindowFocus: false,
  });
}
