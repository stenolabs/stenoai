import { beforeEach, describe, expect, test, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';

type Models = 'ready' | 'missing' | 'unavailable' | 'unknown' | undefined;
type Progress = { percent: number; phase: string } | null;

function idleMutation() {
  return { mutate: vi.fn(), isPending: false, isError: false, variables: undefined as string | undefined };
}

const diarization = vi.hoisted(() => ({
  engine: { data: 'sortformer' as string | undefined, isError: false, refetch: vi.fn() },
  models: { data: 'ready' as Models },
  mutation: {
    mutate: vi.fn(),
    isPending: false,
    isError: false,
    variables: undefined as string | undefined,
  },
  download: {
    progress: null as Progress,
    clearProgress: vi.fn(),
    download: {
      mutate: vi.fn(),
      isPending: false,
      isError: false,
      variables: undefined as string | undefined,
    },
  },
}));

vi.mock('@/hooks/useSettings', () => ({
  useIdentityMatchingEnabledSetting: () => ({ data: false }),
  useSetIdentityMatchingEnabled: () => ({ mutate: vi.fn() }),
}));

vi.mock('@/hooks/useModels', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/hooks/useModels')>()),
  useDiarizationEngine: () => diarization.engine,
  useDiarizationModelsState: () => diarization.models,
  useDownloadDiarizationModels: () => diarization.download,
  useSetDiarizationEngine: () => diarization.mutation,
}));

import { SpeakerIdentificationSetting, SpeakerSeparationSetting } from './AiTab';

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

describe('Individual speakers row with the engine picker', () => {
  beforeEach(() => {
    diarization.engine = { data: 'sortformer', isError: false, refetch: vi.fn() };
    diarization.models = { data: 'ready' };
    diarization.mutation = idleMutation();
    diarization.download = { progress: null, clearProgress: vi.fn(), download: idleMutation() };
  });

  function picker() {
    const trigger = screen.getByRole('combobox', { name: 'Speaker detection' });
    expect(trigger.getAttribute('aria-describedby')).toBe('speaker-models-description');
    expect(document.getElementById('speaker-models-description')?.textContent).toContain(
      'Runs on your device',
    );
    return trigger as HTMLButtonElement;
  }

  test('installed models show Installed next to the saved engine', () => {
    render(<SpeakerSeparationSetting />);

    expect(picker().textContent).toContain('Standard');
    expect(picker().disabled).toBe(false);
    expect(screen.getByText('Installed')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Download' })).toBeNull();
    expect(screen.queryByRole('alert')).toBeNull();
  });

  test("Download fetches the saved engine's models without re-saving it", () => {
    diarization.engine = { data: 'nemotron3', isError: false, refetch: vi.fn() };
    diarization.models = { data: 'missing' };
    render(<SpeakerSeparationSetting />);

    fireEvent.click(screen.getByRole('button', { name: 'Download' }));
    expect(diarization.download.download.mutate).toHaveBeenCalledWith('nemotron3');
    expect(diarization.mutation.mutate).not.toHaveBeenCalled();
  });

  test('a failed check still offers the download', () => {
    diarization.models = { data: 'unknown' };
    render(<SpeakerSeparationSetting />);
    expect(screen.getByRole('button', { name: 'Download' })).toBeTruthy();
  });

  test('a build without the speaker sidecar says so instead of offering the picker', () => {
    diarization.models = { data: 'unavailable' };
    render(<SpeakerSeparationSetting />);

    expect(screen.getByText('Not available on this Mac.')).toBeTruthy();
    expect(screen.queryByRole('combobox')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Download' })).toBeNull();
  });

  test("shows the download's progress and locks the picker while it runs", () => {
    diarization.models = { data: 'missing' };
    diarization.download = {
      ...diarization.download,
      progress: { percent: 37, phase: 'downloading' },
      download: { ...idleMutation(), isPending: true, variables: 'sortformer' },
    };
    render(<SpeakerSeparationSetting />);

    expect(picker().disabled).toBe(true);
    const bar = screen.getByRole('progressbar', { name: 'Speaker model download progress' });
    expect(bar.getAttribute('aria-valuenow')).toBe('37');
    expect(screen.queryByRole('button', { name: 'Download' })).toBeNull();
  });

  test('locks the picker on the pending engine while switching downloads it', () => {
    diarization.models = { data: 'ready' };
    diarization.mutation = { ...idleMutation(), isPending: true, variables: 'nemotron3' };
    render(<SpeakerSeparationSetting />);

    expect(picker().disabled).toBe(true);
    expect(picker().textContent).toContain('Nemotron 3');
  });

  test('a failed switch keeps the previous engine and says so', () => {
    diarization.mutation = { ...idleMutation(), isError: true, variables: 'nemotron3' };
    render(<SpeakerSeparationSetting />);

    expect(picker().textContent).toContain('Standard');
    expect(screen.getByRole('alert').textContent).toContain('previous model is still active');
  });

  test('a failed Download says so and offers a retry', () => {
    diarization.models = { data: 'missing' };
    diarization.download = {
      ...diarization.download,
      download: { ...idleMutation(), isError: true, variables: 'sortformer' },
    };
    render(<SpeakerSeparationSetting />);

    expect(screen.getByRole('alert').textContent).toContain('Download failed');
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    expect(diarization.download.download.mutate).toHaveBeenCalledWith('sortformer');
  });

  test('a failed setting read locks the picker and retries the read', () => {
    diarization.engine = { data: undefined, isError: true, refetch: vi.fn() };
    render(<SpeakerSeparationSetting />);

    expect(picker().disabled).toBe(true);
    expect(screen.getByRole('alert').textContent).toContain(
      'Could not load the speaker detection setting',
    );
    fireEvent.click(screen.getByTestId('diarization-engine-retry'));
    expect(diarization.engine.refetch).toHaveBeenCalledOnce();
  });
});
