import path from 'node:path';

// Shared definition of "what counts as user-facing copy".
//
// Two tools consume this: the lint gate (renderer/eslint.config.i18n.mjs) which blocks NEW
// hardcoded strings, and the copy inventory (scripts/i18n-copy-inventory.mjs) which records
// the EXISTING English wording so a migration to t() can be proven not to change it.
// They must agree — if the linter and the inventory disagree about what copy is, a string
// can be silently dropped by one and never noticed by the other.

/** Files whose strings are never shown to a user, so never translated. */
export const IGNORED_FILES = [
  'dist/**',
  'node_modules/**',
  // The /dev component showcase (App.tsx routes it at /dev) — demo copy only.
  '**/routes/Sandbox.tsx',
  '**/*.test.ts',
  '**/*.test.tsx',
];

/**
 * JSX attributes whose value a user actually reads.
 *
 * Both the DOM ones and this app's own component props: `<SettingRow label="…" />` and
 * `<ConfirmDialog confirmLabel="…" />` are copy every bit as much as `placeholder`, and
 * there are ~170 such sites in the renderer. Leaving them out let new hardcoded copy in
 * through the front door — the gate would go green on it.
 */
export const COPY_ATTRIBUTES = [
  // DOM attributes
  'placeholder',
  'title',
  'alt',
  'aria-label',
  'aria-description',
  // This app's own copy-bearing component props
  'label',
  'description',
  'hint',
  'heading',
  'subtitle',
  'caption',
  'tooltip',
  'emptyText',
  'message',
  'confirmLabel',
  'cancelLabel',
  'submitLabel',
  'selectLabel',
];

/**
 * Props that render a ReactNode, but are too polymorphic to treat as ordinary string props.
 *
 * `action` sometimes carries an element and sometimes a direct string or the argument to a
 * node-producing helper. The inventory must record those latter two as rendered copy, while
 * adding the broad prop name to COPY_ATTRIBUTES would make unrelated data-shaped action
 * props look like copy to the blocking lint gate.
 */
export const RENDERED_NODE_ATTRIBUTES = ['action'];

/** Every ESLint rule whose findings make up the blocking per-file ratchet. */
export const I18N_GATE_RULE_IDS = [
  'i18next/no-literal-string',
  'steno-i18n/no-interpolated-literal',
];

/**
 * JSX props whose NAME sounds like copy but whose value is data, an id, or a handler.
 *
 * This list exists so the copy-attribute allowlist cannot rot silently. `COPY_ATTRIBUTES`
 * is an allowlist, and an allowlist's incompleteness is invisible by nature — that is how
 * `label=` and `description=` (~170 sites of visible copy) sat outside the gate while it
 * reported green. The tripwire test in i18n-gate.test.mjs walks every JSX prop name the
 * renderer actually uses, and fails if a copy-sounding one is in neither list. An allowlist
 * is acceptable exactly when its gaps are mechanically detectable; this is that mechanism.
 *
 * Adding a name here is a deliberate statement: this prop carries data, not words.
 */
export const KNOWN_NON_COPY_ATTRIBUTES = [
  'className', // structure
  'descriptionId', // aria wiring, an id
  'name', // form field / entity name
  'folderName', // user-entered data
  'meetingName', // user-entered data
  'summaryFile', // file path
  'activeSummaryFile', // file path
  'routeSummaryFile', // file path
  'text', // transcript body, not UI copy
  'liveText', // live transcript data
  'streamText', // streamed model output
  'messages', // chat message objects
  'sizeLabel', // a formatted byte size, e.g. "2.1 GB"
];

/** Props matching this look like copy; each must be classified in one of the two lists. */
export const COPY_SOUNDING_PROP = /label|title|text|description|message|caption|hint|placeholder|tooltip|heading|subtitle|summary/i;

/**
 * Normalise a path for comparison against globs and checked-in baselines.
 *
 * `path.relative()` yields backslashes on Windows, so the slash-based ignore patterns stop
 * matching and every baseline key differs from the committed one — both gates would fail on
 * an untouched Windows checkout. CLAUDE.md requires the two platforms to behave the same.
 *
 * `sep` is injectable purely so the Windows behaviour is testable from a POSIX machine,
 * where `path.sep` is already '/' and the function would otherwise be a silent no-op.
 */
export function toPosixPath(relPath, sep = path.sep) {
  return String(relPath).split(sep).join('/');
}

/**
 * Text that looks like a string but is not copy.
 *
 * These MUST be RegExp objects, never strings: eslint-plugin-i18next compiles a string
 * pattern with a bare `new RegExp()` — no `u` flag — so `\p{L}` degrades to a literal `p`
 * and `[^\p{L}]+` then matches ordinary copy such as "All notes". Guarded by
 * i18n-gate.test.mjs.
 */
