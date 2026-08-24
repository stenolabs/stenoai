#!/usr/bin/env node
'use strict';

const fs = require('fs');

if (require.main === module) {
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

  // Emit LIVE_READY protocol line so main.js marks liveTranscriptState.ready = true
  process.stdout.write('LIVE_READY:\n');

  const locale = process.argv[3] || 'en';
  let emittedSegment = false;

  // Drain stdin and exit cleanly on stream close or signal
  process.stdin.resume();
  process.stdin.on('data', () => {
    if (!emittedSegment) {
      emittedSegment = true;
      const segment = {
        text: `Apple live utterance (${locale})`,
        start: 0.0,
        end: 2.5,
        is_final: true,
        speaker: 'You',
      };
      process.stdout.write(`LIVE_SEG:${JSON.stringify(segment)}\n`);
    }
  });
  process.stdin.on('end', () => {
    process.exit(0);
  });
  process.on('SIGTERM', () => {
    process.exit(0);
  });
  process.on('SIGINT', () => {
    process.exit(0);
  });
}
