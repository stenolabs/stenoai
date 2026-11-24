'use strict';

/**
 * The built-in "Email" action: draft_email opens a draft in the user's own
 * mail app through a mailto: URL. Nothing is sent by Steno; the user reviews
 * the draft and presses Send (or not) in their mail client.
 *
 * It is shaped like an MCP tool (name, inputSchema) so suggestions, chat and
 * the action cards treat it like any other action, but it never touches the
 * network: approve() calls runDraftEmail() here instead of an MCP server.
 *
 * Building the URL (RFC 6068):
 *   - Recipients must be plain addresses (validated below); they need no
 *     percent-encoding and are joined with commas. Anything else fails.
 *   - Subject: CR/LF and other control characters become spaces, so a value
 *     can never start a new header; then percent-encoded.
 *   - Body: line breaks normalised to CRLF, percent-encoded (encodeURIComponent
 *     also encodes "&", "=", "?" and "#", so no value can add a parameter).
 *   - Length: mail clients and the OS handoff truncate long mailto URLs
 *     (Windows ShellExecute and Outlook at about 2,000 characters), so the URL
 *     is kept under MAX_MAILTO_LENGTH on every platform. When the body does
 *     not fit, the full message goes to the clipboard and the draft carries
 *     the start of it plus a note saying so; the card tells the user too.
 *     One behaviour on macOS and Windows keeps the result predictable.
 */

const EMAIL_CONNECTION_ID = 'builtin-email';
const EMAIL_KIND = 'email';
const EMAIL_TOOL_NAME = 'draft_email';

const MAX_MAILTO_LENGTH = 1800;
const MAX_RECIPIENTS = 20;
const MAX_SUBJECT = 200;
const MAX_BODY = 20000;
const CONTINUED_NOTE = '\n\n…(continued in Steno: the full message is on your clipboard, paste it here)';

// Deliberately narrower than RFC 5322: the characters real addresses use, and
// nothing that would need encoding in a mailto: URL.
const LABEL = '[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?';
const EMAIL_PATTERN = `^[A-Za-z0-9_+-]+(?:\\.[A-Za-z0-9_+-]+)*@${LABEL}(?:\\.${LABEL})+$`;
const EMAIL_RE = new RegExp(EMAIL_PATTERN);

/** Domains reserved for documentation (RFC 2606): an address there is a placeholder. */
const RESERVED_DOMAIN_RE = /(^|\.)(example\.(com|org|net)|example|test|invalid|localhost)$/i;

function isValidEmail(value) {
  if (typeof value !== 'string') return false;
  const v = value.trim();
  if (v.length > 254 || !EMAIL_RE.test(v)) return false;
  return v.indexOf('@') <= 64;
}

function isPlaceholderEmail(value) {
  if (!isValidEmail(value)) return true;
  const domain = value.trim().split('@')[1];
  return RESERVED_DOMAIN_RE.test(domain);
}

const recipientsSchema = (title, description) => ({
  type: 'array',
  title,
  description,
  maxItems: MAX_RECIPIENTS,
  items: { type: 'string', pattern: EMAIL_PATTERN, maxLength: 254 },
});

/** The tool as a tools/list entry (mcp-remote-client toolSummary shape). */
const EMAIL_TOOL = Object.freeze({
  name: EMAIL_TOOL_NAME,
  title: 'Draft email',
  description: "Open a draft email in the user's mail app for them to review and send themselves, such as a follow-up to the meeting's participants with the decisions and action items. Steno sends nothing.",
  inputSchema: {
    type: 'object',
    properties: {
      to: recipientsSchema('To', 'Recipient email addresses. Only addresses written in the note; leave out when unknown.'),
      cc: recipientsSchema('Cc', 'Copy recipients. Only addresses written in the note.'),
      subject: { type: 'string', title: 'Subject', minLength: 1, maxLength: MAX_SUBJECT, description: 'Email subject line' },
      body: { type: 'string', title: 'Message', minLength: 1, maxLength: MAX_BODY, description: 'Plain-text email body' },
    },
    required: ['subject', 'body'],
    additionalProperties: false,
  },
  readOnly: false,
  destructive: false,
});

class EmailDraftError extends Error {
  constructor(message) {
    super(message);
    this.name = 'EmailDraftError';
    this.code = 'invalid-arguments';
  }
}

function recipients(list, field) {
  if (list === undefined || list === null) return [];
  if (!Array.isArray(list) || list.length > MAX_RECIPIENTS) throw new EmailDraftError(`${field} is invalid`);
  return list.map((v) => {
    if (!isValidEmail(v)) throw new EmailDraftError(`${field} has an invalid address`);
    return v.trim();
  });
}

/** A string with any lone surrogate replaced, so encodeURIComponent cannot throw. */
const wellFormed = (s) => (typeof s.toWellFormed === 'function' ? s.toWellFormed() : s.replace(/[\ud800-\udfff]/g, '\ufffd'));