export const NON_COPY_PATTERNS = [
  // Symbol-, punctuation- and number-only text: separators, counters, glyphs.
  /^[^\p{L}]+$/u,
  // Product and vendor names are not translated.
  /^(Steno|stenoai|Ollama|Whisper|Parakeet|OpenAI|Anthropic|Obsidian|macOS|Windows|GitHub|Zapier|Discord)$/,
];

/** True when `text` is a string a translator would need to see. */
export function isCopy(text) {
  const trimmed = String(text ?? '').trim();
  if (!trimmed) return false;
  return !NON_COPY_PATTERNS.some((pattern) => pattern.test(trimmed));
}

// ---------------------------------------------------------------------------
// The inventory needs a WIDER net than the lint gate, and the direction of its default
// is the whole point.
//
// The gate BLOCKS, so a false positive costs a contributor real time and a noisy rule gets
// downgraded to `warn` — precision wins, an allowlist is right. The inventory only
// WITNESSES, so a false positive is a harmless extra line in a generated file while a
// false negative is a string that can be reworded with nothing to notice — recall wins.
//
// The first version of this file stated that principle and then implemented its opposite:
// an allowlist of copy *shapes*, which excludes anything it does not recognise. Its
// failure mode is silent omission, which is the exact failure the inventory exists to
// prevent — and it showed. Across three review rounds the same defect surfaced in a new
// disguise every time: "All notes", all-caps `AI`, lowercase `note`/`notes`, `Ask AI`,
// `Re-run first-time setup`. An allowlist here has to enumerate every shape English copy
// can take, which is unwinnable.
//
// So the burden of proof is inverted: a string is copy unless it is PROVABLY not. Position
// in the AST does most of the work (see collectFromSource), and what position cannot
// settle — `const cls = 'flex items-center'` and `const heading = 'Nothing to process'`
// sit in identical positions — is settled by the reject list below. Its incompleteness
// produces visible clutter a reviewer can trim, not invisible holes.

/** An SVG path payload: a command letter followed by coordinate soup. */
const SVG_PATH = /^[MmLlHhVvCcSsQqTtAaZz][\d\s,.eE+-]{8,}/;

/** Strings that are structurally technical: ids, keys, paths, CSS, URLs, class names. */
const TECHNICAL_PATTERNS = [
  /^https?:\/\//i,
  // Real path prefixes only. A bare leading `~` is also ordinary approximation copy
  // (`~572 MB`), so treating the character alone as a path silently dropped visible text.
  /^(?:\.{1,2}[\\/]|~[\\/]|[\\/]{1,2}|[A-Za-z]:[\\/])/, // relative, home, root/UNC, drive
  /^--/, // CSS custom properties
  /^[a-z]+([A-Z][a-z0-9]*)+$/, // camelCase identifiers
  /^[A-Z0-9]+(_[A-Z0-9]+)+$/, // SCREAMING_SNAKE_CASE
  /^[a-z0-9]+(\.[a-z0-9]+)+$/i, // dotted keys and file names
  // Casing is not proof that a colon-shaped literal is technical: lowercase labels such
  // as "status:" and "note:" are ordinary copy too. Reject only protocol/CSS prefixes
  // and Tailwind variants that are known to be structural. Missing a variant adds safe
  // inventory noise; accepting arbitrary lowercase prefixes would silently drop copy.
  /^(?:https?|data|var):\S*$/,
  /^(?:(?:sm|hover|focus-visible):)+\S+$/,
  /^[A-Z][A-Z0-9_]*:\S+$/, // screaming markers ("PROGRESS:transcribe:"), never a bare "URL:"
];

/** A CSS value, selector, or utility-class list — the dominant noise in a Tailwind app. */
/**
 * The utility-class vocabulary: Tailwind's prefixes, its bare utilities, and this app's
 * own `mv-` component classes. Used only to prove that a lowercase, hyphen-bearing string
 * is markup rather than English. Extend it when a new class prefix appears; forgetting to
 * costs an `uncertain` entry, never a dropped string.
 */
const UTILITY_PREFIX =
  /^(bg|text|font|border|rounded|shadow|flex|grid|gap|space|items|justify|self|place|content|p|px|py|pt|pb|pl|pr|m|mx|my|mt|mb|ml|mr|w|h|min|max|size|overflow|opacity|z|top|bottom|left|right|inset|translate|rotate|scale|transform|transition|duration|ease|delay|animate|cursor|select|pointer|whitespace|break|truncate|leading|tracking|list|table|tabular|ring|outline|divide|decoration|backdrop|blur|object|aspect|col|row|order|basis|grow|shrink|sr|not|first|last|odd|even|hover|focus|active|disabled|group|peer|dark|sm|md|lg|xl|inline|block|hidden|static|fixed|absolute|relative|sticky|mv)-/;

