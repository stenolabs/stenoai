import { describe, test, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { ModelCard, modelDisplayName, modelNote } from './model-card';

// The icon-only delete-model button needs an accessible name for screen
// readers; the sighted-only `title` tooltip is not exposed as the accessible
// name reliably (#309).

describe('ModelCard delete button', () => {
  test('the delete-model button has an accessible name', () => {
    render(
      <ModelCard
        name="gemma3:12b"
        isCurrent={false}
        isInstalled
        onSelect={vi.fn()}
        onDeleteModel={vi.fn()}
      />,
    );

    expect(
      screen.getByRole('button', { name: 'Delete model' }),
    ).toBeTruthy();
  });

  test('a disabled non-deletable card cannot be selected or deleted', () => {
    render(
      <ModelCard
        name="Apple Intelligence"
        isCurrent={false}
        isInstalled={false}
        onSelect={vi.fn()}
        onDeleteModel={undefined}
        selectDisabled
      />,
    );

    expect(screen.queryByRole('button', { name: 'Delete model' })).toBeNull();
    const select = screen.getByRole('button', { name: 'Select' });
    expect((select as HTMLButtonElement).disabled).toBe(true);
  });
});

describe('managed model presentation', () => {
  test('uses the display name and actionable backend description', () => {
    expect(modelDisplayName('apple:system', 'Apple Intelligence')).toBe(
      'Apple Intelligence',
    );
    expect(
      modelNote({
        isRemote: false,
        managed: true,
        description: 'Enable Apple Intelligence in System Settings before selecting this model.',
        speed: 'fast',
        quality: 'good',
      }),
    ).toBe('Enable Apple Intelligence in System Settings before selecting this model.');
  });
});
