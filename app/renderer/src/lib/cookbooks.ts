// Cookbooks — the gallery presentation of note/report templates.
//
// A cookbook IS a template (same id, same IPC, same storage); this module only
// adds presentation metadata on top: a category, a one-line description and a
// "featured" flag. Built-in templates get curated metadata keyed by their
// stable id; user-created ones are classified from their name/prompt so they
// land in a sensible section without the user having to tag anything.
//
// Pure (no React, no IPC) so it is unit-testable.

import type { Template } from '@/lib/ipc';
import { t } from '@/i18n';

export const COOKBOOK_CATEGORIES = ['briefings', 'interviews', 'planning', 'everyday'] as const;
export type CookbookCategory = (typeof COOKBOOK_CATEGORIES)[number];

export interface Cookbook {
  id: string;
  template: Template;
  name: string;
  description: string;
  category: CookbookCategory;
  featured: boolean;
  /** Built-ins are authored by Steno; everything else by the user. */
  mine: boolean;
}

// Static t() calls (the copy inventory requires literal keys).
const CATEGORY_LABELS: Record<CookbookCategory, () => string> = {
  briefings: () => t('cookbooks.category.briefings'),
  interviews: () => t('cookbooks.category.interviews'),
  planning: () => t('cookbooks.category.planning'),
  everyday: () => t('cookbooks.category.everyday'),
};

export function categoryLabel(category: CookbookCategory): string {
  return CATEGORY_LABELS[category]();
}

// Curated metadata for the templates Steno ships (src/templates.py
// BUILTIN_TEMPLATES + the seeded SAMPLE_TEMPLATE). Order here is the
// Featured row's order.
const BUILTIN_META: Record<
  string,
  { category: CookbookCategory; featured: boolean; description: () => string }
> = {
  standard: { category: 'briefings', featured: true, description: () => t('cookbooks.desc.standard') },
  'sales-call': { category: 'interviews', featured: true, description: () => t('cookbooks.desc.salesCall') },
  'one-on-one': { category: 'planning', featured: true, description: () => t('cookbooks.desc.oneOnOne') },
  'product-demo': {
    category: 'interviews',
    featured: true,
    description: () => t('cookbooks.desc.productDemo'),
  },
  standup: { category: 'everyday', featured: true, description: () => t('cookbooks.desc.standup') },
  'shareable-summary': {
    category: 'briefings',
    featured: false,
    description: () => t('cookbooks.desc.shareableSummary'),
  },
};

// Keyword heuristics for templates without curated metadata. Checked in
// order; the name is tried before the prompt so "1:1 Notes" with a prompt
// mentioning "summary" still files under planning. These are matching
// patterns, not interface copy.
const CATEGORY_PATTERNS: [CookbookCategory, RegExp][] = [
  ['interviews', /\b(interview|candidate|hiring|recruit|client|customer|sales|prospect|demo|case|patient|research|discovery|user test)/i],
  ['planning', /(\b1[:-]1\b|one[- ]on[- ]one|\bplan|\breview|\bretro|roadmap|sprint|\bokr|quarterly|feedback|performance|kick-?off)/i],
  ['everyday', /\b(stand-?up|sync|status|weekly|daily|team meeting|check-?in)/i],
  ['briefings', /\b(brief|decision|summary|summar|exec|board|action item|minutes|report|recap)/i],
];

export function classifyTemplate(template: Pick<Template, 'id' | 'name' | 'prompt'>): CookbookCategory {
  const known = BUILTIN_META[template.id];
  if (known) return known.category;
  for (const source of [template.name, template.prompt]) {
    for (const [category, pattern] of CATEGORY_PATTERNS) {
      if (pattern.test(source ?? '')) return category;
    }
  }
  return 'everyday';
}

const MAX_DESCRIPTION = 160;

/** First sentence of the prompt, trimmed to a card-sized line. */
export function describePrompt(prompt: string): string {
  const clean = (prompt ?? '').replace(/\s+/g, ' ').trim();
  if (!clean) return '';
  const sentence = clean.match(/^.*?[.!?](\s|$)/)?.[0]?.trim() ?? clean;
  return sentence.length > MAX_DESCRIPTION
    ? `${sentence.slice(0, MAX_DESCRIPTION - 1).trimEnd()}…`
    : sentence;
}

export function toCookbook(template: Template): Cookbook {
  const known = BUILTIN_META[template.id];
  const description = known
    ? known.description()
    : describePrompt(template.prompt) ||
      (template.format === 'structured'
        ? t('cookbooks.editor.structuredFormat')
        : t('cookbooks.editor.noPrompt'));
  return {
    id: template.id,
    template,
    name: template.name,
    description,
    category: classifyTemplate(template),
    featured: known?.featured ?? false,
    mine: !template.builtin,
  };
}

const featuredRank = (id: string) => {
  const index = Object.keys(BUILTIN_META).indexOf(id);
  return index < 0 ? Number.MAX_SAFE_INTEGER : index;
};

/** Featured row: curated built-ins in curated order. If an install has fewer
 *  than three (renamed ids, tests, future trims), top up with the remaining
 *  built-ins and then the user's own so the row never looks abandoned. */
export function featuredCookbooks(all: Cookbook[], minimum = 3): Cookbook[] {
  const curated = all.filter((c) => c.featured).sort((a, b) => featuredRank(a.id) - featuredRank(b.id));
  if (curated.length >= minimum) return curated;
  const rest = all.filter((c) => !c.featured).sort((a, b) => Number(a.mine) - Number(b.mine));
  return [...curated, ...rest].slice(0, Math.max(minimum, curated.length));
}

export function matchesQuery(cookbook: Cookbook, query: string): boolean {
  const q = query.trim().toLowerCase();
  if (!q) return true;
  return [cookbook.name, cookbook.description, categoryLabel(cookbook.category), cookbook.template.prompt]
    .some((field) => (field ?? '').toLowerCase().includes(q));
}

export function groupByCategory(all: Cookbook[]): { category: CookbookCategory; items: Cookbook[] }[] {
  return COOKBOOK_CATEGORIES.map((category) => ({
    category,
    items: all.filter((c) => c.category === category),
  })).filter((group) => group.items.length > 0);
}

/** Small deterministic hash → seed for the generative covers. */
export function seedFromId(id: string): number {
  let h = 2166136261;
  for (let i = 0; i < id.length; i++) {
    h ^= id.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

/** mulberry32 — tiny seeded PRNG, good enough for line-work. */
export function seededRandom(seed: number): () => number {
  let a = seed || 1;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let r = Math.imul(a ^ (a >>> 15), 1 | a);
    r = (r + Math.imul(r ^ (r >>> 7), 61 | r)) ^ r;
    return ((r ^ (r >>> 14)) >>> 0) / 4294967296;
  };
}
