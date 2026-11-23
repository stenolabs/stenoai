import { describe, expect, it, vi, beforeEach } from 'vitest';
import * as React from 'react';
import { act, fireEvent, render, screen } from '@testing-library/react';
import type { NoteDraft } from '@/lib/noteDraft';
import type { InlineEditorHandle, InlineSaveState } from './InlineNote';

const h = vi.hoisted(() => ({ save: vi.fn() }));
vi.mock('@/hooks/useMeetings', () => ({
  useAutosaveNote: () => ({ mutateAsync: h.save }),
}));

const { InlineNote } = await import('./InlineNote');

const VALUE: NoteDraft = {
  summary: 'We ship Friday.',
  keyPoints: ['Ready'],
  actionItems: [],
  discussionAreas: [{ title: 'Release', analysis: 'QA signed off.' }],
};

let n = 0;
function setup(value: NoteDraft = VALUE) {
  const handle = React.createRef<InlineEditorHandle>();
  const states: InlineSaveState[] = [];
  // A fresh cache key per test keeps the module-level draft cache isolated.
  const key = `note-${(n += 1)}.md`;
  const utils = render(
    <InlineNote
      summaryFile={key}
      cacheKey={key}
      value={value}
      handleRef={handle}
      onStateChange={(s) => states.push(s)}
    />
  );
  return { ...utils, handle, states, key };
}

const field = (name: string) => screen.getByRole('textbox', { name }) as HTMLTextAreaElement;

beforeEach(() => {
  h.save.mockReset();
  h.save.mockResolvedValue({ edited_fields: [] });
});

describe('InlineNote', () => {
  it('renders every section as a labelled field with the note text', () => {
    setup();
    expect(field('Summary').value).toBe('We ship Friday.');
    expect(field('Topic 1 title').value).toBe('Release');
    expect(field('Topic 1 notes').value).toBe('QA signed off.');
    expect(field('Key point 1').value).toBe('Ready');
    // An empty list still offers one bullet to type into.
    expect(field('Action item 1').value).toBe('');
  });

  it('autosaves only the changed section after the debounce', async () => {
    vi.useFakeTimers();
    try {
      const { key } = setup();
      fireEvent.change(field('Summary'), { target: { value: 'We ship Monday.' } });
      expect(h.save).not.toHaveBeenCalled();
      await act(async () => {
        await vi.advanceTimersByTimeAsync(800);
      });
      expect(h.save).toHaveBeenCalledTimes(1);
      expect(h.save.mock.calls[0][0]).toEqual({
        summaryFile: key,
        cacheKey: key,
        patch: { summary: 'We ship Monday.' },
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it('Enter in a bullet creates the next one and Backspace on it removes it', async () => {
    setup();
    const first = field('Key point 1');
    first.setSelectionRange(5, 5);
    fireEvent.keyDown(first, { key: 'Enter' });
    const second = field('Key point 2');
    expect(second.value).toBe('');
    expect(document.activeElement).toBe(second);
    fireEvent.keyDown(second, { key: 'Backspace' });
    expect(screen.queryByRole('textbox', { name: 'Key point 2' })).toBeNull();
    expect(document.activeElement).toBe(field('Key point 1'));
  });

  it('a pasted list becomes one bullet per line', () => {
    setup();
    const first = field('Key point 1');
    first.setSelectionRange(5, 5);
    fireEvent.paste(first, {
      clipboardData: { getData: () => '\n- Docs done\n- Tests green' },
    });
    expect(field('Key point 1').value).toBe('Ready');
    expect(field('Key point 2').value).toBe('Docs done');
    expect(field('Key point 3').value).toBe('Tests green');
  });

  it('refuses a heading inline and never sends it', async () => {
    const { handle } = setup();
    fireEvent.change(field('Summary'), { target: { value: 'Fine\n## Transcript' } });
    expect(screen.getByRole('alert').textContent).toMatch(/summary.*heading/i);
    expect(field('Summary').getAttribute('aria-invalid')).toBe('true');
    let ok: boolean | undefined;
    await act(async () => {
      ok = await handle.current!.flush();
    });
    expect(ok).toBe(false);
    expect(h.save).not.toHaveBeenCalled();
    expect(handle.current!.hasUnsaved()).toBe(true);
  });

  it('flush writes a pending edit immediately and reports Saved', async () => {
    const { handle, states } = setup();
    fireEvent.change(field('Action item 1'), { target: { value: 'Bob publishes' } });
    await act(async () => {
      expect(await handle.current!.flush()).toBe(true);
    });
    expect(h.save).toHaveBeenCalledTimes(1);
    expect(h.save.mock.calls[0][0].patch).toEqual({ action_items: ['Bob publishes'] });
    expect(states.at(-1)?.status).toBe('saved');
    expect(handle.current!.savedEditsThisSession()).toBe(true);
    expect(handle.current!.hasUnsaved()).toBe(false);
  });

  it('a failed write keeps the draft and reports the error for retry', async () => {
    h.save.mockRejectedValueOnce(new Error('Steno is still updating this note.'));
    const { handle, states } = setup();
    fireEvent.change(field('Summary'), { target: { value: 'Changed.' } });
    await act(async () => {
      expect(await handle.current!.flush()).toBe(false);
    });
    expect(states.at(-1)).toMatchObject({ status: 'error', error: 'Steno is still updating this note.' });
    expect(field('Summary').value).toBe('Changed.');
    await act(async () => {
      expect(await handle.current!.flush()).toBe(true);
    });
    expect(h.save).toHaveBeenCalledTimes(2);
  });

  it('an unsaved draft survives an unmount and is re-applied on top of the fresher note', async () => {
    h.save.mockRejectedValue(new Error('busy'));
    const handle = React.createRef<InlineEditorHandle>();
    const props = { summaryFile: 'restore.md', cacheKey: 'restore.md', handleRef: handle, onStateChange: () => {} };
    const first = render(<InlineNote {...props} value={VALUE} />);
    fireEvent.change(field('Summary'), { target: { value: 'Mine.' } });
    await act(async () => {
      first.unmount();
    });
    h.save.mockReset();
    h.save.mockResolvedValue({ edited_fields: ['summary'] });
    await act(async () => {
      render(<InlineNote {...props} value={{ ...VALUE, keyPoints: ['Refined'] }} />);
    });
    expect(field('Summary').value).toBe('Mine.');
    expect(field('Key point 1').value).toBe('Refined');
    await act(async () => {
      expect(await handle.current!.flush()).toBe(true);
    });
    expect(h.save).toHaveBeenLastCalledWith(
      expect.objectContaining({ patch: { summary: 'Mine.' } })
    );
  });
});
