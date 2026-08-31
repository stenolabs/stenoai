import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render } from '@testing-library/react';
import { AlertCircle, CheckCircle2, Mic, Info } from 'lucide-react';

const h = vi.hoisted(() => ({
  showNotification: vi.fn(),
  rendererReady: vi.fn(),
  unsubscribe: vi.fn(),
}));

vi.mock('@/lib/ipc', () => ({
  ipc: () => ({
    on: { showNotification: h.showNotification },
    notification: { rendererReady: h.rendererReady },
  }),
}));

vi.mock('@/hooks/useTheme', () => ({ useTheme: () => ({}) }));

import { NotificationToast, notificationIconMeta } from './NotificationToast';

describe('notificationIconMeta', () => {
  it('returns null for the brand app icon (unset or "app")', () => {
    expect(notificationIconMeta(undefined)).toBeNull();
    expect(notificationIconMeta('app')).toBeNull();
  });

  it('maps alert -> red AlertCircle', () => {
    const meta = notificationIconMeta('alert');
    expect(meta?.Icon).toBe(AlertCircle);
    expect(meta?.className).toContain('red');
  });

  it('maps success -> green CheckCircle2', () => {
    const meta = notificationIconMeta('success');
    expect(meta?.Icon).toBe(CheckCircle2);
    expect(meta?.className).toContain('green');
  });

  it('maps recording -> blue Mic', () => {
    const meta = notificationIconMeta('recording');
    expect(meta?.Icon).toBe(Mic);
    expect(meta?.className).toContain('blue');
  });

  it('falls back to Info for an unknown iconType', () => {
    // @ts-expect-error - intentionally exercising an out-of-contract value
    const meta = notificationIconMeta('bogus');
    expect(meta?.Icon).toBe(Info);
    expect(meta?.className).toContain('gray');
  });
});

describe('NotificationToast handshake', () => {
  beforeEach(() => {
    h.showNotification.mockReset();
    h.rendererReady.mockReset();
    h.unsubscribe.mockReset();
    h.showNotification.mockReturnValue(h.unsubscribe);
  });

  it('subscribes before telling main that the notification renderer is ready', () => {
    render(<NotificationToast />);

    expect(h.showNotification).toHaveBeenCalledOnce();
    expect(h.rendererReady).toHaveBeenCalledOnce();
    expect(h.showNotification.mock.invocationCallOrder[0])
      .toBeLessThan(h.rendererReady.mock.invocationCallOrder[0]);
  });
});
