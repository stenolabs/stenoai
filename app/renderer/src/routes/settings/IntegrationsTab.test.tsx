import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { settingsKeys } from '@/hooks/useSettings';
import { IntegrationsTab } from './IntegrationsTab';

const h = vi.hoisted(() => ({ setObsidianSync: vi.fn() }));
vi.mock('@/lib/ipc', () => ({
  ipc: () => ({ settings: { setObsidianSync: h.setObsidianSync } }),
}));

const failures = [
  { code: 'EIO', at: '2026-11-15T10:01:00.000Z' },
  { code: 'EACCES', at: '2026-11-15T10:00:00.000Z' },
];

function setup(enabled = true, vaultPath = '/synthetic/vault') {
  const client = new QueryClient({
    defaultOptions: { queries: { staleTime: Infinity, retry: false, enabled: false } },
  });
  client.setQueryData(settingsKeys.obsidianSync(), enabled);
  client.setQueryData(settingsKeys.obsidianVaultPath(), vaultPath);
  client.setQueryData(settingsKeys.obsidianConflicts(), {});
  client.setQueryData(settingsKeys.obsidianFailures(), failures);
  const rendered = render(
    <QueryClientProvider client={client}>
      <IntegrationsTab />
    </QueryClientProvider>
  );
  return {
    ...rendered,
    client,
    alert: () => rendered.container.querySelector('[data-obsidian-failures]'),
  };
}

beforeEach(() => {
  h.setObsidianSync.mockReset().mockResolvedValue({ success: true });
});
afterEach(cleanup);

describe('Obsidian failure alert', () => {
  test('shows the count and newest error code as complete sentences', () => {
    const { alert } = setup();
    expect(alert()?.textContent).toBe(
      '2 notes failed to sync to your Obsidian vault. Latest error: EIO. ' +
        'Check that the vault folder exists and is writable.'
    );
  });

  test('turning sync off hides a cached failure immediately', async () => {
    const { alert, client } = setup();
    expect(alert()).not.toBeNull();
    await act(async () => {
      fireEvent.click(screen.getByRole('switch', { name: 'Sync to Obsidian' }));
    });
    expect(h.setObsidianSync).toHaveBeenCalledWith(false);
    expect(client.getQueryData(settingsKeys.obsidianFailures())).toEqual(failures);
    await waitFor(() => expect(alert()).toBeNull());
    client.clear();
  });

  test('hides cached failures without a vault and shows the missing-vault warning', () => {
    const { alert } = setup(true, '');
    expect(alert()).toBeNull();
    expect(screen.getByText(/Sync is on but no vault folder is set yet/)).toBeTruthy();
  });

  test('hides cached failures until the enabled setting is loaded', async () => {
    const { alert, client } = setup();
    await act(async () => {
      await client.resetQueries({ queryKey: settingsKeys.obsidianSync() });
    });
    await waitFor(() => expect(alert()).toBeNull());
    client.clear();
  });
});
