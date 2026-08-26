import { StrictMode, type ReactNode } from 'react';
import { act, renderHook } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { useBlobAudioPlayback } from './useBlobAudioPlayback';

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

class FakeAudio extends EventTarget {
  static instances: FakeAudio[] = [];
  static playResult: () => Promise<void> = () => Promise.resolve();
  readonly pause = vi.fn();
  readonly play = vi.fn(() => FakeAudio.playResult());
  onended: (() => void) | null = null;
  onerror: (() => void) | null = null;

  constructor(readonly src: string) {
    super();
    FakeAudio.instances.push(this);
  }
}

describe('useBlobAudioPlayback', () => {
  beforeEach(() => {
    FakeAudio.instances = [];
    FakeAudio.playResult = () => Promise.resolve();
    vi.stubGlobal('Audio', FakeAudio);
    vi.stubGlobal('atob', () => 'RIFF');
    vi.stubGlobal('URL', {
      createObjectURL: vi.fn(() => 'blob:sample'),
      revokeObjectURL: vi.fn(),
    });
  });

  it('ignores a sample request that resolves after unmount', async () => {
    const request = deferred<string>();
    const { result, unmount } = renderHook(() =>
      useBlobAudioPlayback(() => request.promise),
    );

    let toggle!: Promise<void>;
    act(() => {
      toggle = result.current.toggle('person-1');
    });
    unmount();
    request.resolve('UklGRg==');
    await toggle;

    expect(URL.createObjectURL).not.toHaveBeenCalled();
    expect(FakeAudio.instances).toHaveLength(0);
  });

  it('does not claim the global playback slot through a stale callback after unmount', async () => {
    const first = renderHook(() =>
      useBlobAudioPlayback(async () => 'UklGRg=='),
    );
    const staleToggle = first.result.current.toggle;
    first.unmount();

    await staleToggle('person-1');

    const second = renderHook(() =>
      useBlobAudioPlayback(async () => 'UklGRg=='),
    );
    await act(() => second.result.current.toggle('person-2'));

    expect(FakeAudio.instances).toHaveLength(1);
    expect(second.result.current.playingKey).toBe('person-2');
  });

  it('revokes the active blob URL when playback stops', async () => {
    const { result } = renderHook(() =>
      useBlobAudioPlayback(async () => 'UklGRg=='),
    );

    await act(() => result.current.toggle('person-1'));
    expect(result.current.playingKey).toBe('person-1');

    act(() => result.current.stop());

    expect(FakeAudio.instances[0].pause).toHaveBeenCalledOnce();
    expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:sample');
    expect(result.current.playingKey).toBeNull();
  });

  it('releases media and exposes an error when play rejects', async () => {
    FakeAudio.playResult = () => Promise.reject(new Error('blocked'));
    const { result } = renderHook(() =>
      useBlobAudioPlayback(async () => 'UklGRg=='),
    );

    await act(() => result.current.toggle('person-1'));

    expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:sample');
    expect(result.current.errorKey).toBe('person-1');
    expect(result.current.playingKey).toBeNull();
  });

  it('plays after the StrictMode development remount cycle', async () => {
    const wrapper = ({ children }: { children: ReactNode }) => (
      <StrictMode>{children}</StrictMode>
    );
    const { result } = renderHook(
      () => useBlobAudioPlayback(async () => 'UklGRg=='),
      { wrapper },
    );

    await act(() => result.current.toggle('person-1'));

    expect(FakeAudio.instances).toHaveLength(1);
    expect(result.current.playingKey).toBe('person-1');
  });

  it('stops playback owned by another hook before starting a new clip', async () => {
    const first = renderHook(() =>
      useBlobAudioPlayback(async () => 'UklGRg=='),
    );
    const second = renderHook(() =>
      useBlobAudioPlayback(async () => 'UklGRg=='),
    );

    await act(() => first.result.current.toggle('cluster-1'));
    await act(() => second.result.current.toggle('excerpt-2'));

    expect(FakeAudio.instances).toHaveLength(2);
    expect(FakeAudio.instances[0].pause).toHaveBeenCalledOnce();
    expect(first.result.current.playingKey).toBeNull();
    expect(second.result.current.playingKey).toBe('excerpt-2');
  });

  it('keeps newer playback registered when an older play request rejects', async () => {
    const firstPlay = deferred<void>();
    let playCalls = 0;
    FakeAudio.playResult = () => {
      playCalls += 1;
      return playCalls === 1 ? firstPlay.promise : Promise.resolve();
    };
    const first = renderHook(() =>
      useBlobAudioPlayback(async () => 'UklGRg=='),
    );
    const second = renderHook(() =>
      useBlobAudioPlayback(async () => 'UklGRg=='),
    );

    let staleToggle!: Promise<void>;
    act(() => {
      staleToggle = first.result.current.toggle('cluster-1');
    });
    await act(async () => {
      await Promise.resolve();
    });
    expect(FakeAudio.instances).toHaveLength(1);

    await act(() => first.result.current.toggle('cluster-2'));
    expect(first.result.current.playingKey).toBe('cluster-2');

    firstPlay.reject(new Error('stale failure'));
    await act(() => staleToggle);
    expect(first.result.current.playingKey).toBe('cluster-2');

    await act(() => second.result.current.toggle('excerpt-3'));

    expect(FakeAudio.instances).toHaveLength(3);
    expect(FakeAudio.instances[1].pause).toHaveBeenCalledOnce();
    expect(first.result.current.playingKey).toBeNull();
    expect(second.result.current.playingKey).toBe('excerpt-3');
  });
});
