import { describe, test, expect, beforeEach, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { CookbookEditor } from './CookbookEditor';

// A failed cookbook delete must not become an unhandled promise rejection with
// no user feedback: the dialog stays open and surfaces a visible error so the
// user can retry (#308).

const remove = vi.fn(async () => ({ success: true }));
const onClose = vi.fn();

vi.mock('@/lib/ipc', () => ({
  ipc: () => ({
    templates: {
      list: async () => ({
        success: true,
        default_template_id: 'standard',
        templates: [
          {
            id: 'custom-1',
            name: 'My Custom',
            prompt: 'Do the thing',
            builtin: false,
            locked: false,
          },
        ],
      }),
      remove,
      save: async () => ({ success: true }),
      setDefault: async () => ({ success: true }),
      reset: async () => ({ success: true }),
    },
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
      <CookbookEditor
        editing={{ id: 'custom-1', name: 'My Custom', prompt: 'Do the thing', builtin: false, locked: false }}
        onClose={onClose}
      />
    </QueryClientProvider>,
  );
}

describe('CookbookEditor delete failure', () => {
  beforeEach(() => {
    remove.mockReset();
    onClose.mockReset();
  });

  test('a rejected delete keeps the dialog open and shows an error', async () => {
    const unhandled: unknown[] = [];
    const onUnhandled = (e: PromiseRejectionEvent) => unhandled.push(e.reason);
    window.addEventListener('unhandledrejection', onUnhandled);

    remove.mockRejectedValue(new Error('backend exploded'));
    renderTab();

    // Open the confirm dialog for the custom cookbook.
    const del = await screen.findByRole('button', { name: 'Delete cookbook My Custom' });
    fireEvent.click(del);
    const confirm = await screen.findByRole('button', { name: 'Delete' });

    // Confirm the delete — the mutation rejects.
    fireEvent.click(confirm);

    // A visible error surfaces...
    await screen.findByText(/backend exploded/i);
    // ...and the dialog stays open (its title is still present; getByText
    // throws if absent).
    expect(screen.getByText('Delete cookbook "My Custom"?')).toBeTruthy();
    expect(onClose).not.toHaveBeenCalled();

    // Let any microtasks settle, then assert nothing escaped unhandled.
    await new Promise((r) => setTimeout(r, 0));
    expect(unhandled).toEqual([]);

    window.removeEventListener('unhandledrejection', onUnhandled);
  });
});
