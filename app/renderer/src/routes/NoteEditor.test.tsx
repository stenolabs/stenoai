import { describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { NoteEditor, validateNotePatch, type NoteDraft } from './NoteEditor';

const DRAFT: NoteDraft = {
  summary: 'We agreed the budget.',
  keyPoints: ['Budget approved'],
  actionItems: ['Anna sends the draft'],
  discussionAreas: [{ title: 'Budget', analysis: 'Reviewed.' }],
};

describe('NoteEditor', () => {
  it('renders the current values', () => {
    render(<NoteEditor value={DRAFT} onSave={vi.fn()} onCancel={vi.fn()} />);
    expect(screen.getByDisplayValue('We agreed the budget.')).toBeTruthy();
    expect(screen.getByDisplayValue('Budget approved')).toBeTruthy();
  });

  // getByDisplayValue and getByLabelText both match a <textarea>, so every other
  // test in this file passes if a list row regresses to one. It must not: a
  // newline in a key point or action item silently truncates the entry on the
  // next write (renderBulletList keeps only the first line), which is why the
  // rows are single-line inputs and the line-break guard exists at all.
  it('renders list rows as single-line inputs', () => {
    render(<NoteEditor value={DRAFT} onSave={vi.fn()} onCancel={vi.fn()} />);
    expect(screen.getByLabelText('Key point 1').tagName).toBe('INPUT');
    expect(screen.getByLabelText('Action item 1').tagName).toBe('INPUT');
    expect(screen.getByLabelText('Topic 1 title').tagName).toBe('INPUT');
  });

  // The measure belongs to the editor body, once. Expressed per field it was
  // `64ch` against three different font sizes, which resolved to three
  // different pixel widths and three visibly ragged right edges.
  it('does not set a per-field measure', () => {
    render(<NoteEditor value={DRAFT} onSave={vi.fn()} onCancel={vi.fn()} />);
    for (const label of ['Key point 1', 'Action item 1', 'Topic 1 title', 'Topic 1 notes']) {
      expect((screen.getByLabelText(label) as HTMLElement).style.maxWidth).toBe('');
    }
    expect((screen.getByDisplayValue('We agreed the budget.') as HTMLElement).style.maxWidth).toBe(
      ''
    );
  });

  it('keeps Save disabled until something changes', () => {
    render(<NoteEditor value={DRAFT} onSave={vi.fn()} onCancel={vi.fn()} />);
    const save = screen.getByRole('button', { name: /save/i }) as HTMLButtonElement;
    expect(save.disabled).toBe(true);
    fireEvent.change(screen.getByDisplayValue('We agreed the budget.'), {
      target: { value: 'We agreed the Q3 budget.' },
    });
    expect(save.disabled).toBe(false);
  });

  it('sends only the fields that actually changed', async () => {
    const onSave = vi.fn().mockResolvedValue(undefined);
    render(<NoteEditor value={DRAFT} onSave={onSave} onCancel={vi.fn()} />);
    fireEvent.change(screen.getByDisplayValue('We agreed the budget.'), {
      target: { value: 'We agreed the Q3 budget.' },
    });
    // act() around the click flushes the resolved onSave promise, so the
    // component's own post-save state update doesn't land after the test ends.
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /save/i }));
    });
    expect(onSave).toHaveBeenCalledWith({ summary: 'We agreed the Q3 budget.' });
  });

  it('refuses a value containing a markdown heading and explains why', () => {
    const onSave = vi.fn();
    render(<NoteEditor value={DRAFT} onSave={onSave} onCancel={vi.fn()} />);
    fireEvent.change(screen.getByDisplayValue('We agreed the budget.'), {
      target: { value: 'ok\n## Transcript' },
    });
    fireEvent.click(screen.getByRole('button', { name: /save/i }));
    expect(onSave).not.toHaveBeenCalled();
    expect(screen.getByText(/heading/i)).toBeTruthy();
  });

  // The Save button is pinned, so the reason it refused has to be pinned with
  // it. As a sibling below the bar it scrolled away on exactly the long notes
  // where the user cannot see both at once.
  it('shows the error inside the sticky action bar', () => {
    render(<NoteEditor value={DRAFT} onSave={vi.fn()} onCancel={vi.fn()} />);
    fireEvent.change(screen.getByDisplayValue('We agreed the budget.'), {
      target: { value: 'ok\n## Transcript' },
    });
    fireEvent.click(screen.getByRole('button', { name: /save/i }));
    const alert = screen.getByRole('alert');
    const bar = alert.closest('.sticky');
    expect(bar).not.toBeNull();
    expect(bar?.contains(screen.getByRole('button', { name: /save/i }))).toBe(true);
  });

  it('names the row a rejected value is in and marks that row', () => {
    const onSave = vi.fn();
    render(<NoteEditor value={DRAFT} onSave={onSave} onCancel={vi.fn()} />);
    fireEvent.change(screen.getByLabelText('Key point 1'), { target: { value: '# forged' } });
    fireEvent.click(screen.getByRole('button', { name: /save/i }));
    expect(onSave).not.toHaveBeenCalled();
    expect(screen.getByRole('alert').textContent).toMatch(/key point 1/i);
    expect(screen.getByLabelText('Key point 1').getAttribute('aria-invalid')).toBe('true');
    expect(screen.getByLabelText('Action item 1').getAttribute('aria-invalid')).toBeNull();
  });

  // The patch drops blank rows, so its indices stop matching the draft's the
  // moment there is one. The message used to be numbered from the patch and the
  // highlight from the draft, so they pointed at different rows and the
  // sentence sent the user to a field that was fine.
  it('numbers the row the user sees, not the row in the patch', () => {
    render(<NoteEditor value={DRAFT} onSave={vi.fn()} onCancel={vi.fn()} />);
    // Row 1 blank, row 2 (added) carries the rejected value: the patch sees one
    // entry at index 0, the draft has it at index 1.
    fireEvent.change(screen.getByLabelText('Key point 1'), { target: { value: '' } });
    fireEvent.click(screen.getByRole('button', { name: /add key point/i }));
    fireEvent.change(screen.getByLabelText('Key point 2'), { target: { value: '# forged' } });
    fireEvent.click(screen.getByRole('button', { name: /save/i }));

    expect(screen.getByRole('alert').textContent).toMatch(/key point 2/i);
    expect(screen.getByRole('alert').textContent).not.toMatch(/key point 1/i);
    // The highlight was always right; the sentence now agrees with it.
    expect(screen.getByLabelText('Key point 2').getAttribute('aria-invalid')).toBe('true');
    expect(screen.getByLabelText('Key point 1').getAttribute('aria-invalid')).toBeNull();
  });

  it('retires the rejection once the row is retyped', () => {
    render(<NoteEditor value={DRAFT} onSave={vi.fn()} onCancel={vi.fn()} />);
    fireEvent.change(screen.getByLabelText('Key point 1'), { target: { value: '# forged' } });
    fireEvent.click(screen.getByRole('button', { name: /save/i }));
    expect(screen.queryByRole('alert')).not.toBeNull();
    fireEvent.change(screen.getByLabelText('Key point 1'), { target: { value: 'Budget signed' } });
    expect(screen.queryByRole('alert')).toBeNull();
    expect(screen.getByLabelText('Key point 1').getAttribute('aria-invalid')).toBeNull();
  });

  it('reports whether there is anything to lose', () => {
    const onDirtyChange = vi.fn();
    render(
      <NoteEditor value={DRAFT} onSave={vi.fn()} onCancel={vi.fn()} onDirtyChange={onDirtyChange} />
    );
    expect(onDirtyChange).toHaveBeenLastCalledWith(false);
    fireEvent.change(screen.getByDisplayValue('We agreed the budget.'), {
      target: { value: 'We agreed the Q3 budget.' },
    });
    expect(onDirtyChange).toHaveBeenLastCalledWith(true);
  });

  it('removes a list row', async () => {
    const onSave = vi.fn().mockResolvedValue(undefined);
    render(<NoteEditor value={DRAFT} onSave={onSave} onCancel={vi.fn()} />);
    fireEvent.click(screen.getByRole('button', { name: /remove key point 1/i }));
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /save/i }));
    });
    expect(onSave).toHaveBeenCalledWith({ key_points: [] });
  });

  it('calls onCancel without saving', () => {
    const onSave = vi.fn();
    const onCancel = vi.fn();
    render(<NoteEditor value={DRAFT} onSave={onSave} onCancel={onCancel} />);
    fireEvent.change(screen.getByDisplayValue('We agreed the budget.'), {
      target: { value: 'changed' },
    });
    fireEvent.click(screen.getByRole('button', { name: /cancel/i }));
    expect(onCancel).toHaveBeenCalled();
    expect(onSave).not.toHaveBeenCalled();
  });

  // ---- beyond the brief -------------------------------------------------

  it('adds a row and sends the appended entry', async () => {
    const onSave = vi.fn().mockResolvedValue(undefined);
    render(<NoteEditor value={DRAFT} onSave={onSave} onCancel={vi.fn()} />);
    fireEvent.click(screen.getByRole('button', { name: /add action item/i }));
    fireEvent.change(screen.getByLabelText('Action item 2'), {
      target: { value: 'Robin books the room' },
    });
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /save/i }));
    });
    expect(onSave).toHaveBeenCalledWith({
      action_items: ['Anna sends the draft', 'Robin books the room'],
    });
  });

  it('does not enable Save for an added but still-empty row', () => {
    render(<NoteEditor value={DRAFT} onSave={vi.fn()} onCancel={vi.fn()} />);
    fireEvent.click(screen.getByRole('button', { name: /add key point/i }));
    const save = screen.getByRole('button', { name: /save/i }) as HTMLButtonElement;
    expect(save.disabled).toBe(true);
  });

  it('edits a topic title and analysis', async () => {
    const onSave = vi.fn().mockResolvedValue(undefined);
    render(<NoteEditor value={DRAFT} onSave={onSave} onCancel={vi.fn()} />);
    fireEvent.change(screen.getByDisplayValue('Budget'), { target: { value: 'Q3 budget' } });
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /save/i }));
    });
    expect(onSave).toHaveBeenCalledWith({
      discussion_areas: [{ title: 'Q3 budget', analysis: 'Reviewed.' }],
    });
  });

  it('keeps edit mode open and preserves typing when the save fails', async () => {
    const onSave = vi.fn().mockRejectedValue(new Error('Disk is full'));
    const onCancel = vi.fn();
    render(<NoteEditor value={DRAFT} onSave={onSave} onCancel={onCancel} />);
    fireEvent.change(screen.getByDisplayValue('We agreed the budget.'), {
      target: { value: 'We agreed the Q3 budget.' },
    });
    fireEvent.click(screen.getByRole('button', { name: /save/i }));
    await waitFor(() => expect(screen.getByText(/disk is full/i)).toBeTruthy());
    expect(screen.getByDisplayValue('We agreed the Q3 budget.')).toBeTruthy();
    expect(onCancel).not.toHaveBeenCalled();
  });

  it('disables both buttons while a save is in flight', async () => {
    let release!: () => void;
    const onSave = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          release = () => resolve();
        })
    );
    render(<NoteEditor value={DRAFT} onSave={onSave} onCancel={vi.fn()} />);
    fireEvent.change(screen.getByDisplayValue('We agreed the budget.'), {
      target: { value: 'We agreed the Q3 budget.' },
    });
    fireEvent.click(screen.getByRole('button', { name: /save/i }));
    await waitFor(() => {
      expect((screen.getByRole('button', { name: /saving/i }) as HTMLButtonElement).disabled).toBe(
        true
      );
    });
    expect((screen.getByRole('button', { name: /cancel/i }) as HTMLButtonElement).disabled).toBe(
      true
    );
    release();
    await waitFor(() => expect(onSave).toHaveBeenCalledTimes(1));
  });
});

