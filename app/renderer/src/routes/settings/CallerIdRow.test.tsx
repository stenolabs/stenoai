import { beforeEach, describe, test, expect, vi } from 'vitest';
import { act, render, screen, fireEvent } from '@testing-library/react';

import { CallerIdRow } from './CallerIdRow';

// The description names iMCP as a link to its home page, so the row says how to
// get what it needs before anyone turns it on. Turning it on asks first, since
// caller names then reach the AI model, which may be a cloud provider's.

const h = vi.hoisted(() => ({
  openExternal: vi.fn(() => Promise.resolve({ success: true })),
  isMac: true,
  saveFailed: false,
  queried: 0,
  enabled: false,
  mutate: vi.fn(),
}));

vi.mock('@/lib/utils', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/utils')>();
  return {
    ...actual,
    get isMac() {
      return h.isMac;
    },
  };
});

vi.mock('@/hooks/useSettings', () => ({
  useCallerIdSetting: () => (
    h.queried++,
    {
      data: {
        supported: true,
        caller_id_enabled: h.enabled,
        meeting_detection: true,
        status: { state: 'off', contacts: false },
        download_url: 'https://imcp.app/download',
        homebrew: 'brew install --cask mattt/tap/iMCP',
      },
      isError: false,
    }
  ),
  useSetCallerId: () => ({ mutate: h.mutate, isPending: false, isError: h.saveFailed }),
}));

vi.mock('@/lib/ipc', () => ({
  ipc: () => ({ shell: { openExternal: h.openExternal }, settings: { openImcpDownload: vi.fn() } }),
}));

beforeEach(() => {
  Object.assign(h, { isMac: true, saveFailed: false, queried: 0, enabled: false });
  h.mutate.mockReset();
});

const toggle = () => screen.getByRole('switch', { name: 'Identify call participants' });
const consent = /Caller names will be visible to the LLM, including cloud models/;

describe('CallerIdRow', () => {
  test('off macOS it renders nothing and asks main for nothing', () => {
    h.isMac = false;
    const { container } = render(<CallerIdRow />);
    expect(container.innerHTML).toBe('');
    expect(h.queried).toBe(0);
  });

  test('turning it on asks first; "I understand" saves it', async () => {
    render(<CallerIdRow />);
    await act(async () => {
      fireEvent.click(toggle());
    });
    expect(screen.getByText('Identify callers')).toBeTruthy();
    expect(screen.getByText(consent).textContent).toBe(
      "iMCP will read the Mac's local call and Contacts databases. Caller names will be visible " +
        'to the LLM, including cloud models, when they summarize the transcript. Numbers are ' +
        'saved, but not added to the transcript.'
    );
    expect(h.mutate).not.toHaveBeenCalled();
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'I understand' }));
    });
    expect(h.mutate).toHaveBeenCalledWith(true);
    expect(screen.queryByText(consent)).toBeNull();
  });

  test('"Disable" leaves it off and saves nothing', async () => {
    render(<CallerIdRow />);
    await act(async () => {
      fireEvent.click(toggle());
    });
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Disable' }));
    });
    expect(h.mutate).not.toHaveBeenCalled();
    expect(screen.queryByText(consent)).toBeNull();
    expect(toggle().getAttribute('aria-checked')).toBe('false');
  });

  test('turning it off saves at once, without the dialog', async () => {
    h.enabled = true;
    render(<CallerIdRow />);
    expect(toggle().getAttribute('aria-checked')).toBe('true');
    await act(async () => {
      fireEvent.click(toggle());
    });
    expect(screen.queryByText(consent)).toBeNull();
    expect(h.mutate).toHaveBeenCalledWith(false);
  });

  test('a failed save says so', () => {
    h.saveFailed = true;
    render(<CallerIdRow />);
    expect(screen.getByRole('alert').textContent).toBe(
      'Could not change the caller setting. Try again.'
    );
  });

  test('names iMCP as a link to imcp.app, inside the sentence', () => {
    render(<CallerIdRow />);
    const link = screen.getByRole('button', { name: 'iMCP.app' });
    expect(link.parentElement?.textContent).toContain(
      'Capture the name or number of phone and FaceTime call participants using the free iMCP.app.'
    );
    fireEvent.click(link);
    expect(h.openExternal).toHaveBeenCalledWith('https://imcp.app');
  });
});
