import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { Result } from '@/lib/ipc';
import { ipc } from '@/lib/ipc';
import { unwrap } from '@/lib/result';

export interface McpStatus {
  enabled: boolean;
  port: number;
  running: boolean;
  keySet: boolean;
  endpoint?: string;
}

export interface McpKeyResponse {
  key: string;
}

export interface McpBridge {
  getStatus: () => Promise<Result<McpStatus>>;
  getKey: () => Promise<Result<McpKeyResponse>>;
  setKey: (key: string) => Promise<Result<Record<string, never>>>;
  regenerateKey: () => Promise<Result<Record<string, never> | McpKeyResponse>>;
  setEnabled: (enabled: boolean) => Promise<Result<Record<string, never>>>;
  setPort: (port: number) => Promise<Result<Record<string, never>>>;
}

function getMcpBridge(): McpBridge {
  const currentIpc: unknown = ipc();
  if (
    currentIpc &&
    typeof currentIpc === 'object' &&
    'mcp' in currentIpc &&
    currentIpc.mcp &&
    typeof currentIpc.mcp === 'object'
  ) {
    return currentIpc.mcp as McpBridge;
  }
  throw new Error('[ipc] window.stenoai.mcp is not defined — preload did not expose it.');
}

export const mcpKeys = {
  all: ['mcp'] as const,
  status: () => [...mcpKeys.all, 'status'] as const,
};

export function useMcpStatus() {
  return useQuery({
    queryKey: mcpKeys.status(),
    queryFn: async (): Promise<McpStatus> => {
      try {
        const bridge = getMcpBridge();
        const res = await bridge.getStatus();
        const unwrapped = unwrap(res);
        return {
          enabled: unwrapped.enabled ?? false,
          port: unwrapped.port ?? 27127,
          running: unwrapped.running ?? false,
          keySet: unwrapped.keySet ?? false,
          endpoint:
            unwrapped.endpoint ??
            (unwrapped.port
              ? `http://127.0.0.1:${unwrapped.port}/mcp`
              : 'http://127.0.0.1:27127/mcp'),
        };
      } catch {
        // Fallback when bridge/mock returns partial or during unit test setup
        return {
          enabled: false,
          port: 27127,
          running: false,
          keySet: false,
          endpoint: 'http://127.0.0.1:27127/mcp',
        };
      }
    },
  });
}

export function useSetMcpEnabled() {
  const qc = useQueryClient();
  const key = mcpKeys.status();
  return useMutation({
    mutationFn: async (enabled: boolean) => {
      const bridge = getMcpBridge();
      return unwrap(await bridge.setEnabled(enabled));
    },
    onMutate: async (enabled: boolean) => {
      await qc.cancelQueries({ queryKey: key });
      const previous = qc.getQueryData<McpStatus>(key);
      if (previous) {
        qc.setQueryData<McpStatus>(key, {
          ...previous,
          enabled,
          running: enabled ? previous.running : false,
        });
      }
      return { previous };
    },
    onError: (_err, _v, ctx) => {
      if (ctx?.previous) {
        qc.setQueryData<McpStatus>(key, ctx.previous);
      }
    },
    onSettled: () => {
      qc.invalidateQueries({ queryKey: key });
    },
  });
}

export function useSetMcpPort() {
  const qc = useQueryClient();
  const key = mcpKeys.status();
  return useMutation({
    mutationFn: async (port: number) => {
      const bridge = getMcpBridge();
      return unwrap(await bridge.setPort(port));
    },
    onMutate: async (port: number) => {
      await qc.cancelQueries({ queryKey: key });
      const previous = qc.getQueryData<McpStatus>(key);
      if (previous) {
        qc.setQueryData<McpStatus>(key, {
          ...previous,
          port,
          endpoint: `http://127.0.0.1:${port}/mcp`,
        });
      }
      return { previous };
    },
    onError: (_err, _v, ctx) => {
      if (ctx?.previous) {
        qc.setQueryData<McpStatus>(key, ctx.previous);
      }
    },
    onSettled: () => {
      qc.invalidateQueries({ queryKey: key });
    },
  });
}

export function useSetMcpKey() {
  const qc = useQueryClient();
  const key = mcpKeys.status();
  return useMutation({
    mutationFn: async (apiKey: string) => {
      const bridge = getMcpBridge();
      return unwrap(await bridge.setKey(apiKey));
    },
    onMutate: async () => {
      await qc.cancelQueries({ queryKey: key });
      const previous = qc.getQueryData<McpStatus>(key);
      if (previous) {
        qc.setQueryData<McpStatus>(key, {
          ...previous,
          keySet: true,
        });
      }
      return { previous };
    },
    onError: (_err, _v, ctx) => {
      if (ctx?.previous) {
        qc.setQueryData<McpStatus>(key, ctx.previous);
      }
    },
    onSettled: () => {
      qc.invalidateQueries({ queryKey: key });
    },
  });
}

export function useRegenerateMcpKey() {
  const qc = useQueryClient();
  const key = mcpKeys.status();
  return useMutation({
    mutationFn: async () => {
      const bridge = getMcpBridge();
      const res = unwrap(await bridge.regenerateKey());
      return res as Record<string, never> | McpKeyResponse;
    },
    onSettled: () => {
      qc.invalidateQueries({ queryKey: key });
    },
  });
}

/**
 * Fetch the MCP API key.
 *
 * NOTE: The key is NEVER fetched as part of useMcpStatus or stored in any query
 * cache. It is only fetched on an explicit user action (e.g. reveal, copy).
 */
export function useGetMcpKey() {
  return useMutation({
    mutationFn: async (): Promise<string> => {
      const bridge = getMcpBridge();
      const res = unwrap(await bridge.getKey());
      return res?.key ?? '';
    },
  });
}
