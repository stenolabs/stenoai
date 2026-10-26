#!/usr/bin/env node
'use strict';

const fs = require('fs');

if (require.main === module) {
  const [command, locale = 'auto'] = process.argv.slice(2);
  const logFile = process.env.STENOAI_MOCK_SIDECAR_LOG;
  if (logFile) {
    const entry =
      JSON.stringify({
        args: process.argv.slice(2),
        time: Date.now(),
        pid: process.pid,
      }) + '\n';
    try {
      fs.appendFileSync(logFile, entry, 'utf8');
    } catch {
      // Best-effort write
    }
  }

  if (command === 'status') {
    const supported = locale !== process.env.STENOAI_MOCK_SIDECAR_REJECT_LOCALE;
    process.stdout.write(JSON.stringify({
      success: true,
      available: true,
      supported,
      installed: supported,
      locale,
      display_name: 'Apple On-Device',
      system_managed: true,
    }) + '\n');
    process.exit(0);
  }
  if (command === 'prepare') {
    process.stderr.write('Unexpected model preparation in model-free test\n');
    process.exit(1);
  }
  if (command === 'transcribe-file') {
    process.stdout.write(JSON.stringify({ success: true, text: '', segments: [] }) + '\n');
    process.exit(0);
  }
  if (command !== 'stream') process.exit(2);

  // Emit LIVE_READY protocol line so main.js marks liveTranscriptState.ready = true
  process.stdout.write('LIVE_READY:\n');

  let emittedSegment = false;
  const revokeControl = process.env.STENOAI_MOCK_SIDECAR_REVOKE_CONTROL;
  const revokeScenario = revokeControl && locale === 'en';
  const finalOrder = process.env.STENOAI_MOCK_SIDECAR_FINAL_ORDER;
  let revoked = false;
  let emittedAfterRevoke = false;
  const emitSegment = (segment) => {
    process.stdout.write(`LIVE_SEG:${JSON.stringify(segment)}\n`);
  };
  const controlTimer = revokeScenario ? setInterval(() => {
    if (!revoked && fs.existsSync(`${revokeControl}.withdraw`)) {
      revoked = true;
      process.stdout.write('LIVE_REVOKE:{"speaker":"You"}\n');
    }
    if (revoked && !emittedAfterRevoke && fs.existsSync(`${revokeControl}.final`)) {
      emittedAfterRevoke = true;
      emitSegment({ text: 'Final after revoke (en)', start: 2, end: 3, is_final: true, speaker: 'You' });
    }
  }, 20) : null;

  // Drain stdin and exit cleanly on stream close or signal
  process.stdin.resume();
  process.stdin.on('data', () => {
    if (!emittedSegment) {
      emittedSegment = true;
      if (revokeScenario && (finalOrder === 'late' || finalOrder === 'duplicate')) {
        const final = { text: 'Earlier final (en)', start: 0, end: 2, is_final: true, speaker: 'You' };
        const partial = { text: 'Newer partial (en)', start: 3, end: 4, is_final: false, speaker: 'You' };
        if (finalOrder === 'late') {
          emitSegment(partial);
          emitSegment(final);
        } else {
          // The duplicate earlier final is suppressed by Swift's tracker;
          // the consumer sees only this prior final and the newer partial.
          emitSegment(final);
          emitSegment(partial);
        }
      } else if (revokeScenario) {
        emitSegment({ text: 'Retained final (en)', start: 0, end: 1, is_final: true, speaker: 'You' });
        emitSegment({ text: 'Withdraw me (en)', start: 1, end: 2, is_final: false, speaker: 'You' });
        emitSegment({ text: 'Other channel (en)', start: 1, end: 2, is_final: false, speaker: 'Others' });
      } else {
        emitSegment({
          text: `Apple live utterance (${locale})`,
          start: 0.0,
          end: 2.5,
          is_final: true,
          speaker: 'You',
        });
      }
    }
  });
  process.stdin.on('end', () => {
    if (controlTimer) clearInterval(controlTimer);
    process.exit(0);
  });
  process.on('SIGTERM', () => {
    if (controlTimer) clearInterval(controlTimer);
    process.exit(0);
  });
  process.on('SIGINT', () => {
    if (controlTimer) clearInterval(controlTimer);
    process.exit(0);
  });
}
