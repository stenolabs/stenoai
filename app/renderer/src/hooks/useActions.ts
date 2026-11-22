import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  ipc,
  type ActionCard,
  type ActionConnectorId,
  type ActionValidationError,
  type AddCustomEndpointInput,
} from '@/lib/ipc';
import { ResultError, unwrap } from '@/lib/result';

export const actionsKeys = {
  all: ['actions'] as const,
  overview: () => [...actionsKeys.all, 'overview'] as const,
  cards: (summaryFile: string) => [...actionsKeys.all, 'cards', summaryFile] as const,
  recent: () => [...actionsKeys.all, 'recent'] as const,
};

/** An approve that failed validation carries the field problems. */
export class ActionValidationFailure extends ResultError {
  readonly validationErrors: ActionValidationError[];

  constructor(message: string, errors: ActionValidationError[]) {
    super(message, 'invalid-arguments');
    this.validationErrors = errors;
  }
}

/** Connections, connector catalogue, auto-suggest setting and org policy. */
export function useActionsOverview() {
  return useQuery({
    queryKey: actionsKeys.overview(),
    queryFn: async () => unwrap(await ipc().actions.list()),
    refetchOnWindowFocus: true,
  });
}

function useOverviewMutation<A extends unknown[], R>(fn: (...args: A) => Promise<R>) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (args: A) => fn(...args),
    onSettled: () => {
      void qc.invalidateQueries({ queryKey: actionsKeys.all });
    },
  });
}

export function useAddCustomEndpoint() {
  return useOverviewMutation(async (input: AddCustomEndpointInput) =>
    unwrap(await ipc().actions.addCustom(input))
  );
}

export function useConnectConnector() {
  return useOverviewMutation(async (id: ActionConnectorId) =>
    unwrap(await ipc().actions.connectConnector(id))
  );
}

export function useAuthorizeConnection() {
  return useOverviewMutation(async (id: string) => unwrap(await ipc().actions.authorize(id)));
}

export function useRefreshConnection() {
  return useOverviewMutation(async (id: string) => unwrap(await ipc().actions.refreshTools(id)));
}

export function useSetConnectionEnabled() {
  return useOverviewMutation(async (id: string, enabled: boolean) =>
    unwrap(await ipc().actions.setEnabled(id, enabled))
  );
}

export function useRemoveConnection() {
  return useOverviewMutation(async (id: string) => unwrap(await ipc().actions.remove(id)));
}

export function useSetAutoSuggest() {
  return useOverviewMutation(async (value: boolean) =>
    unwrap(await ipc().actions.setAutoSuggest(value))
  );
}

export function useRecentActions() {
  return useQuery({
    queryKey: actionsKeys.recent(),
    queryFn: async () => unwrap(await ipc().actions.recent(20)).entries,
  });
}

/** Action cards for one note, and whether any connection could take one. */
export function useActionCards(summaryFile: string) {
  return useQuery({
    queryKey: actionsKeys.cards(summaryFile),
    queryFn: async () => unwrap(await ipc().actions.getCards(summaryFile)),
  });
}

export function useSuggestActions(summaryFile: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async () => unwrap(await ipc().actions.suggest(summaryFile)),
    onSuccess: (data) => {
      qc.setQueryData(
        actionsKeys.cards(summaryFile),
        (prev: { available: boolean } | undefined) => ({
          available: prev?.available ?? true,
          cards: data.cards,
        })
      );
    },
  });
}

export function useApproveAction(summaryFile: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({ cardId, args }: { cardId: string; args: Record<string, unknown> }) => {
      const res = await ipc().actions.approve(summaryFile, cardId, args);
      if (!res.success) {
        if ('validationErrors' in res && res.validationErrors) {
          throw new ActionValidationFailure(res.error, res.validationErrors);
        }
        throw new ResultError(res.error, res.error_code);
      }
      return res.card as ActionCard;
    },
    onSettled: () => {
      void qc.invalidateQueries({ queryKey: actionsKeys.cards(summaryFile) });
      void qc.invalidateQueries({ queryKey: actionsKeys.recent() });
    },
  });
}

export function useDismissAction(summaryFile: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (cardId: string) => unwrap(await ipc().actions.dismiss(summaryFile, cardId)),
    onSuccess: (data) => {
      qc.setQueryData(
        actionsKeys.cards(summaryFile),
        (prev: { available: boolean } | undefined) => ({
          available: prev?.available ?? true,
          cards: data.cards,
        })
      );
    },
  });
}