/** One header line: no CR/LF or other control characters, bounded. */
function headerText(value, max) {
  return wellFormed(String(value ?? '')).replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max); // \s covers U+2028/U+2029
}

function bodyText(value) {
  return wellFormed(String(value ?? ''))
    .replace(/\r\n?/g, '\n')
    .replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, '')
    .slice(0, MAX_BODY);
}

const encodeBody = (text) => encodeURIComponent(text.replace(/\n/g, '\r\n'));

/**
 * The mailto: URL for a draft. Returns { url, truncated, body } where body
 * is the full (cleaned) message text, for the clipboard when truncated.
 * Throws EmailDraftError on an invalid recipient.
 */
function buildMailto(args, { maxLength = MAX_MAILTO_LENGTH } = {}) {
  const a = args && typeof args === 'object' ? args : {};
  const to = recipients(a.to, 'To');
  const cc = recipients(a.cc, 'Cc');
  const subject = headerText(a.subject, MAX_SUBJECT);
  const body = bodyText(a.body);

  const base = `mailto:${to.join(',')}`;
  const params = [];
  if (cc.length) params.push(`cc=${cc.join(',')}`);
  if (subject) params.push(`subject=${encodeURIComponent(subject)}`);
  const head = `${base}${params.length ? `?${params.join('&')}` : ''}`;
  const sep = params.length ? '&' : '?';
  if (!body) return { url: head, truncated: false, body };

  const full = `${head}${sep}body=${encodeBody(body)}`;
  if (full.length <= maxLength) return { url: full, truncated: false, body };

  // Keep as much of the body as fits, cut at a whole character (and at a
  // line or word break when there is one nearby), then add the note.
  const note = encodeBody(CONTINUED_NOTE);
  const room = maxLength - head.length - sep.length - 'body='.length - note.length;
  // Never split a surrogate pair (encodeURIComponent throws on half of one).
  const whole = (n) => (n > 0 && /[\ud800-\udbff]/.test(body[n - 1]) ? n - 1 : n);
  let lo = 0;
  let hi = body.length;
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    if (encodeBody(body.slice(0, whole(mid))).length <= room) lo = mid;
    else hi = mid - 1;
  }
  let cut = whole(lo);
  const soft = Math.max(body.lastIndexOf('\n', cut), body.lastIndexOf(' ', cut));
  if (soft > cut * 0.8) cut = soft;
  const start = body.slice(0, Math.max(0, cut)).trimEnd();
  return { url: `${head}${sep}body=${encodeBody(start)}${note}`, truncated: true, body };
}

/**
 * Run an approved draft_email: open the draft, and put the full body on the
 * clipboard when the URL had to be shortened. Resolves the tool-result shape
 * approve() records ({ isError, link, text, clipboard }).
 */
async function runDraftEmail(args, { openMailto, writeClipboard }) {
  const { url, truncated, body } = buildMailto(args);
  if (!/^mailto:/i.test(url)) throw new EmailDraftError('Not a mail link');
  let clipboard = false;
  if (truncated && typeof writeClipboard === 'function') {
    try {
      await writeClipboard(body);
      clipboard = true;
    } catch (_) {
      clipboard = false;
    }
  }
  await openMailto(url);
  return {
    isError: false,
    link: null,
    clipboard,
    text: clipboard
      ? 'Draft opened in your mail app. The message was too long for a mail link, so the full text is on the clipboard.'
      : 'Draft opened in your mail app.',
  };
}

/**
 * Recipients a model may propose: only addresses written in the note, never
 * reserved example domains. Returns args with `to` / `cc` filtered (and left
 * out when nothing remains) and how many were removed.
 */
function groundRecipients(args, noteText) {
  const text = String(noteText || '').toLowerCase();
  const out = { ...(args || {}) };
  let removed = 0;
  for (const key of ['to', 'cc']) {
    if (!Object.hasOwn(out, key)) continue;
    const list = Array.isArray(out[key]) ? out[key] : [out[key]];
    const kept = list.filter((v) => typeof v === 'string' && !isPlaceholderEmail(v) && text.includes(v.trim().toLowerCase()));
    removed += list.length - kept.length;
    if (kept.length) out[key] = kept.map((v) => v.trim());
    else delete out[key];
  }
  return { args: out, removed };
}

module.exports = {
  EMAIL_CONNECTION_ID,
  EMAIL_KIND,
  EMAIL_TOOL,
  EMAIL_TOOL_NAME,
  EMAIL_PATTERN,
  MAX_MAILTO_LENGTH,
  EmailDraftError,
  isValidEmail,
  isPlaceholderEmail,
  buildMailto,
  runDraftEmail,
  groundRecipients,
};
