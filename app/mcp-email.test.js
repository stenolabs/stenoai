'use strict';

// mailto: building for the built-in Email drafts (mcp-email.js).

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { buildMailto, isValidEmail, isPlaceholderEmail, groundRecipients, MAX_MAILTO_LENGTH } = require('./mcp-email');

test('encodes subject and body; recipients and cc as plain addresses', () => {
  const { url, truncated } = buildMailto({ to: ['a@b.co', 'c.d+x@e.io'], cc: ['f@g.org'], subject: 'Q3 & next?', body: 'Hi,\n\n50% done #1' });
  assert.equal(truncated, false);
  assert.equal(url, 'mailto:a@b.co,c.d+x@e.io?cc=f@g.org&subject=Q3%20%26%20next%3F&body=Hi%2C%0D%0A%0D%0A50%25%20done%20%231');
  const parsed = new URL(url);
  assert.equal(parsed.searchParams.get('subject'), 'Q3 & next?');
  assert.equal(parsed.searchParams.get('body'), 'Hi,\r\n\r\n50% done #1');
});

test('no header injection: CR/LF in the subject become spaces; bad addresses throw', () => {
  const { url } = buildMailto({ subject: 'Hi\r\nBcc: spy@evil.co x', body: 'b' });
  assert.ok(!/%0D|%0A|%E2%80%A8/i.test(url.split('&body=')[0]));
  for (const bad of ['a@b.co\r\nBcc:x@y.z', 'a@b.co?bcc=x@y.z', 'a@b.co,x@y.z', '<a@b.co>', 'a b@c.co', 'a@b', 'a@-b.co']) {
    assert.throws(() => buildMailto({ to: [bad], subject: 's', body: 'b' }), { code: 'invalid-arguments' }, bad);
    assert.equal(isValidEmail(bad), false, bad);
  }
  assert.throws(() => buildMailto({ to: 'a@b.co', subject: 's', body: 'b' }), { code: 'invalid-arguments' });
});

test('a long body is cut to fit, with a note, never splitting a character', () => {
  const body = `${'é'.repeat(900)}\u{1F600}${'x'.repeat(2000)}`;
  const r = buildMailto({ to: ['a@b.co'], subject: 'S', body });
  assert.equal(r.truncated, true);
  assert.ok(r.url.length <= MAX_MAILTO_LENGTH);
  assert.equal(r.body, body);
  const sent = new URL(r.url).searchParams.get('body');
  assert.match(sent, /continued in Steno/);
  assert.ok(body.startsWith(sent.split('\r\n\r\n…')[0]));
  // Lone surrogates do not throw.
  assert.doesNotThrow(() => buildMailto({ subject: '\ud800', body: '\udc00'.repeat(3000) }));
});

test('recipients a model proposes must be in the note and not example domains', () => {
  assert.equal(isPlaceholderEmail('you@example.com'), true);
  assert.equal(isPlaceholderEmail('a@mail.test'), true);
  assert.equal(isPlaceholderEmail('dana@acme.co'), false);
  assert.deepEqual(
    groundRecipients({ to: ['DANA@acme.co', 'x@acme.co'], cc: ['you@example.com'], subject: 's' }, 'Email dana@acme.co the deck'),
    { args: { to: ['DANA@acme.co'], subject: 's' }, removed: 2 },
  );
});
