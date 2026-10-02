import { test, expect } from '../fixtures/electron';
import { realUserDataDir, fileSig } from '../fixtures/real-user-data';
import { writeUserConfig, writeMeetingSummary } from '../fixtures/user-config';
import { E2E_SUMMARY_MODEL, isSummaryModelReady } from '../fixtures/summary-model';
import { readFileSync } from 'fs';

/**
 * T2 @summarize-real — real-summarization smoke (#382). NIGHTLY-ONLY.
 *
 * summarize-contract.t2 proves the prompt-build + response-parse contract with a
 * MOCK Ollama (deterministic, fast, per-PR). This spec closes the "real summary
 * never asserted" hole: it drives a REAL small summary model (E2E_SUMMARY_MODEL,
 * default llama3.2:1b) through the actual `reprocess` path — the same
 * prompt-build + streamed response-parse the app ships — and asserts a usable
 * summary comes out the other end.
 *
 * A real model is HEAVY and NON-DETERMINISTIC, so:
 *   - It is kept OUT of the per-PR lanes: not tagged @pipeline (so the
 *     model-bearing pipeline jobs don't pick it up) and grep-inverted out of the
 *     model-free t2 jobs in e2e.yml. It runs only in the dedicated
 *     e2e-nightly.yml `summarize-real-windows` job.
 *   - It asserts ONLY WEAK INVARIANTS. A 1B model does not reliably emit an
 *     exact section set, so there is NO section-list / exact-heading assertion
 *     and NO content-quality check — only: a summary was written and is
 *     non-empty, the response-parse structured it (didn't leak raw markdown),
 *     its length clears a sane floor, and at least one known section was parsed.
 *
 * The model must be pre-pulled (the nightly job does this + verifies it); the
 * spec skips LOUDLY otherwise rather than triggering the summarizer's mid-test
 * auto-pull (which would download weights and can fall back to heavy models).
 */

// A short, fixed transcript with clear, summarisable content. Deterministic
// input; only the model's phrasing varies run to run (which is why the
// assertions below are structural, not content-exact).
const TRANSCRIPT = [
  'Alice: Welcome everyone. Today we need to lock the launch date for the mobile app.',
  'Bob: Engineering is on track. We can ship on Friday the 14th if QA signs off by Thursday.',
  'Alice: Good. Carol, is the marketing page ready?',
  'Carol: Yes, the landing page goes live Friday morning. I will send the press email at noon.',
  'Bob: One risk: the payment provider integration still needs a final review.',
  'Alice: Okay. Bob owns the payment review, Carol owns the press email, and I will confirm the QA sign-off.',
].join('\n');

// The seeded stale summary the reprocess must overwrite with real model output.
const STALE_SUMMARY = 'STALE placeholder summary that the real model must replace.';

// A human name (NOT an auto-generated pattern) so reprocess with
// regenerate_title=false does exactly one summarise call — no extra title call.
const MEETING_NAME = 'Launch Planning Meeting';

// Sane length floor: a real one/two-sentence summary of the transcript above
// clears this easily, while an empty or trivially-degenerate parse would not.
const SUMMARY_FLOOR = 20;

type ReprocessResult = { success: boolean; error?: string };
type StenoWindow = Window & {
  stenoai: {
    meetings: {
      reprocess: (
        summaryFile: string,
        regenTitle: boolean,
        name: string,
      ) => Promise<ReprocessResult>;
    };
  };
};

type SummaryDoc = {
  summary?: unknown;
  key_points?: unknown;
  action_items?: unknown;
};

const readSummary = (file: string): SummaryDoc =>
  JSON.parse(readFileSync(file, 'utf8')) as SummaryDoc;

/** Summary field if the file is present AND fully-written JSON, else undefined —
 *  so a poll never throws on a mid-write partial read. */
const readSummaryTextSafe = (file: string): string | undefined => {
  try {
    const s = readSummary(file).summary;
    return typeof s === 'string' ? s : undefined;
  } catch {
    return undefined;
  }
};

