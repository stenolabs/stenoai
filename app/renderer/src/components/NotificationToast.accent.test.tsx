import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, act } from '@testing-library/react';

/**
 * #412: the accent bar used to take a colour hashed from the toast title, which
 * read as meaningful and broke the paper + ink palette. Only a calendar event's
 * own colour belongs there now; every other toast gets the neutral bar.
 */

const h = vi.hoisted(() => ({
  listener: null as ((data: Record<string, unknown>) => void) | null,
}));

vi.mock('@/lib/ipc', () => ({
  ipc: () => ({
    on: {
      showNotification: (cb: (data: Record<string, unknown>) => void) => {
        h.listener = cb;
        return () => {
          h.listener = null;
        };
      },
    },
    analytics: { track: vi.fn() },
    notification: { close: vi.fn(), bodyClicked: vi.fn(), actionClicked: vi.fn(), rendererReady: vi.fn() },
    window: { focus: vi.fn() },
  }),
}));
vi.mock('@/hooks/useTheme', () => ({ useTheme: () => undefined }));

import { NotificationToast } from './NotificationToast';

function show(data: Record<string, unknown>) {
  render(<NotificationToast />);
  act(() => h.listener?.({ id: 'n_1', body: '', ...data }));
  return screen.getByTestId('toast-accent-bar');
}

describe('NotificationToast accent bar', () => {
  beforeEach(() => {
    h.listener = null;
  });

  it('is neutral for a generic toast, whatever its title', () => {
    const bar = show({ title: 'Recording paused', iconType: 'alert' });
    expect(bar.style.backgroundColor).toBe('');
    expect(bar.className).toContain('bg-gray-300');
  });

  it("keeps a calendar event's own colour", () => {
    const bar = show({ title: 'Team sync', premeeting: true, color: '#33b679' });
    expect(bar.style.backgroundColor).toBe('rgb(51, 182, 121)');
    expect(bar.className).not.toContain('bg-gray-300');
  });
});
