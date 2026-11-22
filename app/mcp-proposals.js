'use strict';

/**
 * Server-side checks on the tool calls the summariser proposes
 * (src/action_suggest.py does the same before replying; this is the main
 * process's own copy, so a model or prompt slip never reaches a card):
 *
 *   - Each proposal must cite one of the note's action items.
 *   - Required arguments must be real values, not placeholders such as
 *     "not_specified", "TBD", "<page id>" or "your_page_id".
 *   - A required argument that names an existing object (page_id, issue_id,
 *     parent, ...) is only allowed when its value appears verbatim in the
 *     note: the model must never invent an id.
 *
 * Pure functions; mcp-actions.js applies them in suggest().
 */

const PLACEHOLDER_WORDS = new Set([
  'not_specified', 'not specified', 'not-specified', 'unspecified', 'unknown', 'tbd', 'tbc', 'n/a', 'na',
  'none', 'null', 'nil', 'undefined', 'todo', 'placeholder', '?', '...', '…', '-',
]);
const PLACEHOLDER_PATTERNS = [
  /^<[^>]*>$/, // <page id>
  /^\{\{?[^}]*\}?\}$/, // {page_id} / {{page_id}}
  /^\[[^\]]*\]$/, // [page id]
  /^your[_-][\w-]*$/i, // your_page_id, your-team-id (identifier-shaped only)
  /^(example|sample|dummy|fake|test)([_-]?(id|page|item|issue|value|\d+))?$/i, // example_id, sample-page
  /^x{3,}$/i, // xxx
  /^0{8}-0{4}-0{4}-0{4}-0{12}$/, // the nil UUID
  /^(123|1234|12345|123456|abc123|abcdef)$/i,
];

/** True for a string that stands in for a value the model did not have. */
function isPlaceholder(value) {
  if (value === null || value === undefined) return true;
  if (typeof value !== 'string') return false;
  const v = value.trim();
  if (!v) return true;
  const lower = v.toLowerCase();
  if (PLACEHOLDER_WORDS.has(lower)) return true;
  return PLACEHOLDER_PATTERNS.some((re) => re.test(v));
}

/** Any placeholder among the string leaves of a value (arrays and objects included). */
function containsPlaceholder(value, depth = 0) {
  if (depth > 6) return false;
  if (Array.isArray(value)) return value.length === 0 || value.some((v) => containsPlaceholder(v, depth + 1));
  if (value && typeof value === 'object') return Object.values(value).some((v) => containsPlaceholder(v, depth + 1));
  return isPlaceholder(value);
}

function requiredKeys(schema) {
  return Array.isArray(schema?.required) ? schema.required.filter((k) => typeof k === 'string') : [];
}

/** Parameter names that point at an existing object rather than describe a new one. */
function isIdentifierParam(name) {
  return /^(id|parent)$/i.test(name) || /(_id|Id|ID)$/.test(name) || /^parent[_A-Z]/.test(name);
}

/** The required arguments that are missing or placeholders. A value the schema lists in its enum is real. */
function placeholderArguments(schema, args) {
  return requiredKeys(schema).filter((k) => {
    if (!Object.hasOwn(args || {}, k)) return true;
    const allowed = schema?.properties?.[k]?.enum;
    if (Array.isArray(allowed) && allowed.includes(args[k])) return false;
    return containsPlaceholder(args[k]);
  });
}

/** Required identifier arguments whose value is not written in the note. */
function ungroundedIdentifiers(schema, args, noteText) {
  const text = typeof noteText === 'string' ? noteText : '';
  return requiredKeys(schema).filter((k) => {
    if (!isIdentifierParam(k) || !Object.hasOwn(args || {}, k)) return false;
    const v = args[k];
    // An id has no spaces: "Website content cleanup" is a title the note mentions, not a page id.
    if (typeof v === 'string' || typeof v === 'number') {
      const id = String(v).trim();
      return !id || !text.includes(id) || /\s/.test(id);
    }
    return true; // an object/array id is never something the note wrote down
  });
}

/** The action item a proposal cites (1-based number or exact text), or null. */
function citedActionItem(proposal, actionItems) {
  const items = Array.isArray(actionItems) ? actionItems.filter((i) => typeof i === 'string' && i.trim()) : [];
  const ref = proposal?.action_item;
  if (typeof ref === 'number' || (typeof ref === 'string' && /^\d+$/.test(ref.trim()))) {
    const n = Number(ref);
    return Number.isInteger(n) && n >= 1 && n <= items.length ? items[n - 1] : null;
  }
  if (typeof ref === 'string') {
    const want = ref.trim();
    return items.find((i) => i.trim() === want) || null;
  }
  return null;
}

/** The note text a proposal may draw identifiers from. */
function noteText(note) {
  if (!note || typeof note !== 'object') return '';
  const items = Array.isArray(note.action_items) ? note.action_items : [];
  return [note.title, note.summary, ...items].filter((s) => typeof s === 'string').join('\n');
}

/**
 * Check one proposal against its tool schema and the note. Returns
 * { ok: true, actionItem } or { ok: false, reason } ('uncited' |
 * 'placeholder' | 'ungrounded-id').
 */
function checkProposal(proposal, schema, note) {
  const actionItem = citedActionItem(proposal, note?.action_items);
  if (!actionItem) return { ok: false, reason: 'uncited' };
  if (placeholderArguments(schema, proposal.arguments).length) return { ok: false, reason: 'placeholder' };
  if (ungroundedIdentifiers(schema, proposal.arguments, noteText(note)).length) return { ok: false, reason: 'ungrounded-id' };
  return { ok: true, actionItem };
}

module.exports = {
  isPlaceholder,
  containsPlaceholder,
  isIdentifierParam,
  placeholderArguments,
  ungroundedIdentifiers,
  citedActionItem,
  noteText,
  checkProposal,
};
