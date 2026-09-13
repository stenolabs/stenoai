// Exercise the real shell helper and the app's metadata reader with fake OS tools.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

function run(t, { setterFailures = 0, staleReads = 0, dumpFailures = 0 } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'steno-pipewire-readiness-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const tool = `#!/usr/bin/env node
const fs = require('node:fs');
const path = require('node:path');
const name = path.basename(process.argv[1]);
const counter = path.join(${JSON.stringify(dir)}, name + '.calls');
const n = fs.existsSync(counter) ? Number(fs.readFileSync(counter, 'utf8')) + 1 : 1;
fs.writeFileSync(counter, String(n));
if (name === 'pactl') {
  if (process.argv[2] === 'list') process.exit(0);
  if (n <= ${setterFailures}) { console.error('Failure: Not supported'); process.exit(1); }
} else if (name === 'pw-dump') {
  if (n <= ${dumpFailures}) process.exit(1);
  console.log(JSON.stringify([{
    type: 'PipeWire:Interface:Metadata', props: { 'metadata.name': 'default' },
    metadata: [
      { key: 'default.configured.audio.sink', value: { name: 'steno_test' } },
      { key: 'default.audio.sink', value: { name: n <= ${staleReads} ? 'other_sink' : 'steno_test' } },
    ],
  }]));
}
`;
  for (const name of ['pactl', 'pw-dump', 'sleep']) {
    fs.writeFileSync(path.join(dir, name), tool, { mode: 0o755 });
  }
  const result = spawnSync('bash', [path.join(__dirname, 'wait-pipewire-sink.sh'), 'steno_test'], {
    env: { ...process.env, PATH: dir + path.delimiter + process.env.PATH },
    encoding: 'utf8',
    timeout: 20000,
  });
  assert.ifError(result.error);
  return result;
}

test('accepts the selected sink when both interfaces are ready', (t) => {
  const result = run(t);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /ready: steno_test \(attempt 1\)/);
});

test('survives Not supported until WirePlumber accepts the setter', (t) => {
  const result = run(t, { setterFailures: 2 });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stderr, /Failure: Not supported/);
  assert.match(result.stdout, /attempt 3/);
});

test('waits for the active sink even when the configured sink already matches', (t) => {
  const result = run(t, { staleReads: 2 });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /attempt 3/);
});

test('retries a transient PipeWire read failure', (t) => {
  const result = run(t, { dumpFailures: 1 });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /attempt 2/);
});

test('fails after bounded retries if the setter never becomes ready', (t) => {
  const result = run(t, { setterFailures: 100 });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /::error::PipeWire default sink did not converge/);
  assert.doesNotMatch(result.stdout, /ready:/);
});

test('fails when the active sink never matches', (t) => {
  const result = run(t, { staleReads: 100 });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /::error::PipeWire default sink did not converge/);
});