const BARE_UTILITIES = new Set([
  'flex', 'grid', 'block', 'inline', 'hidden', 'static', 'fixed', 'absolute', 'relative',
  'sticky', 'border', 'truncate', 'italic', 'underline', 'uppercase', 'lowercase',
  'capitalize', 'group', 'peer', 'active', 'open', 'contents', 'isolate', 'antialiased',
]);

const utilityShaped = (token) => UTILITY_PREFIX.test(token) || BARE_UTILITIES.has(token);

// A bare number is ordinary copy context ("2 active"), not utility syntax. Digits only
// strengthen the markup signal when they are attached to a class-shaped token such as
// `mt-2`; brackets, variants and fractions are independently conclusive markers.
const hasMarkupMarker = (token) =>
  /[:[\]/]/.test(token) || (/\d/.test(token) && (token.includes('-') || utilityShaped(token)));

// Tailwind variants decorate, but do not change, the underlying utility. Peel only
// conventional lowercase/alphanumeric or bracketed variants so prose containing a colon
// cannot be mistaken for markup merely because one word resembles a utility.
const utilityBase = (token) => {
  let base = token;
  let match;
  while ((match = base.match(/^(?:[a-z][a-z0-9-]*|[0-9]+xl|\[[^\]]+\]):/))) {
    base = base.slice(match[0].length);
  }
  return base;
};

const readsAsUtilityClassList = (tokens) =>
  tokens.length > 1 &&
  tokens.every((token) => !/\p{Lu}/u.test(token)) &&
  tokens.every((token) => utilityShaped(utilityBase(token))) &&
  tokens.some(hasMarkupMarker);

const CSS_LIKE = [
  /^[a-z-]+\([^)]*\)$/i, // var(--fg-1), rotate(90deg), translateY(-2px)
  /^#[0-9a-f]{3,8}$/i, // hex colours
  /^-?\d*\.?\d+(px|rem|em|vh|vw|%|s|ms|deg|fr|ch)$/i, // single css length
  /^(-?\d*\.?\d+(px|rem|em|vh|vw|%|s|ms|deg)?\s+)+-?\d*\.?\d+(px|rem|em|vh|vw|%|s|ms|deg)?$/i, // "0 14px"
];

/** Storage units are technical tokens, not words a translator should move. */
const STORAGE_UNIT = /^(?:B|KB|MB|GB|TB|KiB|MiB|GiB|TiB)$/;

/**
 * True when `text` is provably not user-facing copy.
 *
 * Everything this returns false for lands in the inventory. Keep the tests here narrow and
 * literal: a rule that is too eager reintroduces the silent-omission failure above.
 */
export function definitelyNotCopy(text) {
  const trimmed = String(text ?? '').trim();
  if (!trimmed) return true;
  if (!/\p{L}/u.test(trimmed)) return true; // no letters at all: numbers, glyphs, symbols
  if (!isCopy(trimmed)) return true; // brand names and symbol-only text
  if (TECHNICAL_PATTERNS.some((pattern) => pattern.test(trimmed))) return true;
  if (SVG_PATH.test(trimmed)) return true;
  if (CSS_LIKE.some((pattern) => pattern.test(trimmed))) return true;

  // A utility class or list of them: all lower case, markup-shaped, no sentence casing.
  //
  // A bare hyphen is NOT enough evidence. An earlier revision rejected every lowercase
  // kebab-case token, which threw away ordinary English copy — "e-mail", "opt-in",
  // "built-in", "sign-in", "follow-up", "drag-and-drop". The revision after that kept a
  // single hyphenated word but rejected the whole string as soon as a second token
  // followed, which threw away the same words in a sentence: "sign-in required" was
  // dropped just like "flex items-center". Markup now has to prove itself twice over —
  // either a token carries a bracket, slash, colon or an attached utility-style digit,
  // or EVERY token comes from the utility vocabulary below.
  //
  // That vocabulary is a reject list, so its gaps fail safe: an unrecognised class prefix
  // means the string is recorded as `uncertain`, which is noise. An unrecognised English
  // word would otherwise mean a string that can be reworded with nothing to notice.
  //
  // A digit used to be proof on its own, which was the same hole one level over: "last 7
  // days" and "2 speakers detected" were dropped exactly like "mt-2 flex-1". Numbers turn
  // up in copy more often than hyphens do, so that gap was the wider of the two. Now EVERY
  // token has to look like markup — from the vocabulary or carrying a marker — and at
  // least one has to carry a marker or a hyphen, so a phrase built only from bare
  // utilities that are also English words ("open group") stays copy too.
  //
  // Markers alone are still not enough, or a version label like "v2 beta3" would match on
  // digits the way "h-8 w-28" does: at least one token has to come from the vocabulary,
  // and a class list always has one while a version string has none.
  //
  // The cost is paid in the safe direction: CSS transitions ("height 80ms linear"), CSS
  // animation names and this app's own component classes ("scrollbar-clean flex ...") no
  // longer look like markup and are recorded. That is noise in a generated file, which is
  // what this file's inverted burden of proof asks us to prefer over a dropped string.
  const tokens = trimmed.split(/\s+/);
  const classListShaped = (token) => /^[a-z0-9[\]:/._%-]+$/.test(token);
  if (
    !/\p{Lu}/u.test(trimmed) &&
    tokens.every(classListShaped) &&
    tokens.every((t) => utilityShaped(t) || hasMarkupMarker(t)) &&
    tokens.some((t) => hasMarkupMarker(t) || t.includes('-')) &&
    tokens.some(utilityShaped)
  ) {
    return true;
  }

  return false;
}

