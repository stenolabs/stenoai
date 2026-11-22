import { describe, expect, it } from 'vitest';
import { fillTemplate } from './actionTemplate';

// The same cases as app/mcp-simple-actions.test.js, so the preview matches what is sent.
describe('fillTemplate', () => {
  it('builds the Notion create-pages payload and drops empty fields', () => {
    const tpl = { pages: [{ properties: { title: '{{title}}' }, content: '{{content}}' }] };
    expect(fillTemplate(tpl, { title: 'Website content cleanup', content: '- Defence' })).toEqual({
      pages: [{ properties: { title: 'Website content cleanup' }, content: '- Defence' }],
    });
    expect(fillTemplate(tpl, { title: 'T', content: '  ' })).toEqual({ pages: [{ properties: { title: 'T' } }] });
  });

  it('looks values up and keeps literals', () => {
    const tpl = { cloudId: 'site-1', projectKey: { $lookup: 'project', map: { 'Web (WEB)': 'WEB' } }, team: { $lookup: 'team', map: {} } };
    expect(fillTemplate(tpl, { project: 'Web (WEB)', team: 'Eng' })).toEqual({ cloudId: 'site-1', projectKey: 'WEB', team: 'Eng' });
    expect(fillTemplate(tpl, {})).toEqual({ cloudId: 'site-1' });
  });
});
