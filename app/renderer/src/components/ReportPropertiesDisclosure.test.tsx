import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  PROPERTIES_OPEN_KEY,
  PROPERTIES_PANEL_ID,
  PropertiesToggle,
  useStoredFlag,
} from './ReportPropertiesDisclosure';
import { ReportProperties, type ReportProperty } from '@/lib/markdown';

const properties: ReportProperty[] = [
  ['client', 'Erika Mustermann'],
  ['issue', 'Empty Bcc field'],
];

// The pieces as MeetingDetail puts them together: the toggle in the switch row,
// the table below it only while it is open.
function Harness() {
  const [open, toggle] = useStoredFlag(PROPERTIES_OPEN_KEY);
  return (
    <>
      <PropertiesToggle count={properties.length} open={open} onToggle={toggle} />
      {open && <ReportProperties id={PROPERTIES_PANEL_ID} properties={properties} />}
    </>
  );
}

describe('report properties disclosure', () => {
  // Node's own `localStorage` global shadows jsdom's here and is unusable, so
  // each test gets a fresh in-memory one.
  beforeEach(() => {
    const store = new Map<string, string>();
    vi.stubGlobal('localStorage', {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => void store.set(k, v),
    });
  });
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it('is closed by default, with the count on the toggle', () => {
    render(<Harness />);
    const toggle = screen.getByTestId('report-properties-toggle');
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
    expect(toggle.textContent).toBe('Properties2');
    expect(screen.queryByTestId('report-properties')).toBeNull();
  });

  it('opens every property, in order', () => {
    render(<Harness />);
    fireEvent.click(screen.getByTestId('report-properties-toggle'));
    const table = screen.getByTestId('report-properties');
    expect(table.id).toBe(PROPERTIES_PANEL_ID);
    expect([...table.querySelectorAll('dt')].map((dt) => dt.textContent)).toEqual(['client', 'issue']);
  });

  it('remembers the choice for the next note', () => {
    const first = render(<Harness />);
    fireEvent.click(screen.getByTestId('report-properties-toggle'));
    first.unmount();
    render(<Harness />);
    expect(screen.getByTestId('report-properties-toggle').getAttribute('aria-expanded')).toBe('true');
    expect(screen.getByTestId('report-properties')).toBeTruthy();
  });
});
