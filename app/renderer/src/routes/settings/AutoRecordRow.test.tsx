import { describe, test, expect, beforeEach, vi } from 'vitest';
import { render, screen, fireEvent, act } from '@testing-library/react';

import { AutoRecordRow } from './AutoRecordRow';

// Auto-record (#463) records without asking, so the row must start off, turn on
// only after the consent dialog, act only while meeting detection does, and
// say why when it can't.

const h = vi.hoisted(() => ({
  autoRecord: { data: false as boolean | undefined },
  setAutoRecord: { mutate: vi.fn(), isPending: false },
}));

vi.mock('@/hooks/useSettings', () => ({
  useAutoRecordMeetingsSetting: () => h.autoRecord,
  useSetAutoRecordMeetings: () => h.setAutoRecord,
}));

const toggle = () => screen.getByRole('switch', { name: 'Auto-record detected meetings' }) as HTMLButtonElement;
const consent = /many jurisdictions only permit recording/;

beforeEach(() => {
  h.autoRecord.data = false;
  h.setAutoRecord.mutate.mockReset();
  h.setAutoRecord.isPending = false;
});

describe('AutoRecordRow', () => {
  test('off by default, and the description mentions consent', () => {
    render(<AutoRecordRow detectionSupported detectionOn />);
    expect(toggle().getAttribute('aria-checked')).toBe('false');
    expect(toggle().disabled).toBe(false);
    expect(screen.getByText(/obtain the consent of all participants when necessary/)).toBeTruthy();
  });

  test('turning it on asks first; "I understand" saves it', async () => {
    render(<AutoRecordRow detectionSupported detectionOn />);
    await act(async () => {
      fireEvent.click(toggle());
    });
    expect(screen.getByText(consent)).toBeTruthy();
    expect(h.setAutoRecord.mutate).not.toHaveBeenCalled();
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'I understand' }));
    });
    expect(h.setAutoRecord.mutate).toHaveBeenCalledWith(true);
    expect(screen.queryByText(consent)).toBeNull();
  });

  test('"Keep off" leaves it off and saves nothing', async () => {
    render(<AutoRecordRow detectionSupported detectionOn />);
    await act(async () => {
      fireEvent.click(toggle());
    });
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Keep off' }));
    });
    expect(h.setAutoRecord.mutate).not.toHaveBeenCalled();
    expect(screen.queryByText(consent)).toBeNull();
    expect(toggle().getAttribute('aria-checked')).toBe('false');
  });

  test('turning it off saves at once, without the dialog', async () => {
    h.autoRecord.data = true;
    render(<AutoRecordRow detectionSupported detectionOn />);
    expect(toggle().getAttribute('aria-checked')).toBe('true');
    await act(async () => {
      fireEvent.click(toggle());
    });
    expect(screen.queryByText(consent)).toBeNull();
    expect(h.setAutoRecord.mutate).toHaveBeenCalledWith(false);
  });

  test('disabled while a save runs, so two saves cannot overlap', () => {
    h.setAutoRecord.isPending = true;
    render(<AutoRecordRow detectionSupported detectionOn />);
    expect(toggle().disabled).toBe(true);
  });

  test('the switch is described by the row text, for screen readers', () => {
    render(<AutoRecordRow detectionSupported detectionOn />);
    const id = toggle().getAttribute('aria-describedby');
    expect(id).toBeTruthy();
    expect(document.getElementById(id!)?.textContent).toContain('Start recording automatically');
  });

  test('without meeting detection it is off, disabled, and says how to turn it on', () => {
    h.autoRecord.data = true;
    render(<AutoRecordRow detectionSupported detectionOn={false} />);
    expect(toggle().getAttribute('aria-checked')).toBe('false');
    expect(toggle().disabled).toBe(true);
    expect(screen.getByText(/Turn on Auto-detected meetings to use this\./)).toBeTruthy();
  });

  test('where detection is unsupported it says so instead', () => {
    render(<AutoRecordRow detectionSupported={false} detectionOn={false} />);
    expect(toggle().disabled).toBe(true);
    expect(screen.getByText(/Requires macOS 14 \(Sonoma\) or later\./)).toBeTruthy();
    expect(screen.queryByText(/Turn on Auto-detected meetings/)).toBeNull();
  });

  test('disabled until the setting has loaded', () => {
    h.autoRecord.data = undefined;
    render(<AutoRecordRow detectionSupported detectionOn />);
    expect(toggle().disabled).toBe(true);
  });
});
