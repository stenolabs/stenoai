'use strict';
// Generated Opus silence only. Two seconds, 312 pre-skip frames and 480 end-trim frames.
function makeWebMOpus({ gap = 0 } = {}) {
  const uint = value => { const b = Buffer.alloc(8); b.writeBigUInt64BE(BigInt(value)); return b; };
  const e = (id, payload) => {
    let width = 1;
    while (payload.length >= 2 ** (7 * width) - 1) width++;
    let size = BigInt(payload.length) | (1n << BigInt(7 * width));
    const bytes = Buffer.alloc(width);
    for (let i = width - 1; i >= 0; i--) { bytes[i] = Number(size & 255n); size >>= 8n; }
    return Buffer.concat([Buffer.from(id, 'hex'), bytes, payload]);
  };
  const cookie = Buffer.from('4f707573486561640102380180bb0000000000', 'hex');
  const rate = Buffer.alloc(8); rate.writeDoubleBE(48000);
  const track = Buffer.concat([e('d7', Buffer.from([1])), e('83', Buffer.from([2])),
    e('86', Buffer.from('A_OPUS')), e('63a2', cookie), e('56aa', uint(6500000)),
    e('e1', Buffer.concat([e('b5', rate), e('9f', Buffer.from([2]))]))]);
  const body = [e('1654ae6b', e('ae', track))];
  for (let i = 0; i < 100; i++) {
    const block = Buffer.from([0x81, 0, 0, 0x80, 0xf8, 0xff, 0xfe]);
    const packet = i === 99 ? e('a0', Buffer.concat([e('a1', block), e('75a2', uint(10000000))])) : e('a3', block);
    body.push(e('1f43b675', Buffer.concat([e('e7', uint(i * 20 + (i >= 50 ? gap : 0))), packet])));
  }
  return Buffer.concat([e('1a45dfa3', e('4282', Buffer.from('webm'))), e('18538067', Buffer.concat(body))]);
}
module.exports = { makeWebMOpus };