/**
 * Positive signal that a string is copy rather than merely not-provably-technical.
 *
 * This decides which partition of the inventory a string lands in, never whether it is
 * recorded at all. `copy` is the contract a migration diff must hold; `uncertain` is the
 * safety net, so an uncertain-only diff in a styling PR is a five-second read.
 */
export function readsAsCopy(text) {
  const trimmed = String(text ?? '').trim();
  if (definitelyNotCopy(trimmed)) return false;
  if (STORAGE_UNIT.test(trimmed)) return false;
  const tokens = trimmed.split(/\s+/);
  // Some complete Tailwind lists survive the conservative reject list because variants
  // and arbitrary values obscure their utility prefixes. Keep them in the inventory's
  // safety net, but do not promote them to the contractual copy partition.
  if (readsAsUtilityClassList(tokens)) return false;
  if (tokens.length > 1) return true; // a phrase that survived the reject list is prose
  return /^\p{Lu}/u.test(trimmed); // one word: capitalised reads as a label
}

// Minimal glob-to-RegExp for the subset IGNORED_FILES uses.
//
// Substitution goes through sentinels, NOT chained .replace() calls. Expanding a leading
// double-star segment into an optional "any directories" group produces a regex that still
// contains a star; the following pass that turns a single star into "[^/]*" then rewrites
// the star INSIDE that replacement, narrowing it from "any number of path segments" to
// exactly one. The double-star test-file patterns then quietly stopped matching anything
// below renderer/src, and every test file leaked into the inventory.
// Guarded by i18n-gate.test.mjs.
export function globToRegExp(pattern) {
  const GLOBSTAR_SLASH = '\u0000globstarslash\u0000';
  const GLOBSTAR = '\u0000globstar\u0000';
  const STAR = '\u0000star\u0000';
  const source = pattern
    .replace(/\*\*\//g, GLOBSTAR_SLASH)
    .replace(/\*\*/g, GLOBSTAR)
    .replace(/\*/g, STAR)
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replaceAll(GLOBSTAR_SLASH, '(?:.*/)?')
    .replaceAll(GLOBSTAR, '.*')
    .replaceAll(STAR, '[^/]*');
  return new RegExp(`^${source}$`);
}

/**
 * Decode the HTML entities JSX source may carry.
 *
 * `JsxText` hands back the raw source text, so `Summarisation &amp; Chat` is stored with
 * the entity intact while React renders `Summarisation & Chat`. That breaks the one rule
 * the inventory exists to support: during the migration to locale strings, copy that never
 * changed would show up as changed — and anyone copying the inventory text into a locale
 * file would ship the literal entity to the UI.
 */
const NAMED_ENTITIES = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: '\u00a0',
  ldquo: '\u201c',
  rdquo: '\u201d',
  lsquo: '\u2018',
  rsquo: '\u2019',
  mdash: '\u2014',
  ndash: '\u2013',
  hellip: '\u2026',
  times: '\u00d7',
  middot: '\u00b7',
};

export function decodeEntities(text) {
  return String(text).replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z][a-zA-Z0-9]*);/g, (match, body) => {
    if (body[0] === '#') {
      const codePoint =
        body[1] === 'x' || body[1] === 'X'
          ? Number.parseInt(body.slice(2), 16)
          : Number.parseInt(body.slice(1), 10);
      return Number.isFinite(codePoint) && codePoint > 0 && codePoint <= 0x10ffff
        ? String.fromCodePoint(codePoint)
        : match;
    }
    // `&` is decoded last by construction: a single pass never rewrites its own output.
    return Object.hasOwn(NAMED_ENTITIES, body) ? NAMED_ENTITIES[body] : match;
  });
}
