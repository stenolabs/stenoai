import { defineCollection, z } from 'astro:content'
import { ALL as ALL_COMPARISONS } from './content/comparisons.data.js'
import { ALL as ALL_INDUSTRIES } from './content/industries.data.js'

// Both collections are backed by a small custom loader (not `glob`) so the
// plain-JS data modules — which use a shared `STENO` object + `ROW()` helper
// constructor to dedupe Steno's own claims across every comparison page, and
// a shared `COMPLIANCE_BODY` string across every industry page — keep
// working exactly as authored, instead of being flattened into per-entry
// JSON/YAML/MD files that can't share computed values.

const toneValue = z.object({
  text: z.string(),
  tone: z.enum(['good', 'bad', 'neutral']),
})

const sourceSchema = z.object({ label: z.string(), href: z.string().url() })

const faqSchema = z.object({
  q: z.string(),
  a: z.string(),
})

const comparisons = defineCollection({
  loader: () => ALL_COMPARISONS.map((entry) => ({ id: entry.slug, ...entry })),
  schema: z.object({
    slug: z.string(),
    name: z.string(),
    oneLiner: z.string(),
    metaTitle: z.string(),
    metaDescription: z.string(),
    eyebrow: z.string(),
    h1: z.string(),
    intro: z.string(),
    rows: z.array(
      z.object({
        label: z.string(),
        steno: toneValue,
        them: toneValue,
      }),
    ),
    verdict: z.string(),
    chooseSteno: z.array(z.string()),
    chooseThem: z.array(z.string()),
    faqs: z.array(faqSchema),
    complianceNotes: z.string().optional(),
  }),
})

const industries = defineCollection({
  loader: () => ALL_INDUSTRIES.map((entry) => ({ id: entry.slug, ...entry })),
  schema: z.object({
    slug: z.string(),
    name: z.string(),
    metaTitle: z.string(),
    metaDescription: z.string(),
    eyebrow: z.string(),
    h1: z.string(),
    lede: z.string(),
    image: z.string(),
    imageAlt: z.string(),
    intro: z.string(),
    chips: z.array(z.string()),
    pains: z.array(z.string()),
    points: z.array(
      z.object({
        h: z.string(),
        b: z.string(),
      }),
    ),
    // Documented incidents shown on the industry page. Optional so a new
    // industry can ship before its evidence has been researched and sourced;
    // when present, every item must carry a source link (see the editorial
    // rules in industries.data.js).
    breaches: z
      .object({
        heading: z.string(),
        intro: z.string(),
        items: z.array(
          z.object({
            title: z.string(),
            meta: z.string(),
            what: z.string(),
            why: z.string(),
            source: z.object({ label: z.string(), href: z.string().url() }),
          }),
        ),
      })
      .optional(),
    // Sector-page detail: illustrative settings, sourced timeline, policy
    // cards and (defence) deployment postures. All optional.
    useCases: z.array(z.object({ code: z.string(), title: z.string(), outcome: z.string(), for: z.string(), env: z.string(), outputs: z.array(z.string()) })).optional(),
    whyNow: z.object({
      heading: z.string(),
      intro: z.string(),
      items: z.array(z.object({ date: z.string(), place: z.string(), title: z.string(), body: z.string(), source: sourceSchema, extra: sourceSchema.optional() })),
    }).optional(),
    policy: z.object({
      heading: z.string(),
      intro: z.string(),
      cards: z.array(z.object({ law: z.string(), says: z.string(), so: z.string(), yours: z.string(), sources: z.array(sourceSchema) })),
    }).optional(),
    postures: z.array(z.object({ name: z.string(), title: z.string(), body: z.string(), steps: z.array(z.string()), holds: z.string() })).optional(),
    // Lines the product is explicitly not presented as crossing.
    notFor: z.array(z.object({ h: z.string(), b: z.string() })).optional(),
    faqs: z.array(faqSchema),
  }),
})

export const collections = { comparisons, industries }
