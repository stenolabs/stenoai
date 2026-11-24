import { describe, expect, it } from 'vitest';
import type { Template } from '@/lib/ipc';
import {
  classifyTemplate,
  describePrompt,
  featuredCookbooks,
  groupByCategory,
  matchesQuery,
  seedFromId,
  seededRandom,
  toCookbook,
} from './cookbooks';

const tpl = (over: Partial<Template>): Template => ({
  id: 'x',
  name: 'X',
  icon: '',
  prompt: '',
  language: 'auto',
  format: 'markdown',
  builtin: false,
  locked: false,
  ...over,
});

describe('cookbooks metadata', () => {
  it('maps the shipped built-ins to curated categories', () => {
    expect(classifyTemplate(tpl({ id: 'standard' }))).toBe('briefings');
    expect(classifyTemplate(tpl({ id: 'sales-call' }))).toBe('interviews');
    expect(classifyTemplate(tpl({ id: 'product-demo' }))).toBe('interviews');
    expect(classifyTemplate(tpl({ id: 'one-on-one' }))).toBe('planning');
    expect(classifyTemplate(tpl({ id: 'standup' }))).toBe('everyday');
    expect(classifyTemplate(tpl({ id: 'shareable-summary' }))).toBe('briefings');
  });

  it('classifies custom templates by name before prompt, defaulting to everyday', () => {
    expect(classifyTemplate(tpl({ id: 'a', name: '1:1 Notes', prompt: 'Write a summary' }))).toBe('planning');
    expect(classifyTemplate(tpl({ id: 'b', name: 'Candidate debrief' }))).toBe('interviews');
    expect(classifyTemplate(tpl({ id: 'c', name: 'Board pack', prompt: '' }))).toBe('briefings');
    expect(classifyTemplate(tpl({ id: 'd', name: 'Misc', prompt: 'Anything' }))).toBe('everyday');
  });

  it('describes a custom template by its first prompt sentence', () => {
    expect(describePrompt('Do the thing.  Then more.')).toBe('Do the thing.');
    expect(describePrompt('')).toBe('');
    expect(describePrompt('a'.repeat(300)).length).toBeLessThanOrEqual(160);
  });

  it('features curated built-ins in curated order and tops up short lists', () => {
    const all = ['standup', 'standard', 'sales-call', 'mine'].map((id) =>
      toCookbook(tpl({ id, name: id, builtin: id !== 'mine' })),
    );
    expect(featuredCookbooks(all).map((c) => c.id)).toEqual(['standard', 'sales-call', 'standup']);
    const short = [toCookbook(tpl({ id: 'standard', builtin: true })), toCookbook(tpl({ id: 'zz' }))];
    expect(featuredCookbooks(short).map((c) => c.id)).toEqual(['standard', 'zz']);
  });

  it('searches name, description and prompt; groups in category order', () => {
    const a = toCookbook(tpl({ id: 'a', name: 'Retro', prompt: 'What went well' }));
    const b = toCookbook(tpl({ id: 'b', name: 'Daily sync', prompt: 'Status' }));
    expect(matchesQuery(a, 'WENT')).toBe(true);
    expect(matchesQuery(b, 'went')).toBe(false);
    expect(groupByCategory([b, a]).map((g) => g.category)).toEqual(['planning', 'everyday']);
  });

  it('seeds covers deterministically', () => {
    expect(seedFromId('sales-call')).toBe(seedFromId('sales-call'));
    const r1 = seededRandom(42);
    const r2 = seededRandom(42);
    expect([r1(), r1()]).toEqual([r2(), r2()]);
  });
});
