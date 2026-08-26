import { describe, test, expect, beforeEach, vi } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { AdvancedTab } from './AdvancedTab';
import { setLocale } from '@/i18n';
// Reset button on the storage-location row must clear the custom override by
// sending '' to the backend (set-storage-path treats '' as "use default"),
// NOT the default path itself — which the backend records as a fresh custom
// override, so "Reset" would visually hide itself while leaving the override
// in place (#304).

const setStoragePath = vi.fn(async () => ({ success: true }));

vi.mock('@/lib/ipc', () => ({
  ipc: () => ({
    settings: {
      getStoragePath: async () => ({
        success: true,
        storage_path: '/custom/path',
        default_path: '/default/path',
        custom_path: '/custom/path',
      }),
      setStoragePath,
      pickStorageFolder: async () => ({ success: true, folderPath: null }),
      getTelemetry: async () => ({
        success: true,
        telemetry_enabled: false,
        anonymous_id: null,
      }),
      setTelemetry: async () => ({ success: true }),
    },
    system: { clearState: async () => ({ success: true }) },
  }),
}));

function renderTab() {
  const qc = new QueryClient({
    defaultOptions: {
      queries: { retry: false, gcTime: Infinity },
      mutations: { retry: false },
    },
  });
  return render(
    <QueryClientProvider client={qc}>
      <AdvancedTab />
    </QueryClientProvider>,
  );
}

describe('AdvancedTab storage reset', () => {
  beforeEach(() => {
    setLocale('en');
    setStoragePath.mockClear();
  });

  test('Reset clears the custom override with an empty string, not the default path', async () => {
    renderTab();

    // Reset only appears once the storage query resolves with a custom path.
    const reset = await screen.findByRole('button', { name: 'Reset' });
    fireEvent.click(reset);

    await waitFor(() => expect(setStoragePath).toHaveBeenCalledTimes(1));
    expect(setStoragePath).toHaveBeenCalledWith('');
  });
});