/**
 * The line-break guard can't be driven through the rendered single-line inputs:
 * jsdom (like a real browser) applies the value-sanitization algorithm to
 * `input[type=text]` and strips CR/LF on assignment, so a newline can never
 * reach the draft that way. It CAN reach it from the note on disk, which is
 * exactly the case that must not be saved back through renderBulletList. So the
 * guard is tested where it lives, as a pure function.
 */
describe('validateNotePatch', () => {
  it('passes a clean patch', () => {
    expect(validateNotePatch({ summary: 'Fine.', key_points: ['a', 'b'] })).toBeNull();
  });

  it('rejects a markdown heading in any field', () => {
    expect(validateNotePatch({ summary: 'ok\n## Transcript' })?.message).toMatch(/heading/i);
    expect(validateNotePatch({ key_points: ['### forged'] })?.message).toMatch(/heading/i);
    expect(validateNotePatch({ action_items: ['ok', '  # forged'] })?.message).toMatch(/heading/i);
    expect(validateNotePatch({ discussion_areas: [{ title: '# forged' }] })?.message).toMatch(
      /heading/i
    );
    expect(
      validateNotePatch({ discussion_areas: [{ title: 'ok', analysis: 'a\n#### forged' }] })
        ?.message
    ).toMatch(/heading/i);
  });

  // A single message for the whole patch left the one user who can hit this
  // (a legacy .json note whose key_points already contain a newline) unable to
  // save and unable to tell which row to retype.
  it('locates the offending field', () => {
    expect(validateNotePatch({ summary: '# forged' })).toMatchObject({
      section: 'summary',
      index: null,
      fieldLabel: 'The summary',
    });
    expect(validateNotePatch({ action_items: ['ok', '  # forged'] })).toMatchObject({
      section: 'action_items',
      index: 1,
      fieldLabel: 'Action item 2',
    });
    expect(validateNotePatch({ action_items: ['ok', '  # forged'] })?.message).toMatch(
      /action item 2/i
    );
    expect(
      validateNotePatch({ discussion_areas: [{ title: 'ok' }, { title: 'x', analysis: '# f' }] })
    ).toMatchObject({ section: 'discussion_areas', index: 1, part: 'analysis' });
  });

  it('does not mistake a hash that is not a heading for one', () => {
    expect(validateNotePatch({ summary: 'Ticket #42 is done.' })).toBeNull();
    expect(validateNotePatch({ key_points: ['C#'] })).toBeNull();
  });

  it('rejects a line break in a list entry, which renderBulletList would truncate', () => {
    expect(validateNotePatch({ key_points: ['line one\nline two'] })?.message).toMatch(
      /line break/i
    );
    expect(validateNotePatch({ action_items: ['line one\r\nline two'] })?.message).toMatch(
      /line break/i
    );
  });

  it('rejects a line break in a topic title, which would slide into the analysis', () => {
    expect(validateNotePatch({ discussion_areas: [{ title: 'Budget\nreview' }] })?.message).toMatch(
      /line break/i
    );
    expect(validateNotePatch({ discussion_areas: [{ title: 'Budget\rreview' }] })?.message).toMatch(
      /line break/i
    );
  });

  it('allows a line break in the summary and in a topic analysis', () => {
    expect(validateNotePatch({ summary: 'One.\n\nTwo.' })).toBeNull();
    expect(
      validateNotePatch({ discussion_areas: [{ title: 'T', analysis: 'One.\n\nTwo.' }] })
    ).toBeNull();
  });
});