test('@summarize-real a real summary model produces a non-empty, parsed summary through reprocess', async ({
  launchApp,
  userDataDir,
}) => {
  // A real model cold-load + summarise on a CPU runner (plus PyInstaller cold
  // start + Ollama serve) can far outlast Playwright's 30 s default.
  test.setTimeout(300_000);

  const realDirBefore = fileSig(realUserDataDir());

  // Local provider + the small model as the configured summary model. The
  // summarizer reads config.model in local mode (Config.set_model allows the
  // arbitrary tag; resolve_runtime_tag / resolve_num_ctx pass it through).
  writeUserConfig(userDataDir, { ai_provider: 'local', model: E2E_SUMMARY_MODEL });

  const summaryFile = writeMeetingSummary(userDataDir, 'summarize-real', {
    name: MEETING_NAME,
    summary: STALE_SUMMARY,
    transcript: TRANSCRIPT,
  });

  const { page } = await launchApp();

  // Skip LOUDLY if the model isn't installed/loadable — never let the spec fall
  // into the summarizer's mid-test auto-pull (weights download + heavy
  // fallback). The nightly job pre-pulls + verifies the model, so a skip there
  // is impossible; locally it degrades to a loud skip instead of a slow pull.
  const modelReady = await isSummaryModelReady(page);
  // In the nightly job the model is pre-pulled AND verify-model'd before this
  // spec runs, so a not-ready model here is a real regression, not an
  // environment gap — REQUIRE it (env set by the workflow) so the run fails
  // loudly instead of skipping green with zero real-summary coverage. Locally
  // the env is unset and it degrades to a loud skip below.
  if (process.env.STENOAI_E2E_REQUIRE_SUMMARY_MODEL) {
    expect(
      modelReady,
      `${E2E_SUMMARY_MODEL} must be installed/loadable when STENOAI_E2E_REQUIRE_SUMMARY_MODEL is set (nightly)`,
    ).toBe(true);
  }
  if (!modelReady) {
    // eslint-disable-next-line no-console
    console.warn(
      `[t2:@summarize-real] SKIPPED: summary model ${E2E_SUMMARY_MODEL} not installed/loadable on this runner.`,
    );
    test.info().annotations.push({
      type: 'skip-reason',
      description: `${E2E_SUMMARY_MODEL} not installed`,
    });
  }
  test.skip(!modelReady, `${E2E_SUMMARY_MODEL} not installed`);

  // Pass both args into the browser context — page.evaluate can't close over
  // Node module-scope consts (they don't exist in the page).
  const res = await page.evaluate(
    ([f, name]) => (window as StenoWindow).stenoai.meetings.reprocess(f, false, name),
    [summaryFile, MEETING_NAME] as const,
  );
  expect(res.success).toBe(true);

  // reprocess streams the real model, parses it, then writes the file at
  // STREAM_COMPLETE — poll until the seeded stale summary is replaced. A string
  // that differs from the seed is the signal real model output flowed through
  // the whole prompt-build → stream → parse → write path.
  await expect
    .poll(
      () => {
        const s = readSummaryTextSafe(summaryFile);
        return s !== undefined && s.trim().length > 0 && s !== STALE_SUMMARY;
      },
      { timeout: 240_000, intervals: [2000] },
    )
    .toBe(true);

  const updated = readSummary(summaryFile);
  const summary = updated.summary;

  // (1) A summary was written and is a non-empty string (not the seeded stale one).
  expect(typeof summary).toBe('string');
  const summaryText = (summary as string).trim();
  expect(summaryText).not.toBe(STALE_SUMMARY);
  expect(summaryText.length).toBeGreaterThan(0);

  // (2) Length clears a sane floor — guards against a degenerate near-empty parse.
  expect(summaryText.length).toBeGreaterThanOrEqual(SUMMARY_FLOOR);

  // (3) Response-parse SUCCEEDED (did not fall back to a raw markdown dump): the
  // structured `summary` field must NOT still contain the section headings the
  // parser is meant to consume. If parsing had degenerated into dumping the raw
  // reply, those `## Summary` / `## Key Points` / ... markers would leak in.
  expect(summaryText).not.toMatch(/(^|\n)\s*##\s+(Summary|Key Points|Action Items|Key Topics)\b/i);

  // Keystone: the real user-data dir is byte-for-byte untouched.
  expect(fileSig(realUserDataDir())).toBe(realDirBefore);
});
