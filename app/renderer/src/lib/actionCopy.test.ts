import { describe, expect, it } from 'vitest';
import { actionPhrase, headlineValue, inlineFieldKeys } from './actionCopy';
import type { FormField } from './actionForm';

const field = (key: string, required = false): FormField => ({
  key, label: key, description: '', kind: 'string', required, options: [],
});

describe('actionPhrase', () => {
  it('reads like a verb and an object', () => {
    expect(actionPhrase('create_page', null, 'Notion')).toBe('Create page');
    expect(actionPhrase('notion-create-pages', null, 'Notion')).toBe('Create pages');
    expect(actionPhrase('createIssue', null, 'Linear')).toBe('Create issue');
    expect(actionPhrase('send_message', 'Send message', 'Slack')).toBe('Send message');
  });
});

describe('headlineValue', () => {
  it('names the thing being made', () => {
    expect(headlineValue({ title: ' Website content cleanup ' })).toBe('Website content cleanup');
    expect(headlineValue({ channel: '#x', text: 'hi' })).toBeNull();
    expect(headlineValue({ pages: [{ properties: { title: 'Nested' } }] })).toBe('Nested');
  });
});

describe('inlineFieldKeys', () => {
  it('shows the important fields first and hides the rest', () => {
    const fields = [field('parent_id'), field('icon'), field('description'), field('title', true), field('due_date'), field('assignee')];
    expect(inlineFieldKeys(fields, { title: 'x' })).toEqual(['title', 'description', 'assignee']);
  });

  it('tops up with required fields and always shows an empty required one', () => {
    expect(inlineFieldKeys([field('channel', true), field('text', true)], { channel: '#a', text: 'b' }))
      .toEqual(['text', 'channel']);
    const fields = [field('title', true), field('summary'), field('description'), field('team_id', true)];
    expect(inlineFieldKeys(fields, { title: 'x' })).toEqual(['title', 'summary', 'description', 'team_id']);
    expect(inlineFieldKeys(fields, { title: 'x', team_id: 't' })).toEqual(['title', 'summary', 'description']);
  });
});
