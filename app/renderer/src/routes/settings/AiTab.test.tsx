import { describe, expect, test, vi } from 'vitest';
import { render, screen } from '@testing-library/react';

vi.mock('@/hooks/useSettings', () => ({
  useIdentityMatchingEnabledSetting: () => ({ data: false }),
  useSetIdentityMatchingEnabled: () => ({ mutate: vi.fn() }),
}));

import { SpeakerIdentificationSetting } from './AiTab';

describe('Speaker identification setting', () => {
  test('exposes its opt-in responsibility to assistive technology', () => {
    render(<SpeakerIdentificationSetting />);

    const toggle = screen.getByRole('switch', { name: 'Speaker identification' });
    const descriptionId = toggle.getAttribute('aria-describedby');
    expect(descriptionId).toBe('speaker-identification-description');
    expect(document.getElementById(descriptionId!)?.textContent).toContain(
      'you confirm that you will inform the people you record',
    );
  });
});
