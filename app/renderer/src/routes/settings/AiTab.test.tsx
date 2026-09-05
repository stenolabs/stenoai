import { describe, expect, test, vi } from 'vitest';
import { render, screen } from '@testing-library/react';

vi.mock('@/hooks/useSettings', () => ({
  useIdentityMatchingEnabledSetting: () => ({ data: false }),
  useSetIdentityMatchingEnabled: () => ({ mutate: vi.fn() }),
}));

import { SpeakerIdentificationSetting } from './AiTab';

describe('Speaker identification setting', () => {
  test('describes itself to assistive technology', () => {
    render(<SpeakerIdentificationSetting />);

    // The wiring is what this guards: the switch must point at a description
    // element that actually exists and carries text. The wording itself is
    // asserted by the copy inventory, not here, so a copy edit doesn't have to
    // touch this test to stay honest.
    const toggle = screen.getByRole('switch', { name: 'Speaker identification' });
    const descriptionId = toggle.getAttribute('aria-describedby');
    expect(descriptionId).toBe('speaker-identification-description');
    const description = document.getElementById(descriptionId!);
    expect(description).not.toBeNull();
    expect(description!.textContent?.trim()).toBe('Optional and off by default.');
  });
});
